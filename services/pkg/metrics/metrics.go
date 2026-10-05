// Package metrics gives each service a Prometheus registry served at /metrics:
// the Go runtime and process collectors, HTTP request count / duration /
// in-flight by route pattern, and hooks for the audit store and other gauges.
//
// The route label is the router's pattern (chi: "/api/v1/pods/{name}"), read
// after the handler ran, never the raw path — so cardinality stays bounded
// (Prometheus instrumentation guidance: keep label sets small, no ids in
// labels). /metrics, /health and / are not counted.
//
// The endpoint is meant for an in-cluster scraper on the service port; the
// gateway does not proxy it. METRICS_ENABLED=false turns it into a 404.
package metrics

import (
	"context"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// Enabled reads METRICS_ENABLED (default true).
func Enabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("METRICS_ENABLED")))
	return v != "false" && v != "0" && v != "off"
}

// Metrics is one service's registry and HTTP instruments.
type Metrics struct {
	Service  string
	Registry *prometheus.Registry
	// Route names the handled route for the HTTP metrics. It runs after the
	// handler so routers that resolve patterns while routing (chi) report the
	// pattern. nil = the request path, for servers with a few fixed paths.
	Route func(ctx context.Context) string

	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
	inFlight prometheus.Gauge
}

type pathKey struct{}

// New builds a registry with the Go/process collectors and the HTTP instruments.
func New(service string) *Metrics {
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	svc := prometheus.Labels{"service": service}
	m := &Metrics{
		Service:  service,
		Registry: reg,
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "kubeast_http_requests_total", Help: "HTTP requests handled, by route pattern and status code.", ConstLabels: svc,
		}, []string{"code", "method", "route"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "kubeast_http_request_duration_seconds", Help: "HTTP request duration in seconds, by route pattern and status code.",
			ConstLabels: svc, Buckets: prometheus.DefBuckets,
		}, []string{"code", "method", "route"}),
		inFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "kubeast_http_requests_in_flight", Help: "HTTP requests currently being handled.", ConstLabels: svc,
		}),
	}
	reg.MustRegister(m.requests, m.duration, m.inFlight)
	return m
}

// ChiRoute is the Route function for chi routers: the matched pattern, or
// "unmatched" for a 404.
func ChiRoute(ctx context.Context) string {
	if rc := chi.RouteContext(ctx); rc != nil {
		if p := rc.RoutePattern(); p != "" {
			return p
		}
	}
	return "unmatched"
}

func (m *Metrics) route(ctx context.Context) string {
	if m.Route != nil {
		return m.Route(ctx)
	}
	if p, ok := ctx.Value(pathKey{}).(string); ok && p != "" {
		return p
	}
	return "unmatched"
}

func skip(path string) bool {
	return path == "/metrics" || path == "/health" || path == "/"
}

// Middleware counts and times every request except the probes. The promhttp
// instrumentation wraps the ResponseWriter so streaming (Flusher) and
// WebSocket upgrades (Hijacker) keep working.
func (m *Metrics) Middleware(next http.Handler) http.Handler {
	opt := promhttp.WithLabelFromCtx("route", m.route)
	instrumented := promhttp.InstrumentHandlerInFlight(m.inFlight,
		promhttp.InstrumentHandlerDuration(m.duration,
			promhttp.InstrumentHandlerCounter(m.requests, next, opt), opt))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if skip(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if m.Route == nil {
			r = r.WithContext(context.WithValue(r.Context(), pathKey{}, r.URL.Path))
		}
		instrumented.ServeHTTP(w, r)
	})
}

// Handler serves the registry in the Prometheus text format, or 404 when
// metrics are disabled.
func (m *Metrics) Handler() http.Handler {
	if !Enabled() {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	}
	return promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{})
}

// Gauge registers a gauge whose value is read at scrape time.
func (m *Metrics) Gauge(name, help string, fn func() float64) {
	m.Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: name, Help: help, ConstLabels: prometheus.Labels{"service": m.Service},
	}, fn))
}

// AuditStore exposes the audit store: kubeast_audit_store_up (its Ready check,
// cached by the store) and kubeast_audit_write_failures_total.
func (m *Metrics) AuditStore(s audit.Statuser) {
	svc := prometheus.Labels{"service": m.Service}
	m.Registry.MustRegister(
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "kubeast_audit_store_up", Help: "1 when the audit store accepts rows (actions that need an audit row are refused otherwise).", ConstLabels: svc,
		}, func() float64 {
			if s.Status(context.Background()).Ready {
				return 1
			}
			return 0
		}),
		prometheus.NewCounterFunc(prometheus.CounterOpts{
			Name: "kubeast_audit_write_failures_total", Help: "Audit rows that could not be stored since start-up.", ConstLabels: svc,
		}, func() float64 { return float64(s.Status(context.Background()).WriteFailures) }),
	)
}
