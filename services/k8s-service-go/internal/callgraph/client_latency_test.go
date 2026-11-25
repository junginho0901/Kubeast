package callgraph

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/prometheus/promql/parser"
)

var plainLabels = []string{"__name__", "client", "server"}

func shapeOf(t *testing.T, labels ...string) Shape {
	t.Helper()
	s, ok := DetectShape(append(append([]string{}, plainLabels...), labels...), "k8s.namespace.name")
	if !ok {
		t.Fatal("no shape")
	}
	return s
}

// The client side's query is the server side's over the client histogram, by connection_type too where the metric has
// that label; the label changes none of the other queries.
func TestBuildQueriesClientSide(t *testing.T) {
	namespaced := []string{"client_k8s_namespace_name", "server_k8s_namespace_name"}
	for _, labels := range [][]string{nil, namespaced} {
		without := shapeOf(t, labels...)
		with := shapeOf(t, append([]string{"connection_type"}, labels...)...)
		if without.Connection || !with.Connection {
			t.Fatalf("connection_type: %+v %+v", without, with)
		}
		q, typed := BuildQueries(without, "shop", time.Hour), BuildQueries(with, "shop", time.Hour)
		if want := strings.ReplaceAll(q.P90, ServerSeconds, ClientSeconds); q.ClientP90 != want {
			t.Errorf("without the label:\n%s\nwant\n%s", q.ClientP90, want)
		}
		if n := strings.Count(typed.ClientP90, ", connection_type)"); n != strings.Count(q.ClientP90, "sum by (") || strings.ReplaceAll(typed.ClientP90, ", connection_type", "") != q.ClientP90 {
			t.Errorf("with the label: %s", typed.ClientP90)
		}
		if typed.Requests != q.Requests || typed.Failed != q.Failed || typed.P90 != q.P90 {
			t.Errorf("the label changes the other queries: %+v", typed)
		}
		for _, query := range []string{q.ClientP90, typed.ClientP90} {
			if _, err := parser.NewParser(parser.Options{}).ParseExpr(query); err != nil {
				t.Errorf("%s: %v", query, err)
			}
			if !strings.Contains(query, "[3600s]") || strings.HasPrefix(query, fmt.Sprintf("topk(%d,", MaxSeries)) != (labels == nil) ||
				strings.Contains(query, `server_k8s_namespace_name="shop"`) != (labels != nil) {
				t.Errorf("range, cap or namespace: %s", query)
			}
		}
	}
}

// web waits 1.3 s for api's 3 ms, as with a delay between the two; api and db take as long on both sides. The client side
// makes no edge of its own, and what was not read (NaN, infinite, 0) is left out.
func TestBuildPutsTheClientSideBesideTheServers(t *testing.T) {
	tr := &Traces{Shape: Shape{Workloads: map[string]string{}, Connection: true},
		Requests: []Sample{sample(900, "client", "web-svc", "server", "api"), sample(500, "client", "api", "server", "db"), sample(100, "client", "api", "server", "cache")},
		P90:      []Sample{sample(0.003, "client", "web-svc", "server", "api"), sample(0.04, "client", "api", "server", "db")},
		ClientP90: []Sample{
			sample(1.3, "client", "web-svc", "server", "api"), sample(0.0421, "client", "api", "server", "db"),
			sample(math.NaN(), "client", "api", "server", "cache"), sample(math.Inf(1), "client", "api", "server", "cache"), sample(0, "client", "api", "server", "cache"),
			sample(9, "client", "web-svc", "server", "cache"),
		},
	}
	edges, total, _ := Build(shopIndex(), tr, nil)
	if total != 3 {
		t.Fatalf("edges %+v", edges)
	}
	want := map[string][2]float64{"Deployment/shop/api": {3, 1300}, "StatefulSet/shop/db": {40, 42.1}, "Deployment/shop/cache": {0, 0}}
	for _, e := range edges {
		if w := want[e.To.ID]; e.P90Ms != w[0] || e.ClientP90Ms != w[1] || e.ConnectionType != "" {
			t.Errorf("%s: %v %v %q, want %v", e.To.ID, e.P90Ms, e.ClientP90Ms, e.ConnectionType, w)
		}
	}
	raw, err := json.Marshal(edges[0])
	if err != nil || !strings.Contains(string(raw), `"p90_ms":3`) || !strings.Contains(string(raw), `"client_p90_ms":1300`) || strings.Contains(string(raw), "connection_type") {
		t.Fatalf("%s %v", raw, err)
	}
	outside := TimeOutsideCallee(edges)
	if !reflect.DeepEqual(outside, []Outside{{From: "Deployment/shop/web", To: "Deployment/shop/api", ClientP90Ms: 1300, P90Ms: 3, OutsideMs: 1297}}) {
		t.Fatalf("outside the callee: %+v", outside)
	}
	// the same edges without the client side: its two fields are not written, and nothing is listed
	tr.ClientP90 = nil
	edges, _, _ = Build(shopIndex(), tr, nil)
	raw, _ = json.Marshal(edges)
	if strings.Contains(string(raw), "client_p90") || strings.Contains(string(raw), "connection_type") || TimeOutsideCallee(edges) != nil {
		t.Fatalf("not asked: %s", raw)
	}
}

