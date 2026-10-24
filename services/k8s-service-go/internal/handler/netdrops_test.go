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

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// fakeDrops answers like the Cilium kind cluster's Prometheus (deploy/kind/cilium-values.yaml).
type fakeDrops struct {
	available bool
	labels    []string
	labelsErr error
	queryErr  error
	workload  *netdrops.Workload
	pods      []string
	queries   []string
	targets   []string
}

func (f *fakeDrops) PrometheusAvailable(context.Context) bool { return f.available }

func (f *fakeDrops) PrometheusLabels(_ context.Context, label, selector string, since time.Duration, _ int) ([]string, error) {
	if label != "" || selector != netdrops.Metric || since <= 0 {
		return nil, errors.New("unexpected labels call")
	}
	return f.labels, f.labelsErr
}

func (f *fakeDrops) PrometheusQuery(_ context.Context, q string) ([]k8s.PrometheusQueryResult, error) {
	f.queries = append(f.queries, q)
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	if strings.Contains(q, `destination_workload="web"`) {
		return []k8s.PrometheusQueryResult{
			{Metric: map[string]interface{}{"reason": "POLICY_DENIED", "source_namespace": "flows-demo", "source_workload": "stranger", "source_workload_kind": "Deployment"}, Value: 28},
			{Metric: map[string]interface{}{"reason": "POLICY_DENIED", "source_namespace": "other", "source_workload": "scanner", "source_workload_kind": "DaemonSet"}, Value: 3},
		}, nil
	}
	return nil, nil
}

func (f *fakeDrops) NetdropsTarget(_ context.Context, namespace, kind, name string, wantPods bool) (*netdrops.Workload, []string, bool, error) {
	f.targets = append(f.targets, kind+"/"+namespace+"/"+name)
	var pods []string
	if wantPods {
		pods = f.pods
	}
	return f.workload, pods, false, nil
}

var dropsShape = []string{"__name__", "destination_namespace", "destination_workload", "destination_workload_kind", "protocol", "reason", "source_namespace", "source_workload", "source_workload_kind", "traffic_direction"}

func getDrops(h *Handler, target string, payload auth.TokenPayload) (*httptest.ResponseRecorder, netdrops.Result) {
	w := httptest.NewRecorder()
	h.NetworkDrops(w, logSearchRequestAs(target, "self", "flows-demo", payload))
	var res netdrops.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	return w, res
}

func TestNetworkDropsReads(t *testing.T) {
	f := &fakeDrops{available: true, labels: dropsShape, workload: &netdrops.Workload{Kind: "Deployment", Name: "web"}}
	h := &Handler{netdropsSrc: f}
	w, res := getDrops(h, "/api/v1/namespaces/flows-demo/networkdrops?kind=Pod&name=web-5f98b4964-h725v&range=15m", flowReader)
	if w.Code != http.StatusOK || !res.Available || res.Style != netdrops.StyleLabels || res.Range != "15m0s" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if len(f.targets) != 1 || f.targets[0] != "Pod/flows-demo/web-5f98b4964-h725v" || len(f.queries) != 2 || !strings.Contains(f.queries[0], "[900s]") {
		t.Fatalf("targets %v queries %v", f.targets, f.queries)
	}
	if res.Incoming.Total != 31 || res.Incoming.Peers[0].Workload != "stranger" || res.Workload.Name != "web" || res.Notes[0] != netdrops.NoteWorkloadLevel || res.Redacted {
		t.Fatalf("%+v", res)
	}
	// a namespace-limited reader: peers elsewhere by namespace only
	scoped := flowReader
	scoped.Namespaces = map[string][]string{"self": {"flows-demo"}}
	_, res = getDrops(h, "/api/v1/namespaces/flows-demo/networkdrops?kind=Deployment&name=web", scoped)
	if !res.Redacted || res.Incoming.Peers[1] != (netdrops.Peer{Namespace: "other", Reason: "POLICY_DENIED", Count: 3}) {
		t.Fatalf("scoped %+v", res.Incoming)
	}
}

