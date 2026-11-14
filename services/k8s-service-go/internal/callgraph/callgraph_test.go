package callgraph

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/prometheus/promql/parser"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nettraffic"
)

// shop: Deployment web (Service web-svc), Deployment api (Service api), Deployment cache and StatefulSet db behind one
// Service shared, a Job with no Service.
func shopGraph() ([]Node, []GraphEdge) {
	nodes := []Node{
		{ID: "Deployment/shop/web", Kind: "Deployment", Name: "web", Namespace: "shop", Health: "warn"},
		{ID: "ReplicaSet/shop/web-7d9", Kind: "ReplicaSet", Name: "web-7d9", Namespace: "shop", Health: "ok"},
		{ID: "Pod/shop/web-7d9-group", Kind: "Pod", Name: "web-7d9 (12)", Namespace: "shop", Group: true, Health: "ok"},
		{ID: "Service/shop/web-svc", Kind: "Service", Name: "web-svc", Namespace: "shop"},
		{ID: "Deployment/shop/api", Kind: "Deployment", Name: "api", Namespace: "shop", Health: "error"},
		{ID: "ReplicaSet/shop/api-5f", Kind: "ReplicaSet", Name: "api-5f", Namespace: "shop"},
		{ID: "Pod/shop/api-5f-x1", Kind: "Pod", Name: "api-5f-x1", Namespace: "shop", Health: "error"},
		{ID: "Service/shop/api", Kind: "Service", Name: "api", Namespace: "shop"},
		{ID: "Deployment/shop/cache", Kind: "Deployment", Name: "cache", Namespace: "shop", Health: "ok"},
		{ID: "ReplicaSet/shop/cache-1", Kind: "ReplicaSet", Name: "cache-1", Namespace: "shop"},
		{ID: "Pod/shop/cache-1-a", Kind: "Pod", Name: "cache-1-a", Namespace: "shop", Health: "ok"},
		{ID: "StatefulSet/shop/db", Kind: "StatefulSet", Name: "db", Namespace: "shop", Health: "ok"},
		{ID: "Pod/shop/db-0", Kind: "Pod", Name: "db-0", Namespace: "shop", Health: "ok"},
		{ID: "Service/shop/shared", Kind: "Service", Name: "shared", Namespace: "shop"},
		{ID: "Job/shop/migrate", Kind: "Job", Name: "migrate", Namespace: "shop", Health: "ok"},
	}
	edges := []GraphEdge{
		{"Deployment/shop/web", "ReplicaSet/shop/web-7d9", "owns"},
		{"ReplicaSet/shop/web-7d9", "Pod/shop/web-7d9-group", "owns"},
		{"Service/shop/web-svc", "Pod/shop/web-7d9-group", "selects"},
		{"Deployment/shop/api", "ReplicaSet/shop/api-5f", "owns"},
		{"ReplicaSet/shop/api-5f", "Pod/shop/api-5f-x1", "owns"},
		{"Service/shop/api", "Pod/shop/api-5f-x1", "selects"},
		{"Deployment/shop/cache", "ReplicaSet/shop/cache-1", "owns"},
		{"ReplicaSet/shop/cache-1", "Pod/shop/cache-1-a", "owns"},
		{"StatefulSet/shop/db", "Pod/shop/db-0", "owns"},
		{"Service/shop/shared", "Pod/shop/cache-1-a", "selects"},
		{"Service/shop/shared", "Pod/shop/db-0", "selects"},
	}
	return nodes, edges
}

func shopIndex() *Index {
	nodes, edges := shopGraph()
	return NewIndex("shop", nodes, edges)
}

func TestDetectShape(t *testing.T) {
	if _, ok := DetectShape([]string{"__name__", "client", "connection_type"}, "k8s.namespace.name"); ok {
		t.Fatal("no server label")
	}
	s, ok := DetectShape([]string{"__name__", "client", "server", "connection_type"}, "k8s.namespace.name")
	if !ok || s.Namespace != "" || len(s.Workloads) != 0 {
		t.Fatalf("plain: %+v %v", s, ok)
	}
	s, ok = DetectShape([]string{"client", "server", "client_k8s_namespace_name", "server_k8s_namespace_name", "client_k8s_deployment_name", "server_k8s_deployment_name", "server_k8s_statefulset_name"}, "k8s.namespace.name")
	if !ok || s.Namespace != "k8s_namespace_name" || !reflect.DeepEqual(s.Workloads, map[string]string{"k8s_deployment_name": "Deployment"}) {
		t.Fatalf("dimensions (a workload label on one side only does not count): %+v", s)
	}
}

