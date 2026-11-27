package logsearch

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMatchersAreWrittenWithTheirOperator(t *testing.T) {
	cases := map[Matcher]string{
		{Name: "a", Value: "b"}:                                  `a="b"`,
		{Name: "a", Value: "b", Not: true}:                       `a!="b"`,
		{Name: "a", Value: ".+", Regex: true}:                    `a=~".+"`,
		{Name: "a", Value: "x|y", Not: true, Regex: true}:        `a!~"x|y"`,
		{Name: "a", Value: `x", b=~".+`}:                         `a="x\", b=~\".+"`,
		{Name: "a", Value: `x\"}`, Regex: true}:                  `a=~"x\\\"}"`,
		{Name: "k8s_namespace_name", Value: "kube-system"}:       `k8s_namespace_name="kube-system"`,
		{Name: "k8s_namespace_name", Value: "", Not: true}:       `k8s_namespace_name!=""`,
		{Name: "k8s_namespace_name", Value: "apps", Regex: true}: `k8s_namespace_name=~"apps"`,
	}
	for m, want := range cases {
		if got := string(m.appendTo(nil)); got != want {
			t.Errorf("%+v: %s, want %s", m, got, want)
		}
	}
}

// What a query written by hand or by the AI is held to is the selector a structured search starts from, on every kind
// of store: the two are built from one list of matchers, and across namespaces that list asks for a namespace label.
func TestEveryReadStartsFromTheSelectorOfAStructuredSearch(t *testing.T) {
	withLabel := testConfig("http://loki:3100")
	noLabel := testConfig("http://loki:3100")
	noLabel.Labels.Cluster = ""
	stores := []struct {
		name  string
		cfg   Config
		value string
	}{
		{"a store with a cluster label", withLabel, "kubeast"},
		{"a cluster's own store with no label value", withLabel, ""},
		{"a store without a cluster label", noLabel, ""},
	}
	want := map[string]string{
		"a store with a cluster label  ":                                `{k8s_cluster_name="kubeast", k8s_namespace_name=~".+"}`,
		"a store with a cluster label  kubeast-node-shell":              `{k8s_cluster_name="kubeast", k8s_namespace_name=~".+", k8s_namespace_name!="kubeast-node-shell"}`,
		"a store with a cluster label apps ":                            `{k8s_cluster_name="kubeast", k8s_namespace_name="apps"}`,
		"a cluster's own store with no label value  ":                   `{k8s_namespace_name=~".+"}`,
		"a cluster's own store with no label value  kubeast-node-shell": `{k8s_namespace_name=~".+", k8s_namespace_name!="kubeast-node-shell"}`,
		"a cluster's own store with no label value apps ":               `{k8s_namespace_name="apps"}`,
		"a store without a cluster label  ":                             `{k8s_namespace_name=~".+"}`,
		"a store without a cluster label  kubeast-node-shell":           `{k8s_namespace_name=~".+", k8s_namespace_name!="kubeast-node-shell"}`,
		"a store without a cluster label apps ":                         `{k8s_namespace_name="apps"}`,
	}
	seen := 0
	for _, s := range stores {
		for _, ns := range []string{"", "apps"} {
			for _, hidden := range []string{"", "kubeast-node-shell"} {
				if ns != "" && hidden != "" {
					continue // a read of one namespace hides none
				}
				key := s.name + " " + ns + " " + hidden
				search := s.cfg.LogQL(Request{Namespace: ns, HiddenNamespace: hidden}, s.value)
				written, err := InjectMatchers("{}", s.cfg.scope(s.value, ns, hidden))
				if err != nil {
					t.Fatalf("%s: %v", key, err)
				}
				if search != want[key] || written != search {
					t.Errorf("%s:\n search  %s\n written %s\n want    %s", key, search, written, want[key])
				}
				seen++
			}
		}
	}
	if seen != len(want) {
		t.Fatalf("%d cases, %d expected selectors", seen, len(want))
	}
}

