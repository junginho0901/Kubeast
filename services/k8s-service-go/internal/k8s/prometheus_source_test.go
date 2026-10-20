package k8s

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func TestInjectMatcher(t *testing.T) {
	cases := map[string]string{
		`up`: `up{cluster="alpha"}`,
		`sum(rate(container_cpu_usage_seconds_total{namespace="x"}[5m])) by (pod)`: `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="x",cluster="alpha"}[5m]))`,
		`up{cluster="other"}`:               `up{cluster="alpha"}`,
		`a / b`:                             `a{cluster="alpha"} / b{cluster="alpha"}`,
		`max_over_time(rate(x[1m])[1h:1m])`: `max_over_time(rate(x{cluster="alpha"}[1m])[1h:1m])`,
		`kube_pod_info{job=~"kube.*"} * on(pod) group_left() up`: `kube_pod_info{job=~"kube.*",cluster="alpha"} * on (pod) group_left () up{cluster="alpha"}`,
	}
	// The printer orders matchers by name, so compare printed forms of both sides.
	norm := func(q string) string {
		e, err := promParser.ParseExpr(q)
		if err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return e.String()
	}
	for in, want := range cases {
		got, err := injectMatcher(in, "cluster", "alpha")
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if got != norm(want) {
			t.Errorf("%s\n got  %s\n want %s", in, got, norm(want))
		}
	}
	if got, err := injectMatcher(`sum(`, "cluster", "alpha"); !errors.Is(err, ErrBadQuery) || got != `sum(` {
		t.Fatalf("invalid query must come back unchanged with an error: %q %v", got, err)
	}
	// MetricsQL-only syntax cannot be scoped (VictoriaMetrics would run it unscoped): refused as a bad query
	for _, q := range []string{`rate(http_requests_total)`, `WITH (x = up) x`, `sum(rate(x[5m])) keep_metric_names`} {
		if _, err := injectMatcher(q, "cluster", "alpha"); !errors.Is(err, ErrBadQuery) {
			t.Errorf("%s: %v", q, err)
		}
	}
}

func TestExternalFromInfo(t *testing.T) {
	t.Setenv("PROMETHEUS_URL", "")
	t.Setenv("PROMETHEUS_AUTH_HEADER", "")
	if externalFromInfo(cluster.Info{}) != nil {
		t.Fatal("no URL anywhere must mean no external source")
	}
	own := externalFromInfo(cluster.Info{PrometheusURL: "https://m.example.com/prom/", PrometheusAuthHeader: "Bearer t", PrometheusClusterLabel: "alpha"})
	if own == nil || own.baseURL != "https://m.example.com/prom" || own.authHeader != "Bearer t" || own.labelValue != "alpha" {
		t.Fatalf("own source = %+v", own)
	}
	t.Setenv("PROMETHEUS_URL", "http://central:9090/")
	t.Setenv("PROMETHEUS_AUTH_HEADER", "Basic abc")
	global := externalFromInfo(cluster.Info{PrometheusClusterLabel: "beta"})
	if global == nil || global.baseURL != "http://central:9090" || global.authHeader != "Basic abc" || global.labelValue != "beta" {
		t.Fatalf("global source = %+v", global)
	}
	// A cluster with its own URL keeps its own (possibly empty) auth, not the global one.
	own2 := externalFromInfo(cluster.Info{PrometheusURL: "http://mine:9090"})
	if own2.authHeader != "" {
		t.Fatalf("own URL must not borrow the global header: %+v", own2)
	}
	src := &promSource{ext: global}
	if q, _ := src.scoped("up"); q != `up{cluster="beta"}` {
		t.Fatalf("scoped = %s", q)
	}
	if q, _ := (&promSource{ext: &promExternal{baseURL: "x"}}).scoped("up"); q != "up" {
		t.Fatalf("no label value must leave the query alone: %s", q)
	}
	if q, _ := (&promSource{proxy: &promServiceInfo{}}).scoped("up"); q != "up" {
		t.Fatalf("proxy source must leave the query alone: %s", q)
	}
	t.Setenv("PROMETHEUS_CLUSTER_LABEL", "k8s_cluster")
	if q, _ := src.scoped("up"); q != `up{k8s_cluster="beta"}` {
		t.Fatalf("label name from env: %s", q)
	}
	t.Setenv("PROMETHEUS_DISCOVER", "false")
	if PrometheusDiscoverEnabled() {
		t.Fatal("discover off")
	}
}

