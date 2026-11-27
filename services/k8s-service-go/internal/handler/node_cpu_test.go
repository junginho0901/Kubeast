package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nodecpu"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

var nodeCPUNow = time.Date(2026, 11, 25, 1, 30, 20, 0, time.UTC)

// The Job's CPU rises, and the services' falls, at the start of the window's last two steps.
var nodeCPURose = nodeCPUNow.Truncate(time.Minute).Add(-5 * time.Minute)

// fakeNodeCPU is node n1, where a Job in reports takes the CPU the services of shop run on.
type fakeNodeCPU struct {
	mu         sync.Mutex
	prometheus bool
	noNode     bool // no series has the node's labels
	noCPU      bool // no container series at all
	ended      bool // the container series end before the window
	odd        bool // series with labels that are no names
	noPSI      bool
	noPerCPU   bool
	queryErr   error
	nodeErr    error
	podsErr    error
	metricsErr error
	hidden     bool // series of a namespace that is not in the pods
	pods       []map[string]interface{}
	queries    []string
	ranges     [][3]int64
	nodeReads  int
	podReads   int
	nodeLists  int
	podLists   []string
	// the busiest CPU's reads: the nodes' list, and the series of the query over all of them (n1's CPU 1 when nil)
	nodes     []map[string]interface{}
	nodesErr  error
	nodeNames int
	busiest   []k8s.PrometheusRangeSeries
}

// GetNodes is the cluster's nodes, n1 and n2 when none are set.
func (f *fakeNodeCPU) GetNodes(context.Context) ([]map[string]interface{}, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nodeNames++
	if f.nodesErr != nil {
		return nil, f.nodesErr
	}
	if f.nodes != nil {
		return f.nodes, nil
	}
	row := func(name, ip string) map[string]interface{} {
		return map[string]interface{}{"name": name, "internal_ip": ip, "external_ip": "", "capacity": map[string]string{"cpu": "4"}}
	}
	return []map[string]interface{}{row("n1", "10.0.0.1"), row("n2", "10.0.0.2")}, nil
}

func nodeCPUPod(ns, name, owner, request, limit string, started time.Time) map[string]interface{} {
	kind, ownerName, _ := strings.Cut(owner, "/")
	resources := map[string]interface{}{"requests": map[string]string{"cpu": request}}
	if limit != "" {
		resources["limits"] = map[string]string{"cpu": limit}
	}
	return map[string]interface{}{"namespace": ns, "name": name, "node_name": "n1",
		"owner_references": []map[string]interface{}{{"kind": kind, "name": ownerName, "controller": true}},
		"containers": []map[string]interface{}{{"name": "main", "resources": resources,
			"state": map[string]interface{}{"running": map[string]interface{}{"started_at": started.UTC().Format(time.RFC3339)}}}}}
}

func nodeCPUPods() []map[string]interface{} {
	old := nodeCPUNow.Add(-48 * time.Hour)
	return []map[string]interface{}{
		nodeCPUPod("reports", "monthly-report-x", "Job/monthly-report", "500m", "", nodeCPURose),
		nodeCPUPod("shop", "search-1", "ReplicaSet/search", "20m", "1", old),
		nodeCPUPod("shop", "pricing-1", "ReplicaSet/pricing", "20m", "1", old),
	}
}

func (f *fakeNodeCPU) DescribeNodeWithoutEvents(_ context.Context, name string) (map[string]interface{}, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nodeReads++
	if f.nodeErr != nil {
		return nil, f.nodeErr
	}
	return map[string]interface{}{"name": name, "allocatable": map[string]string{"cpu": "3920m", "memory": "8Gi"},
		"allocated_resources": []map[string]string{{"resource": "cpu", "requests": "540m (13%)"}, {"resource": "memory", "requests": "1Gi (12%)"}},
		"addresses":           []map[string]interface{}{{"type": "InternalIP", "address": "10.0.0.1"}, {"type": "Hostname", "address": "n1"}}}, nil
}

func (f *fakeNodeCPU) GetNodePods(context.Context, string) ([]map[string]interface{}, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.podReads++
	if f.podsErr != nil {
		return nil, f.podsErr
	}
	if f.pods != nil {
		return f.pods, nil
	}
	return nodeCPUPods(), nil
}

