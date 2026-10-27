package netflows

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
)

// encodeFlow writes the fields decodeFlow reads, for flows the fixtures lack.
func encodeFlow(f Flow) []byte {
	var b []byte
	var ts []byte
	ts = protowire.AppendTag(ts, 1, protowire.VarintType)
	ts = protowire.AppendVarint(ts, uint64(f.Time.Unix()))
	b = appendMessage(b, 1, ts)
	b = protowire.AppendTag(b, 2, protowire.VarintType)
	b = protowire.AppendVarint(b, uint64(Verdicts[f.Verdict]))
	end := func(e End) []byte {
		var m []byte
		if e.Namespace != "" {
			m = appendString(m, 3, e.Namespace)
		}
		if e.Pod != "" {
			m = appendString(m, 5, e.Pod)
		}
		if e.Workload != nil {
			m = appendMessage(m, 6, e.Workload.encode())
		}
		return m
	}
	b = appendMessage(b, 8, end(f.Source))
	b = appendMessage(b, 9, end(f.Destination))
	var tcp []byte
	tcp = protowire.AppendTag(tcp, 2, protowire.VarintType)
	tcp = protowire.AppendVarint(tcp, uint64(f.Destination.Port))
	b = appendMessage(b, 6, appendMessage(nil, 1, tcp))
	var resp []byte
	resp = appendMessage(resp, 1, b)
	return resp
}

// relay is a fake Hubble Relay: it records the request and answers with the
// given messages and trailers.
type relay struct {
	status   int
	messages [][]byte
	trailer  map[string]string
	header   map[string]string
	delay    time.Duration
	got      []byte
}

func (r *relay) serve(t *testing.T) (*httptest.Server, *http.Client) {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.ProtoMajor != 2 || req.Header.Get("Content-Type") != "application/grpc" || req.URL.Path != getFlowsPath {
			t.Errorf("request %s %s %q", req.Proto, req.URL.Path, req.Header.Get("Content-Type"))
		}
		r.got, _ = io.ReadAll(req.Body)
		if r.delay > 0 {
			time.Sleep(r.delay)
		}
		if r.status != 0 {
			w.WriteHeader(r.status)
			_, _ = w.Write([]byte("refused"))
			return
		}
		w.Header().Set("Content-Type", "application/grpc")
		w.Header().Set("Trailer", "Grpc-Status, Grpc-Message")
		for k, v := range r.header {
			w.Header().Set(k, v)
		}
		w.WriteHeader(http.StatusOK)
		for _, m := range r.messages {
			_, _ = w.Write(frame(m))
		}
		for k, v := range r.trailer {
			w.Header().Set(k, v)
		}
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv, srv.Client()
}

func fixtureMessages(t *testing.T, name string) [][]byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var out [][]byte
	_ = readMessages(strings.NewReader(string(raw)), func(m []byte) error { out = append(out, m); return nil })
	return out
}

func testStore() *Store {
	s, _ := New(Config{Clusters: map[string]Target{"c": {Mode: "proxy"}}, DefaultRange: 15 * time.Minute, MaxRange: time.Hour, MaxFlows: 20, GraphMaxFlows: 300, Timeout: 2 * time.Second, PerUserPerMinute: 2})
	return s
}

// The newest flow of the fixtures.
var fixtureNow = time.Date(2026, 10, 24, 14, 5, 30, 0, time.UTC)

