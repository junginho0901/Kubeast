package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
)

// calicoLookup is what the cluster of internal/netflows/testdata/whisker-flows.json answers.
type calicoLookup struct{}

func (calicoLookup) Workloads(_ context.Context, ns string) (map[string]netflows.Workload, error) {
	switch ns {
	case "flows-demo":
		return map[string]netflows.Workload{
			"client-7bc956576c-*": {Kind: "Deployment", Name: "client"}, "web-787b7df48d-*": {Kind: "Deployment", Name: "web"},
			"stranger-f6b8b5b45-*": {Kind: "Deployment", Name: "stranger"},
		}, nil
	case "kube-system":
		return map[string]netflows.Workload{"coredns-559f6c778d-*": {Kind: "Deployment", Name: "coredns"}}, nil
	}
	return nil, errors.New("forbidden")
}

func (calicoLookup) ServiceIPs(context.Context, string) (map[string]bool, error) { return nil, nil }

func (calicoLookup) PodSet(_ context.Context, ns, pod string) (string, error) {
	if ns == "flows-demo" && strings.HasPrefix(pod, "web-787b7df48d-") {
		return "web-787b7df48d-*", nil
	}
	return pod, nil
}

// A cluster read as calico: Whisker answers its recorded flow list (no filter applied — Kubeast checks every item).
func newCalicoFixture(t *testing.T) (*netflowsFixture, *[]string) {
	t.Helper()
	raw, err := os.ReadFile("../netflows/testdata/whisker-flows.json")
	if err != nil {
		t.Fatal(err)
	}
	f := &netflowsFixture{store: &memAudit{}}
	var paths []string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls++
		paths = append(paths, r.Method+" "+r.URL.Path)
		if f.status != 0 {
			w.WriteHeader(f.status)
			return
		}
		_, _ = w.Write(raw)
	}))
	t.Cleanup(srv.Close)
	s, err := netflows.New(netflows.Config{
		Clusters:     map[string]netflows.Target{"cal": {Mode: "proxy", Source: netflows.SourceCalico, Relay: netflows.DefaultWhisker}},
		DefaultRange: 15 * time.Minute, MaxRange: time.Hour, MaxFlows: 50, GraphMaxFlows: 400, Timeout: 2 * time.Second, PerUserPerMinute: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.h = &Handler{auditStore: f.store, netflowsLook: calicoLookup{}}
	f.h.SetNetworkFlows(s)
	f.h.netflowsCanI = func(_ context.Context, t netflows.Target) (bool, error) {
		f.relays, f.verbs = append(f.relays, t.Relay), append(f.verbs, t.ProxyVerb())
		return f.status != http.StatusForbidden, nil
	}
	f.h.netflowsDial = func(context.Context, netflows.Target) (string, *http.Client, error) {
		return srv.URL + "/whisker-backend/flows", srv.Client(), nil
	}
	f.h.netflowsNow = func() time.Time { return time.Date(2026, 10, 25, 12, 55, 30, 0, time.UTC) }
	return f, &paths
}

func (f *netflowsFixture) getCalico(target string) (*httptest.ResponseRecorder, netflows.Result) {
	w := httptest.NewRecorder()
	f.h.NetworkFlows(w, logSearchRequestAs(target, "cal", "flows-demo", flowReader))
	var res netflows.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	return w, res
}

func TestNetworkFlowsCalico(t *testing.T) {
	f, paths := newCalicoFixture(t)
	w, res := f.getCalico("/api/v1/namespaces/flows-demo/networkflows?kind=Deployment&name=web")
	if w.Code != http.StatusOK || res.Provider != "calico" || res.Relay != "calico-system/whisker:8443" || len(res.Groups) != 2 { // client allowed, stranger dropped
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	// the cluster was asked for get on Whisker's services/proxy, and Whisker for its two lists
	if len(f.verbs) != 1 || f.verbs[0] != "get" || f.relays[0].ProxyName() != "https:whisker:8443" || len(*paths) != 2 || (*paths)[0] != "GET /whisker-backend/flows" {
		t.Fatalf("verbs %v relays %v paths %v", f.verbs, f.relays, *paths)
	}
	row, after := f.lastRow(t)
	if row.Action != "k8s.networkflows.query" || after["provider"] != "calico" || after["relay"] != "calico-system/whisker:8443" || row.TargetType != "deployment" {
		t.Fatalf("audit %+v after %v", row, after)
	}
	// a pod: the flows of its set (Calico names the pods of one GenerateName together)
	if _, res = f.getCalico("/api/v1/namespaces/flows-demo/networkflows?kind=Pod&name=web-787b7df48d-9cf9k"); len(res.Flows) != 4 {
		t.Fatalf("pod: %+v", res)
	}
	// features say which clusters are Calico
	if got := f.h.networkFlowsFeature()["providers"].(map[string]string); got["cal"] != "calico" {
		t.Fatalf("providers %v", got)
	}
}

func TestNetworkFlowsCalicoRefusals(t *testing.T) {
	f, _ := newCalicoFixture(t)
	f.status = http.StatusForbidden
	w, _ := f.getCalico("/api/v1/namespaces/flows-demo/networkflows")
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "Calico's Whisker (get on services/proxy https:whisker:8443 in calico-system)") {
		t.Fatalf("forbidden: %d %s", w.Code, w.Body)
	}
	// the API server cannot reach Whisker: what to do is named
	f, _ = newCalicoFixture(t)
	f.status = http.StatusServiceUnavailable
	if w, _ = f.getCalico("/api/v1/namespaces/flows-demo/networkflows"); w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "lets the API server reach Whisker") {
		t.Fatalf("unreachable: %d %s", w.Code, w.Body)
	}
}

// The Resource Graph's lines from Calico: client → web allowed where it arrived, stranger → web dropped.
func TestNetworkTrafficCalico(t *testing.T) {
	f, _ := newCalicoFixture(t)
	w := httptest.NewRecorder()
	f.h.NetworkTraffic(w, logSearchRequestAs("/api/v1/networktraffic?namespaces=flows-demo&source=relay", "cal", "", flowReader))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	var res struct {
		Provider string `json:"provider"`
		Lines    []struct {
			From, To         struct{ Namespace, Name string }
			Allowed, Dropped int64
		} `json:"lines"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	got := map[string][2]int64{}
	for _, l := range res.Lines {
		got[l.From.Name+"→"+l.To.Name] = [2]int64{l.Allowed, l.Dropped}
	}
	// packets: client → web 818 + 736 back; stranger's 77 dropped at web (its 77 leaving, unanswered, are not allowed)
	if res.Provider != "calico" || got["client→web"] != [2]int64{1554, 0} || got["stranger→web"] != [2]int64{0, 77} {
		t.Fatalf("lines %v %s", got, res.Provider)
	}
}
