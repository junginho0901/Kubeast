package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nodecpu"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

const busiestPath = "/api/v1/metrics/nodes/busiest-cpu"

func newBusiestFixture(src *fakeNodeCPU) *nodeCPUFixture {
	f := newNodeCPUFixture(src)
	f.n.busiest = true
	return f
}

func (f *nodeCPUFixture) line(t *testing.T, payload auth.TokenPayload) (*httptest.ResponseRecorder, nodecpu.BusiestResult) {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, busiestPath, nil)
	ctx := context.WithValue(r.Context(), auth.TokenPayloadContextKey(), payload)
	ctx = cluster.WithID(ctx, cluster.ID("self"))
	w := httptest.NewRecorder()
	f.n.Busiest(w, r.WithContext(ctx))
	var res nodecpu.BusiestResult
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatal(err)
		}
	}
	return w, res
}

func TestNodeBusiestIsOffUntilBothItsSwitchesAreOn(t *testing.T) {
	for _, c := range []struct {
		neighbors, busiest string
		want               bool
	}{{"", "", false}, {"true", "", false}, {"", "true", false}, {"false", "true", false}, {"true", "no", false}, {"true", "true", true}, {"1", " On ", true}} {
		t.Setenv("NODE_NEIGHBORS_ENABLED", c.neighbors)
		t.Setenv("NODE_NEIGHBORS_BUSIEST_CPU", c.busiest)
		n := (&Handler{}).NodeNeighbors()
		if NodeBusiestOn() != c.want || n.busiest != c.want {
			t.Errorf("%+v: %v, %v", c, NodeBusiestOn(), n.busiest)
		}
	}
	for _, off := range []*NodeNeighbors{{on: true}, {busiest: true}, {}} {
		src := &fakeNodeCPU{prometheus: true}
		f := newNodeCPUFixture(src)
		f.n.on, f.n.busiest = off.on, off.busiest
		w, _ := f.line(t, flowReader)
		if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "features.nodeNeighbors.busiestCPU") || src.nodeNames+len(src.queries)+src.podReads > 0 {
			t.Errorf("on %v, busiest %v: %d %s, %+v", off.on, off.busiest, w.Code, w.Body, src)
		}
	}
}

func TestNodeBusiestNamesTheCPUAndThePodsOfEveryNamespace(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true}
	f := newBusiestFixture(src)
	w, res := f.line(t, flowReader)
	if w.Code != http.StatusOK || res.StoreQueries != 3 || res.StepSeconds != 120 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	for _, word := range []string{"over 2 nodes (30 steps of 2m)", "CPU 1 of Node/n1, 100% busy", "reports/monthly-report-x (Job/monthly-report) 0.98", "over every namespace", "node=n1"} {
		if !strings.Contains(res.Line, word) {
			t.Errorf("%q is not in %s", word, res.Line)
		}
	}
	// the whole hour, in steps of a thirtieth of it
	if len(src.ranges) != 3 {
		t.Fatalf("%v", src.ranges)
	}
	end := nodeCPUNow.Truncate(time.Minute).Unix()
	for i, r := range src.ranges {
		if want := [3]int64{end - 3600 + 120, end, 120}; r != want {
			t.Errorf("%s: %v, want %v", src.queries[i], r, want)
		}
	}
	// the nodes' series alone, then the chosen node's own, and no audit row
	if q := src.queries[0]; !strings.Contains(q, `node=~"n(?:1|2)"`) || !strings.Contains(q, `instance=~"(?:n(?:1|2)|10.0.0.(?:1|2))(?::[0-9]+)?"`) {
		t.Errorf("%s", q)
	}
	for _, q := range src.queries[1:] {
		if !strings.Contains(q, `node="n1"`) {
			t.Errorf("%s", q)
		}
	}
	if f.rows.n != 0 {
		t.Fatalf("%d audit rows", f.rows.n)
	}
}

func TestNodeBusiestRefusedThePodsNamesOnlyNamespacesTheCallerMayList(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true, hidden: true, podsErr: nodeCPUForbidden("pods")}
	f := newBusiestFixture(src)
	f.allowed = map[string]bool{"shop": true}
	w, res := f.line(t, flowReader)
	if w.Code != http.StatusOK || len(f.asked) != 4 {
		t.Fatalf("%d, asked %v", w.Code, f.asked)
	}
	for _, word := range []string{"reports", "monthly", "payroll", "salary", "hr/", "leave"} {
		if strings.Contains(w.Body.String(), word) {
			t.Errorf("%q is in the answer: %s", word, w.Body)
		}
	}
	if !strings.Contains(res.Line, "shop/search-1") || !strings.Contains(res.Line, "3 pods in 3 namespaces whose pods you may not list, or it was not asked whether you may, used 1.48 together, counted and not named") || !strings.Contains(res.Line, "; the pods on the node: ") {
		t.Fatalf("%s", res.Line)
	}
}

func TestNodeBusiestForAGrantLimitedToNamespacesAsksNoPrometheus(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true, hidden: true}
	f := newBusiestFixture(src)
	limited := auth.TokenPayload{UserID: "u3", Perms: auth.PermissionMatrix{"self": {"resource.*.read"}}, Namespaces: map[string][]string{"self": {"shop"}}}
	_, res := f.line(t, limited)
	if len(src.queries) != 0 || src.podReads != 0 || !strings.Contains(res.Line, "limited to namespaces") {
		t.Fatalf("%v %s", src.queries, res.Line)
	}
}

