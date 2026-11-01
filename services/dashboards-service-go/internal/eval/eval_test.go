package eval

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

const casesDir = "../../../../evals/dashboards"

func loadCase(t *testing.T, id string) (Case, []byte) {
	t.Helper()
	cases, err := LoadCases(casesDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if c.ID == id {
			ref, err := os.ReadFile(filepath.Join(casesDir, id, "reference.json"))
			if err != nil {
				t.Fatal(err)
			}
			return c, ref
		}
	}
	t.Fatalf("no case %s", id)
	return Case{}, nil
}

// Every reference answer passes the checks that need no store (they also
// returned data on the dev cluster's Prometheus — see the README).
func TestReferencesPass(t *testing.T) {
	cases, err := LoadCases(casesDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) != 10 {
		t.Fatalf("%d cases, want 10", len(cases))
	}
	for _, c := range cases {
		ref, err := os.ReadFile(filepath.Join(casesDir, c.ID, "reference.json"))
		if err != nil {
			t.Fatal(err)
		}
		r := Grade(context.Background(), c, ref, nil)
		if !r.Pass {
			t.Errorf("%s: reference fails %+v", c.ID, r.Failed())
		}
	}
}

// edit changes the reference as a builder might get it wrong.
func edit(t *testing.T, ref []byte, fn func(d map[string]any)) []byte {
	t.Helper()
	var d map[string]any
	if err := json.Unmarshal(ref, &d); err != nil {
		t.Fatal(err)
	}
	fn(d)
	b, _ := json.Marshal(d)
	return b
}

func panels(d map[string]any) map[string]any {
	return d["spec"].(map[string]any)["panels"].(map[string]any)
}

func expr(d map[string]any, panel string) map[string]any {
	return panels(d)[panel].(map[string]any)["queries"].([]any)[0].(map[string]any)
}

func replaceExpr(old, new string) func(map[string]any) {
	return func(d map[string]any) {
		for _, p := range panels(d) {
			for _, q := range p.(map[string]any)["queries"].([]any) {
				qm := q.(map[string]any)
				qm["expr"] = strings.ReplaceAll(qm["expr"].(string), old, new)
			}
		}
	}
}

// Each wrong answer fails the check named for it.
func TestCatchesWrongAnswers(t *testing.T) {
	cases := []struct {
		name, caseID, failing string
		fn                    func(map[string]any)
	}{
		{"unknown field", "01_namespace_resources", "document", func(d map[string]any) { d["colour"] = "red" }},
		{"invalid layout", "01_namespace_resources", "document", func(d map[string]any) {
			d["spec"].(map[string]any)["layout"].(map[string]any)["items"].([]any)[0].(map[string]any)["w"] = 30
		}},
		{"wrong metric", "01_namespace_resources", "asked for: CPU 사용량", replaceExpr("container_cpu_usage_seconds_total", "container_cpu_user_seconds_total")},
		{"counter without rate", "09_network_by_namespace", "counters read as rates", replaceExpr("rate(container_network_receive_bytes_total[$__rate_interval])", "container_network_receive_bytes_total")},
		{"namespace dropped", "01_namespace_resources", "kept to namespace=kube-system", replaceExpr(`namespace="$namespace", `, "")},
		{"namespace as .*", "01_namespace_resources", "kept to namespace=kube-system", replaceExpr(`namespace="$namespace"`, `namespace=~".*"`)},
		{"cluster matcher", "07_pod_phase", "no cluster matcher (the server adds it)", replaceExpr("kube_pod_status_phase)", `kube_pod_status_phase{cluster="$cluster"})`)},
		{"PromQL broken", "03_pod_restarts", "PromQL parses", replaceExpr("increase(", "increase((")},
		{"panel without query", "04_deployment_replicas", "every panel has a query", func(d map[string]any) {
			panels(d)["missing"].(map[string]any)["queries"] = []any{}
		}},
		{"memory in the wrong unit", "01_namespace_resources", "asked for: 메모리 사용량", func(d map[string]any) {
			for _, k := range []string{"mem-total", "mem-by-pod"} {
				panels(d)[k].(map[string]any)["fieldDefaults"] = map[string]any{"unit": "short"}
			}
		}},
		{"too few panels", "02_node_overview", "panel count", func(d map[string]any) {
			for _, k := range []string{"mem-used", "disk-used", "net"} {
				delete(panels(d), k)
			}
			d["spec"].(map[string]any)["layout"].(map[string]any)["items"] = []any{map[string]any{"panel": "cpu-busy", "x": 0, "y": 0, "w": 12, "h": 8}}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cs, ref := loadCase(t, c.caseID)
			r := Grade(context.Background(), cs, edit(t, ref, c.fn), nil)
			if r.Pass {
				t.Fatal("passed")
			}
			found := false
			for _, f := range r.Failed() {
				found = found || f.Name == c.failing
			}
			if !found {
				t.Errorf("want %q among the failures, got %+v", c.failing, r.Failed())
			}
		})
	}
}