// An edge takes the client side of its traced calls before that of a database, a queue or a virtual node, whichever comes
// first in the answer, and the slowest of one kind; only the latter kind names its connection_type and is not compared.
func TestClientSideOfCallsThatAreNotTwoEnds(t *testing.T) {
	plain := func(v float64) Sample { return sample(v, "client", "web-svc", "server", "api") }
	typed := func(v float64, connection string) Sample {
		return sample(v, "client", "web-svc", "server", "api", "connection_type", connection)
	}
	for name, c := range map[string]struct {
		answer []Sample
		ms     float64
		kind   string
	}{
		"traced, then a virtual node":    {[]Sample{plain(0.2), typed(9, "virtual_node")}, 200, ""},
		"a virtual node, then traced":    {[]Sample{typed(9, "virtual_node"), plain(0.2)}, 200, ""},
		"the slowest of the traced":      {[]Sample{plain(0.2), plain(0.5), plain(0.3)}, 500, ""},
		"the slowest of the others":      {[]Sample{typed(0.2, "database"), typed(0.5, "virtual_node"), typed(0.3, "database")}, 500, "virtual_node"},
		"a database alone":               {[]Sample{typed(0.8, "database")}, 800, "database"},
		"a queue alone":                  {[]Sample{typed(0.8, "messaging_system")}, 800, "messaging_system"},
		"a virtual node's untraced side": {[]Sample{typed(0, "virtual_node")}, 0, ""},
	} {
		edges, _, _ := Build(shopIndex(), &Traces{Shape: Shape{Connection: true}, Requests: []Sample{plain(10)}, P90: []Sample{plain(0.002)}, ClientP90: c.answer}, nil)
		if len(edges) != 1 || edges[0].ClientP90Ms != c.ms || edges[0].ConnectionType != c.kind {
			t.Errorf("%s: %+v", name, edges)
			continue
		}
		if out := TimeOutsideCallee(edges); (len(out) == 1) != (c.kind == "" && c.ms > 0) {
			t.Errorf("%s compared: %+v", name, out)
		}
	}
}

func TestTimeOutsideCallee(t *testing.T) {
	end := func(name string) End { return End{ID: "Deployment/shop/" + name} }
	edge := func(to string, server, client float64) Edge {
		return Edge{From: end("web"), To: end(to), P90Ms: server, ClientP90Ms: client}
	}
	// at the bounds: twice the callee's and 50 ms above it; one below either is not listed, nor is a side not read
	got := TimeOutsideCallee([]Edge{
		edge("at", 50, 100), edge("ratio", 100, 199.9), edge("small", 10, 59.9), edge("server-slow", 1300, 1310),
		edge("no-server", 0, 900), edge("no-client", 900, 0), edge("faster", 900, 20),
	})
	if len(got) != 1 || got[0].To != "Deployment/shop/at" || got[0].OutsideMs != 50 {
		t.Fatalf("%+v", got)
	}
	// the largest difference first, at most MaxOutside; an end that is no box of the graph by its name
	var many []Edge
	for i := 0; i < MaxOutside+3; i++ {
		many = append(many, edge(fmt.Sprintf("s%d", i), 10, float64(100+i)))
	}
	many = append(many, Edge{From: End{Service: "gate"}, To: End{Namespace: "billing", Kind: "Deployment", Name: "pay"}, P90Ms: 1, ClientP90Ms: 5000.05})
	got = TimeOutsideCallee(many)
	if len(got) != MaxOutside || got[0] != (Outside{From: "service gate", To: "Deployment/billing/pay", ClientP90Ms: 5000.05, P90Ms: 1, OutsideMs: 4999.1}) || got[1].To != "Deployment/shop/s7" {
		t.Fatalf("%+v", got)
	}
	if TimeOutsideCallee(nil) != nil {
		t.Fatal("no edges")
	}
}

// Without the namespace labels the client side's query is capped too: a full answer says an edge's may not have been
// read, and does not mark the traces themselves as cut.
func TestAFullClientAnswerIsItsOwnCut(t *testing.T) {
	var full []Sample
	for i := 0; i < MaxSeries; i++ {
		full = append(full, sample(1, "client", fmt.Sprintf("c%d", i), "server", "s"))
	}
	for name, c := range map[string]struct {
		tr   *Traces
		want bool
	}{
		"full":             {&Traces{ClientP90: full}, true},
		"short of the cap": {&Traces{ClientP90: full[1:]}, false},
		"namespace labels": {&Traces{Shape: Shape{Namespace: "k8s_namespace_name"}, ClientP90: full}, false},
	} {
		if c.tr.ClientCut() != c.want || c.tr.Cut() {
			t.Errorf("%s: client cut %v, cut %v", name, c.tr.ClientCut(), c.tr.Cut())
		}
	}
}
