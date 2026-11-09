package azuremonitor

import (
	"bytes"
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

	rw.WriteHeader(res.StatusCode)
	_, err = rw.Write(body)
	if err != nil {
		return nil, fmt.Errorf("unable to write HTTP response: %v", err)
	}

	for k, v := range res.Header {
		rw.Header().Set(k, v[0])
		for _, v := range v[1:] {
			rw.Header().Add(k, v)
		}
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
	return func(rw http.ResponseWriter, req *http.Request) {
		s.logger.Debug("Received resource call", "url", req.URL.String(), "method", req.Method)

		newPath, err := getTarget(req.URL.Path)
		if err != nil {
			writeErrorResponse(rw, http.StatusBadRequest, err.Error())
			return
		}

		dsInfo, err := s.getDataSourceFromHTTPReq(req)
		if err != nil {
			writeErrorResponse(rw, http.StatusInternalServerError, fmt.Sprintf("unexpected error %v", err))
			return
		}

		service := dsInfo.Services[subDataSource]
		serviceURL, err := url.Parse(service.URL)
		if err != nil {
			writeErrorResponse(rw, http.StatusInternalServerError, fmt.Sprintf("unexpected error %v", err))
			return
		}
		req.URL.Path = newPath
		req.URL.Host = serviceURL.Host
		req.URL.Scheme = serviceURL.Scheme

		_, err = s.executors[subDataSource].ResourceRequest(rw, req, service.HTTPClient)
		if err != nil {
			// The ResourceRequest function should handle writing the error response
			// We log the error here to ensure it's captured
			s.logger.Error("error in resource request", "error", err)
			return
		}
	}
}

func (s *Service) handleHealthModelsResourceReq(rw http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		rw.Header().Set("Allow", http.MethodGet)
		writeErrorResponse(rw, http.StatusMethodNotAllowed, "the health models dataplane request only supports GET")
		return
	}

	dsInfo, err := s.getDataSourceFromHTTPReq(req)
	if err != nil {
		writeErrorResponse(rw, http.StatusInternalServerError, fmt.Sprintf("unexpected error %v", err))
		return
	}
	service, ok := dsInfo.Services[azureHealthModels]
	if !ok {
		writeErrorResponse(rw, http.StatusInternalServerError, "AZURE_HEALTH_MODELS_DATAPLANE_URL is not set for the Grafana backend")
		return
	}
	endpoint, err := url.Parse(service.URL)
	if err != nil {
		writeErrorResponse(rw, http.StatusInternalServerError, "invalid configured health models dataplane URL")
		return
	}
	upstreamReq, err := http.NewRequestWithContext(req.Context(), http.MethodGet, service.URL, nil)
	if err != nil {
		writeErrorResponse(rw, http.StatusBadRequest, "invalid configured health models dataplane request")
		return
	}
	upstreamReq.Header.Set("Accept", "application/json")

	res, err := service.HTTPClient.Do(upstreamReq)
	if err != nil {
		message := strings.ReplaceAll(err.Error(), endpoint.Hostname(), "[configured dataplane]")
		s.logger.Error("health models dataplane request failed", "error", message)
		writeErrorResponse(rw, http.StatusBadGateway, message)
		return
	}
	defer func() {
		if err := res.Body.Close(); err != nil {
			s.logger.Warn("failed to close health models dataplane response", "error", err)
		}
	}()

	body, err := io.ReadAll(res.Body)
	if err != nil {
		writeErrorResponse(rw, http.StatusBadGateway, "failed to read the health models dataplane response")
		return
	}
	if res.StatusCode/100 == 2 && !json.Valid(body) {
		writeErrorResponse(rw, http.StatusBadGateway, "invalid JSON response from the health models dataplane")
		return
	}
	body = bytes.ReplaceAll(body, []byte(endpoint.Hostname()), []byte("[configured dataplane]"))
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(res.StatusCode)
	if _, err := rw.Write(body); err != nil {
		s.logger.Error("failed to write health models dataplane response", "error", err)
	}
}

// newResourceMux provides route definitions shared with the frontend.
// Check: /public/app/plugins/datasource/azuremonitor/utils/common.ts <routeNames>
func (s *Service) newResourceMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/azuremonitor/", s.handleResourceReq(azureMonitor))
	mux.HandleFunc("/loganalytics/", s.handleResourceReq(azureLogAnalytics))
	mux.HandleFunc("/resourcegraph/", s.handleResourceReq(azureResourceGraph))
	mux.HandleFunc("/healthmodels", s.handleHealthModelsResourceReq)
	mux.HandleFunc("/healthmodels/", s.handleHealthModelsResourceReq)
	return mux
}
