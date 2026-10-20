package k8s

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// VictoriaMetrics behind a cluster API server, answering as v1.154.0 does (scripts/kind-victoriametrics.sh,
// kubeast/raw/20261020/victoriametrics/vm-probes.txt): /-/healthy "VictoriaMetrics is Healthy." (also under
// vmselect's /select/0/prometheus), rules and alerts as empty placeholders, vmselect's targets 400
// "unsupported path requested", the single node's targets from its own scraping.
type vmServer struct {
	// prometheus: a Prometheus as well, found by name in monitoring (it must still win)
	prometheus bool
	// single: "labelled" (operator Service vmsingle-main in ns vm), "chart" (chart-labelled Service in ns metrics),
	// "named" (chart Service in monitoring), ""
	single string
	// scraping: the single node scrapes itself (targets listed) — else it is fed by remote write (none)
	scraping bool
}

func newVMServer(t *testing.T, v vmServer) *kubernetes.Clientset {
	t.Helper()
	healthy := func(w http.ResponseWriter, text string) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte(text))
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		p, sel := r.URL.Path, r.URL.Query().Get("labelSelector")
		switch {
		case p == "/api/v1/services" && sel == "app.kubernetes.io/name=vmsingle" && v.single == "labelled":
			_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"vmsingle-main","namespace":"vm"},"spec":{"ports":[{"name":"http","port":8428}]}}]}`))
		case p == "/api/v1/services" && sel == "app.kubernetes.io/name=victoria-metrics-single" && v.single == "chart":
			_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"vm-server","namespace":"metrics"},"spec":{"ports":[{"name":"http","port":8428}]}}]}`))
		case p == "/api/v1/namespaces/monitoring/services":
			items := []string{}
			if v.prometheus {
				items = append(items, `{"metadata":{"name":"prometheus","namespace":"monitoring"},"spec":{"ports":[{"port":9090}]}}`)
			}
			if v.single == "named" {
				items = append(items, `{"metadata":{"name":"vm-victoria-metrics-single-server","namespace":"monitoring"},"spec":{"ports":[{"port":8428}]}}`)
			}
			items = append(items, `{"metadata":{"name":"vmselect-main","namespace":"monitoring"},"spec":{"ports":[{"port":8481}]}}`,
				`{"metadata":{"name":"vm-victoria-metrics-operator","namespace":"monitoring"},"spec":{"ports":[{"port":8080}]}}`)
			_, _ = w.Write([]byte(`{"items":[` + strings.Join(items, ",") + `]}`))
		case strings.HasSuffix(p, "/services"):
			_, _ = w.Write([]byte(`{"items":[]}`))
		case p == "/api/v1/namespaces/monitoring/services/vmselect-main":
			_, _ = w.Write([]byte(`{"metadata":{"name":"vmselect-main","namespace":"monitoring"},"spec":{"ports":[{"port":8481}]}}`))
		case strings.Contains(p, "/services/vmselect-main:8481/proxy/") && !strings.Contains(p, "/proxy/select/0/prometheus/"):
			// vmselect serves the Prometheus API only under its tenant path
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`unsupported path requested: "` + strings.SplitN(p, "/proxy", 2)[1] + `"`))
		case p == "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/-/healthy" && v.prometheus:
			healthy(w, "Prometheus Server is Healthy.\n")
		case strings.HasSuffix(p, "/proxy/-/healthy") || strings.HasSuffix(p, "/proxy/select/0/prometheus/-/healthy"):
			healthy(w, "VictoriaMetrics is Healthy.\n")
		case strings.HasSuffix(p, "/proxy/select/0/prometheus/api/v1/targets"):
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`unsupported path requested: "/select/0/prometheus/api/v1/targets"`))
		case strings.HasSuffix(p, "/api/v1/targets") && v.scraping:
			_, _ = w.Write([]byte(`{"status":"success","data":{"activeTargets":[{"labels":{"job":"node-exporter","instance":"10.0.0.1:9100"},"scrapePool":"node-exporter","health":"up"}]}}`))
		case strings.HasSuffix(p, "/api/v1/targets"):
			_, _ = w.Write([]byte(`{"status":"success","data":{"activeTargets":[]}}`))
		case strings.HasSuffix(p, "/api/v1/rules"):
			_, _ = w.Write([]byte(`{"status":"success","data":{"groups":[]}}`))
		case strings.HasSuffix(p, "/api/v1/query"):
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"job":"kubelet","instance":"n1"},"value":[1,"1"]}]},"stats":{"seriesFetched":"1"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		}
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	return cs
}

func TestDiscoveryFindsASingleNodeVictoriaMetricsOnlyWithoutPrometheus(t *testing.T) {
	for name, c := range map[string]struct {
		v      vmServer
		want   string
		flavor string
	}{
		"operator labels":  {vmServer{single: "labelled"}, "vm/vmsingle-main:8428 (via K8s API proxy)", "victoriametrics"},
		"chart labels":     {vmServer{single: "chart"}, "metrics/vm-server:8428 (via K8s API proxy)", "victoriametrics"},
		"chart name":       {vmServer{single: "named"}, "monitoring/vm-victoria-metrics-single-server:8428 (via K8s API proxy)", "victoriametrics"},
		"Prometheus first": {vmServer{single: "labelled", prometheus: true}, "monitoring/prometheus:9090 (via K8s API proxy)", "prometheus"},
	} {
		promDiscoveryEnv(t)
		s := newPromService(newVMServer(t, c.v), nil)
		st := s.PrometheusStatus(context.Background())
		if st["available"] != true || st["endpoint"] != c.want || st["flavor"] != c.flavor {
			t.Errorf("%s: %v", name, st)
		}
	}
	// a vmselect needs its tenant path: never found by itself (nor the operator's own Service, port 8080)
	promDiscoveryEnv(t)
	s := newPromService(newVMServer(t, vmServer{}), nil)
	if st := s.PrometheusStatus(context.Background()); st["available"] != false {
		t.Errorf("vmselect alone: %v", st)
	}
}