func TestBuildQueriesParse(t *testing.T) {
	for _, s := range []Shape{{Workloads: map[string]string{}}, {Namespace: "k8s_namespace_name", Workloads: map[string]string{"k8s_deployment_name": "Deployment"}}} {
		q := BuildQueries(s, "shop", time.Hour)
		for _, query := range []string{q.Requests, q.Failed, q.P90} {
			if _, err := parser.NewParser(parser.Options{}).ParseExpr(query); err != nil {
				t.Fatalf("%s: %v", query, err)
			}
			if !strings.Contains(query, "[3600s]") {
				t.Fatalf("range: %s", query)
			}
			if s.Namespace != "" && (!strings.Contains(query, `server_k8s_namespace_name="shop"`) || !strings.Contains(query, `client_k8s_namespace_name="shop"`)) {
				t.Fatalf("namespace halves: %s", query)
			}
			if s.Namespace == "" && !strings.HasPrefix(query, fmt.Sprintf("topk(%d,", MaxSeries)) {
				t.Fatalf("no namespace labels: at most MaxSeries series, the 90th percentile too: %s", query)
			}
			if s.Namespace != "" && strings.Contains(query, "topk(") {
				t.Fatalf("namespace labels: the namespace's series, no cap: %s", query)
			}
		}
	}
}

func TestPlaceService(t *testing.T) {
	ix := shopIndex()
	none := map[string]string{}
	for _, c := range []struct {
		service, namespace string
		workloads          map[string]string
		want               End
	}{
		// no namespace on the metric: placed by name in this namespace, which another namespace's service of that name also fits
		{"api", "", none, End{ID: "Deployment/shop/api", Namespace: "shop", Kind: "Deployment", Name: "api", MatchedBy: "workload_name_unscoped"}},
		{"web-svc", "", none, End{ID: "Deployment/shop/web", Namespace: "shop", Kind: "Deployment", Name: "web", MatchedBy: "service_selector_unscoped"}},
		// a Service selecting two workloads stays the Service
		{"shared", "", none, End{ID: "Service/shop/shared", Namespace: "shop", Kind: "Service", Name: "shared", MatchedBy: "service_selector_unscoped"}},
		{"frontend", "", none, End{Service: "frontend"}},
		{"cache", "", map[string]string{"k8s_deployment_name": "cache"}, End{ID: "Deployment/shop/cache", Namespace: "shop", Kind: "Deployment", Name: "cache", MatchedBy: "labels_unscoped"}},
		// the metric names this namespace: the same names, scoped
		{"api", "shop", none, End{ID: "Deployment/shop/api", Namespace: "shop", Kind: "Deployment", Name: "api", MatchedBy: "workload_name"}},
		{"web-svc", "shop", none, End{ID: "Deployment/shop/web", Namespace: "shop", Kind: "Deployment", Name: "web", MatchedBy: "service_selector"}},
		{"checkout", "shop", map[string]string{"k8s_deployment_name": "web"}, End{ID: "Deployment/shop/web", Namespace: "shop", Kind: "Deployment", Name: "web", MatchedBy: "labels"}},
		{"payments", "billing", map[string]string{"k8s_deployment_name": "payments"}, End{Namespace: "billing", Kind: "Deployment", Name: "payments", MatchedBy: "labels"}},
		{"payments", "billing", none, End{Namespace: "billing", Service: "payments", MatchedBy: "labels"}},
		// a group of pods and a ReplicaSet are never matched by name
		{"web-7d9", "", none, End{Service: "web-7d9"}},
	} {
		if got := ix.placeService(c.service, c.namespace, c.workloads); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s/%s: %+v, want %+v", c.namespace, c.service, got, c.want)
		}
	}
}

func sample(value float64, kv ...string) Sample {
	l := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		l[kv[i]] = kv[i+1]
	}
	return Sample{Labels: l, Value: value}
}

