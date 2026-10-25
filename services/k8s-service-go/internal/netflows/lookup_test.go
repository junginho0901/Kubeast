package netflows

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"testing"
	"time"
)

// getflows-retina.bin is a GetFlows answer of Microsoft Retina's Hubble Relay (v1.3.0, kind with kindnet)
// read through the API server service proxy: 40 flows with either end in flows-demo, where client reaches web
// through the Service flows-demo/web (10.96.228.69) and both look up names through kube-dns (10.96.0.10).
var retinaNow = time.Date(2026, 10, 25, 11, 31, 30, 0, time.UTC)

const (
	retinaClient  = "client-7bc956576c-2j5zw"
	retinaWeb     = "web-787b7df48d-9h4c6"
	retinaWebIP   = "10.96.228.69"
	retinaDNSIP   = "10.96.0.10"
	retinaCoreDNS = "coredns-559f6c778d-jmv5l"
)

// fakeLookup answers from maps and counts what it was asked.
type fakeLookup struct {
	workloads map[string]map[string]Workload
	ips       map[string]map[string]bool
	fail      map[string]bool
	asked     []string
}

func (f *fakeLookup) Workloads(_ context.Context, ns string) (map[string]Workload, error) {
	f.asked = append(f.asked, "pods "+ns)
	if f.fail[ns] {
		return nil, errors.New("forbidden")
	}
	return f.workloads[ns], nil
}

func (f *fakeLookup) ServiceIPs(_ context.Context, ns string) (map[string]bool, error) {
	f.asked = append(f.asked, "services "+ns)
	if f.fail[ns] {
		return nil, errors.New("forbidden")
	}
	return f.ips[ns], nil
}

func retinaLookup() *fakeLookup {
	return &fakeLookup{
		workloads: map[string]map[string]Workload{
			"flows-demo": {
				retinaClient:               {Kind: "Deployment", Name: "client"},
				retinaWeb:                  {Kind: "Deployment", Name: "web"},
				"stranger-f6b8b5b45-9ndf6": {Kind: "Deployment", Name: "stranger"},
			},
			"kube-system": {retinaCoreDNS: {Kind: "Deployment", Name: "coredns"}, "coredns-559f6c778d-7nrtm": {Kind: "Deployment", Name: "coredns"}},
		},
		ips: map[string]map[string]bool{"flows-demo": {retinaWebIP: true}, "kube-system": {retinaDNSIP: true}},
	}
}

func TestDecodeRetinaFlows(t *testing.T) {
	flows := readFixture(t, "getflows-retina.bin")
	if len(flows) != 40 {
		t.Fatalf("40 flows asked for, got %d", len(flows))
	}
	var toService, fromService bool
	for _, f := range flows {
		if f.Source.Workload != nil || f.Destination.Workload != nil || f.Node != "" {
			t.Fatalf("Retina names pods only, and no node: %+v", f)
		}
		if f.Direction == "egress" && !f.IsReply && f.Destination.Pod == "" && f.Destination.IP == retinaWebIP {
			toService = f.Destination.Service == "flows-demo/web" && f.Destination.Port == 80 && f.Source.Pod == retinaClient || toService
		}
		if f.IsReply && f.Source.IP == retinaWebIP && f.Source.Pod == "" && f.Source.Service == "flows-demo/web" && f.Destination.Pod == retinaClient {
			fromService = true
		}
	}
	if !toService || !fromService {
		t.Fatalf("the Service's address both ways: to %v, back %v", toService, fromService)
	}
}

func TestFillNamesWorkloadsAndServiceAddresses(t *testing.T) {
	flows := readFixture(t, "getflows-retina.bin")
	l := retinaLookup()
	fill(context.Background(), l, flows)
	for _, f := range flows {
		for _, e := range []End{f.Source, f.Destination} {
			switch {
			case e.Pod != "" && (e.Workload == nil || e.Workload.Kind != "Deployment" || e.ServiceAddress):
				t.Fatalf("every pod gets its Deployment, and a pod's address is its own: %+v", e)
			case e.Pod == "" && e.ServiceAddress != (e.IP == retinaWebIP || e.IP == retinaDNSIP):
				t.Fatalf("the Services' addresses, both ways, and nothing else: %+v", e)
			}
		}
	}
	sort.Strings(l.asked)
	if want := []string{"pods flows-demo", "pods kube-system", "services flows-demo", "services kube-system"}; !reflect.DeepEqual(l.asked, want) {
		t.Fatalf("one list per namespace: %v", l.asked)
	}
}

