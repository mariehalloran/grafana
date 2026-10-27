package azuremonitor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
)

type healthModel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type healthModelsPage struct {
	Value    []healthModel `json:"value"`
	NextLink string        `json:"nextLink"`
}

// Buffer proxy responses so paging failures cannot return a partial list as a success.
type healthModelsResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *healthModelsResponse) Header() http.Header { return r.header }
func (r *healthModelsResponse) WriteHeader(status int) {
	r.status = status
}
func (r *healthModelsResponse) Write(body []byte) (int, error) {
	return r.body.Write(body)
}

func (s *Service) handleHealthModels(rw http.ResponseWriter, req *http.Request) {
	rw.Header().Set("Content-Type", "application/json")
	if req.Method != http.MethodGet {
		rw.Header().Set("Allow", http.MethodGet)
		writeErrorResponse(rw, http.StatusMethodNotAllowed, "Health Models must be requested using GET")
		return
	}
	subscription := req.URL.Query().Get("subscriptionId")
	if _, err := uuid.Parse(subscription); err != nil {
		writeErrorResponse(rw, http.StatusBadRequest, "a valid subscriptionId is required")
		return
	}
	ds, err := s.getDataSourceFromHTTPReq(req)
	if err != nil {
		writeErrorResponse(rw, http.StatusInternalServerError, fmt.Sprintf("unable to get data source: %v", err))
		return
	}
	service, ok := ds.Services[azureMonitor]
	if !ok || service.HTTPClient == nil {
		writeErrorResponse(rw, http.StatusInternalServerError, "Azure Monitor resource service is not configured")
		return
	}
	executor, ok := s.executors[azureMonitor]
	if !ok {
		writeErrorResponse(rw, http.StatusInternalServerError, "Azure Monitor resource proxy is not configured")
		return
	}
	endpoint, err := url.Parse(service.URL)
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "https" && endpoint.Scheme != "http") {
		writeErrorResponse(rw, http.StatusInternalServerError, "Azure Monitor resource endpoint is invalid")
		return
	}
	collectionPath := fmt.Sprintf("/subscriptions/%s/providers/Microsoft.CloudHealth/healthmodels", subscription)
	endpoint.Path = collectionPath
	endpoint.RawQuery = "api-version=v11"
	models := make([]healthModel, 0)
	visited := make(map[string]bool)
	for {
		if visited[endpoint.String()] || len(visited) >= 1000 {
			writeErrorResponse(rw, http.StatusBadGateway, "Health Models paging did not complete")
			return
		}
		visited[endpoint.String()] = true
		pageRequest := req.Clone(req.Context())
		pageRequest.URL = endpoint
		pageRequest.Host = endpoint.Host
		pageRequest.RequestURI = ""
		response := &healthModelsResponse{header: make(http.Header), status: http.StatusOK}
		if _, err := executor.ResourceRequest(response, pageRequest, service.HTTPClient); err != nil {
			writeErrorResponse(rw, http.StatusBadGateway, fmt.Sprintf("unable to list Health Models: %v", err))
			return
		}
		if response.status < http.StatusOK || response.status >= http.StatusMultipleChoices {
			rw.WriteHeader(response.status)
			if _, err := rw.Write(response.body.Bytes()); err != nil {
				s.logger.Error("Unable to write Health Models error response", "error", err)
			}
			return
		}
		var page healthModelsPage
		if err := json.Unmarshal(response.body.Bytes(), &page); err != nil || page.Value == nil {
			writeErrorResponse(rw, http.StatusBadGateway, "invalid Health Models response from Azure")
			return
		}
		models = append(models, page.Value...)
		if page.NextLink == "" {
			break
		}
		next, err := endpoint.Parse(page.NextLink)
		if err != nil || next.User != nil || next.Scheme != endpoint.Scheme ||
			!strings.EqualFold(next.Host, endpoint.Host) || !strings.EqualFold(next.Path, collectionPath) {
			writeErrorResponse(rw, http.StatusBadGateway, "invalid Health Models nextLink from Azure")
			return
		}
		query := next.Query()
		query.Set("api-version", "v11")
		next.RawQuery = query.Encode()
		endpoint = next
	}
	if err := json.NewEncoder(rw).Encode(models); err != nil {
		s.logger.Error("Unable to write Health Models response", "error", err)
	}
}
