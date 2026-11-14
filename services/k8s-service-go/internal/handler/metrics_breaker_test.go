package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
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

// serveDiscovery answers API discovery as a legacy (not aggregated) API server: core v1 and, with metrics,
// metrics.k8s.io/v1beta1 (metrics-server installed). It counts the discovery reads (the group list asked) in reads.
func serveDiscovery(w http.ResponseWriter, r *http.Request, metrics bool, reads *atomic.Int64) bool {
	const metricsGV = `{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}`
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api":
		_, _ = w.Write([]byte(`{"kind":"APIVersions","versions":["v1"]}`))
	case "/api/v1":
		_, _ = w.Write([]byte(`{"kind":"APIResourceList","groupVersion":"v1","resources":[{"name":"nodes","singularName":"node","namespaced":false,"kind":"Node","verbs":["get","list"]}]}`))
	case "/apis":
		reads.Add(1)
		groups := ""
		if metrics {
			groups = `{"name":"metrics.k8s.io","versions":[` + metricsGV + `],"preferredVersion":` + metricsGV + `}`
		}
		_, _ = w.Write([]byte(`{"kind":"APIGroupList","apiVersion":"v1","groups":[` + groups + `]}`))
	case "/apis/metrics.k8s.io/v1beta1":
		if !metrics {
			http.NotFound(w, r)
			return true
		}
		_, _ = w.Write([]byte(`{"kind":"APIResourceList","groupVersion":"metrics.k8s.io/v1beta1","resources":[{"name":"nodes","namespaced":false,"kind":"NodeMetrics","verbs":["get","list"]},{"name":"pods","namespaced":true,"kind":"PodMetrics","verbs":["get","list"]}]}`))
	default:
		return false
	}
	return true
}

// Without metrics-server the group is not served. Monitoring's reads say so as top-resources does, a 404 with "the
// server could not find the requested resource", where they answered an empty list the tabs asked again every 5 s. The
// cluster's discovery, which lists no metrics.k8s.io, says it for every caller: both reads, every namespace and a grant
// limited to namespaces ask the cluster no list, and discovery is read once.
func TestMonitoringMetricsOfAClusterWithoutTheMetricsAPISayNotServed(t *testing.T) {
	const notFound = "the server could not find the requested resource"
	var asked, discovery atomic.Int64
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDiscovery(w, r, false, &discovery) {
			return
		}
		if strings.HasPrefix(r.URL.Path, "/apis/metrics.k8s.io/") {
			asked.Add(1)
		}
		http.NotFound(w, r)
	}))
	defer api.Close()
	h := metricsHandler(t, api.URL)
	limited := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"c1": {"resource.objects.read"}}, Namespaces: map[string][]string{"c1": {"web", "shop"}}}
	reads := []struct {
		name    string
		path    string
		read    http.HandlerFunc
		payload *auth.TokenPayload
	}{
		{"nodes", "/api/v1/metrics/nodes", h.GetNodeMetrics, nil},
		{"nodes again", "/api/v1/metrics/nodes", h.GetNodeMetrics, nil},
		{"pods of every namespace", "/api/v1/metrics/pods?with_limits=1", h.GetPodMetrics, nil},
		{"pods of one namespace", "/api/v1/metrics/pods?namespace=web&with_limits=1", h.GetPodMetrics, nil},
		{"pods of a grant limited to namespaces", "/api/v1/metrics/pods?with_limits=1", h.GetPodMetrics, &limited},
	}
	for _, c := range reads {
		payload := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}
		if c.payload != nil {
			payload = *c.payload
		}
		sep := "?"
		if strings.Contains(c.path, "?") {
			sep = "&"
		}
		req := httptest.NewRequest(http.MethodGet, c.path+sep+"cluster=c1", nil)
		req = req.WithContext(auth.WithPayload(req.Context(), payload))
		rec := httptest.NewRecorder()
		h.ClusterMiddleware(c.read).ServeHTTP(rec, req)
		var body struct {
			Detail string `json:"detail"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != http.StatusNotFound || body.Detail != notFound {
			t.Fatalf("%s: %d %s, want 404 %q", c.name, rec.Code, rec.Body.String(), notFound)
		}
		if got, reads := asked.Load(), discovery.Load(); got != 0 || reads != 1 {
			t.Fatalf("%s: %d metrics.k8s.io lists asked and %d discovery reads in all, want none and one", c.name, got, reads)
		}
	}
	if h.svc.ClusterDown("c1") {
		t.Error("a cluster without metrics-server was taken down")
	}
}

// Where discovery could not be read (this stand-in answers 404 for the group list too) a grant limited to namespaces
// asks the cluster and gets the same answer from its 404s: the API not served, not namespaces the cluster does not have,
// which would read as no rows.
func TestMonitoringPodMetricsOfALimitedGrantWithoutTheMetricsAPISayNotServed(t *testing.T) {
	api := httptest.NewServer(http.NotFoundHandler())
	defer api.Close()
	h := metricsHandler(t, api.URL)
	payload := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"c1": {"resource.objects.read"}}, Namespaces: map[string][]string{"c1": {"web", "shop", "api"}}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics/pods?with_limits=1&cluster=c1", nil)
	req = req.WithContext(auth.WithPayload(req.Context(), payload))
	rec := httptest.NewRecorder()
	h.ClusterMiddleware(http.HandlerFunc(h.GetPodMetrics)).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "could not find the requested resource") {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
}
