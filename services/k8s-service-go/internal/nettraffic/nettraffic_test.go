package nettraffic

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
)

func TestParseNamespaces(t *testing.T) {
	got, err := ParseNamespaces(" shop,ops ,shop,,kube-system")
	if err != nil || !reflect.DeepEqual(got, []string{"shop", "ops", "kube-system"}) {
		t.Fatalf("%v %v", got, err)
	}
	many := make([]string, MaxNamespaces+1)
	for i := range many {
		many[i] = fmt.Sprintf("ns-%d", i)
	}
	for _, bad := range []string{"", ",", "Shop", "a.b", "-a", "a|b", `a"b`, strings.Repeat("a", 64), strings.Join(many, ",")} {
		if _, err := ParseNamespaces(bad); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%q accepted", bad)
		}
	}
}

var t0 = time.Date(2026, 10, 25, 7, 0, 0, 0, time.UTC)

// group is a connection seen leaving its source and arriving at its destination.
func group(src, dst netflows.End, verdict string, count, replies int, at time.Duration) netflows.Group {
	return netflows.Group{Source: src, Destination: dst, Protocol: "TCP", Observed: []string{"egress", "ingress"}, Verdict: verdict, Count: count, Replies: replies,
		First: t0.Add(at - time.Second), Last: t0.Add(at)}
}

// seen sets where a connection was seen.
func seen(g netflows.Group, observed ...string) netflows.Group {
	g.Observed = observed
	return g
}

func web(port uint32) netflows.End {
	return netflows.End{Namespace: "shop", Pod: "web-1", Workload: &netflows.Workload{Kind: "Deployment", Name: "web"}, Port: port}
}