// With one label per end ("<namespace>/<pod>"), a workload's drops are its pods': they are asked for and named in the query.
func TestNetworkDropsPodStyle(t *testing.T) {
	f := &fakeDrops{available: true, labels: []string{"__name__", "destination", "protocol", "reason", "source"},
		workload: &netdrops.Workload{Kind: "Deployment", Name: "web"}, pods: []string{"web-5f98b4964-h725v", "web-5f98b4964-x2k4q"}}
	w, res := getDrops(&Handler{netdropsSrc: f}, "/api/v1/namespaces/flows-demo/networkdrops?kind=Deployment&name=web", flowReader)
	if w.Code != http.StatusOK || res.Style != netdrops.StylePod || len(f.queries) != 2 {
		t.Fatalf("%d %s %v", w.Code, w.Body, f.queries)
	}
	if !strings.Contains(f.queries[0], `destination=~"flows-demo/(web|web-5f98b4964-h725v|web-5f98b4964-x2k4q)"`) {
		t.Fatalf("pods not in the query: %s", f.queries[0])
	}
	// a pod is its own name: no pods asked
	f.queries = nil
	getDrops(&Handler{netdropsSrc: f}, "/api/v1/namespaces/flows-demo/networkdrops?kind=Pod&name=web-5f98b4964-h725v", flowReader)
	if !strings.Contains(f.queries[0], `destination=~"flows-demo/web-5f98b4964-h725v"`) {
		t.Fatalf("pod: %s", f.queries[0])
	}
}

func TestNetworkDropsNotAvailable(t *testing.T) {
	for _, c := range []struct {
		f      *fakeDrops
		reason string
	}{
		{&fakeDrops{}, "no_prometheus"},
		{&fakeDrops{available: true}, "no_metrics"},
		{&fakeDrops{available: true, labels: []string{"__name__", "reason", "protocol", "instance"}}, "no_context_labels"},
	} {
		w, res := getDrops(&Handler{netdropsSrc: c.f}, "/api/v1/namespaces/flows-demo/networkdrops", flowReader)
		if w.Code != http.StatusOK || res.Available || res.Reason != c.reason || len(c.f.queries) != 0 {
			t.Errorf("%s: %d %s", c.reason, w.Code, w.Body)
		}
	}
}

func TestNetworkDropsRefusals(t *testing.T) {
	podOnly := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"*": {"resource.pod.read"}}}
	for _, c := range []struct {
		name    string
		target  string
		payload auth.TokenPayload
		f       *fakeDrops
		status  int
	}{
		{"no permission", "/api/v1/namespaces/flows-demo/networkdrops", podOnly, &fakeDrops{available: true, labels: dropsShape}, http.StatusForbidden},
		{"name with PromQL in it", `/api/v1/namespaces/flows-demo/networkdrops?kind=Deployment&name=web"}%20or%20vector(1)`, flowReader, &fakeDrops{available: true, labels: dropsShape}, http.StatusBadRequest},
		{"range over a day", "/api/v1/namespaces/flows-demo/networkdrops?range=48h", flowReader, &fakeDrops{available: true, labels: dropsShape}, http.StatusBadRequest},
		{"the cluster refuses Prometheus", "/api/v1/namespaces/flows-demo/networkdrops", flowReader,
			&fakeDrops{available: true, labelsErr: apierrors.NewForbidden(schema.GroupResource{Resource: "services/proxy"}, "prometheus:9090", errors.New("no"))}, http.StatusForbidden},
		{"Prometheus fails", "/api/v1/namespaces/flows-demo/networkdrops?kind=Deployment&name=web", flowReader,
			&fakeDrops{available: true, labels: dropsShape, workload: &netdrops.Workload{Kind: "Deployment", Name: "web"}, queryErr: k8s.ErrPrometheusUpstream}, http.StatusBadGateway},
	} {
		w, _ := getDrops(&Handler{netdropsSrc: c.f}, c.target, c.payload)
		if w.Code != c.status {
			t.Errorf("%s: %d %s", c.name, w.Code, w.Body)
		}
		if c.status == http.StatusBadRequest && len(c.f.queries) != 0 {
			t.Errorf("%s: queried %v", c.name, c.f.queries)
		}
	}
}
