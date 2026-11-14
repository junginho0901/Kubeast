package callgraph

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/prometheus/promql/parser"

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
			if _, err := parser.ParseExpr(query); err != nil {
				t.Fatalf("%s: %v", query, err)
			}
			if !strings.Contains(query, "[3600s]") {
				t.Fatalf("range: %s", query)
			}
			if s.Namespace != "" && (!strings.Contains(query, `server_k8s_namespace_name="shop"`) || !strings.Contains(query, `client_k8s_namespace_name="shop"`)) {
				t.Fatalf("namespace halves: %s", query)
			}
			if s.Namespace == "" && !strings.Contains(query, fmt.Sprintf("topk(%d,", MaxSeries)) && query != q.P90 {
				t.Fatalf("no namespace labels: the busiest series only: %s", query)
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
		{"api", "", none, End{ID: "Deployment/shop/api", Namespace: "shop", Kind: "Deployment", Name: "api", MatchedBy: "workload_name"}},
		{"web-svc", "", none, End{ID: "Deployment/shop/web", Namespace: "shop", Kind: "Deployment", Name: "web", MatchedBy: "service_selector"}},
		// a Service selecting two workloads stays the Service
		{"shared", "", none, End{ID: "Service/shop/shared", Namespace: "shop", Kind: "Service", Name: "shared", MatchedBy: "service_selector"}},
		{"frontend", "", none, End{Service: "frontend"}},
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
	suspects, paths := Suspects(ix, edges)
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
	if s, p := Suspects(ix, edges); len(s) != 0 || len(p) != 0 {
		t.Fatalf("quiet: %+v %v", s, p)
	}
	cycle := []Edge{
		{From: ix.end("Deployment/shop/web", ""), To: ix.end("Deployment/shop/api", ""), Requests: 100, Errors: 50, ErrorRatio: 0.5},
		{From: ix.end("Deployment/shop/api", ""), To: ix.end("Deployment/shop/web", ""), Requests: 100, Errors: 50, ErrorRatio: 0.5},
	}
	s, p := Suspects(ix, cycle)
	if len(s) != 2 || len(s[0].FailingCallees) == 0 || len(p) != 0 {
		t.Fatalf("cycle: %+v %v", s, p)
	}
}