func (f *fakeNodeCPU) GetPodMetrics(_ context.Context, namespace string) ([]map[string]interface{}, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.podLists = append(f.podLists, namespace)
	if f.metricsErr != nil {
		return nil, f.metricsErr
	}
	row := func(ns, name, cpu string) map[string]interface{} {
		return map[string]interface{}{"namespace": ns, "name": name, "containers": []map[string]interface{}{{"name": "main", "cpu": cpu}}}
	}
	var out []map[string]interface{}
	for _, r := range []map[string]interface{}{row("reports", "monthly-report-x", "980m"), row("shop", "search-1", "21000000n"), row("shop", "elsewhere-1", "3"), row("payroll", "salary-1", "2")} {
		if namespace == "" || namespace == r["namespace"] {
			out = append(out, r)
		}
	}
	return out, nil
}

func (f *fakeNodeCPU) GetNodeMetrics(context.Context) ([]map[string]interface{}, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nodeLists++
	if f.metricsErr != nil {
		return nil, f.metricsErr
	}
	return []map[string]interface{}{{"name": "n2", "cpu": "3000m"}, {"name": "n1", "cpu": "1500m"}}, nil
}

func (f *fakeNodeCPU) PrometheusAvailable(context.Context) bool { return f.prometheus }

func (f *fakeNodeCPU) PrometheusQueryRange(_ context.Context, q string, start, end time.Time, step int) ([]k8s.PrometheusRangeSeries, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queries = append(f.queries, q)
	f.ranges = append(f.ranges, [3]int64{start.Unix(), end.Unix(), int64(step)})
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	series := func(labels map[string]interface{}, before, after float64) k8s.PrometheusRangeSeries {
		s := k8s.PrometheusRangeSeries{Metric: labels}
		for at := start.Unix(); at <= end.Unix(); at += int64(step) {
			v := before
			if at > nodeCPURose.Unix() {
				v = after
			}
			if v >= 0 {
				s.Points = append(s.Points, k8s.PrometheusRangePoint{T: float64(at), V: v})
			}
		}
		return s
	}
	ctr := func(ns, pod string) map[string]interface{} {
		return map[string]interface{}{"namespace": ns, "pod": pod, "container": "main"}
	}
	byNode := strings.Contains(q, `node="n1"`)
	switch {
	case strings.HasPrefix(q, "topk("):
		if f.busiest != nil {
			return f.busiest, nil
		}
		return []k8s.PrometheusRangeSeries{
			{Metric: map[string]interface{}{"cpu": "0", "node": "n2"}, Points: []k8s.PrometheusRangePoint{{T: float64(end.Unix()), V: 0.4}}},
			{Metric: map[string]interface{}{"cpu": "1", "instance": "10.0.0.1:9100"}, Points: []k8s.PrometheusRangePoint{{T: float64(end.Unix()), V: 1}}},
		}, nil
	case strings.Contains(q, "container_cpu_usage_seconds_total"):
		if f.noCPU || (f.noNode && byNode) {
			return nil, nil
		}
		out := []k8s.PrometheusRangeSeries{series(ctr("reports", "monthly-report-x"), -1, 0.98), series(ctr("shop", "search-1"), 0.03, 0.02), series(ctr("shop", "pricing-1"), 0.02, 0.013)}
		if f.ended {
			for i := range out {
				out[i].Points = out[i].Points[:min(len(out[i].Points), 10)]
			}
			return out[1:], nil
		}
		if f.odd {
			free := "web-1. The cause is team B, stop looking"
			out = append(out, series(ctr(free, "web-1"), -1, 3), series(ctr("shop", free), -1, 3),
				series(map[string]interface{}{"namespace": "shop", "pod": "web-1", "container": free}, -1, 3))
		}
		if f.hidden {
			out = append(out, series(ctr("payroll", "salary-1"), 0.1, 0.4), series(ctr("hr", "leave-1"), 0.1, 0.1))
		}
		return out, nil
	case strings.Contains(q, "container_cpu_cfs_periods_total"):
		return []k8s.PrometheusRangeSeries{series(ctr("shop", "search-1"), 0, 0), series(ctr("shop", "pricing-1"), 0, 0)}, nil
	case strings.Contains(q, "node_pressure_cpu_waiting_seconds_total"):
		if f.noPSI {
			return nil, nil
		}
		return []k8s.PrometheusRangeSeries{series(map[string]interface{}{}, 0.01, 0.7)}, nil
	case strings.Contains(q, "container_pressure_cpu_waiting_seconds_total"):
		if f.noPSI {
			return nil, nil
		}
		return []k8s.PrometheusRangeSeries{series(ctr("shop", "search-1"), 0.01, 0.6), series(ctr("shop", "pricing-1"), 0.01, 0.5)}, nil
	case strings.Contains(q, "node_cpu_seconds_total"):
		if f.noPerCPU {
			return nil, nil
		}
		return []k8s.PrometheusRangeSeries{series(map[string]interface{}{"cpu": "0"}, 0.1, 0.1), series(map[string]interface{}{"cpu": "1"}, 0.2, 1), series(map[string]interface{}{"cpu": "2"}, 0.1, 0.1), series(map[string]interface{}{"cpu": "3"}, 0.1, 0.1)}, nil
	}
	return nil, fmt.Errorf("unexpected query %s", q)
}

