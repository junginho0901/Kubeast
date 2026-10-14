package logsearch

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

func testConfig(url string) Config {
	return Config{
		Enabled: true, Backend: "loki", URL: url,
		Labels:       Labels{Cluster: "k8s_cluster_name", Namespace: "k8s_namespace_name", Pod: "k8s_pod_name", Container: "k8s_container_name"},
		Clusters:     map[string]string{"self": "kubeast", "b": "kubeast-b"},
		DefaultRange: time.Hour, MaxRange: 24 * time.Hour, MaxLines: 1000, Timeout: 2 * time.Second, PerUserPerMinute: 3,
	}
}

func TestLoadConfigReadsTheEnvironment(t *testing.T) {
	t.Setenv("LOG_SEARCH_ENABLED", "true")
	t.Setenv("LOG_SEARCH_URL", "http://loki:3100/")
	t.Setenv("LOG_SEARCH_CLUSTERS", "self=kubeast, b = kubeast-b")
	t.Setenv("LOG_SEARCH_LABEL_POD", "pod")
	t.Setenv("LOG_SEARCH_MAX_RANGE", "6h")
	c := LoadConfig()
	if !c.Enabled || c.URL != "http://loki:3100" || c.Clusters["b"] != "kubeast-b" || c.Labels.Pod != "pod" ||
		c.Labels.Namespace != "k8s_namespace_name" || c.MaxRange != 6*time.Hour || c.DefaultRange != time.Hour {
		t.Fatalf("config %+v", c)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOG_SEARCH_LABEL_CLUSTER", "")
	if c := LoadConfig(); c.Labels.Cluster != "" {
		t.Fatalf("an explicitly empty cluster label is kept, got %q", c.Labels.Cluster)
	}
}

func TestValidateRefusesWhatCouldLeakOrNotSearch(t *testing.T) {
	cases := map[string]func(*Config){
		"backend":               func(c *Config) { c.Backend = "opensearch" },
		"url":                   func(c *Config) { c.URL = "loki:3100" },
		"no clusters":           func(c *Config) { c.Clusters = map[string]string{} },
		"cluster without value": func(c *Config) { c.Clusters["c"] = "" },
		"no cluster label, two": func(c *Config) { c.Labels.Cluster = "" },
		"label name":            func(c *Config) { c.Labels.Pod = "pod name" },
		"cluster label name":    func(c *Config) { c.Labels.Cluster = `x"}` },
		"default over max":      func(c *Config) { c.DefaultRange = 48 * time.Hour },
		"bad duration":          func(c *Config) { c.Timeout = -1 },
		"lines":                 func(c *Config) { c.MaxLines = 9000 },
		"rate":                  func(c *Config) { c.PerUserPerMinute = 0 },
	}
	for name, mutate := range cases {
		c := testConfig("http://loki:3100")
		mutate(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	one := testConfig("http://loki:3100")
	one.Labels.Cluster = ""
	one.Clusters = map[string]string{"self": ""}
	if err := one.Validate(); err != nil {
		t.Fatalf("one cluster per store without a label: %v", err)
	}
}

func TestNormalizeChecksNamesAndClampsTheRange(t *testing.T) {
	c := testConfig("http://loki:3100")
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)

	r := Request{Namespace: "apps", Limit: 99999, End: now.Add(time.Hour)}
	if err := c.Normalize(&r, now); err != nil {
		t.Fatal(err)
	}
	if !r.End.Equal(now) || !r.Start.Equal(now.Add(-time.Hour)) || r.Limit != 1000 {
		t.Fatalf("defaults: %+v", r)
	}
	bad := []Request{
		{Namespace: "Apps"},
		{Namespace: "apps", Pod: `web"}`},
		{Namespace: "apps", Container: "a/b"},
		{Namespace: "apps", WorkloadKind: "Pod", WorkloadName: "web"},
		{Namespace: "apps", WorkloadKind: "Deployment", WorkloadName: "web", Pod: "web-1"},
		{WorkloadKind: "Deployment", WorkloadName: "web"},
		{Namespace: "apps", Text: strings.Repeat("x", MaxTextLength+1)},
		{Namespace: "apps", Text: "(", Regex: true},
		{Namespace: "apps", Start: now.Add(-48 * time.Hour), End: now},
		{Namespace: "apps", Start: now, End: now.Add(-time.Minute)},
	}
	for i, b := range bad {
		if err := c.Normalize(&b, now); err == nil {
			t.Errorf("case %d accepted: %+v", i, b)
		}
	}
}

func TestLogQLQuotesEveryValueAndAlwaysScopes(t *testing.T) {
	c := testConfig("http://loki:3100")
	got := c.LogQL(Request{Namespace: "apps", Pod: "web-0", Container: "app", Text: `a"} |= "x`}, "kubeast")
	want := `{k8s_cluster_name="kubeast", k8s_namespace_name="apps", k8s_pod_name="web-0", k8s_container_name="app"} |= "a\"} |= \"x"`
	if got != want {
		t.Fatalf("\n got %s\nwant %s", got, want)
	}
	if got := c.LogQL(Request{}, "kubeast"); got != `{k8s_cluster_name="kubeast", k8s_namespace_name=~".+"}` {
		t.Fatalf("every namespace: %s", got)
	}
	if got := c.LogQL(Request{Namespace: "apps", Text: "a.b", IgnoreCase: true}, "kubeast"); !strings.HasSuffix(got, ` |~ "(?i)a\\.b"`) {
		t.Fatalf("ignore case quotes the text as a literal: %s", got)
	}
	if got := c.LogQL(Request{Namespace: "apps", Text: `err\d+`, Regex: true}, "kubeast"); !strings.HasSuffix(got, ` |~ "err\\d+"`) {
		t.Fatalf("regex: %s", got)
	}
	// Normalize already refuses such names; the query is still built from quoted literals only.
	hostile := `x", k8s_namespace_name=~".+`
	got = c.LogQL(Request{Namespace: hostile, Pod: hostile, Container: hostile}, hostile)
	if strings.Count(got, `=~".+"`) != 0 || strings.Count(got, `\"`) != 8 {
		t.Fatalf("a value broke out of its quotes: %s", got)
	}
	one := c
	one.Labels.Cluster = ""
	if got := one.LogQL(Request{Namespace: "apps"}, ""); got != `{k8s_namespace_name="apps"}` {
		t.Fatalf("store without a cluster label: %s", got)
	}
}

// The workload regex keeps to that workload's pods: a same-prefix workload does not match.
func TestWorkloadPodRegex(t *testing.T) {
	c := testConfig("http://loki:3100")
	cases := []struct {
		kind, name  string
		match, miss []string
	}{
		{"Deployment", "api", []string{"api-7d4b9c8f6-x2k9p", "api-5c9f-abcde"}, []string{"api-gateway-7d4b9c8f6-x2k9p", "api-0", "xapi-7d4b9c8f6-x2k9p"}},
		{"StatefulSet", "db", []string{"db-0", "db-12"}, []string{"db-a", "db-0-x"}},
		{"DaemonSet", "agent", []string{"agent-x2k9p"}, []string{"agent-x2k9", "agent-node-x2k9p"}},
		{"Job", "migrate", []string{"migrate-x2k9p", "migrate-3-x2k9p"}, []string{"migrate-x2k9pp"}},
		{"CronJob", "nightly", []string{"nightly-29340000-x2k9p", "nightly-29340000-1-x2k9p"}, []string{"nightly-x2k9p"}},
		{"Deployment", "a.b", []string{"a.b-7d4b9c8f6-x2k9p"}, []string{"axb-7d4b9c8f6-x2k9p"}},
	}
	for _, tc := range cases {
		q := c.LogQL(Request{Namespace: "apps", WorkloadKind: tc.kind, WorkloadName: tc.name}, "kubeast")
		m := regexp.MustCompile(`k8s_pod_name=~"((?:[^"\\]|\\.)*)"`).FindStringSubmatch(q)
		if m == nil {
			t.Fatalf("%s: no pod matcher in %s", tc.kind, q)
		}
		pattern := strings.ReplaceAll(m[1], `\\`, `\`)
		re := regexp.MustCompile("^(?:" + pattern + ")$") // stream selector regexes match the whole value
		for _, p := range tc.match {
			if !re.MatchString(p) {
				t.Errorf("%s %s: %s should match %s", tc.kind, tc.name, pattern, p)
			}
		}
		for _, p := range tc.miss {
			if re.MatchString(p) {
				t.Errorf("%s %s: %s should not match %s", tc.kind, tc.name, pattern, p)
			}
		}
	}
}

func TestSearchReadsLokiStreams(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"streams","result":[
		 {"stream":{"k8s_namespace_name":"apps","k8s_pod_name":"web-1","k8s_container_name":"app"},"values":[["1760443200000000002","b"],["1760443200000000000","a"]]},
		 {"stream":{"k8s_namespace_name":"apps","k8s_pod_name":"web-2","k8s_container_name":"app"},"values":[["1760443200000000001","c"]]}],
		 "stats":{"summary":{"totalBytesProcessed":4096}}}}`))
	}))
	defer srv.Close()
	c := testConfig(srv.URL)
	c.AuthHeader, c.Tenant = "Bearer t0k", "team-a"
	s, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	req := Request{Cluster: "b", Namespace: "apps", Limit: 3}
	if err := c.Normalize(&req, time.Now()); err != nil {
		t.Fatal(err)
	}
	res, err := s.Search(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got.URL.Path != "/loki/api/v1/query_range" || got.Header.Get("Authorization") != "Bearer t0k" || got.Header.Get("X-Scope-OrgID") != "team-a" {
		t.Fatalf("request %s %v", got.URL, got.Header)
	}
	q := got.URL.Query()
	if q.Get("query") != `{k8s_cluster_name="kubeast-b", k8s_namespace_name="apps"}` || q.Get("limit") != "3" || q.Get("direction") != "backward" {
		t.Fatalf("query %v", q)
	}
	if len(res.Lines) != 3 || res.Lines[0].Line != "b" || res.Lines[1].Line != "c" || res.Lines[2].Line != "a" || res.Lines[1].Pod != "web-2" {
		t.Fatalf("lines newest first across streams: %+v", res.Lines)
	}
	if !res.Truncated || res.Bytes != 4096 || res.Oldest.UnixNano() != 1760443200000000000 || res.Newest.UnixNano() != 1760443200000000002 {
		t.Fatalf("result %+v", res)
	}
}