func TestQuantileWithoutLE(t *testing.T) {
	for in, want := range map[string]bool{
		`histogram_quantile(0.9, sum by (le) (rate(x_bucket[5m])))`:       false,
		`histogram_quantile(0.9, sum by (job) (rate(x_bucket[5m])))`:      true,
		`histogram_quantile(0.9, sum without (pod) (rate(x_bucket[5m])))`: false,
		`histogram_quantile(0.9, sum without (le) (rate(x_bucket[5m])))`:  true,
		`histogram_quantile(0.9, rate(x_bucket[5m]))`:                     false,
	} {
		f, err := analyse(in)
		if err != nil {
			t.Fatal(err)
		}
		if f.quantileNoLE != want {
			t.Errorf("%s: no le = %v, want %v", in, f.quantileNoLE, want)
		}
	}
}

func TestCountersNeedRates(t *testing.T) {
	for in, bare := range map[string]bool{
		`x_total`:                         true,
		`sum(x_total)`:                    true,
		`rate(x_total[5m])`:               false,
		`sum(increase(x_total[1h]))`:      false,
		`count(x_total)`:                  false,
		`sum(rate(x_bucket[5m])) by (le)`: false,
		`x_bytes`:                         false,
		`max_over_time(x_total[5m])`:      true,
	} {
		f, err := analyse(in)
		if err != nil {
			t.Fatal(err)
		}
		if got := len(f.bareCounters) > 0; got != bare {
			t.Errorf("%s: bare counter = %v, want %v", in, got, bare)
		}
	}
}