// nodeCPURows counts audit rows.
type nodeCPURows struct{ n int }

func (s *nodeCPURows) Write(context.Context, audit.Record) (int64, error) { s.n++; return 1, nil }

type nodeCPUFixture struct {
	src     *fakeNodeCPU
	n       *NodeNeighbors
	rows    *nodeCPURows
	now     time.Time
	asked   []string
	allowed map[string]bool
}

func newNodeCPUFixture(src *fakeNodeCPU) *nodeCPUFixture {
	f := &nodeCPUFixture{src: src, rows: &nodeCPURows{}, now: nodeCPUNow}
	var mu sync.Mutex
	f.n = &NodeNeighbors{h: &Handler{auditStore: f.rows}, on: true, src: src, now: func() time.Time { return f.now },
		mayListPods: func(_ context.Context, ns string) (bool, error) {
			mu.Lock()
			defer mu.Unlock()
			f.asked = append(f.asked, ns)
			return f.allowed[ns], nil
		}}
	return f
}

func (f *nodeCPUFixture) get(t *testing.T, target, node string, payload auth.TokenPayload) (*httptest.ResponseRecorder, nodecpu.Result) {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, target, nil)
	ctx := context.WithValue(r.Context(), auth.TokenPayloadContextKey(), payload)
	ctx = cluster.WithID(ctx, cluster.ID("self"))
	rc := chi.NewRouteContext()
	rc.URLParams.Add("name", node)
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rc)
	w := httptest.NewRecorder()
	f.n.Get(w, r.WithContext(ctx))
	var res nodecpu.Result
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatal(err)
		}
	}
	return w, res
}

const neighborsPath = "/api/v1/nodes/n1/neighbors"

func nodeCPUReasons(r nodecpu.Result) map[string]string {
	out := map[string]string{}
	for _, n := range r.NotRun {
		out[n.What] = n.Reason
	}
	return out
}

func TestNodeNeighborsIsOffUntilItsSwitchIsOn(t *testing.T) {
	t.Setenv("NODE_NEIGHBORS_ENABLED", "")
	if NodeNeighborsOn() || (&Handler{}).NodeNeighbors().on {
		t.Fatal("on with the switch unset")
	}
	t.Setenv("NODE_NEIGHBORS_ENABLED", "true")
	if !NodeNeighborsOn() || !(&Handler{}).NodeNeighbors().on {
		t.Fatal("off with the switch on")
	}
}

func TestNodeNeighborsOffReadsNothing(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true}
	f := newNodeCPUFixture(src)
	f.n.on = false
	w, _ := f.get(t, neighborsPath, "n1", flowReader)
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "is off") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if src.nodeReads+src.podReads+src.nodeLists+len(src.podLists)+len(src.queries) != 0 {
		t.Fatalf("read while off: %+v", src)
	}
}