func TestBuildFoldsTracesAndTraffic(t *testing.T) {
	ix := shopIndex()
	tr := &Traces{Shape: Shape{Workloads: map[string]string{}},
		Requests: []Sample{
			sample(1200, "client", "web-svc", "server", "api"),
			sample(300, "client", "frontend", "server", "web-svc"),
			sample(900, "client", "elsewhere", "server", "unrelated"), // neither end in shop
			sample(0, "client", "web-svc", "server", "shared"),
		},
		Failed: []Sample{sample(240, "client", "web-svc", "server", "api")},
		P90:    []Sample{sample(0.4321, "client", "web-svc", "server", "api"), sample(0, "client", "frontend", "server", "web-svc")},
	}
	traffic := []nettraffic.Line{
		{From: nettraffic.End{Namespace: "shop", Kind: "Deployment", Name: "web"}, To: nettraffic.End{Namespace: "shop", Kind: "Deployment", Name: "api"}, Allowed: 40},
		{From: nettraffic.End{Namespace: "shop", Kind: "Deployment", Name: "api"}, To: nettraffic.End{Namespace: "ops"}, Allowed: 3, Dropped: 2},
	}
	edges, total, truncated := Build(ix, tr, traffic)
	if total != 3 || truncated || len(edges) != 3 {
		t.Fatalf("%d %v %+v", total, truncated, edges)
	}
	webAPI := edges[0]
	if webAPI.From.ID != "Deployment/shop/web" || webAPI.To.ID != "Deployment/shop/api" || webAPI.Requests != 1200 || webAPI.Errors != 240 ||
		webAPI.ErrorRatio != 0.2 || webAPI.P90Ms != 432.1 || webAPI.Connections != 40 || !reflect.DeepEqual(webAPI.Sources, []string{SourceTraces, SourceNetwork}) {
		t.Fatalf("web → api from both sources: %+v", webAPI)
	}
	if e := edges[1]; e.From.Service != "frontend" || e.To.ID != "Deployment/shop/web" || e.P90Ms != 0 {
		t.Fatalf("an unmatched caller keeps its service name: %+v", e)
	}
	if e := edges[2]; e.To.Namespace != "ops" || e.To.Name != "" || e.Dropped != 2 || !e.Failing() {
		t.Fatalf("a peer outside the grant keeps its namespace: %+v", e)
	}
}

func TestBuildCapsTheEdges(t *testing.T) {
	ix := shopIndex()
	tr := &Traces{Shape: Shape{Workloads: map[string]string{}}}
	for i := 0; i < MaxEdges+20; i++ {
		tr.Requests = append(tr.Requests, sample(float64(i+1), "client", fmt.Sprintf("caller-%03d", i), "server", "api"))
	}
	edges, total, truncated := Build(ix, tr, nil)
	if total != MaxEdges+20 || !truncated || len(edges) != MaxEdges || edges[0].Requests != MaxEdges+20 || edges[MaxEdges-1].Requests != 21 {
		t.Fatalf("%d %v %d first %d last %d", total, truncated, len(edges), edges[0].Requests, edges[len(edges)-1].Requests)
	}
}

// web calls api and both fail: api, which calls nothing failing, comes first, and the path runs from it to web.
func TestSuspectsPutTheCalleeFirst(t *testing.T) {
	ix := shopIndex()
	tr := &Traces{Shape: Shape{Workloads: map[string]string{}},
		Requests: []Sample{sample(1000, "client", "web-svc", "server", "api"), sample(500, "client", "api", "server", "db")},
		Failed:   []Sample{sample(300, "client", "web-svc", "server", "api"), sample(2, "client", "api", "server", "db")},
	}
	edges, _, _ := Build(ix, tr, nil)
	rk := Suspects(ix, edges)
	suspects, paths := rk.Suspects, rk.Paths
	if rk.Total != 2 || rk.NoStart != "" || len(suspects[0].FailingOutside) != 0 {
		t.Fatalf("total %d no_start %q: %+v", rk.Total, rk.NoStart, suspects)
	}
	if len(suspects) != 2 || suspects[0].ID != "Deployment/shop/api" || len(suspects[0].FailingCallees) != 0 ||
		!reflect.DeepEqual(suspects[0].FailingCallers, []string{"Deployment/shop/web"}) || !reflect.DeepEqual(suspects[0].Signals, []string{"health", "calls_fail"}) {
		t.Fatalf("api first: %+v", suspects)
	}
	if suspects[1].ID != "Deployment/shop/web" || !reflect.DeepEqual(suspects[1].FailingCallees, []string{"Deployment/shop/api"}) {
		t.Fatalf("web second, as api's caller: %+v", suspects)
	}
	if !reflect.DeepEqual(paths, [][]string{{"Deployment/shop/api", "Deployment/shop/web"}}) {
		t.Fatalf("paths %v", paths)
	}
	// db is well and 2 failed calls of 500 do not count: not a suspect
	for _, s := range suspects {
		if s.ID == "StatefulSet/shop/db" || s.ID == "Service/shop/shared" {
			t.Fatalf("db: %+v", s)
		}
	}
}

