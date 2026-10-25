package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nettraffic"
)

// retinaLookup is what the cluster of internal/netflows/testdata/getflows-retina.bin answers: the demo pods'
// Deployments and the Services' cluster IPs.
type retinaLookup struct{ asked []string }

func (l *retinaLookup) Workloads(_ context.Context, ns string) (map[string]netflows.Workload, error) {
	l.asked = append(l.asked, "pods "+ns)
	switch ns {
	case "flows-demo":
		return map[string]netflows.Workload{
			"client-7bc956576c-2j5zw": {Kind: "Deployment", Name: "client"}, "web-787b7df48d-9h4c6": {Kind: "Deployment", Name: "web"},
			"stranger-f6b8b5b45-9ndf6": {Kind: "Deployment", Name: "stranger"},
		}, nil
	case "kube-system":
		return map[string]netflows.Workload{"coredns-559f6c778d-jmv5l": {Kind: "Deployment", Name: "coredns"}, "coredns-559f6c778d-7nrtm": {Kind: "Deployment", Name: "coredns"}}, nil
	}
	return nil, errors.New("forbidden")
}

func (l *retinaLookup) ServiceIPs(_ context.Context, ns string) (map[string]bool, error) {
	l.asked = append(l.asked, "services "+ns)
	return map[string]map[string]bool{"flows-demo": {"10.96.228.69": true}, "kube-system": {"10.96.0.10": true}}[ns], nil
}

var retinaRecorded = time.Date(2026, 10, 25, 11, 31, 30, 0, time.UTC)

// A Deployment's recent flows on Retina, whose flows name pods only: found through the pods' workloads.
func TestNetworkFlowsRetinaWorkload(t *testing.T) {
	f := newNetflowsFixtureFrom(t, 5, "getflows-retina.bin", retinaRecorded)
	read := func() netflows.Result {
		t.Helper()
		w := httptest.NewRecorder()
		f.h.NetworkFlows(w, logSearchRequestAs("/api/v1/namespaces/flows-demo/networkflows?kind=Deployment&name=web&since=15m", "self", "flows-demo", flowReader))
		if w.Code != http.StatusOK {
			t.Fatalf("status %d %s", w.Code, w.Body)
		}
		var res netflows.Result
		_ = json.Unmarshal(w.Body.Bytes(), &res)
		return res
	}
	if res := read(); len(res.Groups) != 0 {
		t.Fatalf("without a lookup the workload filter finds nothing: %+v", res.Groups)
	}
	l := &retinaLookup{}
	f.h.netflowsLook = l
	res := read()
	if len(res.Groups) != 1 || res.Groups[0].Source.Workload.Name != "client" || res.Groups[0].Destination.Workload.Name != "web" {
		t.Fatalf("client -> web: %+v", res.Groups)
	}
	if !strings.Contains(string(f.asked), "flows-demo/web-787b7df48d-9h4c6") {
		t.Fatalf("the Relay is asked for web's pods by name: %q", f.asked)
	}
}

// The Resource Graph's lines from Retina's Relay: one line client -> web, none to the Service's address.
func TestNetworkTrafficRelayRetina(t *testing.T) {
	f := newNetflowsFixtureFrom(t, 5, "getflows-retina.bin", retinaRecorded)
	f.h.netflowsLook = &retinaLookup{}
	w, res := getTraffic(f.h, "/api/v1/networktraffic?namespaces=flows-demo&source=relay", flowReader)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	if l := lineOf(res, "flows-demo/client", "flows-demo/web"); l == nil || l.Allowed != 9 {
		t.Fatalf("client -> web: %+v", res.Lines)
	}
	for _, l := range res.Lines {
		if l.To.Outside != "" {
			t.Fatalf("no line to an address outside the pods: %+v", l)
		}
	}
}

// retinaTraffic is a Prometheus whose Hubble metrics name pods only (Retina with source_pod/destination_pod).
type retinaTraffic struct{ fakeTraffic }

var retinaTCPShape = []string{"__name__", "destination_namespace", "destination_pod", "flag", "source_namespace", "source_pod", "traffic_direction"}

func (r *retinaTraffic) PrometheusQuery(_ context.Context, q string) ([]k8s.PrometheusQueryResult, error) {
	r.queries = append(r.queries, q)
	if !strings.Contains(q, nettraffic.TCPMetric) {
		return nil, nil
	}
	row := func(src, dst, dir string, v float64) k8s.PrometheusQueryResult {
		return k8s.PrometheusQueryResult{Metric: map[string]interface{}{"source_namespace": "flows-demo", "source_pod": src,
			"destination_namespace": "flows-demo", "destination_pod": dst, "traffic_direction": dir}, Value: v}
	}
	return []k8s.PrometheusQueryResult{
		row("client-7bc956576c-2j5zw", "web-787b7df48d-9h4c6", "ingress", 40),
		row("client-7bc956576c-2j5zw", "web-787b7df48d-9h4c6", "egress", 40),
	}, nil
}

func TestNetworkTrafficMetricsRetinaPods(t *testing.T) {
	src := &retinaTraffic{fakeTraffic{available: true, labels: map[string][]string{nettraffic.TCPMetric: retinaTCPShape, netdrops.Metric: {"reason", "traffic_direction"}}}}
	h := &Handler{netdropsSrc: src, netflowsLook: &retinaLookup{}}
	w, res := getTraffic(h, "/api/v1/networktraffic?namespaces=flows-demo&source=metrics", flowReader)
	if w.Code != http.StatusOK || !res.Available {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	if l := lineOf(res, "flows-demo/client", "flows-demo/web"); l == nil || l.Allowed != 40 || l.From.Kind != "Deployment" {
		t.Fatalf("the pods' Deployments: %+v", res.Lines)
	}
	if len(src.queries) != 1 || strings.Contains(src.queries[0], "_workload") || !strings.Contains(src.queries[0], "source_pod") {
		t.Fatalf("summed by pod, not by the empty workload labels: %v", src.queries)
	}
}