func TestNodeBusiestSaysWhatItCouldNotRead(t *testing.T) {
	big := []map[string]interface{}{{"name": "n1", "capacity": map[string]string{"cpu": "1900"}}, {"name": "n2", "capacity": map[string]string{"cpu": "128"}}}
	var many []map[string]interface{}
	for i := range 1500 {
		many = append(many, map[string]interface{}{"name": fmt.Sprintf("worker-%04d", i), "capacity": map[string]string{"cpu": "1"}})
	}
	outside := []k8s.PrometheusRangeSeries{{Metric: map[string]interface{}{"cpu": "0", "instance": "203.0.113.9:9100"}, Points: []k8s.PrometheusRangePoint{{T: 1, V: 1}}}}
	for name, c := range map[string]struct {
		src     *fakeNodeCPU
		want    string
		queries int
	}{
		"no Prometheus":               {&fakeNodeCPU{}, "no Prometheus reaches this cluster", 0},
		"too many CPUs":               {&fakeNodeCPU{prometheus: true, nodes: big}, "the 2 nodes have 2028 CPUs together, more than the 2000 read at once", 0},
		"no node":                     {&fakeNodeCPU{prometheus: true, nodes: []map[string]interface{}{}}, "the cluster lists no node", 0},
		"too many names":              {&fakeNodeCPU{prometheus: true, nodes: many}, "the names of 1500 nodes do not fit one query: get_node_metrics with node reads one", 0},
		"the pods did not answer":     {&fakeNodeCPU{prometheus: true, podsErr: context.DeadlineExceeded}, "; the pods on the node did not answer in time;", 3},
		"a failed query":              {&fakeNodeCPU{prometheus: true, queryErr: errors.New("query failed")}, "Prometheus: query failed", 1},
		"only other hosts' CPUs":      {&fakeNodeCPU{prometheus: true, busiest: outside}, nodecpu.NoCPUsOfNodes, 1},
		"no CPU at all":               {&fakeNodeCPU{prometheus: true, busiest: []k8s.PrometheusRangeSeries{}}, nodecpu.NoCPUsOfNodes, 1},
		"no container series":         {&fakeNodeCPU{prometheus: true, noCPU: true}, "Which pods used it was not read", 4},
		"the containers by pod names": {&fakeNodeCPU{prometheus: true, noNode: true}, "reports/monthly-report-x (Job/monthly-report) 0.98", 4},
	} {
		f := newBusiestFixture(c.src)
		w, res := f.line(t, flowReader)
		if w.Code != http.StatusOK || !strings.Contains(res.Line, c.want) || len(c.src.queries) != c.queries || res.StoreQueries != c.queries || c.queries > nodecpu.BusiestQueries {
			t.Errorf("%s: %d, %d queries, %s", name, w.Code, len(c.src.queries), res.Line)
		}
	}
	f := newBusiestFixture(&fakeNodeCPU{prometheus: true, nodesErr: nodeCPUForbidden("nodes")})
	if w, _ := f.line(t, flowReader); w.Code != http.StatusForbidden {
		t.Errorf("nodes refused: %d %s", w.Code, w.Body)
	}
}

func TestNodeBusiestKeepsAWholeAnswerForTheSameCallerForAMinute(t *testing.T) {
	src := &fakeNodeCPU{prometheus: true}
	f := newBusiestFixture(src)
	f.line(t, flowReader)
	f.line(t, flowReader)
	if src.nodeNames != 1 {
		t.Fatalf("read %d times", src.nodeNames)
	}
	other := flowReader
	other.UserID, other.Email = "u2", "other@example.com"
	if f.line(t, other); src.nodeNames != 2 {
		t.Fatalf("another caller was given it: %d", src.nodeNames)
	}
	f.now = f.now.Add(time.Minute)
	if f.line(t, flowReader); src.nodeNames != 3 {
		t.Fatalf("an answer was kept past a minute: %d", src.nodeNames)
	}
	// an answer with a read that failed is not kept
	for _, failing := range []*fakeNodeCPU{{prometheus: true, queryErr: errors.New("query failed")}, {prometheus: true, podsErr: nodeCPUForbidden("pods")}} {
		f = newBusiestFixture(failing)
		f.line(t, flowReader)
		if f.line(t, flowReader); failing.nodeNames != 2 {
			t.Fatalf("a failed answer was kept: %d", failing.nodeNames)
		}
	}
}

// With busiestCPU a node's own window is cut in steps of at most a thirtieth of it; without, as before.
func TestNodeNeighborsWithBusiestCPUReadsFinerSteps(t *testing.T) {
	window := neighborsPath + "?start=2026-11-24T23:30:00Z&end=2026-11-25T01:30:00Z"
	for _, c := range []struct {
		busiest bool
		step    int
	}{{false, 600}, {true, 240}} {
		src := &fakeNodeCPU{prometheus: true}
		f := newNodeCPUFixture(src)
		f.n.busiest = c.busiest
		w, res := f.get(t, window, "n1", flowReader)
		if w.Code != http.StatusOK || res.StepSeconds != c.step || len(src.queries) != 5 {
			t.Errorf("%+v: %d, steps of %d, %d queries", c, w.Code, res.StepSeconds, len(src.queries))
		}
	}
}