func TestSubstitute(t *testing.T) {
	vals := map[string]string{"namespace": "web", "__rate_interval": "5m"}
	for in, want := range map[string]string{
		`rate(x{namespace="$namespace"}[$__rate_interval])`: `rate(x{namespace="web"}[5m])`,
		`x{namespace=~"${namespace:regex}"}`:                `x{namespace=~"web"}`,
		`x{namespace="[[namespace]]"}`:                      `x{namespace="web"}`,
		`x{pod="$pod"}`:                                     `x{pod="$pod"}`,
	} {
		if got := substitute(in, vals); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
	d := &model.Dashboard{Spec: model.Spec{Variables: []model.Variable{
		{Name: "all", Current: json.RawMessage(`{"text": "All", "value": "$__all"}`)},
		{Name: "allv", AllValue: "web.*", Current: json.RawMessage(`{"value": ["$__all"]}`)},
		{Name: "multi", Current: json.RawMessage(`{"value": ["a", "b"]}`)},
		{Name: "opt", Options: []model.VariableOption{{Text: "x", Value: "x"}}},
	}}}
	v := values(Case{Vars: map[string]string{"multi": "case-wins"}}, d)
	for name, want := range map[string]string{"all": ".*", "allv": "web.*", "multi": "case-wins", "opt": "x", "__range": "1h"} {
		if v[name] != want {
			t.Errorf("%s = %q, want %q", name, v[name], want)
		}
	}
}

// fakeStore answers by query text.
type fakeStore struct {
	series map[string]int
	errs   map[string]error
	labels map[string]int
}

func (f fakeStore) Query(_ context.Context, expr string) (int, error) {
	if err, ok := f.errs[expr]; ok {
		return 0, err
	}
	return f.series[expr], nil
}

func (f fakeStore) LabelValues(_ context.Context, label, match string) (int, error) {
	return f.labels[label+"|"+match], nil
}

func TestLiveChecks(t *testing.T) {
	c, ref := loadCase(t, "07_pod_phase")
	store := fakeStore{
		series: map[string]int{`sum by (phase) (kube_pod_status_phase)`: 5},
		errs:   map[string]error{},
	}
	r := Grade(context.Background(), c, ref, store)
	var empty *Check
	for i, ch := range r.Checks {
		if ch.Name == "returns data: pending/A" {
			empty = &r.Checks[i]
		}
	}
	if r.Pass || empty == nil || empty.Pass || !strings.Contains(empty.Detail, `nothing has kube_pod_status_phase{phase="Pending"}`) {
		t.Fatalf("the empty Pending panel should fail and name the value no series has: %+v", r.Failed())
	}

	store.errs["sum by (phase) (kube_pod_status_phase)"] = errors.New("bad_data")
	r = Grade(context.Background(), c, ref, store)
	found := false
	for _, f := range r.Failed() {
		found = found || (f.Name == "returns data: by-phase/A" && strings.Contains(f.Detail, "query error"))
	}
	if !found {
		t.Errorf("a query error should fail its panel: %+v", r.Failed())
	}

	c1, ref1 := loadCase(t, "01_namespace_resources")
	r = Grade(context.Background(), c1, ref1, fakeStore{series: map[string]int{}, labels: map[string]int{}})
	found = false
	for _, f := range r.Failed() {
		found = found || (f.Name == "variable has values: namespace" && f.Detail == "no values")
	}
	if !found {
		t.Errorf("a variable without values should fail: %+v", r.Failed())
	}
}

func TestPrometheusClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/query" && r.URL.Query().Get("query") == "up":
			w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{},{}]}}`))
		case r.URL.Path == "/api/v1/query" && r.URL.Query().Get("query") == "1":
			w.Write([]byte(`{"status":"success","data":{"resultType":"scalar","result":[0,"1"]}}`))
		case r.URL.Path == "/api/v1/query":
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"status":"error","errorType":"bad_data","error":"parse error"}`))
		case r.URL.Path == "/api/v1/label/namespace/values" && r.URL.Query().Get("match[]") == "kube_pod_info":
			w.Write([]byte(`{"status":"success","data":["a","b","c"]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`404`))
		}
	}))
	defer srv.Close()
	p := Prometheus{Base: srv.URL}
	ctx := context.Background()
	if n, err := p.Query(ctx, "up"); err != nil || n != 2 {
		t.Errorf("up = %d, %v; want 2 series", n, err)
	}
	if n, err := p.Query(ctx, "1"); err != nil || n != 1 {
		t.Errorf("scalar = %d, %v; want 1", n, err)
	}
	if _, err := p.Query(ctx, "up{"); err == nil || !strings.Contains(err.Error(), "parse error") {
		t.Errorf("error = %v, want the store's message", err)
	}
	if n, err := p.LabelValues(ctx, "namespace", "kube_pod_info"); err != nil || n != 3 {
		t.Errorf("label values = %d, %v; want 3", n, err)
	}
	if _, err := p.LabelValues(ctx, "nope", ""); err == nil {
		t.Error("a 404 that is not a Prometheus answer should be an error")
	}
}

func TestLoadCasesRefusesUnknownFields(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "01_x"), 0o755)
	os.WriteFile(filepath.Join(dir, "01_x", "case.json"), []byte(`{"question": "q", "expect": [{"what": "w", "metrics": ["m"]}], "colour": 1}`), 0o644)
	if _, err := LoadCases(dir); err == nil {
		t.Error("an unknown field in a case should be refused")
	}
}
