package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/anomaly"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
)

var anomalyNow = time.Date(2026, 11, 15, 1, 30, 0, 0, time.UTC)

// fakeAnomalies answers a namespace where one pod was OOMKilled twice in the last hour and restarts more than before.
type fakeAnomalies struct {
	mu         sync.Mutex
	prometheus bool
	queryErr   error
	issueOpts  []k8s.IssuesOptions
	podReads   int
	queries    []string
	times      []time.Time
}

func (f *fakeAnomalies) CollectIssues(_ context.Context, opts k8s.IssuesOptions) ([]k8s.Issue, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.issueOpts = append(f.issueOpts, opts)
	return []k8s.Issue{
		{Kind: "Pod", Namespace: "shop", Name: "web-1-a", Severity: "critical", Reason: "CrashLoopBackOff", Message: "back-off restarting"},
		{Kind: "Node", Name: "n1", Severity: "warning", Reason: "MemoryPressure"},
		{Kind: "Node", Name: "n9", Severity: "warning", Reason: "DiskPressure"},
	}, nil
}

func (f *fakeAnomalies) GetPods(_ context.Context, namespace, _ string) ([]map[string]interface{}, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.podReads++
	oom := func(at time.Time) map[string]interface{} {
		return map[string]interface{}{"terminated": map[string]interface{}{"reason": "OOMKilled", "exit_code": int32(137), "finished_at": at.Format(time.RFC3339)}}
	}
	return []map[string]interface{}{
		{"name": "web-1-a", "namespace": namespace, "node_name": "n1", "owner_references": []map[string]interface{}{{"kind": "ReplicaSet", "name": "web-1"}},
			"containers": []map[string]interface{}{{"name": "app", "last_state": oom(anomalyNow.Add(-5 * time.Minute))}}},
		{"name": "web-1-b", "namespace": namespace, "node_name": "n1", "owner_references": []map[string]interface{}{{"kind": "ReplicaSet", "name": "web-1"}},
			"containers": []map[string]interface{}{{"name": "app", "last_state": oom(anomalyNow.Add(-15 * time.Minute))}}},
	}, nil
}

func (f *fakeAnomalies) PrometheusAvailable(context.Context) bool { return f.prometheus }

func (f *fakeAnomalies) ProtectedNamespaces(context.Context) protectedns.Namespaces {
	return protectedns.Namespaces{NodeShell: "kubeast-node-shell"}
}

func (f *fakeAnomalies) PrometheusQueryAt(_ context.Context, q string, at time.Time) ([]k8s.PrometheusQueryResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queries = append(f.queries, q)
	f.times = append(f.times, at)
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	switch {
	case strings.Contains(q, "kube_pod_container_status_restarts_total"):
		return bothWindows(map[string]interface{}{"pod": "web-1-a"}, 6, 1), nil
	case strings.Contains(q, "container_memory_working_set_bytes"):
		return bothWindows(map[string]interface{}{"pod": "web-1-a", "container": "app"}, 0.5, 0.5), nil
	}
	return nil, nil
}

// bothWindows is a metric query's answer for one series: its value over the window and over the window before.
func bothWindows(metric map[string]interface{}, now, before float64) []k8s.PrometheusQueryResult {
	row := func(window string, v float64) k8s.PrometheusQueryResult {
		m := map[string]interface{}{anomaly.WindowLabel: window}
		for k, label := range metric {
			m[k] = label
		}
		return k8s.PrometheusQueryResult{Metric: m, Value: v}
	}
	return []k8s.PrometheusQueryResult{row("now", now), row("before", before)}
}

func anomalyHandler(f *fakeAnomalies, cfg config.Config) *Handler {
	cfg.AnomalyRankEnabled = true
	return &Handler{cfg: cfg, anomalySrc: f, anomalyNow: func() time.Time { return anomalyNow }}
}

func getAnomalies(h *Handler, target string, payload auth.TokenPayload) (*httptest.ResponseRecorder, anomaly.Result) {
	w := httptest.NewRecorder()
	h.GetNamespaceAnomalies(w, logSearchRequestAs(target, "self", "shop", payload))
	var res anomaly.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	return w, res
}

func TestAnomaliesOffReadsNothing(t *testing.T) {
	f := &fakeAnomalies{prometheus: true}
	h := &Handler{anomalySrc: f}
	w, _ := getAnomalies(h, "/api/v1/namespaces/shop/anomalies", flowReader)
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "is off") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if len(f.issueOpts) != 0 || f.podReads != 0 || len(f.queries) != 0 {
		t.Fatalf("read while off: %+v", f)
	}
}