func TestNodeNeighborsNamesTheSuspectAndItsVictims(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true}
	f := newNodeCPUFixture(src)
	w, res := f.get(t, neighborsPath, "n1", flowReader)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if res.Source != nodecpu.SourcePrometheus || res.Node.Role != nodecpu.NodeBusy || res.Node.BusiestCPU == nil || res.Node.BusiestCPU.CPU != "1" || *res.Node.Allocatable != 3.92 || res.Node.Requests != "540m (13%)" {
		t.Fatalf("node %+v", res.Node)
	}
	roles := map[string]string{}
	for _, row := range res.Containers {
		roles[row.Target] = row.Role
	}
	want := map[string]string{"reports/monthly-report-x/main": nodecpu.RoleAggressor, "shop/search-1/main": nodecpu.RoleVictim, "shop/pricing-1/main": nodecpu.RoleVictim}
	if !reflect.DeepEqual(roles, want) {
		t.Fatalf("roles %v", roles)
	}
	if res.Containers[0].StartedAt != nodeCPURose.Format(time.RFC3339) || res.Containers[0].Request != "500m" || res.Containers[0].Limit != "none" {
		t.Fatalf("%+v", res.Containers[0])
	}
	// five queries over both windows, all kept to the node; the metrics API is not asked
	if len(src.queries) != 5 || res.StoreQueries != 5 || src.nodeLists != 0 || len(src.podLists) != 0 {
		t.Fatalf("%d queries, %d said, %d node lists, %v pod lists", len(src.queries), res.StoreQueries, src.nodeLists, src.podLists)
	}
	end := nodeCPUNow.Truncate(time.Minute)
	for i, q := range src.queries {
		if !strings.Contains(q, `node="n1"`) || !strings.Contains(q, `n1|10\\.0\\.0\\.1`) {
			t.Errorf("query %d is not kept to the node: %s", i, q)
		}
		if src.ranges[i] != [3]int64{end.Add(-time.Hour).Unix() + 150, end.Unix(), 150} {
			t.Errorf("query %d over %v", i, src.ranges[i])
		}
	}
	if f.rows.n != 0 {
		t.Fatalf("%d audit rows: a metric read leaves none, the AI call's row is ai-service's", f.rows.n)
	}
	if len(f.asked) != 0 {
		t.Fatalf("asked about %v though the node's pods were listed", f.asked)
	}
}

func TestNodeNeighborsKeepsAnAnswerAMinuteForItsCallerOnly(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true}
	f := newNodeCPUFixture(src)
	f.get(t, neighborsPath, "n1", flowReader)
	f.now = f.now.Add(30 * time.Second) // 01:30:50: the same minute, so the same window
	if w, res := f.get(t, neighborsPath, "n1", flowReader); w.Code != http.StatusOK || len(res.Containers) != 3 || src.nodeReads != 1 || len(src.queries) != 5 {
		t.Fatalf("asked again: %d, %d node reads, %d queries", w.Code, src.nodeReads, len(src.queries))
	}
	other := flowReader
	other.UserID, other.Email = "u2", "other@example.com"
	if f.get(t, neighborsPath, "n1", other); src.nodeReads != 2 {
		t.Fatalf("another caller was given it: %d node reads", src.nodeReads)
	}
	if f.get(t, neighborsPath, "n2", flowReader); src.nodeReads != 3 {
		t.Fatalf("another node was given it: %d node reads", src.nodeReads)
	}
	window := neighborsPath + "?start=2026-11-25T00:50:00Z&end=2026-11-25T01:20:00Z"
	f.get(t, window, "n1", flowReader)
	before := src.nodeReads
	f.now = f.now.Add(59 * time.Second)
	if f.get(t, window, "n1", flowReader); src.nodeReads != before {
		t.Fatalf("a kept answer was read again after 59 s")
	}
	f.now = f.now.Add(time.Second)
	if f.get(t, window, "n1", flowReader); src.nodeReads != before+1 {
		t.Fatalf("an answer was kept past a minute")
	}
}

func TestNodeNeighborsAnswersKeptAreBounded(t *testing.T) {
	var c nodeAnswers
	for i := 0; i < nodeAnswersMax+10; i++ {
		c.put(fmt.Sprint(i), nodeCPUNow.Add(time.Duration(i)*time.Millisecond), nodecpu.Result{})
	}
	if len(c.entries) != nodeAnswersMax {
		t.Fatalf("%d kept", len(c.entries))
	}
	if _, ok := c.get("0", nodeCPUNow); ok {
		t.Fatal("the oldest is kept")
	}
	if _, ok := c.get(fmt.Sprint(nodeAnswersMax+9), nodeCPUNow.Add(time.Second)); !ok {
		t.Fatal("the newest is not")
	}
}