// Nothing failing: no suspect and no path; a cycle of failing workloads ends without a start.
func TestSuspectsQuietAndCycle(t *testing.T) {
	nodes, graphEdges := shopGraph()
	for i := range nodes {
		nodes[i].Health = "ok"
	}
	ix := NewIndex("shop", nodes, graphEdges)
	edges, _, _ := Build(ix, &Traces{Shape: Shape{Workloads: map[string]string{}}, Requests: []Sample{sample(10, "client", "web-svc", "server", "api")}}, nil)
	if rk := Suspects(ix, edges); len(rk.Suspects) != 0 || len(rk.Paths) != 0 || rk.Total != 0 || rk.NoStart != "" {
		t.Fatalf("quiet: %+v", rk)
	}
	cycle := []Edge{
		{From: ix.end("Deployment/shop/web", ""), To: ix.end("Deployment/shop/api", ""), Requests: 100, Errors: 50, ErrorRatio: 0.5},
		{From: ix.end("Deployment/shop/api", ""), To: ix.end("Deployment/shop/web", ""), Requests: 100, Errors: 50, ErrorRatio: 0.5},
	}
	rk := Suspects(ix, cycle)
	if len(rk.Suspects) != 2 || len(rk.Suspects[0].FailingCallees) == 0 || len(rk.Paths) != 0 || rk.NoStart != NoStartCycle {
		t.Fatalf("cycle: %+v", rk)
	}
	// web → cache dropped and api now calls cache well: cache calls nothing failing, a start, so no_start stays empty
	cache := ix.end("Deployment/shop/cache", "")
	withStart := append(append([]Edge{}, cycle...), Edge{From: ix.end("Deployment/shop/web", ""), To: cache, Requests: 10, Dropped: 3})
	withStart[1].To, withStart[1].Errors = cache, 0
	if rk := Suspects(ix, withStart); rk.NoStart != "" || rk.Suspects[0].ID != "Deployment/shop/cache" || len(rk.Paths) == 0 {
		t.Fatalf("a start: %+v", rk)
	}
}

// api's calls to a database (a trace service name) and to another namespace fail: named on api, the order unchanged.
func TestSuspectsFailingOutside(t *testing.T) {
	ix := shopIndex()
	tr := &Traces{Shape: Shape{Workloads: map[string]string{}},
		Requests: []Sample{sample(1000, "client", "web-svc", "server", "api"), sample(400, "client", "api", "server", "postgresql"), sample(100, "client", "api", "server", "cache")},
		Failed:   []Sample{sample(300, "client", "web-svc", "server", "api"), sample(390, "client", "api", "server", "postgresql")},
	}
	traffic := []nettraffic.Line{
		{From: nettraffic.End{Namespace: "shop", Kind: "Deployment", Name: "api"}, To: nettraffic.End{Namespace: "billing", Kind: "Deployment", Name: "payments"}, Allowed: 5, Dropped: 4},
		{From: nettraffic.End{Namespace: "shop", Kind: "Deployment", Name: "web"}, To: nettraffic.End{Outside: "world"}, Allowed: 50},
	}
	edges, _, _ := Build(ix, tr, traffic)
	rk := Suspects(ix, edges)
	if rk.Suspects[0].ID != "Deployment/shop/api" || !reflect.DeepEqual(rk.Suspects[0].FailingOutside, []string{"Deployment/billing/payments", "service postgresql"}) {
		t.Fatalf("api: %+v", rk.Suspects)
	}
	if rk.Suspects[1].ID != "Deployment/shop/web" || rk.Suspects[1].FailingOutside != nil {
		t.Fatalf("web's call to the world does not fail: %+v", rk.Suspects[1])
	}
	for _, c := range []struct {
		end  End
		want string
	}{
		{End{Namespace: "ops"}, "namespace ops"},
		{End{Namespace: "ops", Name: "agent"}, "ops/agent"},
		{End{Namespace: "billing", Service: "payments", MatchedBy: "labels"}, "service billing/payments"},
		{End{Outside: "api.example.com"}, "api.example.com"},
		{End{Unnamed: true}, "unnamed"},
	} {
		if got := c.end.outsideName(); got != c.want {
			t.Errorf("%+v: %q, want %q", c.end, got, c.want)
		}
	}
}

