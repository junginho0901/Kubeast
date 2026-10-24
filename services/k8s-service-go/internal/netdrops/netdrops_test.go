package netdrops

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"
)

// The label names Prometheus reported for hubble_drop_total on the Cilium kind cluster
// (deploy/kind/cilium-values.yaml), and Retina's Hubble control plane's.
var (
	labelsShape = []string{"__name__", "destination_namespace", "destination_workload", "destination_workload_kind", "instance", "job", "node", "protocol", "reason", "source_namespace", "source_workload", "source_workload_kind", "traffic_direction"}
	podShape    = []string{"__name__", "cluster", "destination", "instance", "protocol", "reason", "source"}
)

func TestDetectShape(t *testing.T) {
	for _, c := range []struct {
		labels []string
		want   Shape
		ok     bool
	}{
		{labelsShape, Shape{Style: StyleLabels, Kind: true}, true},
		{append(labelsShape, "source_pod", "destination_pod"), Shape{Style: StyleLabels, Kind: true, Pod: true}, true},
		{[]string{"source_namespace", "source_workload", "destination_namespace", "destination_workload", "reason"}, Shape{Style: StyleLabels}, true},
		{podShape, Shape{Style: StylePod}, true},
		{[]string{"__name__", "reason", "protocol", "instance"}, Shape{}, false},
		// a namespace alone does not single out a workload
		{[]string{"source_namespace", "destination_namespace", "reason"}, Shape{}, false},
	} {
		got, ok := DetectShape(c.labels)
		if got != c.want || ok != c.ok {
			t.Errorf("%v: %+v %v", c.labels, got, ok)
		}
	}
}

