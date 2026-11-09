package azuremonitor

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/grafana/grafana/pkg/tsdb/azuremonitor/types"
)

func getTarget(original string) (target string, err error) {
	splittedPath := strings.Split(original, "/")
	if len(splittedPath) < 3 {
		err = fmt.Errorf("the request should contain the service on its path")
		return
	}
	target = fmt.Sprintf("/%s", strings.Join(splittedPath[2:], "/"))
	return
}

type httpServiceProxy struct {
	logger log.Logger
}

func (s *httpServiceProxy) writeErrorResponse(rw http.ResponseWriter, statusCode int, message string) error {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(statusCode)

	// Set error response to initial error message
	errorBody := map[string]string{"error": message}

	// Attempt to locate JSON portion in error message
	re := regexp.MustCompile(`\{.*?\}`)
	jsonPart := re.FindString(message)
	if jsonPart != "" {
		var jsonData map[string]interface{}
		if unmarshalErr := json.Unmarshal([]byte(jsonPart), &jsonData); unmarshalErr != nil {
			errorBody["error"] = fmt.Sprintf("Invalid JSON format in error message. Raw error: %s", message)
			s.logger.Error("failed to unmarshal JSON error message", "error", unmarshalErr)
		} else {
			// Extract relevant fields for a formatted error message
			errorType, _ := jsonData["error"].(string)
			errorDescription, ok := jsonData["error_description"].(string)
			if !ok {
				s.logger.Error("unable to convert error_description to string", "rawError", jsonData["error_description"])
				// Attempt to just format the error as a string
				errorDescription = fmt.Sprintf("%v", jsonData["error_description"])
			}
			if errorType == "" {
				errorType = "UnknownError"
			}

			errorBody["error"] = fmt.Sprintf("%s: %s", errorType, errorDescription)
		}
	}

	jsonRes, _ := json.Marshal(errorBody)
	_, err := rw.Write(jsonRes)
	if err != nil {
		return fmt.Errorf("unable to write HTTP response: %v", err)
	}
	return nil
}

func (s *httpServiceProxy) Do(rw http.ResponseWriter, req *http.Request, cli *http.Client) (http.ResponseWriter, error) {
	res, err := cli.Do(req)
	if err != nil {
		return nil, s.writeErrorResponse(rw, http.StatusInternalServerError, fmt.Sprintf("unexpected error: %v", err))
	}

	defer func() {
		if err := res.Body.Close(); err != nil {
			s.logger.Warn("Failed to close response body", "err", err)
		}
	}()

	body, err := io.ReadAll(res.Body)
	if err != nil {
		rw.WriteHeader(http.StatusInternalServerError)
		_, err = fmt.Fprintf(rw, "unexpected error %v", err)
		if err != nil {
			return nil, fmt.Errorf("unable to write HTTP response: %v", err)
		}
		return nil, err
	}

	for k, v := range res.Header {
		rw.Header().Set(k, v[0])
		for _, v := range v[1:] {
			rw.Header().Add(k, v)
		}
	}

	rw.WriteHeader(res.StatusCode)
	_, err = rw.Write(body)
	if err != nil {
		return nil, fmt.Errorf("unable to write HTTP response: %v", err)
	}

	// Return the ResponseWriter for testing purposes
	return rw, nil
}

func (s *Service) getDataSourceFromHTTPReq(req *http.Request) (types.DatasourceInfo, error) {
	ctx := req.Context()
	pluginContext := backend.PluginConfigFromContext(ctx)
	i, err := s.im.Get(ctx, pluginContext)
	if err != nil {
		return types.DatasourceInfo{}, err
	}
	ds, ok := i.(types.DatasourceInfo)
	if !ok {
		return types.DatasourceInfo{}, fmt.Errorf("unable to convert datasource from service instance")
	}
	return ds, nil
}

func writeErrorResponse(rw http.ResponseWriter, code int, msg string) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(code)
	errorBody := map[string]string{
		"error": msg,
	}
	jsonRes, _ := json.Marshal(errorBody)
	_, err := rw.Write(jsonRes)
	if err != nil {
		backend.Logger.Error("Unable to write HTTP response", "error", err)
	}
}

func (s *Service) handleResourceReq(subDataSource string) func(rw http.ResponseWriter, req *http.Request) {
	return s.handleResourceReqWithTarget(subDataSource, nil)
}