func TestAnomaliesRankWhatChangedAndSayWhatIsNormal(t *testing.T) {
	f := &fakeAnomalies{prometheus: true}
	h := anomalyHandler(f, config.Config{})
	w, res := getAnomalies(h, "/api/v1/namespaces/shop/anomalies", flowReader)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if res.Window.End != "2026-11-15T01:30:00Z" || res.Window.Start != "2026-11-15T00:30:00Z" || res.ComparedWith.Start != "2026-11-14T23:30:00Z" {
		t.Fatalf("windows %+v %+v", res.Window, res.ComparedWith)
	}
	targets := make([]string, 0, len(res.Findings))
	for _, finding := range res.Findings {
		targets = append(targets, finding.Check+":"+finding.Target)
	}
	// new first (two OOM kills where there were none) with the crash loop, critical now, then the restarts that grew six
	// times, then the pressure on the node the pods run on; n9 runs no pod of shop
	want := "crash_reasons:OOMKilled,issues:Pod/web-1-a,restarts:Pod/web-1-a,node_conditions_not_cpu:Node/n1"
	if got := strings.Join(targets, ","); got != want {
		t.Fatalf("findings %s, want %s", got, want)
	}
	if strings.Join(res.Normal, ",") != "memory_near_limit" {
		t.Fatalf("normal %v", res.Normal)
	}
	// no log or trace store here: those checks are listed as not run, never as normal
	notRun := map[string]string{}
	for _, n := range res.NotRun {
		notRun[n.Check] = n.Reason
	}
	if len(res.NotRun) != 6 || notRun[anomaly.CheckCPUThrottling] != anomaly.NoSeries {
		t.Fatalf("not run %+v", res.NotRun)
	}
	for _, check := range anomaly.LogChecks {
		if !strings.HasPrefix(notRun[check], "no log store for this cluster") {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
	for _, check := range anomaly.TraceChecks {
		if !strings.HasPrefix(notRun[check], "no trace store for this cluster") {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
	if res.StoreQueries != 3 || len(f.queries) != 3 {
		t.Fatalf("%d store queries, %d made", res.StoreQueries, len(f.queries))
	}
	for _, at := range f.times {
		if !at.Equal(anomalyNow) {
			t.Errorf("a metric query not at the window's end: %s", at)
		}
	}
	for i, q := range f.queries {
		if !strings.Contains(q, `namespace="shop"`) || !strings.Contains(q, "[3600s]") {
			t.Errorf("query %d does not keep to the namespace and window: %s", i, q)
		}
	}
	if len(f.issueOpts) != 1 || f.issueOpts[0].Namespace != "shop" || f.issueOpts[0].Window != time.Hour {
		t.Fatalf("issue options %+v", f.issueOpts)
	}

	// the same question in the same minute is the answer already made
	w2, again := getAnomalies(h, "/api/v1/namespaces/shop/anomalies", flowReader)
	if w2.Code != http.StatusOK || len(again.Findings) != len(res.Findings) || len(f.queries) != 3 || f.podReads != 1 {
		t.Fatalf("asked again: %d, %d queries, %d pod reads", w2.Code, len(f.queries), f.podReads)
	}
	// another caller is not given it
	other := flowReader
	other.UserID = "u2"
	other.Email = "other@example.com"
	getAnomalies(h, "/api/v1/namespaces/shop/anomalies", other)
	if f.podReads != 2 {
		t.Fatalf("another caller read %d times", f.podReads)
	}
}

func TestAnomaliesWithoutPrometheusSayWhichChecksDidNotRun(t *testing.T) {
	f := &fakeAnomalies{}
	_, res := getAnomalies(anomalyHandler(f, config.Config{}), "/api/v1/namespaces/shop/anomalies", flowReader)
	if len(f.queries) != 0 || res.StoreQueries != 0 {
		t.Fatalf("%d queries without Prometheus", len(f.queries))
	}
	notRun := map[string]string{}
	for _, n := range res.NotRun {
		notRun[n.Check] = n.Reason
	}
	for _, check := range []string{anomaly.CheckRestarts, anomaly.CheckMemoryNearLimit, anomaly.CheckCPUThrottling} {
		if notRun[check] != "no Prometheus reaches this cluster" {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
}

func TestAnomaliesForAGrantLimitedToNamespacesAskNoPrometheus(t *testing.T) {
	f := &fakeAnomalies{prometheus: true}
	limited := auth.TokenPayload{UserID: "u3", Perms: auth.PermissionMatrix{"self": {"resource.*.read"}}, Namespaces: map[string][]string{"self": {"shop"}}}
	_, res := getAnomalies(anomalyHandler(f, config.Config{}), "/api/v1/namespaces/shop/anomalies", limited)
	if len(f.queries) != 0 {
		t.Fatalf("%d Prometheus queries for a grant limited to namespaces", len(f.queries))
	}
	limitedChecks := 0
	for _, n := range res.NotRun {
		if strings.Contains(n.Reason, "limited to namespaces") {
			limitedChecks++
		}
	}
	if limitedChecks != 3 || len(res.Findings) == 0 {
		t.Fatalf("%+v", res)
	}
}

func TestAnomaliesStopAtTheirStoreQueries(t *testing.T) {
	f := &fakeAnomalies{prometheus: true}
	_, res := getAnomalies(anomalyHandler(f, config.Config{AnomalyRankMaxQueries: 2}), "/api/v1/namespaces/shop/anomalies", flowReader)
	spent := 0
	for _, n := range res.NotRun {
		if strings.Contains(n.Reason, "store queries are spent") {
			spent++
		}
	}
	if len(f.queries) != 2 || res.StoreQueries != 2 || spent != 1 {
		t.Fatalf("%d queries, %d counted, %d checks spent", len(f.queries), res.StoreQueries, spent)
	}
}

func TestAnomaliesAPrometheusFailureIsNotRunWithTheReason(t *testing.T) {
	f := &fakeAnomalies{prometheus: true, queryErr: errors.New("upstream answered 502")}
	_, res := getAnomalies(anomalyHandler(f, config.Config{}), "/api/v1/namespaces/shop/anomalies", flowReader)
	failed := 0
	for _, n := range res.NotRun {
		if strings.HasPrefix(n.Reason, "Prometheus: ") {
			failed++
		}
	}
	if failed != 3 {
		t.Fatalf("%+v", res.NotRun)
	}
}

func TestAnomaliesRefuseAWindowTheyCannotCompare(t *testing.T) {
	h := anomalyHandler(&fakeAnomalies{}, config.Config{})
	for _, target := range []string{
		"/api/v1/namespaces/shop/anomalies?start=2026-11-13T00:00:00Z",
		"/api/v1/namespaces/shop/anomalies?start=noon",
		"/api/v1/namespaces/shop/anomalies?workload_kind=Pod&workload_name=web",
		"/api/v1/namespaces/shop/anomalies?workload_name=web",
	} {
		if w, _ := getAnomalies(h, target, flowReader); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", target, w.Code, w.Body)
		}
	}
}

func TestAnomaliesOfOneWorkloadAskForItsPods(t *testing.T) {
	f := &fakeAnomalies{prometheus: true}
	_, res := getAnomalies(anomalyHandler(f, config.Config{}), "/api/v1/namespaces/shop/anomalies?workload_kind=Deployment&workload_name=api", flowReader)
	for _, q := range f.queries {
		if !strings.Contains(q, `pod=~"api-[bcdfghjklmnpqrstvwxz2456789]{1,10}-[bcdfghjklmnpqrstvwxz2456789]{5}"`) {
			t.Errorf("query without the workload's pods: %s", q)
		}
	}
	if res.Workload == nil || res.Workload.Name != "api" {
		t.Fatalf("%+v", res.Workload)
	}
	for _, finding := range res.Findings {
		if finding.Check == anomaly.CheckIssues || finding.Check == anomaly.CheckCrashReasons || finding.Check == anomaly.CheckNodeConditions {
			t.Errorf("a finding of web's pods for api: %+v", finding)
		}
	}
}

// sinceAnomalies is fakeAnomalies whose issue check says since when, when it is asked to.
type sinceAnomalies struct{ fakeAnomalies }

func (f *sinceAnomalies) CollectIssues(ctx context.Context, opts k8s.IssuesOptions) ([]k8s.Issue, error) {
	issues, err := f.fakeAnomalies.CollectIssues(ctx, opts)
	issues = append(issues, k8s.Issue{Kind: "Pod", Namespace: "shop", Name: "web-1-b", Severity: "critical", Reason: "ImagePullBackOff"})
	if opts.Since {
		issues[0].Since = "2026-11-14T22:00:00Z"
		issues[3].Since = "2026-11-15T01:10:00Z"
	}
	return issues, err
}

// alertAnomalies' issue check finds what an alert that waited 15 minutes is about, its cause and one that another alert
// waited an hour for, beside twelve pods that have been failing for hours.
type alertAnomalies struct{ fakeAnomalies }

func (f *alertAnomalies) CollectIssues(context.Context, k8s.IssuesOptions) ([]k8s.Issue, error) {
	row := func(name, since string) k8s.Issue {
		return k8s.Issue{Kind: "Deployment", Namespace: "shop", Name: name, Severity: "critical", Reason: "Unavailable", Since: since}
	}
	issues := []k8s.Issue{row("z-web", "2026-11-15T01:12:30Z"), row("z-db", "2026-11-15T01:11:00Z"), row("z-queue", "2026-11-15T00:26:00Z")}
	for i := range 12 {
		issues = append(issues, row(fmt.Sprintf("a-old-%02d", i), "2026-11-14T20:00:00Z"))
	}
	return issues, nil
}

// An investigation's window starts 15 minutes before the alert: what a rule waited 15 minutes or an hour for began before
// it and is not said to have been there before, and comes before what was.
func TestAnomaliesOfAnAlertThatWaitedDoNotCallItsCauseThereBefore(t *testing.T) {
	f := &alertAnomalies{}
	h := anomalyHandler(&f.fakeAnomalies, config.Config{})
	h.anomalySrc = f
	// the alert fired at 01:29 and the investigation asked at 01:30
	_, res := getAnomalies(h, "/api/v1/namespaces/shop/anomalies?start=2026-11-15T01:14:00Z&end=2026-11-15T01:30:00Z&with_since=true", flowReader)
	if len(res.Findings) != anomaly.MaxFindings || res.FindingsTotal < 15 {
		t.Fatalf("%d of %d findings", len(res.Findings), res.FindingsTotal)
	}
	var states []anomaly.Finding
	for _, fd := range res.Findings {
		if fd.Check == anomaly.CheckIssues {
			states = append(states, fd)
		}
	}
	if len(states) < 4 {
		t.Fatalf("%+v", res.Findings)
	}
	for i, fd := range states {
		target, there, says := "Deployment/a-old-", true, "critical now (already there before the window): "
		if i < 3 {
			target, there, says = "Deployment/"+[]string{"z-db", "z-queue", "z-web"}[i], false, "critical now (no earlier data): "
		}
		if !strings.HasPrefix(fd.Target, target) || fd.AlreadyThere != there || !strings.HasPrefix(fd.Summary, says) {
			t.Errorf("%d: %+v", i, fd)
		}
	}
}

// with_since: the issue check is asked for it, a state from before the window says so, and the answer is kept apart from
// the one without. Without it nothing is asked and nothing is said.
func TestAnomaliesSayWhatWasThereBeforeOnlyWhenAsked(t *testing.T) {
	f := &sinceAnomalies{}
	h := anomalyHandler(&f.fakeAnomalies, config.Config{})
	h.anomalySrc = f
	const target = "/api/v1/namespaces/shop/anomalies?start=2026-11-15T00:30:00Z&end=2026-11-15T01:30:00Z"
	plain, _ := getAnomalies(h, target, flowReader)
	if plain.Code != http.StatusOK || strings.Contains(plain.Body.String(), `"since"`) || strings.Contains(plain.Body.String(), "already_there") {
		t.Fatalf("%d %s", plain.Code, plain.Body)
	}
	_, res := getAnomalies(h, target+"&with_since=true", flowReader)
	var old, fresh anomaly.Finding
	for _, fd := range res.Findings {
		switch fd.Target {
		case "Pod/web-1-a":
			old = fd
		case "Pod/web-1-b":
			fresh = fd
		}
	}
	if !old.AlreadyThere || old.Since != "2026-11-14T22:00:00Z" || !strings.HasPrefix(old.Summary, "critical now (already there before the window): CrashLoopBackOff") {
		t.Fatalf("%+v", old)
	}
	if fresh.AlreadyThere || fresh.Since != "2026-11-15T01:10:00Z" || !strings.HasPrefix(fresh.Summary, "critical now (no earlier data): ImagePullBackOff") {
		t.Fatalf("%+v", fresh)
	}
	again, _ := getAnomalies(h, target, flowReader)
	if again.Body.String() != plain.Body.String() {
		t.Fatalf("the answer without it changed: %s", again.Body)
	}
	var asked []bool
	for _, o := range f.issueOpts {
		asked = append(asked, o.Since)
	}
	if len(asked) < 2 || asked[0] || !asked[1] {
		t.Fatalf("asked %v", asked)
	}
}
