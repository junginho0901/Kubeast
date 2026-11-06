package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

type metricsRegistry struct{ blob string }

func (metricsRegistry) List(context.Context) ([]cluster.Info, error) { return nil, nil }
func (r metricsRegistry) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	return &cluster.Info{ID: id, Mode: cluster.ModeExternal, KubeconfigBlob: r.blob}, nil
}
func (metricsRegistry) Default(context.Context) (cluster.ID, error) { return "c1", nil }

const metricsBreakerFails = 5

func metricsHandler(t *testing.T, apiServer string) *Handler {
	t.Helper()
	blob := fmt.Sprintf(`apiVersion: v1
kind: Config
clusters:
- name: test
  cluster:
    server: %s
contexts:
- name: test
  context:
    cluster: test
    user: test
current-context: test
users:
- name: test
  user:
    token: fake-token
`, apiServer)
	svc, err := k8s.NewService(context.Background(), metricsRegistry{blob: blob}, false, nil, k8s.ServiceOptions{BreakerFails: metricsBreakerFails})
	if err != nil {
		t.Fatal(err)
	}
	return &Handler{svc: svc}
}

func readMetrics(h *Handler, path string, next http.HandlerFunc) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path+"?cluster=c1", nil)
	req = req.WithContext(auth.WithPayload(req.Context(), auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}))
	rec := httptest.NewRecorder()
	h.ClusterMiddleware(next).ServeHTTP(rec, req)
	return rec
}

// The API server answered, only its metrics.k8s.io backend did not. Monitoring keeps asking until it does, so these
// answers must not count toward the breaker: open, it fails every request of the cluster until the next health sweep.
func TestMetricsServerNotAnsweringDoesNotTakeTheClusterDown(t *testing.T) {
	bodies := map[string]struct {
		status      int
		contentType string
		body        string
	}{
		"503 as text, the aggregator's": {http.StatusServiceUnavailable, "text/plain", "service unavailable\n"},
		"503 as a Status":               {http.StatusServiceUnavailable, "application/json", `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"the server is currently unable to handle the request","reason":"ServiceUnavailable","code":503}`},
		"504 as a Status":               {http.StatusGatewayTimeout, "application/json", `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"the request timed out","reason":"Timeout","code":504}`},
	}
	for name, answer := range bodies {
		t.Run(name, func(t *testing.T) {
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", answer.contentType)
				w.WriteHeader(answer.status)
				_, _ = w.Write([]byte(answer.body))
			}))
			defer api.Close()
			h := metricsHandler(t, api.URL)
			reads := map[string]http.HandlerFunc{"/api/v1/metrics/nodes": h.GetNodeMetrics, "/api/v1/metrics/pods": h.GetPodMetrics}
			for path, read := range reads {
				first := readMetrics(h, path, read)
				var body struct {
					Detail string `json:"detail"`
				}
				if err := json.Unmarshal(first.Body.Bytes(), &body); err != nil || !strings.Contains(body.Detail, "metrics") {
					t.Errorf("%s: the reason is gone: %s (%v)", path, first.Body.String(), err)
				}
				codes := map[int]int{first.Code: 1}
				for range metricsBreakerFails * 2 {
					codes[readMetrics(h, path, read).Code]++
				}
				if codes[http.StatusBadGateway] != metricsBreakerFails*2+1 {
					t.Errorf("%s: status counts %v, want each a 502", path, codes)
				}
			}
			if h.svc.ClusterDown("c1") {
				t.Error("metrics-server not answering took the whole cluster down")
			}
		})
	}
}

// A cluster that cannot be reached still counts: that is what the breaker is for.
func TestMetricsReadOfAnUnreachableClusterStillCounts(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := api.URL
	api.Close()
	h := metricsHandler(t, url)
	for range metricsBreakerFails {
		if rec := readMetrics(h, "/api/v1/metrics/nodes", h.GetNodeMetrics); rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
		}
	}
	if !h.svc.ClusterDown("c1") {
		t.Fatal("an unreachable cluster did not open the breaker")
	}
	if rec := readMetrics(h, "/api/v1/metrics/nodes", h.GetNodeMetrics); !strings.Contains(rec.Body.String(), "currently unreachable") {
		t.Fatalf("no fast failure: %d %s", rec.Code, rec.Body.String())
	}
}

// Without metrics-server the group is not served (404): that is no metrics, an empty answer.
func TestMetricsReadWithoutMetricsServerIsEmpty(t *testing.T) {
	api := httptest.NewServer(http.NotFoundHandler())
	defer api.Close()
	h := metricsHandler(t, api.URL)
	rec := readMetrics(h, "/api/v1/metrics/nodes", h.GetNodeMetrics)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
}
