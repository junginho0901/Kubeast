package handler

import (
	"context"
	"encoding/json"
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
	latest := at.Equal(anomalyNow)
	switch {
	case strings.Contains(q, "kube_pod_container_status_restarts_total"):
		v := 1.0
		if latest {
			v = 6
		}
		return []k8s.PrometheusQueryResult{{Metric: map[string]interface{}{"pod": "web-1-a"}, Value: v}}, nil
	case strings.Contains(q, "container_memory_working_set_bytes"):
		return []k8s.PrometheusQueryResult{{Metric: map[string]interface{}{"pod": "web-1-a", "container": "app"}, Value: 0.5}}, nil
	}
	return nil, nil
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
	// new first (two OOM kills where there were none, the crash loop), then the restarts that grew six times, then the
	// pressure on the node the pods run on; n9 runs no pod of shop
	want := "crash_reasons:OOMKilled,issues:Pod/web-1-a,restarts:Pod/web-1-a,node_pressure:Node/n1"
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
	if res.StoreQueries != 6 || len(f.queries) != 6 {
		t.Fatalf("%d store queries, %d made", res.StoreQueries, len(f.queries))
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
	if w2.Code != http.StatusOK || len(again.Findings) != len(res.Findings) || len(f.queries) != 6 || f.podReads != 1 {
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
	_, res := getAnomalies(anomalyHandler(f, config.Config{AnomalyRankMaxQueries: 4}), "/api/v1/namespaces/shop/anomalies", flowReader)
	spent := 0
	for _, n := range res.NotRun {
		if strings.Contains(n.Reason, "store queries are spent") {
			spent++
		}
	}
	if len(f.queries) != 4 || res.StoreQueries != 4 || spent != 1 {
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
		if finding.Check == anomaly.CheckIssues || finding.Check == anomaly.CheckCrashReasons || finding.Check == anomaly.CheckNodePressure {
			t.Errorf("a finding of web's pods for api: %+v", finding)
		}
	}
}