func TestFromFlows(t *testing.T) {
	client := netflows.End{Namespace: "shop", Pod: "client-1", Workload: &netflows.Workload{Kind: "Deployment", Name: "client"}}
	client2 := netflows.End{Namespace: "shop", Pod: "client-2", Workload: &netflows.Workload{Kind: "Deployment", Name: "client"}}
	stranger := netflows.End{Namespace: "shop", Pod: "stranger-1", Workload: &netflows.Workload{Kind: "Deployment", Name: "stranger"}}
	bare := netflows.End{Namespace: "shop", Pod: "debug"}
	dns := netflows.End{Namespace: "kube-system", Pod: "coredns-1", Workload: &netflows.Workload{Kind: "Deployment", Name: "coredns"}, Port: 53}
	github := netflows.End{IP: "140.82.112.3", Identity: 2, Port: 443}
	other := netflows.End{IP: "198.51.100.7", Identity: 9, Port: 443}
	apiserver := netflows.End{IP: "172.18.0.2", Identity: 7, Port: 6443}
	hidden := netflows.End{Namespace: "ops"} // outside the reader's namespaces: netflows kept the namespace only
	denied := &netflows.Policies{IngressDeniedBy: []netflows.PolicyRef{{Kind: "NetworkPolicy", Namespace: "shop", Name: "web-only-client"}}}
	drop := seen(group(stranger, web(80), "DROPPED", 3, 0, -2*time.Second), "ingress")
	drop.DropReason, drop.Policies = "POLICY_DENIED", denied
	res := &netflows.Result{Since: "15m0s", Truncated: true, Lost: 2, Redacted: true, Cluster: "c", Mode: "proxy", Relay: "kube-system/hubble-relay:443",
		Flows: []netflows.Flow{
			{Destination: netflows.End{IP: "140.82.112.3", Names: []string{"github.com"}}},
			{Source: netflows.End{IP: "140.82.112.3", Names: []string{"api.github.com"}}}, // the first name seen wins
		},
		Groups: []netflows.Group{
			group(client, web(80), "FORWARDED", 2, 2, -time.Second),
			drop,
			// the same SYNs, FORWARDED where they left stranger: not allowed, they never arrived
			seen(group(stranger, web(80), "FORWARDED", 3, 0, -2*time.Second), "egress"),
			group(client2, web(80), "FORWARDED", 1, 1, -3*time.Second), // another pod of the same workload: the same line
			group(client, web(8080), "FORWARDED", 1, 0, -4*time.Second),
			seen(group(client, dns, "FORWARDED", 1, 1, -5*time.Second), "egress"),  // answered: it arrived
			seen(group(bare, github, "FORWARDED", 1, 0, -6*time.Second), "egress"), // outside the pods: leaving is all there is
			seen(group(bare, other, "FORWARDED", 1, 0, -7*time.Second), "egress"),
			seen(group(hidden, apiserver, "FORWARDED", 1, 0, -8*time.Second), "egress"),
			seen(group(netflows.End{IP: "10.0.0.9"}, web(80), "FORWARDED", 1, 0, -9*time.Second), "ingress"),
			// seen only leaving towards a pod, unanswered: no line
			seen(group(bare, web(9090), "FORWARDED", 1, 0, -10*time.Second), "egress"),
		},
	}
	got := FromFlows(res, []string{"shop", "ops"})
	if !got.Available || got.Source != "relay" || got.Since != "15m0s" || !got.Truncated || got.Lost != 2 || !got.Redacted ||
		got.Relay != "kube-system/hubble-relay:443" || !reflect.DeepEqual(got.Namespaces, []string{"shop", "ops"}) || got.Flows != 2 {
		t.Fatalf("result %+v", got)
	}
	byKey := map[string]Line{}
	for _, l := range got.Lines {
		byKey[l.From.key()+"→"+l.To.key()] = l
	}
	wl := func(ns, kind, name string) End { return End{Namespace: ns, Kind: kind, Name: name} }
	line := func(from, to End) Line {
		t.Helper()
		l, ok := byKey[from.key()+"→"+to.key()]
		if !ok {
			t.Fatalf("no line %+v → %+v in %+v", from, to, got.Lines)
		}
		return l
	}
	// client → web: 2+2 and 1+1 flows on port 80, 1 on 8080 — counted per port too
	cw := line(wl("shop", "Deployment", "client"), wl("shop", "Deployment", "web"))
	if cw.Allowed != 7 || cw.Dropped != 0 || !reflect.DeepEqual(cw.Ports, []Port{{"TCP", 80, 6, 0}, {"TCP", 8080, 1, 0}}) || len(cw.Connections) != 3 ||
		!cw.Last.Equal(t0.Add(-time.Second)) || cw.Reasons != nil || cw.DeniedBy != nil {
		t.Fatalf("client → web %+v", cw)
	}
	sw := line(wl("shop", "Deployment", "stranger"), wl("shop", "Deployment", "web"))
	// the SYNs that left stranger and never arrived count on no port
	if sw.Allowed != 0 || sw.Dropped != 3 || len(sw.Connections) != 2 || !reflect.DeepEqual(sw.Ports, []Port{{"TCP", 80, 0, 3}}) || !reflect.DeepEqual(sw.Reasons, []netdrops.Reason{{Reason: "POLICY_DENIED", Count: 3}}) ||
		!reflect.DeepEqual(sw.DeniedBy, denied.IngressDeniedBy) {
		t.Fatalf("stranger → web %+v", sw)
	}
	if l := line(wl("shop", "Deployment", "client"), wl("kube-system", "Deployment", "coredns")); l.Allowed != 2 {
		t.Fatalf("client → coredns %+v", l)
	}
	// a pod without a workload is the pod; world addresses by their DNS name, else world; reserved identities by name
	line(wl("shop", "Pod", "debug"), End{Outside: "github.com"})
	line(wl("shop", "Pod", "debug"), End{Outside: "world"})
	line(End{Namespace: "ops"}, End{Outside: "kube-apiserver"})
	line(End{Outside: "unknown"}, wl("shop", "Deployment", "web"))
	if len(got.Lines) != 7 {
		t.Fatalf("%d lines", len(got.Lines))
	}
	// the busiest first
	if !reflect.DeepEqual(got.Lines[0], cw) {
		t.Fatalf("order %+v", got.Lines[0])
	}
	for i := 1; i < len(got.Lines); i++ {
		if got.Lines[i-1].Allowed+got.Lines[i-1].Dropped < got.Lines[i].Allowed+got.Lines[i].Dropped {
			t.Fatalf("not busiest first at %d", i)
		}
	}
}

func TestFromFlowsKeepsTheBusiestPorts(t *testing.T) {
	src := netflows.End{Namespace: "shop", Pod: "client-1", Workload: &netflows.Workload{Kind: "Deployment", Name: "client"}}
	var groups []netflows.Group
	for i := 0; i < MaxPorts; i++ {
		groups = append(groups, group(src, web(uint32(1000+i)), "FORWARDED", 1, 0, -time.Second))
	}
	groups = append(groups, group(src, web(9999), "FORWARDED", 50, 50, -time.Second))
	got := FromFlows(&netflows.Result{Groups: groups}, []string{"shop"}).Lines[0].Ports
	if len(got) != MaxPorts || got[len(got)-1] != (Port{"TCP", 9999, 100, 0}) || got[0].Port != 1000 || got[MaxPorts-2].Port != 1008 {
		t.Fatalf("ports %+v", got)
	}
}