func TestSearchCarriesServiceAndTraceID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Loki returns a line's structured metadata (OTLP trace_id) with the stream labels.
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"streams","result":[
		 {"stream":{"k8s_namespace_name":"apps","k8s_pod_name":"web-1","k8s_container_name":"app","service_name":"web","trace_id":"meta"},"values":[["1760443200000000002","served"]]},
		 {"stream":{"k8s_namespace_name":"apps","k8s_pod_name":"web-1","k8s_container_name":"app"},"values":[["1760443200000000001","text"]]}]}}`))
	}))
	defer srv.Close()
	c := testConfig(srv.URL)
	c.Labels.Service = "service_name"
	var seen []string
	c.TraceID = func(labels map[string]string, line string) string {
		seen = append(seen, labels["trace_id"]+"|"+line)
		return "id-of-" + line
	}
	s, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	req := Request{Cluster: "b", Namespace: "apps", Limit: 10}
	if err := c.Normalize(&req, time.Now()); err != nil {
		t.Fatal(err)
	}
	res, err := s.Search(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Lines) != 2 || res.Lines[0].Service != "web" || res.Lines[0].TraceID != "id-of-served" || res.Lines[1].Service != "" || res.Lines[1].TraceID != "id-of-text" {
		t.Fatalf("lines: %+v", res.Lines)
	}
	if len(seen) != 2 || seen[0] != "meta|served" || seen[1] != "|text" {
		t.Fatalf("TraceID got the stream labels and the line: %v", seen)
	}

	// without tracing, no trace ID is looked for
	c.TraceID = nil
	s, _ = New(c)
	res, _ = s.Search(context.Background(), req)
	if res.Lines[0].TraceID != "" {
		t.Fatalf("trace ID without tracing: %+v", res.Lines[0])
	}
}

func TestSearchErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Query().Get("query"), "slow") {
			time.Sleep(300 * time.Millisecond)
		}
		http.Error(w, "parse error at line 1", http.StatusBadRequest)
	}))
	defer srv.Close()
	c := testConfig(srv.URL)
	s, _ := New(c)
	req := Request{Cluster: "self", Namespace: "apps", Limit: 10, Start: time.Now().Add(-time.Minute), End: time.Now()}
	_, err := s.Search(context.Background(), req)
	var se *StoreError
	if !errors.As(err, &se) || se.Status != 400 || !strings.Contains(se.Body, "parse error") {
		t.Fatalf("store error: %v", err)
	}
	c.Timeout = 50 * time.Millisecond
	s, _ = New(c)
	req.Text = "slow"
	if _, err := s.Search(context.Background(), req); !errors.Is(err, ErrTimeout) {
		t.Fatalf("timeout: %v", err)
	}
}

func TestAllowIsPerUser(t *testing.T) {
	s, _ := New(testConfig("http://loki:3100"))
	for i := 0; i < 3; i++ {
		if !s.Allow("u1") {
			t.Fatalf("search %d refused", i+1)
		}
	}
	if s.Allow("u1") {
		t.Fatal("the 4th search in a minute was allowed")
	}
	if !s.Allow("u2") {
		t.Fatal("another user shares the budget")
	}
	if !s.Configured("b") || s.Configured("test2") || (*Searcher)(nil).Configured("self") {
		t.Fatal("Configured")
	}
}
