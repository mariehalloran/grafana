package azuremonitor

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/tsdb/azuremonitor/metrics"
	"github.com/grafana/grafana/pkg/tsdb/azuremonitor/types"
)

const healthModelsSubscription = "11111111-1111-1111-1111-111111111111"
const healthModelsCollection = "/subscriptions/" + healthModelsSubscription + "/providers/Microsoft.CloudHealth/healthmodels"

func healthModelsTestService(t *testing.T, handler http.HandlerFunc) *Service {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return &Service{
		im: &fakeInstance{services: map[string]types.DatasourceService{
			azureMonitor: {URL: server.URL, HTTPClient: server.Client()},
		}},
		executors: map[string]azDatasourceExecutor{
			azureMonitor: &metrics.AzureMonitorDatasource{Proxy: &httpServiceProxy{logger: log.DefaultLogger}},
		},
		logger: log.DefaultLogger,
	}
}

func TestHealthModels(t *testing.T) {
	t.Run("lists all ARM pages through the resource proxy with v11", func(t *testing.T) {
		var requests []string
		s := healthModelsTestService(t, func(w http.ResponseWriter, r *http.Request) {
			requests = append(requests, r.URL.String())
			assert.Equal(t, "configured-client", r.Header.Get("X-Test-Credentials"))
			assert.Equal(t, healthModelsCollection, r.URL.Path)
			assert.Equal(t, "v11", r.URL.Query().Get("api-version"))
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Query().Get("$skiptoken") {
			case "":
				_, err := fmt.Fprintf(w, `{"value":[{"id":"model-one-id","name":"model-one"}],"nextLink":"http://%s%s?api-version=v11&$skiptoken=next"}`, r.Host, healthModelsCollection)
				assert.NoError(t, err)
			case "next":
				_, err := w.Write([]byte(`{"value":[{"id":"model-two-id","name":"model-two"}],"nextLink":"?api-version=v11&$skiptoken=last"}`))
				assert.NoError(t, err)
			case "last":
				_, err := w.Write([]byte(`{"value":[{"id":"model-three-id","name":"model-three"}]}`))
				assert.NoError(t, err)
			default:
				t.Errorf("unexpected page token: %s", r.URL.RawQuery)
			}
		})
		client := s.im.(*fakeInstance).services[azureMonitor].HTTPClient
		client.Transport = healthModelsCredentialTransport{base: client.Transport}
		response := httptest.NewRecorder()
		s.newResourceMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthmodels?subscriptionId="+healthModelsSubscription, nil))
		require.Equal(t, http.StatusOK, response.Code)
		require.JSONEq(t, `[{"id":"model-one-id","name":"model-one"},{"id":"model-two-id","name":"model-two"},{"id":"model-three-id","name":"model-three"}]`, response.Body.String())
		require.Equal(t, []string{
			healthModelsCollection + "?api-version=v11",
			healthModelsCollection + "?%24skiptoken=next&api-version=v11",
			healthModelsCollection + "?%24skiptoken=last&api-version=v11",
		}, requests)
	})

	t.Run("returns an empty JSON array when Azure has no models", func(t *testing.T) {
		s := healthModelsTestService(t, func(w http.ResponseWriter, r *http.Request) {
			_, err := w.Write([]byte(`{"value":[]}`))
			assert.NoError(t, err)
		})
		response := httptest.NewRecorder()
		s.newResourceMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthmodels?subscriptionId="+healthModelsSubscription, nil))
		require.Equal(t, http.StatusOK, response.Code)
		require.JSONEq(t, `[]`, response.Body.String())
	})

	for _, tt := range []struct {
		name   string
		status int
		header string
		value  string
	}{
		{name: "throttling", status: http.StatusTooManyRequests, header: "Retry-After", value: "30"},
		{name: "authentication", status: http.StatusUnauthorized, header: "WWW-Authenticate", value: "Bearer"},
	} {
		t.Run("preserves ARM "+tt.name+" response headers", func(t *testing.T) {
			s := healthModelsTestService(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set(tt.header, tt.value)
				w.WriteHeader(tt.status)
				_, err := w.Write([]byte(`{"error":{"message":"Request failed"}}`))
				assert.NoError(t, err)
			})
			response := httptest.NewRecorder()
			s.newResourceMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthmodels?subscriptionId="+healthModelsSubscription, nil))
			require.Equal(t, tt.status, response.Code)
			require.Equal(t, tt.value, response.Header().Get(tt.header))
		})
	}

	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests, http.StatusInternalServerError} {
		t.Run(fmt.Sprintf("forwards ARM error %d without returning partial results", status), func(t *testing.T) {
			requests := 0
			s := healthModelsTestService(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				if requests == 1 {
					_, err := w.Write([]byte(`{"value":[{"id":"partial","name":"partial"}],"nextLink":"?page=2"}`))
					assert.NoError(t, err)
					return
				}
				w.WriteHeader(status)
				_, err := w.Write([]byte(`{"error":{"code":"AzureError","message":"Unable to list Health Models"}}`))
				assert.NoError(t, err)
			})
			response := httptest.NewRecorder()
			s.newResourceMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthmodels?subscriptionId="+healthModelsSubscription, nil))
			require.Equal(t, status, response.Code)
			require.JSONEq(t, `{"error":{"code":"AzureError","message":"Unable to list Health Models"}}`, response.Body.String())
			require.Equal(t, 2, requests)
		})
	}

	for _, nextLink := range []string{
		"https://untrusted.example/models",
		"/subscriptions/another/providers/Microsoft.CloudHealth/healthmodels",
		"/subscriptions/" + healthModelsSubscription + "/providers/Microsoft.Compute/virtualMachines",
		"http://user@untrusted.example/models",
		":invalid",
	} {
		t.Run("rejects unsafe continuation "+nextLink, func(t *testing.T) {
			requests := 0
			s := healthModelsTestService(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				_, err := fmt.Fprintf(w, `{"value":[],"nextLink":%q}`, nextLink)
				assert.NoError(t, err)
			})
			response := httptest.NewRecorder()
			s.newResourceMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthmodels?subscriptionId="+healthModelsSubscription, nil))
			require.Equal(t, http.StatusBadGateway, response.Code)
			require.JSONEq(t, `{"error":"invalid Health Models nextLink from Azure"}`, response.Body.String())
			require.Equal(t, 1, requests)
		})
	}

	t.Run("rejects repeated continuation links", func(t *testing.T) {
		requests := 0
		s := healthModelsTestService(t, func(w http.ResponseWriter, r *http.Request) {
			requests++
			_, err := w.Write([]byte(`{"value":[],"nextLink":"?api-version=v11"}`))
			assert.NoError(t, err)
		})
		response := httptest.NewRecorder()
		s.newResourceMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthmodels?subscriptionId="+healthModelsSubscription, nil))
		require.Equal(t, http.StatusBadGateway, response.Code)
		require.JSONEq(t, `{"error":"Health Models paging did not complete"}`, response.Body.String())
		require.Equal(t, 1, requests)
	})

	for _, body := range []string{`not JSON`, `{}`, `{"value":null}`} {
		t.Run("rejects malformed ARM response "+body, func(t *testing.T) {
			s := healthModelsTestService(t, func(w http.ResponseWriter, r *http.Request) {
				_, err := w.Write([]byte(body))
				assert.NoError(t, err)
			})
			response := httptest.NewRecorder()
			s.newResourceMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthmodels?subscriptionId="+healthModelsSubscription, nil))
			require.Equal(t, http.StatusBadGateway, response.Code)
			require.JSONEq(t, `{"error":"invalid Health Models response from Azure"}`, response.Body.String())
		})
	}

	t.Run("rejects missing and malformed subscriptions before contacting Azure", func(t *testing.T) {
		s := healthModelsTestService(t, func(w http.ResponseWriter, r *http.Request) {
			t.Error("must not contact Azure for an invalid subscription")
		})
		for _, subscription := range []string{"", "not-a-subscription", "../other"} {
			response := httptest.NewRecorder()
			s.newResourceMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthmodels?subscriptionId="+subscription, nil))
			require.Equal(t, http.StatusBadRequest, response.Code)
			require.JSONEq(t, `{"error":"a valid subscriptionId is required"}`, response.Body.String())
		}
	})

	t.Run("rejects methods other than GET", func(t *testing.T) {
		s := &Service{}
		response := httptest.NewRecorder()
		s.newResourceMux().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/healthmodels", nil))
		require.Equal(t, http.StatusMethodNotAllowed, response.Code)
		require.Equal(t, http.MethodGet, response.Header().Get("Allow"))
	})

	t.Run("reports an unconfigured ARM service", func(t *testing.T) {
		s := &Service{im: &fakeInstance{}}
		response := httptest.NewRecorder()
		s.newResourceMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthmodels?subscriptionId="+healthModelsSubscription, nil))
		require.Equal(t, http.StatusInternalServerError, response.Code)
		require.JSONEq(t, `{"error":"Azure Monitor resource service is not configured"}`, response.Body.String())
	})
}

type healthModelsCredentialTransport struct {
	base http.RoundTripper
}

func (t healthModelsCredentialTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("X-Test-Credentials", "configured-client")
	return t.base.RoundTrip(req)
}
