package k8s

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// fakeStore answers the Prometheus API paths it is given and records each request.
type fakeStore struct {
	mu    sync.Mutex
	reqs  []*url.URL
	paths map[string]string // path → JSON data member ("" = 404)
	code  int               // non-zero: every request answers with this status
}

func (f *fakeStore) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.reqs = append(f.reqs, r.URL)
		f.mu.Unlock()
		if f.code != 0 {
			w.WriteHeader(f.code)
			_, _ = w.Write([]byte(`{"message":"Invalid API key"}`))
			return
		}
		data, ok := f.paths[r.URL.Path]
		if !ok || data == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":` + data + `}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (f *fakeStore) last(path string) url.Values {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.reqs) - 1; i >= 0; i-- {
		if f.reqs[i].Path == path {
			return f.reqs[i].Query()
		}
	}
	return nil
}

// storeService is a Service whose cluster reads the fake store, as a shared
// store with cluster label value labelValue ("" = a store of its own).
func storeService(t *testing.T, f *fakeStore, labelValue string) *Service {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "")
	t.Setenv("PROMETHEUS_CLUSTER_LABEL", "")
	s := &Service{promQ: newPromQueryCache(0)}
	s.defaultBundle.Store(&clientBundle{prom: &promCache{}, promExt: &promExternal{baseURL: f.server(t).URL, labelValue: labelValue}})
	return s
}

func TestPrometheusMetricNames_ScopedFilteredWithMetadata(t *testing.T) {
	f := &fakeStore{paths: map[string]string{
		"/api/v1/label/__name__/values": `["up","container_memory_working_set_bytes","container_cpu_usage_seconds_total","node_load1"]`,
		"/api/v1/metadata":              `{"container_cpu_usage_seconds_total":[{"type":"counter","help":"Cumulative cpu time","unit":""}]}`,
	}}
	s := storeService(t, f, "alpha")
	got, total, err := s.PrometheusMetricNames(context.Background(), "CONTAINER", 1)
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 || len(got) != 1 || got[0].Name != "container_cpu_usage_seconds_total" || got[0].Type != "counter" || got[0].Help == "" {
		t.Fatalf("names = %+v total %d", got, total)
	}
	q := f.last("/api/v1/label/__name__/values")
	if q.Get("match[]") != `{cluster="alpha"}` || q.Get("start") == "" || q.Get("end") == "" {
		t.Fatalf("a shared store is asked for this cluster's names in a window: %v", q)
	}
	// A store without metadata still gives the names.
	f.paths["/api/v1/metadata"] = ""
	got, _, err = s.PrometheusMetricNames(context.Background(), "node", 10)
	if err != nil || len(got) != 1 || got[0].Name != "node_load1" || got[0].Type != "" {
		t.Fatalf("no metadata = %+v %v", got, err)
	}
}

func TestPrometheusMetricNames_OwnStoreSendsNoMatch(t *testing.T) {
	f := &fakeStore{paths: map[string]string{"/api/v1/label/__name__/values": `["up"]`}}
	s := storeService(t, f, "")
	if _, _, err := s.PrometheusMetricNames(context.Background(), "", 10); err != nil {
		t.Fatal(err)
	}
	if q := f.last("/api/v1/label/__name__/values"); q.Has("match[]") {
		t.Fatalf("a store of the cluster's own needs no matcher: %v", q)
	}
}

func TestPrometheusLabels_SelectorScopedAndChecked(t *testing.T) {
	f := &fakeStore{paths: map[string]string{
		"/api/v1/labels":                 `["__name__","container","namespace","pod"]`,
		"/api/v1/label/namespace/values": `["kube-system","shop"]`,
	}}
	s := storeService(t, f, "alpha")
	names, err := s.PrometheusLabels(context.Background(), "", `container_cpu_usage_seconds_total{namespace="shop"}`, 0, 10)
	if err != nil || len(names) != 4 {
		t.Fatalf("names = %v %v", names, err)
	}
	match := f.last("/api/v1/labels").Get("match[]")
	if !strings.Contains(match, `cluster="alpha"`) || !strings.Contains(match, `namespace="shop"`) {
		t.Fatalf("the selector keeps its matchers and gets the cluster's: %s", match)
	}
	if f.last("/api/v1/labels").Get("limit") != "11" {
		t.Fatalf("one more than the limit is asked for, to see a cut: %v", f.last("/api/v1/labels"))
	}
	vals, err := s.PrometheusLabels(context.Background(), "namespace", "", 0, 10)
	if err != nil || strings.Join(vals, ",") != "kube-system,shop" {
		t.Fatalf("values = %v %v", vals, err)
	}
	if f.last("/api/v1/label/namespace/values").Get("match[]") != `{cluster="alpha"}` {
		t.Fatal("values on a shared store are this cluster's")
	}
	for _, bad := range []string{`sum(up)`, `rate(x[5m])`, `up{`, `up offset 5m + 1`} {
		if _, err := s.PrometheusLabels(context.Background(), "", bad, 0, 10); !errors.Is(err, ErrBadSelector) {
			t.Fatalf("%q must be refused as a selector: %v", bad, err)
		}
	}
}