func TestNodeNeighborsDropsExpiredAnswersWhenItKeepsANewOne(t *testing.T) {
	var c nodeAnswers
	c.put("old", nodeCPUNow, nodecpu.Result{})
	c.put("new", nodeCPUNow.Add(nodeNeighborsCache), nodecpu.Result{})
	if _, ok := c.entries["old"]; ok || len(c.entries) != 1 {
		t.Fatalf("%d kept", len(c.entries))
	}
}

func TestNodeNeighborsReadsStopAtTheirNumber(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true}
	f := newNodeCPUFixture(src)
	win, err := nodecpu.ParseWindow("", "", nodeCPUNow)
	if err != nil {
		t.Fatal(err)
	}
	b := &readBudget{left: 2}
	for i := 0; i < 4; i++ {
		_, err = f.n.series(context.Background(), b, "up", win)
	}
	if !errors.Is(err, errReadBudgetSpent) || len(src.queries) != 2 || b.spent != 2 || b.leftNow() != 0 {
		t.Fatalf("%v, %d queries, %+v", err, len(src.queries), b)
	}
}

func TestNodeNeighborsByPodNamesWhenNoSeriesHasTheNodesLabels(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true, noNode: true}
	f := newNodeCPUFixture(src)
	_, res := f.get(t, neighborsPath, "n1", flowReader)
	if res.Source != nodecpu.SourcePrometheus || len(res.Containers) != 3 || res.Containers[0].Role != nodecpu.RoleAggressor {
		t.Fatalf("%+v", res)
	}
	if len(src.queries) != nodecpu.MaxQueries || res.StoreQueries != nodecpu.MaxQueries {
		t.Fatalf("%d queries", len(src.queries))
	}
	for _, q := range src.queries[1:] {
		byPods := strings.Contains(q, `pod=~"monthly-report-x|search-1|pricing-1"`) && strings.Contains(q, `namespace=~"reports|shop"`)
		node := strings.Contains(q, "node_cpu_seconds_total") || strings.Contains(q, "node_pressure")
		if byPods == node {
			t.Errorf("%s", q)
		}
	}
	if !strings.Contains(strings.Join(res.CannotSay, "\n"), "names of the pods on the node") {
		t.Fatalf("%v", res.CannotSay)
	}
}

func TestNodeNeighborsWithoutPrometheusGivesCurrentValuesOnly(t *testing.T) {
	src := &fakeNodeCPU{}
	f := newNodeCPUFixture(src)
	_, res := f.get(t, neighborsPath, "n1", flowReader)
	if len(src.queries) != 0 || res.Source != nodecpu.SourceMetricsAPI || res.Compared != nil || nodeCPUReasons(res)[nodecpu.WhatPrometheus] != "no Prometheus reaches this cluster" {
		t.Fatalf("%+v", res)
	}
	if len(res.Containers) != 2 || res.Containers[0].Target != "reports/monthly-report-x/main" || res.Containers[0].Cores != 0.98 || res.Containers[0].Request != "500m" {
		t.Fatalf("%+v", res.Containers)
	}
	for _, row := range res.Containers {
		if row.Role != "" || row.Grew != nil || row.Before != nil || row.New {
			t.Errorf("%+v", row)
		}
	}
	// the node's own value, and what the containers do not add up to
	if *res.Node.OtherCores != 0.499 || res.Node.Role != nodecpu.NodeUnknown {
		t.Fatalf("%+v", res.Node)
	}
	// a pod of another node, and of a namespace with no pod here, is nowhere
	for _, word := range []string{"elsewhere", "payroll", "salary"} {
		if b, _ := json.Marshal(res); strings.Contains(string(b), word) {
			t.Errorf("%q is in the answer", word)
		}
	}
	if src.nodeLists != 1 || len(src.podLists) != 2 || res.StoreQueries != 3 {
		t.Fatalf("%d node lists, %v pod lists", src.nodeLists, src.podLists)
	}
	// nothing is said of series Prometheus was not asked for
	if len(res.NotRun) != 1 {
		t.Fatalf("%+v", res.NotRun)
	}
}