func TestFromFlowsCaps(t *testing.T) {
	var groups []netflows.Group
	src := netflows.End{Namespace: "shop", Pod: "client-1", Workload: &netflows.Workload{Kind: "Deployment", Name: "client"}}
	for i := 0; i < MaxConnections+MaxPorts+5; i++ {
		groups = append(groups, group(src, web(uint32(1000+i)), "FORWARDED", 1, 0, -time.Duration(i)*time.Second))
	}
	for i := 0; i < MaxLines+5; i++ {
		groups = append(groups, group(netflows.End{Namespace: "shop", Pod: fmt.Sprintf("p-%d", i)}, web(80), "FORWARDED", 1, 0, -time.Minute))
	}
	got := FromFlows(&netflows.Result{Groups: groups}, []string{"shop"})
	if len(got.Lines) != MaxLines || !got.LinesTruncated {
		t.Fatalf("%d lines, truncated %v", len(got.Lines), got.LinesTruncated)
	}
	first := got.Lines[0]
	// the busiest ports kept: here all equal, so the lowest numbers, listed by port
	if first.From.Name != "client" || len(first.Ports) != MaxPorts || first.Ports[0].Port != 1000 || first.Ports[MaxPorts-1].Port != 1009 || len(first.Connections) != MaxConnections ||
		first.Connections[0].Destination.Port != 1000 {
		t.Fatalf("caps %+v", first)
	}
}

// query parses expr with Prometheus's parser: the two halves of the or, each a sum of increase over the metric.
func query(t *testing.T, expr, metric string) (halves [2]map[string]*labels.Matcher, by []string, rng time.Duration) {
	t.Helper()
	e, err := parser.NewParser(parser.Options{}).ParseExpr(expr)
	if err != nil {
		t.Fatalf("%s: %v", expr, err)
	}
	or, ok := e.(*parser.BinaryExpr)
	if !ok || or.Op != parser.LOR {
		t.Fatalf("not an or: %s", expr)
	}
	for i, side := range []parser.Expr{or.LHS, or.RHS} {
		agg, ok := side.(*parser.AggregateExpr)
		if !ok || agg.Op != parser.SUM {
			t.Fatalf("not a sum: %s", expr)
		}
		call := agg.Expr.(*parser.Call)
		if call.Func.Name != "increase" {
			t.Fatalf("not increase: %s", expr)
		}
		ms := call.Args[0].(*parser.MatrixSelector)
		vs := ms.VectorSelector.(*parser.VectorSelector)
		halves[i] = map[string]*labels.Matcher{}
		for _, m := range vs.LabelMatchers {
			halves[i][m.Name] = m
		}
		if halves[i]["__name__"].Value != metric {
			t.Fatalf("metric %s", expr)
		}
		if i > 0 && (!reflect.DeepEqual(agg.Grouping, by) || ms.Range != rng) {
			t.Fatalf("the halves differ: %s", expr)
		}
		by, rng = agg.Grouping, ms.Range
	}
	return
}

var labelsShape = []string{"__name__", "destination_namespace", "destination_workload", "destination_workload_kind", "family", "flag", "instance", "job", "source_namespace", "source_workload", "source_workload_kind", "traffic_direction"}

func TestDetectShape(t *testing.T) {
	s, ok := DetectShape(labelsShape)
	if !ok || s.Style != netdrops.StyleLabels || !s.Kind || !s.Direction {
		t.Fatalf("%+v %v", s, ok)
	}
	s, ok = DetectShape([]string{"source", "destination", "flag"})
	if !ok || s.Style != netdrops.StylePod || s.Direction {
		t.Fatalf("%+v %v", s, ok)
	}
	if _, ok := DetectShape([]string{"flag", "family", "traffic_direction"}); ok {
		t.Fatal("no ends, no shape")
	}
}

