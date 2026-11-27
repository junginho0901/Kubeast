package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// fakeK8sService stands in for k8s-service: it records the request and answers as scripted.
func fakeK8sService(t *testing.T, respond func(r *http.Request) (int, string)) *[]*http.Request {
	t.Helper()
	var seen []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r)
		status, body := respond(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	orig := k8sServiceURL
	k8sServiceURL = srv.URL
	t.Cleanup(func() { k8sServiceURL = orig; srv.Close() })
	return &seen
}

func ctxFor(cluster string, namespaces ...string) context.Context {
	ctx := withClusterID(context.Background(), cluster)
	if len(namespaces) > 0 {
		ctx = auth.WithPayload(ctx, auth.TokenPayload{Namespaces: map[string][]string{cluster: namespaces}})
	}
	return ctx
}

func bearer() http.Header { return http.Header{"Authorization": {"Bearer user-token"}} }

func TestPrometheusQuery_InstantPassesTokenAndCluster(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"available":true,"results":[{"metric":{"pod":"web-1"},"value":[1700000000,"0.5"]}]}`
	})
	out, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": `sum(rate(container_cpu_usage_seconds_total[5m])) by (pod)`}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	if r.URL.Path != "/api/v1/prometheus/query" || r.URL.Query().Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s auth=%q", r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"))
	}
	if !strings.Contains(r.URL.Query().Get("query"), "container_cpu_usage_seconds_total") {
		t.Fatalf("query not forwarded: %s", r.URL.RawQuery)
	}
	m := decode(t, out)
	if m["range"] != false || m["series"] != float64(1) || m["truncated"] != nil {
		t.Fatalf("result: %s", out)
	}
}

func TestPrometheusQuery_RangeStepAndThinning(t *testing.T) {
	var points []string
	for i := 0; i < 500; i++ {
		points = append(points, `{"t":`+strconv.Itoa(i)+`,"v":"1"}`)
	}
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"available":true,"results":[{"metric":{},"points":[` + strings.Join(points, ",") + `]}]}`
	})
	out, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": "up", "range": true, "since": "2h"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if (*seen)[0].URL.Path != "/api/v1/prometheus/query_range" || q.Get("step") != "60" || q.Get("start") == "" || q.Get("end") == "" {
		t.Fatalf("range request: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	pts := m["results"].([]interface{})[0].(map[string]interface{})["points"].([]interface{})
	if len(pts) != promPointsCap || m["truncated"] != true || m["step_seconds"] != float64(60) {
		t.Fatalf("thinned to %d points, truncated=%v step=%v", len(pts), m["truncated"], m["step_seconds"])
	}
	if last := pts[len(pts)-1].(map[string]interface{})["t"]; last != float64(499) {
		t.Fatalf("the last point is kept: %v", last)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"available":true,"results":[]}` })
	out, err = handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": "up", "range": true, "since": "10m", "step": "5"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	if m["step_seconds"] != float64(promMinStepSecond) || !strings.Contains(m["hint"].(string), "no series") {
		t.Fatalf("minimum step and empty hint: %s", out)
	}
}

func TestPrometheusQuery_UnavailableAndCaps(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"available":false,"results":[]}` })
	out, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": "up"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["status"] != "unavailable" || m["feature"] != "prometheus" || !strings.Contains(m["alternative"].(string), "get_pod_metrics") {
		t.Fatalf("unavailable: %s", out)
	}

	var series []string
	for i := 0; i < promSeriesCap+20; i++ {
		series = append(series, `{"metric":{"i":"`+strconv.Itoa(i)+`"},"value":[1,"1"]}`)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"available":true,"results":[` + strings.Join(series, ",") + `]}`
	})
	out, err = handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": "up"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	if len(m["results"].([]interface{})) != promSeriesCap || m["series"] != float64(promSeriesCap+20) || m["truncated"] != true {
		t.Fatalf("series cap: %s", out[:200])
	}

	if _, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("promql required: %v", err)
	}
}

func TestLogSearch_ParamsScopeAndRefusals(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"lines":[{"ts":"2026-10-15T00:00:00Z","namespace":"shop","pod":"web-1","container":"app","line":"error one"},{"ts":"2026-10-15T00:00:01Z","namespace":"shop","pod":"web-1","container":"app","line":"error two"}],"limit":100}`
	})
	out, err := handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop", "text": "error", "workload_kind": "Deployment", "workload_name": "web", "since": "30m", "limit": 1, "regex": true}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	q := r.URL.Query()
	if r.URL.Path != "/api/v1/namespaces/shop/logsearch" || q.Get("q") != "error" || q.Get("workload_kind") != "Deployment" || q.Get("workload_name") != "web" ||
		q.Get("since") != "30m" || q.Get("limit") != "1" || q.Get("ignore_case") != "true" || q.Get("match") != "regex" || q.Get("cluster") != "c1" {
		t.Fatalf("request: %s %s", r.URL.Path, r.URL.RawQuery)
	}
	m := decode(t, out)
	if len(m["lines"].([]interface{})) != 1 || m["truncated"] != true || m["returned"] != float64(2) || m["namespace"] != "shop" {
		t.Fatalf("capped to limit: %s", out)
	}

	seen = fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"lines":[]}` })
	out, err = handleLogSearch(ctxFor("c1"), map[string]interface{}{"limit": 9999}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q = (*seen)[0].URL.Query()
	if (*seen)[0].URL.Path != "/api/v1/logsearch" || q.Get("since") != "1h" || q.Get("limit") != strconv.Itoa(logLinesCap) || q.Get("match") != "" {
		t.Fatalf("defaults and cap: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "Widen since") || m["namespace"] != "all namespaces" {
		t.Fatalf("empty hint: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 404, `{"detail":"log search is not configured for this cluster"}`
	})
	out, err = handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "unavailable" || !strings.Contains(m["alternative"].(string), "k8s_get_pod_logs") {
		t.Fatalf("not configured: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 403, `{"detail":"forbidden: the cluster does not let you read pod logs in shop"}`
	})
	out, err = handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "forbidden" || !strings.Contains(m["reason"].(string), "pod logs") {
		t.Fatalf("forbidden: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 429, `{"detail":"too many log searches: 10 per minute"}` })
	out, err = handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil || decode(t, out)["status"] != "rate_limited" {
		t.Fatalf("rate limited: %v %s", err, out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 400, `{"detail":"since must be a positive duration"}` })
	if _, err := handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("400 is the caller's: %v", err)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 502, `{"detail":"loki: connection refused"}` })
	if _, err := handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer()); err == nil || errors.Is(err, errBadRequest) {
		t.Fatalf("a store failure stays an error: %v", err)
	}
}

func TestIssues_FilterScopeSeverityAndCounts(t *testing.T) {
	body := `{"window_minutes":30,"generated_at":"2026-10-15T00:00:00Z","issues":[
		{"id":"1","kind":"Pod","namespace":"shop","name":"web-1","severity":"critical","reason":"CrashLoopBackOff"},
		{"id":"2","kind":"Deployment","namespace":"db","name":"pg","severity":"warning","reason":"Unavailable"},
		{"id":"3","kind":"Node","name":"n1","severity":"warning","reason":"MemoryPressure"},
		{"id":"4","kind":"Pod","namespace":"shop","name":"api-1","severity":"info","reason":"Restarted"}]}`
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, err := handleIssues(ctxFor("c1"), map[string]interface{}{"window_minutes": 45}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Query().Get("window") != "45" || (*seen)[0].URL.Path != "/api/v1/issues" {
		t.Fatalf("request: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	counts, _ := json.Marshal(m["counts"])
	if m["total"] != float64(4) || string(counts) != `{"critical":1,"info":1,"warning":2}` || m["namespace"] != "all namespaces" {
		t.Fatalf("whole cluster: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, _ = handleIssues(ctxFor("c1"), map[string]interface{}{"namespace": "shop", "severity": "critical"}, bearer())
	m = decode(t, out)
	issues := m["issues"].([]interface{})
	if m["total"] != float64(1) || issues[0].(map[string]interface{})["name"] != "web-1" {
		t.Fatalf("namespace + severity: %s", out)
	}

	// A namespace-scoped grant sees only its namespaces; cluster-scoped issues (nodes) drop out.
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, _ = handleIssues(ctxFor("c1", "shop"), map[string]interface{}{}, bearer())
	m = decode(t, out)
	ns, _ := json.Marshal(m["namespace"])
	if m["total"] != float64(2) || string(ns) != `["shop"]` {
		t.Fatalf("scoped grant: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"window_minutes":30,"issues":[]}` })
	out, _ = handleIssues(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "Nothing is failing") {
		t.Fatalf("empty hint: %s", out)
	}

	var many []string
	for i := 0; i < issuesCap+5; i++ {
		many = append(many, `{"id":"`+strconv.Itoa(i)+`","kind":"Pod","namespace":"shop","name":"p","severity":"warning"}`)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"window_minutes":30,"issues":[` + strings.Join(many, ",") + `]}`
	})
	out, _ = handleIssues(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); len(m["issues"].([]interface{})) != issuesCap || m["truncated"] != true || m["total"] != float64(issuesCap+5) {
		t.Fatalf("cap: total=%v", m["total"])
	}
}

// What k8s-service answers the issue check when lists were refused: a Collector row each, beside the rows it could read.
const (
	issuesWindow   = `"window_minutes":30,"generated_at":"2026-10-15T00:00:00Z"`
	unreadDeploys  = `{"id":"Collector/deployments","kind":"Collector","message":"deployments.apps is forbidden","name":"deployments","reason":"ListFailed","severity":"info"}`
	unreadEvents   = `{"id":"Collector/events","kind":"Collector","message":"events: the server was unable to return a response in the time allotted","name":"events","reason":"ListFailed","severity":"info"}`
	unreadNodes    = `{"id":"Collector/nodes","kind":"Collector","message":"nodes is forbidden","name":"nodes","reason":"ListFailed","severity":"info"}`
	failingWeb     = `{"id":"Pod/shop/web-1","kind":"Pod","name":"web-1","namespace":"shop","reason":"CrashLoopBackOff","severity":"critical"}`
	issuesQuietEnd = `"hint":"Nothing is failing in the checked scope right now (pods, workloads, nodes, PVCs, Warning events in the window).","issues":[],`
)

func issuesOf(t *testing.T, ctx context.Context, a args, rows ...string) string {
	t.Helper()
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, `{` + issuesWindow + `,"issues":[` + strings.Join(rows, ",") + `]}`
	})
	out, err := handleIssues(ctx, a, bearer())
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// Where no list was refused, and where the answer lists the refused ones as rows, the answer is the bytes it was.
func TestIssues_WithEveryListReadTheAnswerIsTheBytesItWas(t *testing.T) {
	const tail = `"window_minutes":30}`
	const at = `"generated_at":"2026-10-15T00:00:00Z",`
	none := `{"counts":{"critical":0,"info":0,"warning":0},` + at + issuesQuietEnd
	one := `{"counts":{"critical":1,"info":0,"warning":0},` + at + `"issues":[` + failingWeb + `],`
	for _, c := range []struct {
		name string
		args args
		rows []string
		want string
	}{
		{"a quiet cluster", args{}, nil, none + `"namespace":"all namespaces","total":0,` + tail},
		{"a quiet namespace", args{"namespace": "shop"}, nil, none + `"namespace":"shop","total":0,` + tail},
		{"a failing namespace", args{"namespace": "shop"}, []string{failingWeb}, one + `"namespace":"shop","total":1,` + tail},
		{"a severity", args{"severity": "critical"}, []string{failingWeb}, one + `"namespace":"all namespaces","total":1,` + tail},
		{"a refused list among the rows", args{}, []string{unreadNodes},
			`{"counts":{"critical":0,"info":1,"warning":0},` + at + `"issues":[` + unreadNodes + `],"namespace":"all namespaces","total":1,` + tail},
		{"a refused list among the rows of its severity", args{"severity": "info"}, []string{unreadNodes},
			`{"counts":{"critical":0,"info":1,"warning":0},` + at + `"issues":[` + unreadNodes + `],"namespace":"all namespaces","total":1,` + tail},
		// the nodes are no part of a namespace's answer, read or not: a grant limited to namespaces never lists them
		{"a namespace, the nodes refused", args{"namespace": "shop"}, []string{unreadNodes}, none + `"namespace":"shop","total":0,` + tail},
	} {
		if out := issuesOf(t, ctxFor("c1"), c.args, c.rows...); out != c.want {
			t.Errorf("%s:\n%s\nwant\n%s", c.name, out, c.want)
		}
	}
}

// A narrowed answer leaves the refused lists' rows out; it names them in not_read, in front, and its other fields are those
// of the lists that were read, without the hint that nothing is failing.
func TestIssues_ANarrowedAnswerNamesTheListsThatCouldNotBeRead(t *testing.T) {
	deployments := map[string]interface{}{"deployments": "deployments.apps is forbidden"}
	two := map[string]interface{}{"deployments": "deployments.apps is forbidden", "events": "events: the server was unable to return a response in the time allotted"}
	withNodes := map[string]interface{}{"deployments": "deployments.apps is forbidden", "nodes": "nodes is forbidden"}
	for _, c := range []struct {
		name    string
		ctx     context.Context
		args    args
		rows    []string
		notRead map[string]interface{}
		total   float64
	}{
		{"a namespace with nothing found", ctxFor("c1"), args{"namespace": "shop"}, []string{unreadDeploys}, deployments, 0},
		{"two lists", ctxFor("c1"), args{"namespace": "shop"}, []string{unreadDeploys, unreadEvents}, two, 0},
		{"a namespace with a failing pod", ctxFor("c1"), args{"namespace": "shop"}, []string{unreadDeploys, failingWeb}, deployments, 1},
		{"the nodes beside them", ctxFor("c1"), args{"namespace": "shop"}, []string{unreadNodes, unreadDeploys}, deployments, 0},
		{"a namespace and a severity", ctxFor("c1"), args{"namespace": "shop", "severity": "critical"}, []string{unreadDeploys, failingWeb}, deployments, 1},
		{"a namespace and the rows' own severity", ctxFor("c1"), args{"namespace": "shop", "severity": "info"}, []string{unreadDeploys}, deployments, 0},
		{"a namespace of a limited grant", ctxFor("c1", "shop"), args{"namespace": "shop"}, []string{unreadNodes, unreadDeploys}, deployments, 0},
		// a severity leaves their rows out too, of every namespace: the nodes are part of that answer
		{"a severity", ctxFor("c1"), args{"severity": "critical"}, []string{unreadNodes, unreadDeploys, failingWeb}, withNodes, 1},
	} {
		out := issuesOf(t, c.ctx, c.args, c.rows...)
		m := decode(t, out)
		if !reflect.DeepEqual(m["not_read"], c.notRead) || m["total"] != c.total || !strings.HasPrefix(out, `{"not_read":{`) {
			t.Errorf("%s: %s", c.name, out)
		}
		if note, _ := m["not_read_note"].(string); !strings.Contains(note, "not counted, not zero") {
			t.Errorf("%s: note %q", c.name, note)
		}
		if _, ok := m["hint"]; ok {
			t.Errorf("%s: hint beside not_read: %s", c.name, out)
		}
		// beside the two fields and the hint, the answer is that of a cluster whose other lists say the same
		var others []string
		for _, row := range c.rows {
			if row == failingWeb {
				others = append(others, row)
			}
		}
		delete(m, "not_read")
		delete(m, "not_read_note")
		want := decode(t, issuesOf(t, c.ctx, c.args, others...))
		if _, ok := want["hint"]; ok != (c.total == 0) {
			t.Errorf("%s: with every list read, hint %v of total %v", c.name, want["hint"], c.total)
		}
		delete(want, "hint")
		if !reflect.DeepEqual(m, want) {
			t.Errorf("%s: the other fields %v, want %v", c.name, m, want)
		}
	}

	// A refused list's message is masked as any answer is.
	planted := strings.Replace(unreadDeploys, "deployments.apps is forbidden", "dial postgres://app:fake-db-password@db.shop:5432 refused", 1)
	masked, _ := redactToolOutput(issuesOf(t, ctxFor("c1"), args{"namespace": "shop"}, planted))
	if strings.Contains(masked, "fake-db-password") || !strings.Contains(masked, `"not_read":{"deployments":`) {
		t.Errorf("masked: %s", masked)
	}
}

// A grant limited to namespaces never lists the nodes: they are no part of its answers, with a namespace named or not, so
// an answer that missed the nodes alone is what it was before not_read. The rows of an answer that is not narrowed stay.
func TestIssues_ALimitedGrantsAnswerDoesNotMissTheNodes(t *testing.T) {
	const head = `{"counts":{"critical":0,"info":0,"warning":0},"generated_at":"2026-10-15T00:00:00Z",` + issuesQuietEnd
	const tail = `"namespace":["shop"],"total":0,"window_minutes":30}`
	for _, severity := range []string{"critical", "warning"} {
		out := issuesOf(t, ctxFor("c1", "shop"), args{"severity": severity}, unreadNodes)
		if out != head+tail {
			t.Errorf("%s: %s", severity, out)
		}
		// a list of its namespaces that was refused is still named, alone
		m := decode(t, issuesOf(t, ctxFor("c1", "shop"), args{"severity": severity}, unreadNodes, unreadDeploys))
		if !reflect.DeepEqual(m["not_read"], map[string]interface{}{"deployments": "deployments.apps is forbidden"}) || m["hint"] != nil {
			t.Errorf("%s: %v", severity, m)
		}
	}
	for _, a := range []args{{}, {"severity": "info"}} {
		m := decode(t, issuesOf(t, ctxFor("c1", "shop"), a, unreadNodes))
		if m["total"] != float64(1) || m["not_read"] != nil {
			t.Errorf("%v: %v", a, m)
		}
	}
	// whoever reads the whole cluster may list the nodes: an answer that missed them says so
	m := decode(t, issuesOf(t, ctxFor("c1"), args{"severity": "critical"}, unreadNodes))
	if !reflect.DeepEqual(m["not_read"], map[string]interface{}{"nodes": "nodes is forbidden"}) || m["hint"] != nil {
		t.Errorf("the whole cluster: %v", m)
	}
}

// A list a limited grant's namespace refused (k8s-service names the namespaces on the row) is not read in that namespace's
// answer and in one of several, and is no part of another namespace's.
func TestIssues_AListRefusedInANamespaceOfAGrantIsNotReadThere(t *testing.T) {
	const message = `not read in pay: list all deployments: deployments.apps is forbidden`
	const refusedInPay = `{"id":"Collector/deployments","kind":"Collector","message":"` + message + `","name":"deployments","namespaces":["pay"],"reason":"ListFailed","severity":"info"}`
	grant := ctxFor("c1", "pay", "shop")
	notRead := map[string]interface{}{"deployments": message}

	// the namespace it was refused in
	m := decode(t, issuesOf(t, grant, args{"namespace": "pay"}, refusedInPay))
	if !reflect.DeepEqual(m["not_read"], notRead) || m["total"] != 0.0 || m["hint"] != nil {
		t.Errorf("its namespace: %v", m)
	}
	// another namespace of the grant: every list of it was read
	out := issuesOf(t, grant, args{"namespace": "shop"}, refusedInPay, failingWeb)
	if out != issuesOf(t, grant, args{"namespace": "shop"}, failingWeb) {
		t.Errorf("another namespace: %s", out)
	}
	if out = issuesOf(t, grant, args{"namespace": "shop"}, refusedInPay); out != issuesOf(t, grant, args{"namespace": "shop"}) || !strings.Contains(out, "Nothing is failing") {
		t.Errorf("another namespace, quiet: %s", out)
	}
	// both at once, narrowed by severity: named; not narrowed: a row
	m = decode(t, issuesOf(t, grant, args{"severity": "critical"}, refusedInPay))
	if !reflect.DeepEqual(m["not_read"], notRead) || m["hint"] != nil {
		t.Errorf("a severity: %v", m)
	}
	m = decode(t, issuesOf(t, grant, args{}, refusedInPay))
	if rows := m["issues"].([]interface{}); m["not_read"] != nil || len(rows) != 1 || rows[0].(map[string]interface{})["message"] != message {
		t.Errorf("not narrowed: %v", m)
	}
	// a row whose namespaces are no list of names is a list that was not read at all
	odd := strings.Replace(refusedInPay, `["pay"]`, `"pay"`, 1)
	if m = decode(t, issuesOf(t, grant, args{"namespace": "shop"}, odd)); !reflect.DeepEqual(m["not_read"], notRead) {
		t.Errorf("no names: %v", m)
	}
}

func TestFeatureFailure_Mapping(t *testing.T) {
	if out, ok, _ := featureFailure("x", "alt", 404, []byte(`{"detail":"x is not configured for this cluster"}`)); !ok || decode(t, out)["status"] != "unavailable" {
		t.Fatal("404 not configured → unavailable")
	}
	if _, ok, err := featureFailure("x", "", 404, []byte(`{"detail":"cluster not found"}`)); ok || err == nil {
		t.Fatal("an unknown cluster is an error")
	}
	if _, ok, err := featureFailure("x", "", 400, []byte(`{"detail":"bad since"}`)); ok || !errors.Is(err, errBadRequest) {
		t.Fatal("400 → bad request")
	}
	if detailOf([]byte("plain text")) != "plain text" || detailOf([]byte(`{"error":"e"}`)) != "e" {
		t.Fatal("detailOf")
	}
}

func TestFeatureArgsAndGate(t *testing.T) {
	for _, args := range []map[string]interface{}{{"promql": "up{job=\"x\"} > 1"}, {"text": "connection refused"}, {"severity": "Warning"}, {"workload_kind": "Deployment", "workload_name": "web"}, {"pod": "web-1"}} {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v should pass: %v", args, err)
		}
	}
	for _, args := range []map[string]interface{}{{"promql": "up\nup"}, {"promql": strings.Repeat("x", 2001)}, {"text": "a\tb"}, {"severity": "high"}, {"workload_kind": "--all"}, {"pod": "-n"}} {
		if err := validateToolArgs(args); !errors.Is(err, errBadRequest) {
			t.Errorf("%v should be refused: %v", args, err)
		}
	}
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"shop"}}}
	if err := namespaceGate(scoped, "c", "prometheus_query", map[string]interface{}{"promql": "up"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("PromQL spans the cluster: %v", err)
	}
	if err := namespaceGate(scoped, "c", "issues", map[string]interface{}{}); err != nil {
		t.Fatalf("issues scopes itself: %v", err)
	}
	if err := namespaceGate(scoped, "c", "issues", map[string]interface{}{"namespace": "db"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("issues outside the grant: %v", err)
	}
	if err := namespaceGate(scoped, "c", "logsearch", map[string]interface{}{}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("log search needs a namespace from a scoped grant: %v", err)
	}
	_ = url.Values{}
}