func TestQueryRealFixture(t *testing.T) {
	r := &relay{messages: fixtureMessages(t, "getflows-web.bin"), trailer: map[string]string{"Grpc-Status": "0"}}
	srv, client := r.serve(t)
	s := testStore()
	req := Request{Namespace: "demo", Kind: "Pod", Name: "web-5f98b4964-h725v"}
	if err := s.Normalize(&req); err != nil {
		t.Fatal(err)
	}
	res, err := s.Query(context.Background(), client, srv.URL+getFlowsPath, req, fixtureNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Flows) != 20 || !res.Truncated || res.Since != "15m0s" {
		t.Fatalf("20 flows of web, limit reached: %d %v %s", len(res.Flows), res.Truncated, res.Since)
	}
	if !res.Flows[0].Time.After(res.Flows[19].Time) {
		t.Fatal("newest first")
	}
	// two connections: client forwarded (seen leaving client and entering web,
	// where Cilium names the policy that let it in), stranger dropped by policy
	if len(res.Groups) != 2 {
		t.Fatalf("groups: %+v", res.Groups)
	}
	byVerdict := map[string]Group{}
	for _, g := range res.Groups {
		byVerdict[g.Verdict] = g
	}
	fwd := byVerdict["FORWARDED"]
	if fwd.Source.Workload.Name != "client" || fwd.Count != 16 || fwd.Destination.Port != 80 || !reflect.DeepEqual(fwd.Observed, []string{"egress", "ingress"}) {
		t.Fatalf("client group: %+v", fwd)
	}
	if fwd.Policies == nil || len(fwd.Policies.IngressAllowedBy) != 1 || fwd.Policies.IngressAllowedBy[0].Name != "web-only-client" || fwd.Policies.IngressAllowedBy[0].Namespace != "demo" {
		t.Fatalf("allowed by web-only-client: %+v", fwd.Policies)
	}
	if g := byVerdict["DROPPED"]; g.Source.Workload.Name != "stranger" || g.Count != 4 || g.DropReason != "POLICY_DENIED" || !reflect.DeepEqual(g.Observed, []string{"ingress"}) {
		t.Fatalf("stranger group: %+v", g)
	}
	// what was asked: number 20, the pod as source or destination
	want := encodeRequest(20, []filter{{sourcePod: []string{"demo/web-5f98b4964-h725v"}}, {destinationPod: []string{"demo/web-5f98b4964-h725v"}}})
	if string(r.got) != string(frame(want)) {
		t.Fatalf("request %x", r.got)
	}
}