func TestParseRangeAndValidate(t *testing.T) {
	if d, err := ParseRange(""); err != nil || d != time.Hour {
		t.Fatalf("default: %v %v", d, err)
	}
	for _, bad := range []string{"30s", "25h", "soon", "-1h"} {
		if _, err := ParseRange(bad); err == nil {
			t.Errorf("range %q accepted", bad)
		}
	}
	for _, bad := range []Request{
		{Namespace: `demo"} or vector(1) #`},
		{Namespace: "demo", Kind: "Deployment", Name: `web"}`},
		{Namespace: "demo", Kind: "Deployment", Name: "web|.*"},
		{Namespace: "demo", Kind: "Service", Name: "web"},
		{Namespace: "demo", Kind: "Pod"},
		{Namespace: "Demo"},
	} {
		if err := bad.Validate(); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
	if err := (Request{Namespace: "flows-demo", Kind: "Deployment", Name: "web.v2"}).Validate(); err != nil {
		t.Fatal(err)
	}
}

// selector parses expr with Prometheus's parser and returns the drop selector's matchers and the grouping.
func selector(t *testing.T, expr string) (map[string]*labels.Matcher, []string, time.Duration) {
	t.Helper()
	e, err := parser.NewParser(parser.Options{}).ParseExpr(expr)
	if err != nil {
		t.Fatalf("%s: %v", expr, err)
	}
	agg, ok := e.(*parser.AggregateExpr)
	if !ok || agg.Op != parser.SUM {
		t.Fatalf("not a sum: %s", expr)
	}
	call := agg.Expr.(*parser.Call)
	if call.Func.Name != "increase" {
		t.Fatalf("not increase: %s", expr)
	}
	ms := call.Args[0].(*parser.MatrixSelector)
	vs := ms.VectorSelector.(*parser.VectorSelector)
	out := map[string]*labels.Matcher{}
	for _, m := range vs.LabelMatchers {
		out[m.Name] = m
	}
	if out["__name__"].Value != Metric {
		t.Fatalf("metric %s", expr)
	}
	return out, agg.Grouping, ms.Range
}

func TestPlanLabels(t *testing.T) {
	shape := Shape{Style: StyleLabels, Kind: true}
	qs, notes := Plan(shape, Request{Namespace: "flows-demo", Kind: "Deployment", Name: "web", Range: time.Hour, Workload: &Workload{Kind: "Deployment", Name: "web"}})
	if len(qs) != 2 || len(notes) != 0 {
		t.Fatalf("%+v %v", qs, notes)
	}
	in, by, rng := selector(t, qs[0].Expr)
	if qs[0].Side != "incoming" || in["destination_namespace"].Value != "flows-demo" || in["destination_workload"].Value != "web" ||
		in["destination_workload_kind"].Value != "Deployment" || in["source_namespace"] != nil || rng != time.Hour {
		t.Fatalf("incoming %s", qs[0].Expr)
	}
	if !reflect.DeepEqual(by, []string{"reason", "source_namespace", "source_workload", "source_workload_kind"}) {
		t.Fatalf("incoming by %v", by)
	}
	out, by, _ := selector(t, qs[1].Expr)
	if qs[1].Side != "outgoing" || out["source_workload"].Value != "web" || out["destination_workload"] != nil {
		t.Fatalf("outgoing %s", qs[1].Expr)
	}
	if !reflect.DeepEqual(by, []string{"reason", "destination_namespace", "destination_workload", "destination_workload_kind"}) {
		t.Fatalf("outgoing by %v", by)
	}

	// a ReplicaSet's or a pod's drops are its workload's when the metric has no pod label
	qs, notes = Plan(shape, Request{Namespace: "flows-demo", Kind: "Pod", Name: "web-5f98b4964-h725v", Range: time.Hour, Workload: &Workload{Kind: "Deployment", Name: "web"}})
	if in, _, _ := selector(t, qs[0].Expr); in["destination_workload"].Value != "web" || in["destination_pod"] != nil || !reflect.DeepEqual(notes, []string{NoteWorkloadLevel}) {
		t.Fatalf("pod at workload level: %s %v", qs[0].Expr, notes)
	}
	// with pod labels, the pod itself
	qs, notes = Plan(Shape{Style: StyleLabels, Pod: true}, Request{Namespace: "flows-demo", Kind: "Pod", Name: "web-1", Range: time.Hour, Workload: &Workload{Kind: "Deployment", Name: "web"}})
	if in, by, _ := selector(t, qs[0].Expr); in["destination_pod"].Value != "web-1" || in["destination_workload"] != nil || len(notes) != 0 || by[len(by)-1] != "source_pod" {
		t.Fatalf("pod: %s %v", qs[0].Expr, notes)
	}
	// a pod without a workload cannot be told apart
	qs, notes = Plan(shape, Request{Namespace: "flows-demo", Kind: "Pod", Name: "bare", Range: time.Hour})
	if len(qs) != 0 || !reflect.DeepEqual(notes, []string{NoteNoWorkload}) {
		t.Fatalf("bare pod: %+v %v", qs, notes)
	}
	// the namespace
	qs, _ = Plan(shape, Request{Namespace: "flows-demo", Range: 15 * time.Minute})
	if in, _, rng := selector(t, qs[0].Expr); len(in) != 2 || in["destination_namespace"].Value != "flows-demo" || rng != 15*time.Minute {
		t.Fatalf("namespace: %s", qs[0].Expr)
	}
}

func TestPlanPod(t *testing.T) {
	shape := Shape{Style: StylePod}
	qs, notes := Plan(shape, Request{Namespace: "shop.v1", Kind: "Deployment", Name: "web", Range: time.Hour,
		Workload: &Workload{Kind: "Deployment", Name: "web"}, Pods: []string{"web-a1", "web.v2-b2"}, PodsTruncated: true})
	in, by, _ := selector(t, qs[0].Expr)
	m := in["destination"]
	if m.Type != labels.MatchRegexp || !reflect.DeepEqual(by, []string{"reason", "source"}) || !reflect.DeepEqual(notes, []string{NotePodsTruncated}) {
		t.Fatalf("%s %v", qs[0].Expr, notes)
	}
	// a dot in a namespace or pod name is a dot, not any character
	for v, want := range map[string]bool{"shop.v1/web-a1": true, "shop.v1/web.v2-b2": true, "shop.v1/web": true, "shopxv1/web-a1": false, "shop.v1/webxv2-b2": false, "shop.v1/web-c3": false, "other/web-a1": false} {
		if m.Matches(v) != want {
			t.Errorf("destination %q matches %v", v, !want)
		}
	}
	qs, _ = Plan(shape, Request{Namespace: "shop", Kind: "Pod", Name: "web-a1", Range: time.Hour})
	if out, _, _ := selector(t, qs[1].Expr); !out["source"].Matches("shop/web-a1") || out["source"].Matches("shop/web-a12") {
		t.Fatalf("pod: %s", qs[1].Expr)
	}
	qs, _ = Plan(shape, Request{Namespace: "shop", Range: time.Hour})
	if in, _, _ := selector(t, qs[0].Expr); !in["destination"].Matches("shop/anything") || in["destination"].Matches("shopping/x") || in["destination"].Matches("shop/") {
		t.Fatalf("namespace: %s", qs[0].Expr)
	}
}

// Any valid names give a query Prometheus parses whose matchers carry exactly those names.
func TestPlanNamesStayValues(t *testing.T) {
	rnd := rand.New(rand.NewSource(7))
	alphabet := "abcdefghijklmnopqrstuvwxyz0123456789-."
	name := func() string {
		for {
			b := make([]byte, 1+rnd.Intn(20))
			for i := range b {
				b[i] = alphabet[rnd.Intn(len(alphabet))]
			}
			s := string(b)
			if nameRe.MatchString(s) {
				return s
			}
		}
	}
	for i := 0; i < 2000; i++ {
		r := Request{Namespace: name(), Kind: "StatefulSet", Name: name(), Range: time.Duration(1+rnd.Intn(1440)) * time.Minute}
		r.Workload = &Workload{Kind: r.Kind, Name: r.Name}
		r.Pods = []string{r.Name + "-0", r.Name + "-1"}
		if err := r.Validate(); err != nil {
			t.Fatal(err)
		}
		qs, _ := Plan(Shape{Style: StyleLabels, Kind: true}, r)
		in, _, _ := selector(t, qs[0].Expr)
		if in["destination_namespace"].Value != r.Namespace || in["destination_workload"].Value != r.Name {
			t.Fatalf("%+v → %s", r, qs[0].Expr)
		}
		qs, _ = Plan(Shape{Style: StylePod}, r)
		out, _, _ := selector(t, qs[1].Expr)
		if !out["source"].Matches(r.Namespace+"/"+r.Name+"-1") || out["source"].Matches(r.Namespace+"/"+r.Name+"-2") {
			t.Fatalf("%+v → %s", r, qs[1].Expr)
		}
	}
}

func TestAssemble(t *testing.T) {
	shape := Shape{Style: StyleLabels, Kind: true}
	r := Request{Namespace: "flows-demo", Kind: "Deployment", Name: "web", Range: time.Hour, Workload: &Workload{Kind: "Deployment", Name: "web"}}
	answers := map[string][]Sample{
		"incoming": {
			{Labels: map[string]string{"reason": "POLICY_DENIED", "source_namespace": "flows-demo", "source_workload": "stranger", "source_workload_kind": "Deployment"}, Value: 40.4},
			{Labels: map[string]string{"reason": "POLICY_DENIED", "source_namespace": "other", "source_workload": "scanner", "source_workload_kind": "DaemonSet"}, Value: 2},
			{Labels: map[string]string{"reason": "CT_MAP_INSERTION_FAILED"}, Value: 1.6},
			{Labels: map[string]string{"reason": "POLICY_DENIED", "source_namespace": "flows-demo", "source_workload": "old"}, Value: 0.3},
		},
		"outgoing": {},
	}
	res := Assemble(shape, r, nil, answers)
	if !res.Available || res.Source != "hubble" || res.Style != StyleLabels || res.Range != "1h0m0s" || res.Outgoing.Total != 0 || len(res.Outgoing.Peers) != 0 {
		t.Fatalf("%+v", res)
	}
	in := res.Incoming
	if in.Total != 44 || !reflect.DeepEqual(in.Reasons, []Reason{{"POLICY_DENIED", 42}, {"CT_MAP_INSERTION_FAILED", 2}}) {
		t.Fatalf("incoming %+v", in)
	}
	if len(in.Peers) != 3 || in.Peers[0] != (Peer{Namespace: "flows-demo", Workload: "stranger", Kind: "Deployment", Reason: "POLICY_DENIED", Count: 40}) || in.Peers[2] != (Peer{Reason: "CT_MAP_INSERTION_FAILED", Count: 2}) {
		t.Fatalf("peers %+v", in.Peers)
	}

	// a namespace-limited reader sees peers elsewhere by namespace only, merged
	r.Scope = []string{"flows-demo"}
	answers["incoming"] = append(answers["incoming"], Sample{Labels: map[string]string{"reason": "POLICY_DENIED", "source_namespace": "other", "source_workload": "crawler"}, Value: 3})
	res = Assemble(shape, r, nil, answers)
	if !res.Redacted {
		t.Fatal("not redacted")
	}
	for _, p := range res.Incoming.Peers {
		if p.Namespace == "other" && (p.Workload != "" || p.Kind != "" || p.Count != 5) {
			t.Fatalf("other: %+v", p)
		}
	}

	// pod style: "<namespace>/<pod>", or nothing (Retina writes only the pod's own side)
	res = Assemble(Shape{Style: StylePod}, Request{Namespace: "shop", Range: time.Hour}, []string{NotePodsTruncated}, map[string][]Sample{
		"outgoing": {{Labels: map[string]string{"reason": "IPTABLE_RULE_DROP", "destination": "db/postgres-0"}, Value: 7}, {Labels: map[string]string{"reason": "UNKNOWN_DROP", "destination": ""}, Value: 1}},
	})
	if res.Outgoing.Total != 8 || res.Outgoing.Peers[0] != (Peer{Namespace: "db", Pod: "postgres-0", Reason: "IPTABLE_RULE_DROP", Count: 7}) || res.Outgoing.Peers[1] != (Peer{Reason: "UNKNOWN_DROP", Count: 1}) || res.Notes[0] != NotePodsTruncated {
		t.Fatalf("pod style %+v", res)
	}

	// the peers of a side are capped
	var many []Sample
	for i := 0; i < MaxPeers+5; i++ {
		many = append(many, Sample{Labels: map[string]string{"reason": "POLICY_DENIED", "source_namespace": "n", "source_workload": strings.Repeat("w", i+1)}, Value: float64(i + 1)})
	}
	res = Assemble(shape, Request{Namespace: "n", Range: time.Hour}, nil, map[string][]Sample{"incoming": many})
	if len(res.Incoming.Peers) != MaxPeers || res.Incoming.Peers[0].Count != int64(MaxPeers+5) || res.Incoming.Total != int64((MaxPeers+5)*(MaxPeers+6)/2) {
		t.Fatalf("cap: %d %+v total %d", len(res.Incoming.Peers), res.Incoming.Peers[0], res.Incoming.Total)
	}
}