func TestPromExternalHealthAndQuery(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if gotAuth != "Bearer ok" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte("Unauthorized"))
			return
		}
		switch r.URL.Path {
		case "/-/healthy":
			w.WriteHeader(http.StatusNotFound) // a store without the endpoint
		case "/api/v1/query":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"cluster":"alpha"},"value":[1,"2"]}]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	ctx := context.Background()
	bad := &promExternal{baseURL: srv.URL, authHeader: "Bearer no"}
	if ok, msg := bad.healthy(ctx); ok || !strings.Contains(msg, "401") {
		t.Fatalf("bad auth = %v %q", ok, msg)
	}
	good := &promExternal{baseURL: srv.URL, authHeader: "Bearer ok"}
	if ok, msg := good.healthy(ctx); !ok {
		t.Fatalf("404 on /-/healthy must fall back to a query: %q", msg)
	}
	s := &Service{}
	res, err := s.prometheusExternal(ctx, good, "/api/v1/query?query=up")
	if err != nil || len(res) != 1 || res[0]["metric"].(map[string]interface{})["cluster"] != "alpha" {
		t.Fatalf("query = %+v %v", res, err)
	}
	if _, err := s.prometheusExternal(ctx, bad, "/api/v1/query?query=up"); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("bad auth query must fail with the status: %v", err)
	}
}

// The most specific setting wins: the cluster's URL, the cluster's Service, the
// deployment-wide URL, the deployment-wide Service; a malformed one is ignored.
func TestPromSourceFromInfoOrder(t *testing.T) {
	t.Setenv("PROMETHEUS_URL", "")
	t.Setenv("PROMETHEUS_AUTH_HEADER", "")
	t.Setenv("PROMETHEUS_SERVICE", "")
	if ext, svc := promSourceFromInfo(cluster.Info{}); ext != nil || svc != nil {
		t.Fatal("nothing set must mean discover")
	}
	t.Setenv("PROMETHEUS_SERVICE", "monitoring/global-prom:9090")
	if _, svc := promSourceFromInfo(cluster.Info{}); svc == nil || svc.Name != "global-prom" {
		t.Fatalf("deployment-wide Service: %+v", svc)
	}
	t.Setenv("PROMETHEUS_URL", "http://central:9090")
	if ext, svc := promSourceFromInfo(cluster.Info{}); ext == nil || svc != nil {
		t.Fatalf("deployment-wide URL beats the deployment-wide Service: %+v %+v", ext, svc)
	}
	ext, svc := promSourceFromInfo(cluster.Info{PrometheusService: "o11y/prometheus-server:80"})
	if ext != nil || svc == nil || *svc != (promServiceInfo{Namespace: "o11y", Name: "prometheus-server", Port: 80}) {
		t.Fatalf("the cluster's Service beats the deployment-wide URL: %+v %+v", ext, svc)
	}
	ext, svc = promSourceFromInfo(cluster.Info{PrometheusURL: "http://mine:9090", PrometheusService: "o11y/prometheus-server:80"})
	if ext == nil || ext.baseURL != "http://mine:9090" || svc != nil {
		t.Fatalf("the cluster's URL beats its Service: %+v %+v", ext, svc)
	}
	t.Setenv("PROMETHEUS_URL", "")
	if _, svc := promSourceFromInfo(cluster.Info{PrometheusService: "not a ref"}); svc == nil || svc.Name != "global-prom" {
		t.Fatalf("a malformed cluster Service is ignored: %+v", svc)
	}
}
