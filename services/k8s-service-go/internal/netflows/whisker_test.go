package netflows

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// whisker-flows.json is a GET /whisker-backend/flows answer of Calico v3.33.0's Whisker (kind, two nodes) read
// through the API server service proxy, with no filter: the demo's client reaching web (NetworkPolicy
// web-only-client), stranger denied at web, both looking up names in kube-system, and Calico's own components —
// among them the API server denied at Whisker (PRIVATE NETWORK → whisker:8443) before Whisker's policy let it in.
var whiskerNow = time.Date(2026, 10, 25, 12, 55, 30, 0, time.UTC)

func whiskerFixture(t *testing.T) []whiskerFlow {
	t.Helper()
	raw, err := os.ReadFile("testdata/whisker-flows.json")
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Items []whiskerFlow `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	return list.Items
}

func findWhisker(t *testing.T, items []whiskerFlow, src, dst, reporter, action string) whiskerFlow {
	t.Helper()
	for _, it := range items {
		if it.SourceNamespace+"/"+it.SourceName == src && it.DestNamespace+"/"+it.DestName == dst && it.Reporter == reporter && it.Action == action {
			return it
		}
	}
	t.Fatalf("no %s → %s %s %s in the fixture", src, dst, reporter, action)
	return whiskerFlow{}
}

func TestWhiskerItemsAsFlows(t *testing.T) {
	items := whiskerFixture(t)
	if len(items) != 20 {
		t.Fatalf("20 items, got %d", len(items))
	}
	// client → web seen arriving at web: allowed by the NetworkPolicy, the packets in from client and back
	in := findWhisker(t, items, "flows-demo/client-7bc956576c-*", "flows-demo/web-787b7df48d-*", "Dst", "Allow").flow()
	want := Flow{Time: time.Date(2026, 10, 25, 12, 55, 0, 0, time.UTC), Verdict: "FORWARDED", Direction: "ingress", Protocol: "TCP",
		Source: End{Namespace: "flows-demo", Pod: "client-7bc956576c-*"}, Destination: End{Namespace: "flows-demo", Pod: "web-787b7df48d-*", Port: 80},
		Policies: &Policies{IngressAllowedBy: []PolicyRef{{Kind: "NetworkPolicy", Namespace: "flows-demo", Name: "web-only-client"}}}, Count: 409, ReplyCount: 368}
	if !reflect.DeepEqual(in, want) {
		t.Fatalf("got  %+v\nwant %+v", in, want)
	}
	// the same leaving client: its namespace profile is no policy of a name
	out := findWhisker(t, items, "flows-demo/client-7bc956576c-*", "flows-demo/web-787b7df48d-*", "Src", "Allow").flow()
	if out.Direction != "egress" || out.Count != 409 || out.ReplyCount != 368 || out.Policies != nil {
		t.Fatalf("leaving client: %+v", out)
	}
	// stranger denied at web, at the end of the default tier
	denied := findWhisker(t, items, "flows-demo/stranger-f6b8b5b45-*", "flows-demo/web-787b7df48d-*", "Dst", "Deny").flow()
	if denied.Verdict != "DROPPED" || denied.DropReason != "POLICY_DENIED" || denied.Direction != "ingress" || denied.Count != 77 || denied.ReplyCount != 0 || denied.Policies != nil {
		t.Fatalf("stranger denied: %+v", denied)
	}
	// an address outside the pods has no namespace ("-") and a name, which stays as a name
	api := findWhisker(t, items, "-/PRIVATE NETWORK", "calico-system/whisker-7c57955544-*", "Dst", "Deny").flow()
	if !reflect.DeepEqual(api.Source, End{Names: []string{"private network"}}) || api.Destination.Port != 8443 {
		t.Fatalf("the API server at Whisker: %+v", api)
	}
	// a record with no packet counted still stands for one
	if f := findWhisker(t, items, "kube-system/coredns-559f6c778d-*", "-/PUBLIC NETWORK", "Src", "Allow").flow(); f.Count != 1 || f.Destination.Names[0] != "public network" {
		t.Fatalf("no packets: %+v", f)
	}
}

// A policy of a name that denies: at the destination an ingress deny, at the source an egress deny; a Pass is no decision.
func TestWhiskerDenyingPolicies(t *testing.T) {
	deny := whiskerFlow{Action: "Deny", SourceNamespace: "shop", SourceName: "a-*", DestNamespace: "shop", DestName: "b-*", Protocol: "tcp", DestPort: 80, PacketsIn: 3}
	deny.Policies.Enforced = []whiskerPolicyHit{
		{Kind: "GlobalNetworkPolicy", Name: "default.pass-all", Action: "Pass"},
		{Kind: "CalicoNetworkPolicy", Namespace: "shop", Name: "default.no-b", Action: "Deny"},
	}
	deny.Reporter = "Dst"
	ref := []PolicyRef{{Kind: "CalicoNetworkPolicy", Namespace: "shop", Name: "default.no-b"}}
	if f := deny.flow(); f.Policies == nil || !reflect.DeepEqual(f.Policies.IngressDeniedBy, ref) || len(f.Policies.EgressDeniedBy)+len(f.Policies.IngressAllowedBy)+len(f.Policies.EgressAllowedBy) != 0 {
		t.Fatalf("at the destination: %+v", f.Policies)
	}
	deny.Reporter, deny.PacketsIn, deny.PacketsOut = "Src", 0, 3
	if f := deny.flow(); f.Policies == nil || !reflect.DeepEqual(f.Policies.EgressDeniedBy, ref) || len(f.Policies.IngressDeniedBy) != 0 || f.Count != 3 {
		t.Fatalf("at the source: %+v", f)
	}
}

// The newest records are kept when there are more than the limit.
func TestQueryWhiskerKeepsTheNewest(t *testing.T) {
	at := func(min int) whiskerFlow {
		return whiskerFlow{EndTime: whiskerNow.Add(time.Duration(-min) * time.Minute), Action: "Allow", Reporter: "Dst", SourceNamespace: "shop", SourceName: "a-*", DestNamespace: "shop", DestName: "b-*", Protocol: "tcp", DestPort: int64(8000 + min)}
	}
	w := &whiskerServer{items: []whiskerFlow{at(5), at(1), at(9)}}
	srv, client := w.serve(t)
	s := testStore()
	req := Request{Namespace: "shop", Limit: 1}
	_ = s.Normalize(&req)
	res, err := s.Read(context.Background(), Target{Mode: "proxy", Source: SourceCalico, Relay: DefaultWhisker}, client, srv.URL+whiskerFlowsPath, req, whiskerNow)
	if err != nil || len(res.Flows) != 1 || res.Flows[0].Destination.Port != 8001 || !res.Truncated {
		t.Fatalf("%v %+v", err, res)
	}
}

// whiskerServer answers like Whisker: the items whose ends match the filters (Exact namespaces, actions).
type whiskerServer struct {
	items   []whiskerFlow
	status  int
	body    string
	queries []map[string]any
	starts  []string
}

func (w *whiskerServer) serve(t *testing.T) (*httptest.Server, *http.Client) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != whiskerFlowsPath {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		var f map[string]any
		if err := json.Unmarshal([]byte(r.URL.Query().Get("filters")), &f); err != nil {
			t.Errorf("filters %q: %v", r.URL.Query().Get("filters"), err)
		}
		w.queries, w.starts = append(w.queries, f), append(w.starts, r.URL.Query().Get("startTimeGte"))
		if w.status != 0 {
			rw.WriteHeader(w.status)
			_, _ = rw.Write([]byte(w.body))
			return
		}
		if w.body != "" {
			_, _ = rw.Write([]byte(w.body))
			return
		}
		match := func(list any, v string) bool {
			if list == nil {
				return true
			}
			for _, m := range list.([]any) {
				if m.(map[string]any)["value"] == v {
					return true
				}
			}
			return false
		}
		out := []whiskerFlow{}
		for _, it := range w.items {
			okAction := f["actions"] == nil
			for _, a := range asList(f["actions"]) {
				okAction = okAction || a == it.Action
			}
			if match(f["source_namespaces"], it.SourceNamespace) && match(f["dest_namespaces"], it.DestNamespace) && okAction {
				out = append(out, it)
			}
		}
		_ = json.NewEncoder(rw).Encode(map[string]any{"total": map[string]int{"totalPages": 1}, "items": out})
	}))
	t.Cleanup(srv.Close)
	return srv, srv.Client()
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func TestQueryWhiskerReadsEitherEndOnce(t *testing.T) {
	w := &whiskerServer{items: whiskerFixture(t)}
	srv, client := w.serve(t)
	s := testStore()
	req := Request{Namespace: "flows-demo", Lookup: retinaLookupFor(map[string]map[string]Workload{
		"flows-demo":  {"client-7bc956576c-*": {Kind: "Deployment", Name: "client"}, "web-787b7df48d-*": {Kind: "Deployment", Name: "web"}, "stranger-f6b8b5b45-*": {Kind: "Deployment", Name: "stranger"}},
		"kube-system": {"coredns-559f6c778d-*": {Kind: "Deployment", Name: "coredns"}},
	})}
	if err := s.Normalize(&req); err != nil {
		t.Fatal(err)
	}
	res, err := s.Read(context.Background(), Target{Mode: "proxy", Source: SourceCalico, Relay: DefaultWhisker}, client, srv.URL+whiskerFlowsPath, req, whiskerNow)
	if err != nil {
		t.Fatal(err)
	}
	// one list per side, the namespace exact, the window as seconds back
	if len(w.queries) != 2 || !reflect.DeepEqual(w.queries[0], map[string]any{"source_namespaces": []any{map[string]any{"value": "flows-demo", "type": "Exact"}}}) ||
		!reflect.DeepEqual(w.queries[1], map[string]any{"dest_namespaces": []any{map[string]any{"value": "flows-demo", "type": "Exact"}}}) || w.starts[0] != "-900" {
		t.Fatalf("queries %v %v", w.queries, w.starts)
	}
	// the items with both ends in flows-demo came in both lists: each counts once
	if res.Provider != SourceCalico || len(res.Flows) != 8 || res.Truncated {
		t.Fatalf("result %+v", res)
	}
	byKey := map[string]Group{}
	for _, g := range res.Groups {
		byKey[g.Source.Workload.Name+"→"+g.Destination.Workload.Name+" "+g.Verdict] = g
	}
	cw := byKey["client→web FORWARDED"]
	if cw.Count != 818 || cw.Replies != 736 || !reflect.DeepEqual(cw.Observed, []string{"egress", "ingress"}) || cw.Policies == nil {
		t.Fatalf("client → web: %+v", cw)
	}
	if g := byKey["stranger→web DROPPED"]; g.Count != 77 || g.DropReason != "POLICY_DENIED" || !reflect.DeepEqual(g.Observed, []string{"ingress"}) {
		t.Fatalf("stranger → web denied: %+v", g)
	}
	// stranger's side reported its packets leaving; web's side dropped them: one connection, dropped — as the
	// traffic lines count it where it arrived
	if g, ok := byKey["stranger→web FORWARDED"]; ok {
		t.Fatalf("the sender's half of a dropped connection: %+v", g)
	}
}

func retinaLookupFor(w map[string]map[string]Workload) *fakeLookup {
	return &fakeLookup{workloads: w}
}

func TestQueryWhiskerAsksWhatTheRequestAsks(t *testing.T) {
	w := &whiskerServer{items: whiskerFixture(t)}
	srv, client := w.serve(t)
	s := testStore()
	calico := Target{Mode: "proxy", Source: SourceCalico, Relay: DefaultWhisker}
	// drops only: Deny
	req := Request{Namespace: "flows-demo", Verdicts: []string{"DROPPED"}}
	_ = s.Normalize(&req)
	res, err := s.Read(context.Background(), calico, client, srv.URL+whiskerFlowsPath, req, whiskerNow)
	if err != nil || len(res.Flows) != 1 || res.Flows[0].Verdict != "DROPPED" || !reflect.DeepEqual(w.queries[0]["actions"], []any{"Deny"}) {
		t.Fatalf("dropped: %v %+v %v", err, res, w.queries)
	}
	// a verdict Calico has no action for: nothing to ask
	w.queries = nil
	req = Request{Namespace: "flows-demo", Verdicts: []string{"ERROR"}}
	_ = s.Normalize(&req)
	if res, err = s.Read(context.Background(), calico, client, srv.URL+whiskerFlowsPath, req, whiskerNow); err != nil || len(res.Flows) != 0 || len(w.queries) != 0 {
		t.Fatalf("error verdict: %v %+v %d", err, res, len(w.queries))
	}
	// a pod: its set's flows, as Calico names it
	req = Request{Namespace: "flows-demo", Kind: "Pod", Name: "web-787b7df48d-9cf9k", PodSet: "web-787b7df48d-*"}
	_ = s.Normalize(&req)
	if res, err = s.Read(context.Background(), calico, client, srv.URL+whiskerFlowsPath, req, whiskerNow); err != nil || len(res.Flows) != 4 {
		t.Fatalf("pod: %v %d", err, len(res.Flows))
	}
	req.PodSet = ""
	if res, _ = s.Read(context.Background(), calico, client, srv.URL+whiskerFlowsPath, req, whiskerNow); len(res.Flows) != 0 {
		t.Fatalf("without its set a pod matches no record: %d", len(res.Flows))
	}
	// the limit: the newest first, and said so
	req = Request{Namespace: "flows-demo", Limit: 3}
	_ = s.Normalize(&req)
	if res, _ = s.Read(context.Background(), calico, client, srv.URL+whiskerFlowsPath, req, whiskerNow); len(res.Flows) != 3 || !res.Truncated || res.Flows[0].Time.Before(res.Flows[2].Time) {
		t.Fatalf("limit: %d %v", len(res.Flows), res.Truncated)
	}
}

func TestQueryWhiskerErrors(t *testing.T) {
	s := testStore()
	calico := Target{Mode: "proxy", Source: SourceCalico, Relay: DefaultWhisker}
	req := Request{Namespace: "flows-demo"}
	_ = s.Normalize(&req)
	for _, c := range []struct {
		name string
		w    *whiskerServer
		want error
		text string
	}{
		{"the API server cannot reach Whisker", &whiskerServer{status: http.StatusServiceUnavailable, body: "error trying to reach service: dial tcp 192.168.213.129:8443: i/o timeout"}, ErrUnavailable, "i/o timeout"},
		{"no permission", &whiskerServer{status: http.StatusForbidden, body: "forbidden"}, ErrForbidden, ""},
		{"not Whisker's list", &whiskerServer{body: "<html>"}, ErrUnavailable, "not Whisker's flow list"},
		{"too large", &whiskerServer{body: `{"items":[` + strings.Repeat(" ", MaxWhiskerBytes) + `]}`}, ErrUnavailable, "more than 16 MiB"},
	} {
		srv, client := c.w.serve(t)
		_, err := s.Read(context.Background(), calico, client, srv.URL+whiskerFlowsPath, req, whiskerNow)
		if !errors.Is(err, c.want) || !strings.Contains(err.Error(), c.text) {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}
