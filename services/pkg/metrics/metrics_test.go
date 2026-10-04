package metrics

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

func scrape(t *testing.T, m *Metrics) string {
	t.Helper()
	w := httptest.NewRecorder()
	m.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("/metrics = %d", w.Code)
	}
	return w.Body.String()
}

func TestMiddleware_ChiRoutePatternAndStatus(t *testing.T) {
	m := New("test")
	m.Route = ChiRoute
	r := chi.NewRouter()
	r.Use(m.Middleware)
	r.Get("/api/v1/pods/{name}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Get("/metrics", m.Handler().ServeHTTP)

	for _, p := range []string{"/api/v1/pods/a", "/api/v1/pods/b", "/health", "/nope", "/metrics"} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, p, nil))
	}
	body := scrape(t, m)
	for _, want := range []string{
		`kubeast_http_requests_total{code="418",method="get",route="/api/v1/pods/{name}",service="test"} 2`,
		`kubeast_http_requests_total{code="404",method="get",route="unmatched",service="test"} 1`,
		`kubeast_http_request_duration_seconds_count{code="418",method="get",route="/api/v1/pods/{name}",service="test"} 2`,
		`kubeast_http_requests_in_flight{service="test"} 0`,
		"go_goroutines", "process_cpu_seconds_total",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("scrape lacks %q:\n%s", want, body)
		}
	}
	for _, never := range []string{`route="/health"`, `route="/metrics"`, `route="/api/v1/pods/a"`} {
		if strings.Contains(body, never) {
			t.Fatalf("scrape must not contain %q", never)
		}
	}
}

func TestMiddleware_FixedPathsAndStreaming(t *testing.T) {
	m := New("tool-server")
	mux := http.NewServeMux()
	mux.HandleFunc("/tools/call", func(w http.ResponseWriter, _ *http.Request) {
		// A streaming handler flushes through the instrumented writer.
		if f, ok := w.(http.Flusher); !ok {
			w.WriteHeader(http.StatusInternalServerError)
		} else {
			_, _ = io.WriteString(w, "a")
			f.Flush()
		}
	})
	h := m.Middleware(mux)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/tools/call", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("flush through the wrapper: %d", w.Code)
	}
	body := scrape(t, m)
	if !strings.Contains(body, `kubeast_http_requests_total{code="200",method="post",route="/tools/call",service="tool-server"} 1`) {
		t.Fatalf("fixed path route label missing:\n%s", body)
	}
}

type fakeStatuser struct {
	ready    bool
	failures int64
}

func (f fakeStatuser) Status(context.Context) audit.Status {
	return audit.Status{Ready: f.ready, WriteFailures: f.failures}
}

func TestAuditStoreAndGauge(t *testing.T) {
	m := New("k8s")
	m.AuditStore(fakeStatuser{ready: false, failures: 3})
	m.Gauge("kubeast_ws_subscriptions", "x", func() float64 { return 7 })
	body := scrape(t, m)
	for _, want := range []string{
		`kubeast_audit_store_up{service="k8s"} 0`,
		`kubeast_audit_write_failures_total{service="k8s"} 3`,
		`kubeast_ws_subscriptions{service="k8s"} 7`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("scrape lacks %q:\n%s", want, body)
		}
	}
}

func TestHandler_DisabledIs404(t *testing.T) {
	t.Setenv("METRICS_ENABLED", "false")
	w := httptest.NewRecorder()
	New("x").Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("disabled /metrics = %d, want 404", w.Code)
	}
	t.Setenv("METRICS_ENABLED", "")
	if !Enabled() {
		t.Fatal("unset METRICS_ENABLED must mean enabled")
	}
	_ = time.Second
}