func TestQueryLabels(t *testing.T) {
	shape, _ := DetectShape(labelsShape)
	halves, by, rng := query(t, Query(TCPMetric, shape, []string{"shop", "ops"}, time.Hour), TCPMetric)
	if rng != time.Hour || !reflect.DeepEqual(by, []string{"source_namespace", "source_workload", "source_workload_kind",
		"destination_namespace", "destination_workload", "destination_workload_kind", "traffic_direction"}) {
		t.Fatalf("by %v %v", by, rng)
	}
	src, dst := halves[0], halves[1]
	if src["flag"].Value != "SYN" || dst["flag"].Value != "SYN" || src["destination_namespace"] != nil || dst["source_namespace"] != nil {
		t.Fatalf("matchers %v %v", src, dst)
	}
	for v, want := range map[string]bool{"shop": true, "ops": true, "shopping": false, "kube-system": false, "": false} {
		if src["source_namespace"].Matches(v) != want || dst["destination_namespace"].Matches(v) != want {
			t.Errorf("namespace %q matches %v", v, !want)
		}
	}
	// the drop metric is summed by reason too, and has no flag
	halves, by, _ = query(t, Query(netdrops.Metric, Shape{Shape: netdrops.Shape{Style: netdrops.StyleLabels, Pod: true}}, []string{"shop"}, 24*time.Hour), netdrops.Metric)
	if halves[0]["flag"] != nil || !reflect.DeepEqual(by, []string{"source_namespace", "source_workload", "source_pod", "destination_namespace", "destination_workload", "destination_pod", "reason"}) {
		t.Fatalf("drops %v %v", halves, by)
	}
}

func TestQueryPod(t *testing.T) {
	halves, by, _ := query(t, Query(TCPMetric, Shape{Shape: netdrops.Shape{Style: netdrops.StylePod}}, []string{"shop", "ops"}, time.Hour), TCPMetric)
	if !reflect.DeepEqual(by, []string{"source", "destination"}) {
		t.Fatalf("by %v", by)
	}
	for v, want := range map[string]bool{"shop/web-1": true, "ops/x": true, "shop/": false, "shopping/web-1": false, "kube-system/dns": false} {
		if halves[0]["source"].Matches(v) != want || halves[1]["destination"].Matches(v) != want {
			t.Errorf("%q matches %v", v, !want)
		}
	}
}

// Any valid namespaces give a query Prometheus parses whose matchers take exactly those namespaces.
func TestQueryNamesStayValues(t *testing.T) {
	rnd := rand.New(rand.NewSource(11))
	alphabet := "abcdefghijklmnopqrstuvwxyz0123456789-"
	name := func() string {
		for {
			b := make([]byte, 1+rnd.Intn(20))
			for i := range b {
				b[i] = alphabet[rnd.Intn(len(alphabet))]
			}
			if s := string(b); nameRe.MatchString(s) {
				return s
			}
		}
	}
	for i := 0; i < 2000; i++ {
		var raw []string
		for j := 0; j <= rnd.Intn(4); j++ {
			raw = append(raw, name())
		}
		nss, err := ParseNamespaces(strings.Join(raw, ","))
		if err != nil {
			t.Fatal(err)
		}
		labelsStyle := Shape{Shape: netdrops.Shape{Style: netdrops.StyleLabels, Kind: true}, Direction: true}
		halves, _, _ := query(t, Query(TCPMetric, labelsStyle, nss, time.Hour), TCPMetric)
		podStyle, _, _ := query(t, Query(netdrops.Metric, Shape{Shape: netdrops.Shape{Style: netdrops.StylePod}}, nss, time.Hour), netdrops.Metric)
		for _, ns := range nss {
			if !halves[0]["source_namespace"].Matches(ns) || !podStyle[1]["destination"].Matches(ns+"/x") {
				t.Fatalf("%v → %v", nss, halves)
			}
		}
		if halves[0]["source_namespace"].Matches(nss[0]+"x") || podStyle[0]["source"].Matches(nss[0]+"x/y") {
			t.Fatalf("%v matches more", nss)
		}
	}
}

func sample(v float64, kv ...string) Sample {
	l := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		l[kv[i]] = kv[i+1]
	}
	return Sample{Labels: l, Value: v}
}

func ends(src, dst string, kv ...string) []string {
	s := strings.SplitN(src, "/", 3)
	d := strings.SplitN(dst, "/", 3)
	return append([]string{"source_namespace", s[0], "source_workload_kind", s[1], "source_workload", s[2],
		"destination_namespace", d[0], "destination_workload_kind", d[1], "destination_workload", d[2]}, kv...)
}