func TestQueryChecksTheAnswer(t *testing.T) {
	r := &relay{messages: fixtureMessages(t, "getflows-web.bin"), trailer: map[string]string{"Grpc-Status": "0"}}
	srv, client := r.serve(t)
	s := testStore()
	run := func(req Request, now time.Time) *Result {
		t.Helper()
		if err := s.Normalize(&req); err != nil {
			t.Fatal(err)
		}
		res, err := s.Query(context.Background(), client, srv.URL+getFlowsPath, req, now)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	// Hubble's pod filter is a prefix: "web" would match web-5f98…, the exact name check does not.
	if res := run(Request{Namespace: "demo", Kind: "Pod", Name: "web"}, fixtureNow); len(res.Flows) != 0 {
		t.Fatalf("a prefix is not the pod: %d", len(res.Flows))
	}
	if res := run(Request{Namespace: "demo", Kind: "Deployment", Name: "stranger"}, fixtureNow); len(res.Flows) != 4 {
		t.Fatalf("the stranger Deployment's flows: %d", len(res.Flows))
	}
	if res := run(Request{Namespace: "demo", Verdicts: []string{"dropped"}}, fixtureNow); len(res.Flows) != 4 || res.Flows[0].Verdict != "DROPPED" {
		t.Fatalf("only drops: %+v", res.Flows)
	}
	if res := run(Request{Namespace: "other"}, fixtureNow); len(res.Flows) != 0 {
		t.Fatalf("another namespace: %d", len(res.Flows))
	}
	// a window that leaves out the oldest flows (14:05:01 and 14:05:04)
	res := run(Request{Namespace: "demo", Since: 25 * time.Second}, fixtureNow)
	if len(res.Flows) != 13 {
		t.Fatalf("flows of the last 25s: %d", len(res.Flows))
	}
	for _, f := range res.Flows {
		if f.Time.Before(fixtureNow.Add(-25 * time.Second)) {
			t.Fatalf("outside the window: %v", f.Time)
		}
	}
}

func TestQueryRedactsPeersOutsideTheScope(t *testing.T) {
	now := time.Date(2026, 10, 24, 15, 0, 0, 0, time.UTC)
	flows := [][]byte{
		encodeFlow(Flow{Time: now.Add(-time.Minute), Verdict: "FORWARDED",
			Source:      End{Namespace: "ops", Pod: "probe-1", Workload: &Workload{Kind: "Deployment", Name: "probe"}},
			Destination: End{Namespace: "shop", Pod: "web-1", Port: 80}}),
		encodeFlow(Flow{Time: now.Add(-time.Minute), Verdict: "FORWARDED",
			Source:      End{Namespace: "shop", Pod: "api-1"},
			Destination: End{Namespace: "shop", Pod: "web-1", Port: 8080}}),
	}
	r := &relay{messages: flows, trailer: map[string]string{"Grpc-Status": "0"}}
	srv, client := r.serve(t)
	s := testStore()
	req := Request{Namespace: "shop", Kind: "Pod", Name: "web-1", Scope: []string{"shop"}}
	_ = s.Normalize(&req)
	res, err := s.Query(context.Background(), client, srv.URL+getFlowsPath, req, now)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Redacted || len(res.Flows) != 2 {
		t.Fatalf("redacted: %+v", res)
	}
	byPort := map[uint32]Flow{}
	for _, f := range res.Flows {
		byPort[f.Destination.Port] = f
	}
	if got := byPort[80].Source; !reflect.DeepEqual(got, End{Namespace: "ops"}) {
		t.Fatalf("a peer outside the grant shows its namespace only: %+v", got)
	}
	if got := byPort[8080].Source; got.Pod != "api-1" {
		t.Fatalf("a peer inside the grant is kept: %+v", got)
	}
	// unscoped: nothing hidden
	req.Scope = nil
	res, _ = s.Query(context.Background(), client, srv.URL+getFlowsPath, req, now)
	if res.Redacted {
		t.Fatal("no scope, no redaction")
	}
}

func TestQuerySeveralNamespaces(t *testing.T) {
	now := time.Date(2026, 10, 24, 15, 0, 0, 0, time.UTC)
	flows := [][]byte{
		encodeFlow(Flow{Time: now.Add(-time.Minute), Verdict: "FORWARDED", Source: End{Namespace: "ops", Pod: "probe-1"}, Destination: End{Namespace: "shop", Pod: "web-1", Port: 80}}),
		encodeFlow(Flow{Time: now.Add(-time.Minute), Verdict: "FORWARDED", Source: End{Namespace: "ops", Pod: "probe-1"}, Destination: End{Namespace: "kube-system", Pod: "dns-1", Port: 53}}),
		encodeFlow(Flow{Time: now.Add(-time.Minute), Verdict: "FORWARDED", Source: End{Namespace: "lab", Pod: "x-1"}, Destination: End{Namespace: "lab", Pod: "y-1", Port: 80}}),
	}
	r := &relay{messages: flows, trailer: map[string]string{"Grpc-Status": "0"}}
	srv, client := r.serve(t)
	s := testStore()
	req := Request{Namespace: "shop", More: []string{"ops"}, Graph: true}
	_ = s.Normalize(&req)
	res, err := s.Query(context.Background(), client, srv.URL+getFlowsPath, req, now)
	if err != nil {
		t.Fatal(err)
	}
	// both namespaces' flows, either side; another namespace's flow is checked out again
	if len(res.Flows) != 2 || len(res.Groups) != 2 {
		t.Fatalf("flows of shop and ops: %+v", res.Flows)
	}
}

func TestGroupFoldsReplies(t *testing.T) {
	now := time.Date(2026, 10, 24, 15, 0, 0, 0, time.UTC)
	client := End{Namespace: "shop", Pod: "client-1", Workload: &Workload{Kind: "Deployment", Name: "client"}}
	web := End{Namespace: "shop", Pod: "web-1", Workload: &Workload{Kind: "Deployment", Name: "web"}}
	req := func(port uint32, dir string) Flow {
		s, d := client, web
		s.Port, d.Port = port, 80
		return Flow{Time: now, Verdict: "FORWARDED", Protocol: "TCP", Direction: dir, Source: s, Destination: d}
	}
	reply := func(port uint32) Flow {
		s, d := web, client
		s.Port, d.Port = 80, port
		return Flow{Time: now.Add(time.Second), Verdict: "FORWARDED", Protocol: "TCP", Direction: "egress", IsReply: true, Source: s, Destination: d}
	}
	got := group([]Flow{reply(41000), req(41000, "egress"), req(41000, "ingress"), reply(42000), req(42000, "egress")})
	if len(got) != 1 {
		t.Fatalf("one connection client -> web:80, got %+v", got)
	}
	g := got[0]
	if g.Source.Workload.Name != "client" || g.Destination.Port != 80 || g.Count != 3 || g.Replies != 2 || !reflect.DeepEqual(g.Observed, []string{"egress", "ingress"}) {
		t.Fatalf("group %+v", g)
	}
}

func TestGroupLeavesOutTheSenderHalfOfADroppedConnection(t *testing.T) {
	now := time.Date(2026, 10, 27, 11, 0, 0, 0, time.UTC)
	stranger := End{Namespace: "flows-demo", Pod: "stranger-5d9-*", Workload: &Workload{Kind: "Deployment", Name: "stranger"}}
	client := End{Namespace: "flows-demo", Pod: "client-7c9-*", Workload: &Workload{Kind: "Deployment", Name: "client"}}
	web := End{Namespace: "flows-demo", Pod: "web-787-*", Workload: &Workload{Kind: "Deployment", Name: "web"}}
	web.Port = 80
	flow := func(src End, verdict, dir string) Flow {
		f := Flow{Time: now, Verdict: verdict, Protocol: "TCP", Direction: dir, Source: src, Destination: web, Count: 10}
		if verdict == "DROPPED" {
			f.DropReason = "POLICY_DENIED"
		}
		return f
	}
	got := group([]Flow{
		flow(stranger, "FORWARDED", "egress"), flow(stranger, "DROPPED", "ingress"), // Calico's two halves of one denied connection
		flow(client, "FORWARDED", "egress"), flow(client, "FORWARDED", "ingress"),
	})
	var lines []string
	for _, g := range got {
		lines = append(lines, g.Source.Workload.Name+" "+g.Verdict)
	}
	if !reflect.DeepEqual(lines, []string{"stranger DROPPED", "client FORWARDED"}) {
		t.Fatalf("groups %v", lines)
	}
}

func TestQueryErrors(t *testing.T) {
	s := testStore()
	req := Request{Namespace: "demo"}
	_ = s.Normalize(&req)
	cases := []struct {
		name  string
		relay *relay
		want  error
		text  string
	}{
		{"API server refuses", &relay{status: http.StatusForbidden}, ErrForbidden, "refused"},
		{"plain Relay behind the proxy", &relay{status: http.StatusServiceUnavailable}, ErrUnavailable, "hubble.relay.tls.server.enabled"},
		{"no such service", &relay{status: http.StatusNotFound}, ErrRelayMissing, "refused"},
		{"trailers-only refusal", &relay{header: map[string]string{"Grpc-Status": "7", "Grpc-Message": "denied"}}, ErrForbidden, "denied"},
		{"bad request", &relay{trailer: map[string]string{"Grpc-Status": "3", "Grpc-Message": "number and since"}}, ErrInvalidRequest, "number and since"},
		{"failure after messages", &relay{messages: fixtureMessages(t, "getflows-web.bin")[:2], trailer: map[string]string{"Grpc-Status": "13", "Grpc-Message": "boom"}}, ErrUnavailable, "boom"},
		{"no status at the end", &relay{messages: fixtureMessages(t, "getflows-web.bin")[:1]}, ErrUnavailable, "without a gRPC status"},
		{"too slow", &relay{delay: 3 * time.Second}, ErrTimeout, ""},
	}
	for _, c := range cases {
		srv, client := c.relay.serve(t)
		_, err := s.Query(context.Background(), client, srv.URL+getFlowsPath, req, fixtureNow)
		if !errors.Is(err, c.want) || !strings.Contains(err.Error(), c.text) {
			t.Errorf("%s: %v, want %v containing %q", c.name, err, c.want, c.text)
		}
	}
}

func TestNormalize(t *testing.T) {
	s := testStore()
	for _, bad := range []Request{
		{},
		{Namespace: "a", Kind: "Service", Name: "x"},
		{Namespace: "a", Kind: "Pod"},
		{Namespace: "a", Name: "x"},
		{Namespace: "a", Verdicts: []string{"maybe"}},
		{Namespace: "a", Since: 2 * time.Hour},
		{Namespace: "a", More: []string{"b"}},
		{Namespace: "a", Kind: "Pod", Name: "x", More: []string{"b"}, Graph: true},
		{Namespace: "a", Pods: []string{"p"}},
		{Namespace: "a", Kind: "Pod", Name: "x", Pods: []string{"x"}},
	} {
		if err := s.Normalize(&bad); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%+v: %v", bad, err)
		}
	}
	r := Request{Namespace: "a", Limit: 5000, Verdicts: []string{" dropped "}}
	if err := s.Normalize(&r); err != nil || r.Limit != 20 || r.Since != 15*time.Minute || r.Verdicts[0] != "DROPPED" {
		t.Fatalf("defaults: %+v %v", r, err)
	}
	g := Request{Namespace: "a", More: []string{"b"}, Graph: true, Limit: 5000}
	if err := s.Normalize(&g); err != nil || g.Limit != 300 {
		t.Fatalf("a graph read has its own cap: %+v %v", g, err)
	}
	w := Request{Namespace: "a", Kind: "Deployment", Name: "web", Pods: make([]string, MaxPods+1)}
	if err := s.Normalize(&w); err != nil || len(w.Pods) != MaxPods {
		t.Fatalf("a workload's pods are capped: %d %v", len(w.Pods), err)
	}
}