func TestPrometheusRules_SharedStoreKeepsThisClusterAlerts(t *testing.T) {
	f := &fakeStore{paths: map[string]string{"/api/v1/rules": `{"groups":[{"name":"k8s","rules":[
		{"type":"alerting","name":"KubePodCrashLooping","query":"rate(x[5m]) > 0","duration":600,"labels":{"severity":"warning"},
		 "annotations":{"summary":"crash"},"state":"firing","health":"ok",
		 "alerts":[{"labels":{"cluster":"beta","pod":"b"},"state":"firing","activeAt":"2026-10-19T00:00:00Z","value":"1"},
		           {"labels":{"cluster":"alpha","pod":"a"},"state":"pending","activeAt":"2026-10-19T00:01:00Z","value":"1"}]},
		{"type":"alerting","name":"NodeDown","query":"up == 0","state":"firing","health":"ok",
		 "alerts":[{"labels":{"cluster":"beta"},"state":"firing"}]},
		{"type":"recording","name":"job:up:sum","query":"sum(up) by (job)","health":"ok"}]}]}`}}
	s := storeService(t, f, "alpha")
	rules, shared, err := s.PrometheusRules(context.Background(), "", "")
	if err != nil || !shared || len(rules) != 3 {
		t.Fatalf("rules = %+v shared %v %v", rules, shared, err)
	}
	crash := rules[0]
	if len(crash.Alerts) != 1 || crash.Alerts[0].Labels["pod"] != "a" || crash.State != "pending" || crash.ForSeconds != 600 {
		t.Fatalf("only this cluster's alert, state from it: %+v", crash)
	}
	if rules[1].State != "inactive" || len(rules[1].Alerts) != 0 {
		t.Fatalf("another cluster's firing alert does not make it firing here: %+v", rules[1])
	}
	if rules[2].Type != "recording" || rules[2].Query == "" {
		t.Fatalf("recording rule = %+v", rules[2])
	}
	rules, _, _ = s.PrometheusRules(context.Background(), "alert", "crash")
	if len(rules) != 1 || rules[0].Name != "KubePodCrashLooping" || f.last("/api/v1/rules").Get("type") != "alert" {
		t.Fatalf("name filter and type = %+v %v", rules, f.last("/api/v1/rules"))
	}
	f.paths["/api/v1/rules"] = ""
	if _, _, err := s.PrometheusRules(context.Background(), "", ""); !errors.Is(err, ErrPrometheusNotServed) {
		t.Fatalf("a store without rules (404) = not served: %v", err)
	}
}

func TestPrometheusTargets_APIOrUp(t *testing.T) {
	f := &fakeStore{paths: map[string]string{
		"/api/v1/targets": `{"activeTargets":[{"labels":{"job":"kubelet","instance":"n1:10250"},"scrapePool":"kubelet","health":"down","lastError":"connection refused","lastScrape":"2026-10-19T00:00:00Z"}],"droppedTargets":[]}`,
		"/api/v1/query":   `{"resultType":"vector","result":[{"metric":{"job":"node","instance":"10.0.0.1:9100","cluster":"alpha"},"value":[1,"1"]},{"metric":{"job":"ksm","instance":"k"},"value":[1,"0"]}]}`,
	}}
	own := storeService(t, f, "")
	targets, source, err := own.PrometheusTargets(context.Background())
	if err != nil || source != "targets_api" || len(targets) != 1 || targets[0].Health != "down" || targets[0].LastError == "" {
		t.Fatalf("own store = %+v %s %v", targets, source, err)
	}
	shared := storeService(t, f, "alpha")
	targets, source, err = shared.PrometheusTargets(context.Background())
	if err != nil || source != "up_metric" || len(targets) != 2 || targets[0].Health != "up" || targets[1].Health != "down" {
		t.Fatalf("shared store = %+v %s %v", targets, source, err)
	}
	if q := f.last("/api/v1/query").Get("query"); q != `up{cluster="alpha"}` {
		t.Fatalf("a shared store's targets come from this cluster's up: %s", q)
	}
	f.paths["/api/v1/targets"] = ""
	if _, source, err := own.PrometheusTargets(context.Background()); err != nil || source != "up_metric" {
		t.Fatalf("no targets API = up: %s %v", source, err)
	}
}

func TestPrometheusStoreErrorsAreUpstream(t *testing.T) {
	f := &fakeStore{code: http.StatusUnauthorized}
	s := storeService(t, f, "alpha")
	if _, _, err := s.PrometheusMetricNames(context.Background(), "", 10); !errors.Is(err, ErrPrometheusUpstream) || !strings.Contains(err.Error(), "401") {
		t.Fatalf("find call = %v", err)
	}
	if _, err := s.PrometheusQuery(context.Background(), "up"); !errors.Is(err, ErrPrometheusUpstream) || !strings.Contains(err.Error(), "status 401") {
		t.Fatalf("query = %v", err)
	}
}