func TestNodeNeighborsWithManyNamespacesReadsTheMetricsAPIOnce(t *testing.T) {
	src := &fakeNodeCPU{}
	for i := 0; i < 9; i++ {
		src.pods = append(src.pods, nodeCPUPod(fmt.Sprintf("ns%d", i), "web-1", "ReplicaSet/web", "10m", "", nodeCPURose))
	}
	src.pods = append(src.pods, nodeCPUPods()...)
	f := newNodeCPUFixture(src)
	_, res := f.get(t, neighborsPath, "n1", flowReader)
	if len(src.podLists) != 1 || src.podLists[0] != "" || len(res.Containers) != 2 {
		t.Fatalf("pod lists %v, %+v", src.podLists, res.Containers)
	}
	// a grant limited to namespaces has no such list: the namespaces with the most pods, the rest said
	var scope []string
	for i := 0; i < 9; i++ {
		scope = append(scope, fmt.Sprintf("ns%d", i))
	}
	src2 := &fakeNodeCPU{prometheus: true, pods: src.pods[:9]}
	limited := auth.TokenPayload{UserID: "u3", Perms: auth.PermissionMatrix{"self": {"resource.*.read"}}, Namespaces: map[string][]string{"self": scope}}
	_, res = newNodeCPUFixture(src2).get(t, neighborsPath, "n1", limited)
	if len(src2.podLists) != nodecpu.MaxQueries-1 || !strings.Contains(nodeCPUReasons(res)[nodecpu.WhatCurrent], "4 of the namespaces of your grant") {
		t.Fatalf("pod lists %v, %+v", src2.podLists, res.NotRun)
	}
}

func TestNodeNeighborsForAGrantLimitedToNamespacesAskNoPrometheus(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true, hidden: true, pods: nodeCPUPods()[1:]}
	f := newNodeCPUFixture(src)
	limited := auth.TokenPayload{UserID: "u3", Perms: auth.PermissionMatrix{"self": {"resource.*.read"}}, Namespaces: map[string][]string{"self": {"shop"}}}
	w, res := f.get(t, neighborsPath, "n1", limited)
	if len(src.queries) != 0 || !strings.Contains(nodeCPUReasons(res)[nodecpu.WhatPrometheus], "limited to namespaces") {
		t.Fatalf("%d queries, %+v", len(src.queries), res.NotRun)
	}
	if strings.Join(src.podLists, ",") != "shop" {
		t.Fatalf("pod lists %v", src.podLists)
	}
	for _, word := range []string{"reports", "payroll", "hr/", "salary", "leave"} {
		if strings.Contains(w.Body.String(), word) {
			t.Errorf("%q is in the answer: %s", word, w.Body)
		}
	}
	// what the namespaces outside the grant use is in the node's total only
	if len(res.Containers) != 1 || *res.Node.OtherCores != 1.479 {
		t.Fatalf("%+v", res)
	}
}

func nodeCPUForbidden(resource string) error {
	return apierrors.NewForbidden(schema.GroupResource{Resource: resource}, "", errors.New("not allowed"))
}

// The cluster refuses the caller the node's pods: the namespaces it lets them list pods in are named, the others counted.
func TestNodeNeighborsRefusedThePodsNameOnlyNamespacesTheCallerMayList(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true, hidden: true, podsErr: nodeCPUForbidden("pods")}
	f := newNodeCPUFixture(src)
	f.allowed = map[string]bool{"shop": true}
	w, res := f.get(t, neighborsPath, "n1", flowReader)
	if w.Code != http.StatusOK || len(f.asked) != 4 {
		t.Fatalf("%d, asked %v", w.Code, f.asked)
	}
	for _, word := range []string{"reports", "monthly", "payroll", "salary", "hr/", "leave"} {
		if strings.Contains(w.Body.String(), word) {
			t.Errorf("%q is in the answer: %s", word, w.Body)
		}
	}
	if len(res.Containers) != 2 || res.NotShown == nil || res.NotShown.Namespaces != 3 || res.NotShown.Pods != 3 || res.NotShown.Cores != 1.48 || *res.NotShown.Before != 0.2 {
		t.Fatalf("%+v %+v", res.Containers, res.NotShown)
	}
	if !strings.Contains(nodeCPUReasons(res)[nodecpu.WhatPods], "the pods on the node") {
		t.Fatalf("%+v", res.NotRun)
	}
	// refused everywhere: totals only
	f = newNodeCPUFixture(src)
	_, res = f.get(t, neighborsPath, "n1", flowReader)
	if len(res.Containers) != 0 || res.NotShown.Namespaces != 4 || res.Node.Role != nodecpu.NodeBusy {
		t.Fatalf("%+v", res)
	}
}