// More failing workloads than MaxSuspects: the first MaxSuspects in order, with the total.
func TestSuspectsAreCapped(t *testing.T) {
	var nodes []Node
	var edges []Edge
	for i := 0; i < MaxSuspects+5; i++ {
		nodes = append(nodes, Node{ID: fmt.Sprintf("Deployment/shop/w%02d", i), Kind: "Deployment", Name: fmt.Sprintf("w%02d", i), Namespace: "shop", Health: "error"})
	}
	nodes = append(nodes, Node{ID: "Deployment/shop/front", Kind: "Deployment", Name: "front", Namespace: "shop", Health: "error"})
	ix := NewIndex("shop", nodes, nil)
	// front calls the last one: that one has a failing caller and comes first
	last := fmt.Sprintf("Deployment/shop/w%02d", MaxSuspects+4)
	edges = append(edges, Edge{From: ix.end("Deployment/shop/front", ""), To: ix.end(last, ""), Requests: 100, Errors: 50, ErrorRatio: 0.5})
	rk := Suspects(ix, edges)
	if rk.Total != MaxSuspects+6 || len(rk.Suspects) != MaxSuspects || rk.Suspects[0].ID != last {
		t.Fatalf("total %d kept %d first %s", rk.Total, len(rk.Suspects), rk.Suspects[0].ID)
	}
	if !reflect.DeepEqual(rk.Paths, [][]string{{last, "Deployment/shop/front"}}) {
		t.Fatalf("paths %v", rk.Paths)
	}
}

// Two traffic lines on one edge: their drop reasons are summed, most first.
func TestBuildCarriesDropReasons(t *testing.T) {
	ix := shopIndex()
	traffic := []nettraffic.Line{
		{From: nettraffic.End{Namespace: "shop", Kind: "Deployment", Name: "web"}, To: nettraffic.End{Namespace: "shop", Kind: "Deployment", Name: "api"}, Allowed: 10, Dropped: 5,
			Reasons: []netdrops.Reason{{Reason: "POLICY_DENIED", Count: 4}, {Reason: "CT_MAP_INSERTION_FAILED", Count: 1}}},
		{From: nettraffic.End{Namespace: "shop", Kind: "Deployment", Name: "web"}, To: nettraffic.End{Namespace: "shop", Kind: "Deployment", Name: "api"}, Dropped: 9,
			Reasons: []netdrops.Reason{{Reason: "POLICY_DENIED", Count: 7}, {Reason: "STALE_OR_UNROUTABLE_IP", Count: 2}}},
		{From: nettraffic.End{Namespace: "shop", Kind: "Deployment", Name: "api"}, To: nettraffic.End{Namespace: "shop", Kind: "StatefulSet", Name: "db"}, Allowed: 30},
	}
	edges, _, _ := Build(ix, nil, traffic)
	var webAPI, apiDB *Edge
	for i := range edges {
		switch edges[i].From.ID + "→" + edges[i].To.ID {
		case "Deployment/shop/web→Deployment/shop/api":
			webAPI = &edges[i]
		case "Deployment/shop/api→StatefulSet/shop/db":
			apiDB = &edges[i]
		}
	}
	want := []netdrops.Reason{{Reason: "POLICY_DENIED", Count: 11}, {Reason: "STALE_OR_UNROUTABLE_IP", Count: 2}, {Reason: "CT_MAP_INSERTION_FAILED", Count: 1}}
	if webAPI == nil || webAPI.Dropped != 14 || !reflect.DeepEqual(webAPI.DropReasons, want) {
		t.Fatalf("web → api: %+v", webAPI)
	}
	if apiDB == nil || apiDB.DropReasons != nil {
		t.Fatalf("no drops, no reasons: %+v", apiDB)
	}
}