// Cilium's flows name the workloads and the backend pod, so a read of them looks nothing up.
func TestFillAsksNothingOfCiliumFlows(t *testing.T) {
	flows := readFixture(t, "getflows-web.bin")
	before := fmt.Sprintf("%+v", flows)
	l := retinaLookup()
	fill(context.Background(), l, flows)
	if len(l.asked) != 0 || fmt.Sprintf("%+v", flows) != before {
		t.Fatalf("asked %v", l.asked)
	}
}

func TestFillLeavesWhatTheReaderCannotRead(t *testing.T) {
	flows := readFixture(t, "getflows-retina.bin")
	l := retinaLookup()
	l.fail = map[string]bool{"kube-system": true}
	fill(context.Background(), l, flows)
	for _, f := range flows {
		for _, e := range []End{f.Source, f.Destination} {
			if e.Namespace == "kube-system" && e.Workload != nil || e.IP == retinaDNSIP && e.ServiceAddress {
				t.Fatalf("kube-system stays as the flows name it: %+v", e)
			}
			if e.Namespace == "flows-demo" && e.Workload == nil || e.IP == retinaWebIP && !e.ServiceAddress {
				t.Fatalf("flows-demo is still filled: %+v", e)
			}
		}
	}
	fill(context.Background(), nil, flows) // no lookup: nothing to do
}

func TestFillCapsTheNamespaces(t *testing.T) {
	var flows []Flow
	for i := 0; i < MaxLookupNamespaces+5; i++ {
		ns := fmt.Sprintf("ns%02d", i)
		flows = append(flows, Flow{Source: End{Namespace: ns, Pod: "p"}, Destination: End{IP: "10.96.0.1", Service: ns + "/s"}})
	}
	l := &fakeLookup{}
	fill(context.Background(), l, flows)
	if len(l.asked) != 2*MaxLookupNamespaces {
		t.Fatalf("at most %d namespaces of each: %d", MaxLookupNamespaces, len(l.asked))
	}
}

// A workload's flows on Retina: the Relay is asked for its pods by name as well, and the flows are kept by the
// workload Kubeast names. Without the lookup nothing comes back, as before.
func TestQueryRetinaWorkload(t *testing.T) {
	r := &relay{messages: fixtureMessages(t, "getflows-retina.bin"), trailer: map[string]string{"Grpc-Status": "0"}}
	srv, client := r.serve(t)
	s := testStore()
	req := Request{Namespace: "flows-demo", Kind: "Deployment", Name: "web", Pods: []string{retinaWeb}, Lookup: retinaLookup(), Limit: 40}
	if err := s.Normalize(&req); err != nil {
		t.Fatal(err)
	}
	res, err := s.Query(context.Background(), client, srv.URL+getFlowsPath, req, retinaNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Groups) != 1 {
		t.Fatalf("one connection, client -> web: %+v", res.Groups)
	}
	g := res.Groups[0]
	// in the fixture: five client -> web packets seen entering web, four replies seen entering client
	if g.Source.Workload.Name != "client" || g.Destination.Workload.Name != "web" || g.Destination.Port != 80 || g.Count != 5 || g.Replies != 4 {
		t.Fatalf("group %+v", g)
	}
	w := []Workload{{Kind: "Deployment", Name: "web"}}
	want := encodeRequest(20, []filter{
		{sourcePod: []string{"flows-demo/"}, sourceWorkload: w}, {destinationPod: []string{"flows-demo/"}, destinationWorkload: w},
		{sourcePod: []string{"flows-demo/" + retinaWeb}}, {destinationPod: []string{"flows-demo/" + retinaWeb}},
	})
	if string(r.got) != string(frame(want)) {
		t.Fatalf("request %x", r.got)
	}

	req.Lookup = nil
	if res, err = s.Query(context.Background(), client, srv.URL+getFlowsPath, req, retinaNow); err != nil || len(res.Flows) != 0 {
		t.Fatalf("without the lookup no flow names the workload: %d %v", len(res.Flows), err)
	}
}