// A query across namespaces keeps the user's own selectors and ANDs a namespace label to each, on every path that
// sends one: the lines, a metric query, the patterns, the index estimate and the narrowing's pattern samples. A store
// with no cluster label value gets that matcher too, so a query is never sent as written.
func TestAQueryAcrossNamespacesAsksForANamespaceLabelOnEveryPath(t *testing.T) {
	var sent []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		sent = append(sent, r.URL.Path+" "+q)
		switch {
		case r.URL.Path == "/loki/api/v1/index/stats":
			_, _ = w.Write([]byte(`{"streams":1,"chunks":1,"entries":1,"bytes":10}`))
		case r.URL.Path == "/loki/api/v1/patterns":
			_, _ = w.Write([]byte(`{"status":"success","data":[]}`))
		case strings.HasPrefix(q, "{"):
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"streams","result":[]}}`))
		default:
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
		}
	}))
	defer srv.Close()
	s, err := New(testConfig(srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	s.OwnStore = func(_ context.Context, id string) *Store {
		if id == "own" {
			return &Store{URL: srv.URL} // holds this cluster alone: no label value
		}
		return nil
	}
	ctx := context.Background()
	end := time.Date(2026, 11, 26, 1, 0, 0, 0, time.UTC)
	scopes := map[string]string{
		"self": `k8s_cluster_name="kubeast", k8s_namespace_name=~".+"`,
		"own":  `k8s_namespace_name=~".+"`,
	}
	// selectors that name no namespace, and ones that name a namespace label themselves
	selectors := []string{`{job="systemd-journal"}`, `{job=~".*"}`, `{k8s_namespace_name=""}`, `{k8s_namespace_name=~".*"}`, `{k8s_namespace_name!~".+"}`}
	for cluster, scope := range scopes {
		for _, sel := range selectors {
			inner := sel[1 : len(sel)-1]
			want := "{" + scope + ", " + inner + "}"
			req := QueryRequest{Cluster: cluster, Query: sel + ` |= "x"`, Start: end.Add(-time.Hour), End: end, Limit: 10}
			res, err := s.Query(ctx, req)
			if err != nil || res.EffectiveQuery != want+` |= "x"` {
				t.Errorf("%s lines %s: %q %v", cluster, sel, res.EffectiveQuery, err)
			}
			metric := req
			metric.Query, metric.Metric, metric.Step = `sum(count_over_time(`+sel+`[5m])) / sum(count_over_time(`+sel+`[5m]))`, true, time.Minute
			res, err = s.Query(ctx, metric)
			if err != nil || strings.Count(res.EffectiveQuery, want) != 2 {
				t.Errorf("%s metric %s: %q %v", cluster, sel, res.EffectiveQuery, err)
			}
			patterns, err := s.Patterns(ctx, QueryRequest{Cluster: cluster, Query: sel, Start: req.Start, End: req.End})
			if err != nil || patterns.EffectiveQuery != want {
				t.Errorf("%s patterns %s: %q %v", cluster, sel, patterns.EffectiveQuery, err)
			}
			if _, effective, err := s.Estimate(ctx, QueryRequest{Cluster: cluster, Query: sel, Start: req.Start, End: req.End}); err != nil || effective != want {
				t.Errorf("%s estimate %s: %q %v", cluster, sel, effective, err)
			}
			if _, effective, err := s.PatternSamples(ctx, QueryRequest{Cluster: cluster, Query: sel, Start: req.Start, End: req.End}); err != nil || effective != want {
				t.Errorf("%s pattern samples %s: %q %v", cluster, sel, effective, err)
			}
		}
	}
	// every query the store was sent, the index's selectors too, carries the namespace label matcher
	if len(sent) != len(scopes)*len(selectors)*5 {
		t.Fatalf("%d reads of the store", len(sent))
	}
	for _, line := range sent {
		if !strings.Contains(line, `k8s_namespace_name=~".+"`) {
			t.Errorf("sent without a namespace label: %s", line)
		}
	}
}

// A read of one namespace sends what it always sent: the regex matcher is for reads across namespaces only.
func TestAQueryOfOneNamespaceSendsItsEqualityMatcherOnly(t *testing.T) {
	c := testConfig("http://loki:3100")
	got, err := InjectMatchers(`{job="web"} |= "x"`, c.scope("kubeast", "apps", ""))
	if err != nil || got != `{k8s_cluster_name="kubeast", k8s_namespace_name="apps", job="web"} |= "x"` {
		t.Fatalf("%q %v", got, err)
	}
}