func (s *Service) handleResourceReqWithTarget(subDataSource string, target *url.URL) func(rw http.ResponseWriter, req *http.Request) {
	return func(rw http.ResponseWriter, req *http.Request) {
		s.logger.Debug("Received resource call", "url", req.URL.String(), "method", req.Method)

		var newPath string
		if target == nil {
			var err error
			newPath, err = getTarget(req.URL.Path)
			if err != nil {
				writeErrorResponse(rw, http.StatusBadRequest, err.Error())
				return
			}
		}

		dsInfo, err := s.getDataSourceFromHTTPReq(req)
		if err != nil {
			writeErrorResponse(rw, http.StatusInternalServerError, fmt.Sprintf("unexpected error %v", err))
			return
		}

		service, ok := dsInfo.Services[subDataSource]
		if !ok {
			writeErrorResponse(rw, http.StatusInternalServerError, fmt.Sprintf("no service configured for %s", subDataSource))
			return
		}

		if target != nil {
			upstreamReq, err := http.NewRequestWithContext(req.Context(), req.Method, target.String(), req.Body)
			if err != nil {
				writeErrorResponse(rw, http.StatusBadRequest, err.Error())
				return
			}
			upstreamReq.ContentLength = req.ContentLength
			upstreamReq.GetBody = req.GetBody
			for _, name := range []string{"Accept", "Content-Type", "Content-Encoding"} {
				if values, ok := req.Header[name]; ok {
					upstreamReq.Header[name] = values
				}
			}
			req = upstreamReq
		} else {
			serviceURL, err := url.Parse(service.URL)
			if err != nil {
				writeErrorResponse(rw, http.StatusInternalServerError, fmt.Sprintf("unexpected error %v", err))
				return
			}
			req.URL.Path = newPath
			req.URL.Host = serviceURL.Host
			req.URL.Scheme = serviceURL.Scheme
		}
		req.Host = req.URL.Host

		if executor, ok := s.executors[subDataSource]; ok {
			_, err = executor.ResourceRequest(rw, req, service.HTTPClient)
		} else {
			proxy := httpServiceProxy{logger: s.logger}
			_, err = proxy.Do(rw, req, service.HTTPClient)
		}
		if err != nil {
			s.logger.Error("error in resource request", "error", err)
			return
		}
	}
}

func (s *Service) handleHealthModelsResourceReq(rw http.ResponseWriter, req *http.Request, dataplaneURL, resourcePath string) {
	endpoint, err := url.Parse(dataplaneURL)
	if err != nil || endpoint.Scheme != "https" || endpoint.User != nil || endpoint.Fragment != "" ||
		(endpoint.Port() != "" && endpoint.Port() != "443") ||
		!strings.HasSuffix(strings.ToLower(endpoint.Hostname()), ".data.cloudhealth.azure.com") {
		writeErrorResponse(rw, http.StatusBadRequest, "dataplaneUrl must be an HTTPS CloudHealth endpoint")
		return
	}
	operation, err := url.Parse(resourcePath)
	if err != nil || operation.IsAbs() || operation.Host != "" || operation.User != nil || operation.Fragment != "" {
		writeErrorResponse(rw, http.StatusBadRequest, "path must be relative to the dataplane endpoint")
		return
	}
	target := endpoint.JoinPath(operation.EscapedPath())
	query := target.Query()
	for key, values := range operation.Query() {
		query[key] = values
	}
	for key, values := range req.URL.Query() {
		if key != "dataplaneUrl" && key != "path" {
			query[key] = values
		}
	}
	target.RawQuery = query.Encode()
	s.handleResourceReqWithTarget(azureHealthModels, target)(rw, req)
}

// newResourceMux provides route definitions shared with the frontend.
// Check: /public/app/plugins/datasource/azuremonitor/utils/common.ts <routeNames>
func (s *Service) newResourceMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/azuremonitor/", s.handleResourceReq(azureMonitor))
	mux.HandleFunc("/loganalytics/", s.handleResourceReq(azureLogAnalytics))
	mux.HandleFunc("/resourcegraph/", s.handleResourceReq(azureResourceGraph))
	healthModels := func(rw http.ResponseWriter, req *http.Request) {
		params := req.URL.Query()
		s.handleHealthModelsResourceReq(rw, req, params.Get("dataplaneUrl"), params.Get("path"))
	}
	mux.HandleFunc("/healthmodels", healthModels)
	mux.HandleFunc("/healthmodels/", healthModels)
	return mux
}