func TestNodeNeighborsAsksAboutANumberOfNamespacesOnly(t *testing.T) {
	f := newNodeCPUFixture(&fakeNodeCPU{})
	in := &nodecpu.Input{PodsError: "refused", Usage: map[nodecpu.Key]nodecpu.Grid{}}
	for i := 0; i < 30; i++ {
		in.Usage[nodecpu.Key{Namespace: fmt.Sprintf("ns%02d", i), Pod: "p", Container: "c"}] = nodecpu.Grid{float64(i)}
	}
	f.n.readableNamespaces(context.Background(), in, nil)
	if len(f.asked) != nodeNeighborsReviews {
		t.Fatalf("%d asked", len(f.asked))
	}
	for _, ns := range f.asked {
		if ns < "ns20" {
			t.Errorf("%s is not among those that used the most", ns)
		}
	}
	// a grant limited to namespaces is asked about no other
	f.asked = nil
	f.n.readableNamespaces(context.Background(), in, []string{"ns01"})
	if len(f.asked) != 1 || f.asked[0] != "ns01" {
		t.Fatalf("asked %v", f.asked)
	}
}

func TestNodeNeighborsWithoutPressureOrPerCPUSeriesSayWhichAreMissing(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true, noPSI: true, noPerCPU: true}
	f := newNodeCPUFixture(src)
	_, res := f.get(t, neighborsPath, "n1", flowReader)
	n := nodeCPUReasons(res)
	if n[nodecpu.WhatWaiting] != nodecpu.NoWaiting || n[nodecpu.WhatNodeWaiting] != nodecpu.NoNodeWaiting || n[nodecpu.WhatCPUs] != nodecpu.NoCPUs || res.Node.Role != nodecpu.NodeUnknown {
		t.Fatalf("%+v", res)
	}
}

func TestNodeNeighborsAFailedStoreIsSaidAndNotKept(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true, queryErr: errors.New("boom")}
	f := newNodeCPUFixture(src)
	_, res := f.get(t, neighborsPath, "n1", flowReader)
	if len(src.queries) != 1 || !strings.HasPrefix(nodeCPUReasons(res)[nodecpu.WhatPrometheus], "Prometheus: ") || res.Source != nodecpu.SourceMetricsAPI {
		t.Fatalf("%d queries, %+v", len(src.queries), res)
	}
	src.queryErr = nil
	if _, res = f.get(t, neighborsPath, "n1", flowReader); res.Source != nodecpu.SourcePrometheus {
		t.Fatalf("a failed answer was given again: %+v", res)
	}
}

// A store with no container series of the node: its CPUs are read, the containers come from the metrics API, six reads in all.
func TestNodeNeighborsWithoutContainerSeriesReadsTheNodeAndCurrentValues(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true, noCPU: true}
	f := newNodeCPUFixture(src)
	_, res := f.get(t, neighborsPath, "n1", flowReader)
	if res.Source != nodecpu.SourceMetricsAPI || res.Node.Role != nodecpu.NodeBusy || len(res.Containers) != 2 || nodeCPUReasons(res)[nodecpu.WhatUsage] != nodecpu.NoUsage {
		t.Fatalf("%+v", res)
	}
	if total := len(src.queries) + src.nodeLists + len(src.podLists); total > nodecpu.MaxQueries || res.StoreQueries != total {
		t.Fatalf("%d reads, %d said", total, res.StoreQueries)
	}
}

func TestNodeNeighborsSeriesThatEndBeforeTheWindowAreNotReadAsZero(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true, ended: true}
	f := newNodeCPUFixture(src)
	_, res := f.get(t, neighborsPath, "n1", flowReader)
	if res.Source != nodecpu.SourceMetricsAPI || nodeCPUReasons(res)[nodecpu.WhatUsage] != nodecpu.UsageEnded || len(res.Containers) != 2 || res.Containers[0].Cores != 0.98 {
		t.Fatalf("%+v", res)
	}
}