// Hubble is asked for either side of a flow, so the limit is spent on the flows asked for.
func TestFiltersAskBothSides(t *testing.T) {
	web := []Workload{{Kind: "Deployment", Name: "web"}}
	dropped := []int32{Verdicts["DROPPED"]}
	for _, c := range []struct {
		req  Request
		want []filter
	}{
		{Request{Namespace: "demo"}, []filter{{sourcePod: []string{"demo/"}}, {destinationPod: []string{"demo/"}}}},
		{Request{Namespace: "demo", More: []string{"shop"}, Graph: true}, []filter{{sourcePod: []string{"demo/", "shop/"}}, {destinationPod: []string{"demo/", "shop/"}}}},
		{Request{Namespace: "demo", Kind: "Pod", Name: "web-1"}, []filter{{sourcePod: []string{"demo/web-1"}}, {destinationPod: []string{"demo/web-1"}}}},
		{Request{Namespace: "demo", Kind: "Deployment", Name: "web", Verdicts: []string{"DROPPED"}}, []filter{
			{sourcePod: []string{"demo/"}, sourceWorkload: web, verdicts: dropped},
			{destinationPod: []string{"demo/"}, destinationWorkload: web, verdicts: dropped},
		}},
		// flows that name no workload (Retina) are asked for by the workload's pods as well
		{Request{Namespace: "demo", Kind: "Deployment", Name: "web", Verdicts: []string{"DROPPED"}, Pods: []string{"web-1", "web-2"}}, []filter{
			{sourcePod: []string{"demo/"}, sourceWorkload: web, verdicts: dropped},
			{destinationPod: []string{"demo/"}, destinationWorkload: web, verdicts: dropped},
			{sourcePod: []string{"demo/web-1", "demo/web-2"}, verdicts: dropped},
			{destinationPod: []string{"demo/web-1", "demo/web-2"}, verdicts: dropped},
		}},
	} {
		if got := c.req.filters(); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%+v: %+v", c.req, got)
		}
	}
}

func TestPerUserLimit(t *testing.T) {
	s := testStore()
	if !s.Allow("u") || !s.Allow("u") || s.Allow("u") || !s.Allow("v") {
		t.Fatal("2 per minute per user")
	}
}