func TestAVictoriaMetricsClusterNamedWithItsPath(t *testing.T) {
	promDiscoveryEnv(t)
	s := newPromService(newVMServer(t, vmServer{}), nil)
	s.defaultBundle.Load().promSvc = parsePromService("monitoring/vmselect-main:8481/select/0/prometheus", "test")
	ctx := context.Background()
	st := s.PrometheusStatus(ctx)
	if st["available"] != true || st["endpoint"] != "monitoring/vmselect-main:8481/select/0/prometheus (via K8s API proxy)" || st["flavor"] != "victoriametrics" {
		t.Fatalf("status %v", st)
	}
	// vmselect has no targets API (400 unsupported path): the `up` series instead
	targets, source, err := s.PrometheusTargets(ctx)
	if err != nil || source != "up_metric" || len(targets) != 1 || targets[0].Job != "kubelet" || targets[0].Health != "up" {
		t.Fatalf("targets %v %q %v", targets, source, err)
	}
	// rules: an empty placeholder without -vmalert.proxyURL is not "no rules"
	if _, _, err := s.PrometheusRules(ctx, "", ""); !errors.Is(err, ErrPrometheusNotServed) || !strings.Contains(err.Error(), "vmalert") {
		t.Fatalf("rules %v", err)
	}
}

func TestTargetsAndRulesOfASingleNode(t *testing.T) {
	ctx := context.Background()
	promDiscoveryEnv(t)
	s := newPromService(newVMServer(t, vmServer{single: "labelled", scraping: true}), nil)
	if targets, source, err := s.PrometheusTargets(ctx); err != nil || source != "targets_api" || targets[0].Job != "node-exporter" {
		t.Fatalf("scraping: %v %q %v", targets, source, err)
	}
	promDiscoveryEnv(t)
	s = newPromService(newVMServer(t, vmServer{single: "labelled"}), nil)
	if _, source, err := s.PrometheusTargets(ctx); err != nil || source != "up_metric" {
		t.Fatalf("fed by remote write (empty targets): %q %v", source, err)
	}
	// a Prometheus with no rules says so: empty is a fact there
	promDiscoveryEnv(t)
	s = newPromService(newVMServer(t, vmServer{prometheus: true}), nil)
	if rules, _, err := s.PrometheusRules(ctx, "", ""); err != nil || len(rules) != 0 {
		t.Fatalf("prometheus rules %v %v", rules, err)
	}
}

func TestAnExternalVictoriaMetricsUnderItsPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/select/0/prometheus/-/healthy":
			_, _ = w.Write([]byte("VictoriaMetrics is Healthy.\n"))
		case "/select/0/prometheus/api/v1/targets":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`unsupported path requested: "/select/0/prometheus/api/v1/targets"`))
		case "/select/0/prometheus/api/v1/rules":
			_, _ = w.Write([]byte(`{"status":"success","data":{"groups":[]}}`))
		case "/select/0/prometheus/api/v1/query":
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"job":"kubelet"},"value":[1,"0"]}]}}`))
		case "/select/0/prometheus/api/v1/labels":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"status":"error","errorType":"bad_data","error":"cannot parse match[]"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	promDiscoveryEnv(t)
	s := newPromService(newVMServer(t, vmServer{}), nil)
	s.defaultBundle.Load().promExt = &promExternal{baseURL: srv.URL + "/select/0/prometheus"}
	ctx := context.Background()
	if st := s.PrometheusStatus(ctx); st["available"] != true || st["flavor"] != "victoriametrics" {
		t.Fatalf("status %v", st)
	}
	if _, _, err := s.PrometheusRules(ctx, "", ""); !errors.Is(err, ErrPrometheusNotServed) {
		t.Fatalf("rules %v", err)
	}
	if targets, source, err := s.PrometheusTargets(ctx); err != nil || source != "up_metric" || targets[0].Health != "down" {
		t.Fatalf("targets %v %q %v", targets, source, err)
	}
	// a 400 about the request itself stays an error, not "not served"
	if _, err := s.promGetData(ctx, s.getPromSource(ctx), "/api/v1/labels?match[]=x"); errors.Is(err, ErrPrometheusNotServed) || !errors.Is(err, ErrPrometheusUpstream) {
		t.Fatalf("bad request %v", err)
	}
}

func TestUnsupportedPathThroughTheProxy(t *testing.T) {
	text := `unsupported path requested: "/select/0/prometheus/api/v1/targets"`
	for name, c := range map[string]struct {
		err  error
		want bool
	}{
		"vmselect 400":            {apierrors.NewGenericServerResponse(400, "GET", schema.GroupResource{}, "", text, 0, true), true},
		"wrapped":                 {fmt.Errorf("x: %w", apierrors.NewGenericServerResponse(400, "GET", schema.GroupResource{}, "", text, 0, true)), true},
		"other 400":               {apierrors.NewGenericServerResponse(400, "GET", schema.GroupResource{}, "", "cannot parse query", 0, true), false},
		"same text, not 400":      {apierrors.NewGenericServerResponse(502, "GET", schema.GroupResource{}, "", text, 0, true), false},
		"no endpoints, no detail": {apierrors.NewServiceUnavailable("no endpoints available for service"), false},
		"not an API error":        {errors.New(text), false},
	} {
		if got := unsupportedPathError(c.err); got != c.want {
			t.Errorf("%s: %v", name, got)
		}
	}
}