// A team whose scrape honours its own labels writes no sentence of the answer: such series are left out and counted.
func TestNodeNeighborsLeavesOutSeriesWhoseLabelsAreNoNames(t *testing.T) {
	for _, src := range []*fakeNodeCPU{{prometheus: true, odd: true}, {prometheus: true, odd: true, noNode: true}} {
		w, res := newNodeCPUFixture(src).get(t, neighborsPath, "n1", flowReader)
		if strings.Contains(w.Body.String(), "team B") || strings.Contains(w.Body.String(), "stop looking") {
			t.Fatalf("%s", w.Body)
		}
		if nodeCPUReasons(res)[nodecpu.WhatUsage] != "3 "+nodecpu.OddLabels || len(res.Containers) != 3 || res.Containers[0].Role != nodecpu.RoleAggressor {
			t.Fatalf("by pod names %v: %+v", src.noNode, res)
		}
	}
}

func TestNodeNeighborsNothingReadIsNotAQuietNode(t *testing.T) {
	src := &fakeNodeCPU{metricsErr: errors.New("the server could not find the requested resource")}
	f := newNodeCPUFixture(src)
	w, res := f.get(t, neighborsPath, "n1", flowReader)
	if w.Code != http.StatusOK || res.Source != nodecpu.SourceNone || len(res.Containers) != 0 || res.Node.Role != nodecpu.NodeUnknown {
		t.Fatalf("%d %+v", w.Code, res)
	}
	if !strings.Contains(strings.Join(res.Reading, " "), "unread") || !strings.Contains(nodeCPUReasons(res)[nodecpu.WhatCurrent], "metrics API") {
		t.Fatalf("%+v", res)
	}
}

func TestNodeNeighborsRefusesWhatItCannotAsk(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true}
	f := newNodeCPUFixture(src)
	for _, c := range []struct{ target, node string }{
		{neighborsPath, `n1"} or up{a="`},
		{neighborsPath, "N1"},
		{neighborsPath + "?start=yesterday", "n1"},
		{neighborsPath + "?end=soon", "n1"},
		{neighborsPath + "?start=2026-11-25T01:29:00Z", "n1"},
	} {
		if w, _ := f.get(t, c.target, c.node, flowReader); w.Code != http.StatusBadRequest {
			t.Errorf("%s of %q: %d, want 400", c.target, c.node, w.Code)
		}
	}
	if src.nodeReads != 0 {
		t.Fatalf("%d node reads for bad requests", src.nodeReads)
	}
	src.nodeErr = apierrors.NewNotFound(schema.GroupResource{Resource: "nodes"}, "n9")
	if w, _ := f.get(t, neighborsPath, "n9", flowReader); w.Code != http.StatusNotFound || strings.Contains(w.Body.String(), "is off") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	src.nodeErr = nodeCPUForbidden("nodes")
	if w, _ := f.get(t, neighborsPath, "n1", flowReader); w.Code != http.StatusForbidden {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if len(src.queries) != 0 {
		t.Fatalf("%d queries for a node that was not read", len(src.queries))
	}
}

func TestNodeNeighborsForALimitedGrantDoesNotShowTheNodesRequests(t *testing.T) {
	in := nodecpu.Input{}
	desc := map[string]interface{}{"allocatable": map[string]string{"cpu": "4"}, "allocated_scope": []string{"shop"},
		"allocated_resources": []map[string]string{{"resource": "cpu", "requests": "540m (13%)"}}}
	if fillNodeInput(&in, desc); in.Requests != "" || in.Allocatable != 4 {
		t.Fatalf("%+v", in)
	}
}

func TestNodeNeighborsMatchesTheNodesIPAddressesOnly(t *testing.T) {
	in := nodecpu.Input{}
	got := fillNodeInput(&in, map[string]interface{}{"addresses": []map[string]interface{}{
		{"type": "InternalIP", "address": "10.0.0.1"}, {"type": "Hostname", "address": "some-host"}, {"type": "InternalDNS", "address": "some.dns"}, {"type": "ExternalIP", "address": "203.0.113.7"}}})
	if strings.Join(got, ",") != "10.0.0.1,203.0.113.7" {
		t.Fatalf("%v", got)
	}
}