func TestFromMetrics(t *testing.T) {
	tcp, _ := DetectShape(labelsShape)
	drop := Shape{Shape: netdrops.Shape{Style: netdrops.StyleLabels, Kind: true}, Direction: true}
	tcpRows := []Sample{
		// one SYN seen leaving the client and arriving at web: one connection, counted where it arrived
		sample(12.4, ends("shop/Deployment/client", "shop/Deployment/web", "traffic_direction", "egress")...),
		sample(11.6, ends("shop/Deployment/client", "shop/Deployment/web", "traffic_direction", "ingress")...),
		sample(4, ends("shop/Deployment/client", "ops/Deployment/audit", "traffic_direction", "egress")...),
		sample(4, ends("shop/Deployment/client", "ops/Deployment/audit", "traffic_direction", "ingress")...),
		sample(0.2, ends("shop/Deployment/client", "shop/Deployment/idle", "traffic_direction", "ingress")...), // rounds to 0
		// stranger's SYNs leave (FORWARDED at its egress) and are dropped at web: not opened
		sample(9, ends("shop/Deployment/stranger", "shop/Deployment/web", "traffic_direction", "egress")...),
		// SYNs seen leaving towards a pod and never arriving, with no drop counted: no line
		sample(5, ends("shop/Deployment/client", "shop/Deployment/ghost", "traffic_direction", "egress")...),
		// the world reaching web: only the ingress side sees it; web reaching the world: only the egress side
		sample(3, "destination_namespace", "shop", "destination_workload", "web", "destination_workload_kind", "Deployment", "traffic_direction", "ingress"),
		sample(2, "source_namespace", "shop", "source_workload", "web", "source_workload_kind", "Deployment", "traffic_direction", "egress"),
	}
	dropRows := []Sample{
		sample(5, ends("shop/Deployment/stranger", "shop/Deployment/web", "reason", "POLICY_DENIED", "traffic_direction", "ingress")...),
		sample(1, ends("shop/Deployment/stranger", "shop/Deployment/web", "reason", "CT_MAP_INSERTION_FAILED", "traffic_direction", "egress")...),
	}
	got := FromMetrics(tcp, true, tcpRows, drop, true, dropRows, []string{"shop"}, []string{"shop"}, time.Hour)
	if !got.Available || got.Source != "metrics" || got.Style != netdrops.StyleLabels || got.Range != "1h0m0s" || len(got.Notes) != 0 || !got.Redacted {
		t.Fatalf("result %+v", got)
	}
	want := []Line{
		{From: End{"shop", "Deployment", "client", ""}, To: End{"shop", "Deployment", "web", ""}, Allowed: 12},
		{From: End{"shop", "Deployment", "stranger", ""}, To: End{"shop", "Deployment", "web", ""}, Dropped: 6,
			Reasons: []netdrops.Reason{{Reason: "POLICY_DENIED", Count: 5}, {Reason: "CT_MAP_INSERTION_FAILED", Count: 1}}},
		// ops is outside the reader's namespaces: its namespace only
		{From: End{"shop", "Deployment", "client", ""}, To: End{Namespace: "ops"}, Allowed: 4},
		{From: End{Outside: "unknown"}, To: End{"shop", "Deployment", "web", ""}, Allowed: 3},
		{From: End{"shop", "Deployment", "web", ""}, To: End{Outside: "unknown"}, Allowed: 2},
	}
	if !reflect.DeepEqual(got.Lines, want) {
		t.Fatalf("lines\n%+v\nwant\n%+v", got.Lines, want)
	}

	// without traffic_direction both ends' counts add up, and the screen says so
	noDir := Shape{Shape: tcp.Shape}
	got = FromMetrics(noDir, true, tcpRows[:2], drop, false, nil, []string{"shop"}, nil, time.Hour)
	if got.Lines[0].Allowed != 24 || !reflect.DeepEqual(got.Notes, []string{NoteCountedTwice, NoteNoDropMetric}) || got.Redacted { // 12 + 12
		t.Fatalf("no direction %+v", got)
	}
	// drops only
	got = FromMetrics(Shape{}, false, nil, drop, true, dropRows, []string{"shop"}, nil, time.Hour)
	if len(got.Lines) != 1 || got.Lines[0].Dropped != 6 || !reflect.DeepEqual(got.Notes, []string{NoteNoTCPMetric}) || got.Style != netdrops.StyleLabels {
		t.Fatalf("drops only %+v", got)
	}
	// pod style: "namespace/name" may be a pod or a workload, so no kind
	pod := Shape{Shape: netdrops.Shape{Style: netdrops.StylePod}}
	got = FromMetrics(pod, true, []Sample{sample(2, "source", "shop/client-1", "destination", "shop/web-1"), sample(1, "source", "shop/client-1")}, Shape{}, false, nil, []string{"shop"}, nil, time.Hour)
	if !reflect.DeepEqual(got.Lines, []Line{
		{From: End{Namespace: "shop", Name: "client-1"}, To: End{Namespace: "shop", Name: "web-1"}, Allowed: 2},
		{From: End{Namespace: "shop", Name: "client-1"}, To: End{Outside: "unknown"}, Allowed: 1},
	}) {
		t.Fatalf("pod style %+v", got.Lines)
	}
}
