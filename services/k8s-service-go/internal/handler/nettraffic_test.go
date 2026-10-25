package handler

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nettraffic"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"google.golang.org/protobuf/encoding/protowire"
)

func getTraffic(h *Handler, target string, payload auth.TokenPayload) (*httptest.ResponseRecorder, nettraffic.Result) {
	w := httptest.NewRecorder()
	h.NetworkTraffic(w, logSearchRequestAs(target, "self", "", payload))
	var res nettraffic.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	return w, res
}

func lineOf(res nettraffic.Result, from, to string) *nettraffic.Line {
	for i, l := range res.Lines {
		if l.From.Namespace+"/"+l.From.Name == from && l.To.Namespace+"/"+l.To.Name == to {
			return &res.Lines[i]
		}
	}
	return nil
}

func TestNetworkTrafficRelay(t *testing.T) {
	f := newNetflowsFixture(t, 5)
	w, res := getTraffic(f.h, "/api/v1/networktraffic?namespaces=demo&source=relay&since=1h", flowReader)
	if w.Code != http.StatusOK || !res.Available || res.Source != "relay" || res.Relay != "kube-system/hubble-relay:443" || res.Flows == 0 {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	allowed, dropped := lineOf(res, "demo/client", "demo/web"), lineOf(res, "demo/stranger", "demo/web")
	if allowed == nil || allowed.Allowed == 0 || allowed.Dropped != 0 || allowed.From.Kind != "Deployment" {
		t.Fatalf("client → web %+v in %+v", allowed, res.Lines)
	}
	// recorded from a real Relay: stranger's SYNs are FORWARDED leaving it and DROPPED at web — a dropped line
	if dropped == nil || dropped.Dropped == 0 || dropped.Allowed != 0 || dropped.Reasons[0].Reason != "POLICY_DENIED" {
		t.Fatalf("stranger → web %+v", dropped)
	}
	row, after := f.lastRow(t)
	if row.Action != "k8s.networkflows.query" || row.Result == audit.ResultFailure || row.TargetType != "namespaces" || row.TargetID != "demo" ||
		row.Namespace != "demo" || after["graph"] != true || !reflect.DeepEqual(after["namespaces"], []interface{}{"demo"}) || after["limit"] != float64(400) {
		t.Fatalf("audit %+v after %v", row, after)
	}
	if strings.Contains(string(row.After), "client-559d6f749c") || strings.Contains(string(row.After), "10.244.") {
		t.Fatal("the audit row carries flow contents")
	}
	// several namespaces: one read, one row, no single namespace
	f.calls = 0
	if w, _ := getTraffic(f.h, "/api/v1/networktraffic?namespaces=demo,shop&source=relay", flowReader); w.Code != http.StatusOK || f.calls != 1 {
		t.Fatalf("two namespaces: %d calls %d", w.Code, f.calls)
	}
	if row, after := f.lastRow(t); row.TargetID != "demo,shop" || row.Namespace != "" || !reflect.DeepEqual(after["namespaces"], []interface{}{"demo", "shop"}) {
		t.Fatalf("audit %+v %v", row, after)
	}
}

func TestNetworkTrafficRefusals(t *testing.T) {
	podOnly := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"*": {"resource.pod.read"}}}
	scoped := flowReader
	scoped.Namespaces = map[string][]string{"self": {"demo"}}
	cases := []struct {
		name    string
		target  string
		payload auth.TokenPayload
		canI    bool
		status  int
		audited bool
	}{
		{"no networkflow permission", "/api/v1/networktraffic?namespaces=demo&source=relay", podOnly, true, http.StatusForbidden, false},
		{"no source", "/api/v1/networktraffic?namespaces=demo", flowReader, true, http.StatusBadRequest, false},
		{"bad source", "/api/v1/networktraffic?namespaces=demo&source=stream", flowReader, true, http.StatusBadRequest, false},
		{"no namespace", "/api/v1/networktraffic?source=relay", flowReader, true, http.StatusBadRequest, false},
		{"bad namespace", "/api/v1/networktraffic?namespaces=demo,a%7Cb&source=relay", flowReader, true, http.StatusBadRequest, false},
		{"outside the grant", "/api/v1/networktraffic?namespaces=demo,shop&source=relay", scoped, true, http.StatusForbidden, false},
		{"over the window", "/api/v1/networktraffic?namespaces=demo&source=relay&since=2h", flowReader, true, http.StatusBadRequest, false},
		{"the cluster refuses the Relay", "/api/v1/networktraffic?namespaces=demo&source=relay", flowReader, false, http.StatusForbidden, true},
	}
	for _, c := range cases {
		f := newNetflowsFixture(t, 5)
		allowed := c.canI
		f.h.netflowsCanI = func(context.Context, netflows.Target) (bool, error) { return allowed, nil }
		w, _ := getTraffic(f.h, c.target, c.payload)
		if w.Code != c.status || f.calls != 0 {
			t.Errorf("%s: %d %s (relay calls %d)", c.name, w.Code, w.Body, f.calls)
		}
		if c.audited {
			if row, _ := f.lastRow(t); row.Result != audit.ResultFailure || row.TargetType != "namespaces" {
				t.Errorf("%s: audit %+v", c.name, row)
			}
		} else if len(f.store.rows) != 0 {
			t.Errorf("%s: unexpected audit rows %d", c.name, len(f.store.rows))
		}
	}
	// a cluster without flows
	f := newNetflowsFixture(t, 5)
	w := httptest.NewRecorder()
	f.h.NetworkTraffic(w, logSearchRequestAs("/api/v1/networktraffic?namespaces=demo&source=relay", "other", "", flowReader))
	if w.Code != http.StatusNotFound {
		t.Fatalf("not configured: %d", w.Code)
	}
	// a read the audit store cannot record is refused before the Relay is asked
	g := newNetflowsFixture(t, 5)
	g.h.auditStore = &downAudit{}
	if w, _ := getTraffic(g.h, "/api/v1/networktraffic?namespaces=demo&source=relay", flowReader); w.Code != http.StatusServiceUnavailable || g.calls != 0 {
		t.Fatalf("without audit: %d calls %d", w.Code, g.calls)
	}
}

// The token's namespaces reach the Relay read: ends outside them show their namespace only.
func TestNetworkTrafficRelayScope(t *testing.T) {
	f := newNetflowsFixture(t, 5)
	scoped := flowReader
	scoped.Namespaces = map[string][]string{"self": {"shop"}}
	w, res := getTraffic(f.h, "/api/v1/networktraffic?namespaces=shop&source=relay", scoped)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	// the fixture is namespace demo: asked for shop, nothing comes back
	if len(res.Lines) != 0 {
		t.Fatalf("another namespace's flows: %+v", res.Lines)
	}
}

// droppedFlow is one GetFlows answer message: a DROPPED flow from (namespace, pod, workload) to demo/web-1:80.
func droppedFlow(at time.Time, ns, pod, workload string) []byte {
	str := func(b []byte, n protowire.Number, v string) []byte {
		b = protowire.AppendTag(b, n, protowire.BytesType)
		return protowire.AppendString(b, v)
	}
	msg := func(b []byte, n protowire.Number, m []byte) []byte {
		b = protowire.AppendTag(b, n, protowire.BytesType)
		return protowire.AppendBytes(b, m)
	}
	end := func(ns, pod, workload string) []byte {
		b := str(str(nil, 3, ns), 5, pod)
		if workload != "" {
			b = msg(b, 6, str(str(nil, 1, workload), 2, "Deployment"))
		}
		return b
	}
	var flow, ts, tcp []byte
	ts = protowire.AppendVarint(protowire.AppendTag(ts, 1, protowire.VarintType), uint64(at.Unix()))
	flow = msg(flow, 1, ts)
	flow = protowire.AppendVarint(protowire.AppendTag(flow, 2, protowire.VarintType), uint64(netflows.Verdicts["DROPPED"]))
	tcp = protowire.AppendVarint(protowire.AppendTag(tcp, 2, protowire.VarintType), 80)
	flow = msg(flow, 6, msg(nil, 1, tcp))
	flow = msg(flow, 8, end(ns, pod, workload))
	flow = msg(flow, 9, end("demo", "web-1", "web"))
	m := msg(nil, 1, flow)
	out := make([]byte, 5, 5+len(m))
	binary.BigEndian.PutUint32(out[1:], uint32(len(m)))
	return append(out, m...)
}

// A namespace-limited reader's Relay read hides the ends outside their namespaces: namespace only.
func TestNetworkTrafficRelayRedactsOutsideTheScope(t *testing.T) {
	f := newNetflowsFixture(t, 5)
	at := time.Date(2026, 10, 24, 14, 5, 0, 0, time.UTC)
	answer := append(droppedFlow(at, "ops", "probe-1", "probe"), droppedFlow(at, "demo", "client-1", "client")...)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/grpc")
		w.Header().Set("Trailer", "Grpc-Status")
		_, _ = w.Write(answer)
		w.Header().Set("Grpc-Status", "0")
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	f.h.netflowsDial = func(context.Context, netflows.Target) (string, *http.Client, error) {
		return srv.URL + "/observer.Observer/GetFlows", srv.Client(), nil
	}
	scoped := flowReader
	scoped.Namespaces = map[string][]string{"self": {"demo"}}
	_, res := getTraffic(f.h, "/api/v1/networktraffic?namespaces=demo&source=relay", scoped)
	if !res.Redacted || lineOf(res, "ops/", "demo/web") == nil || lineOf(res, "demo/client", "demo/web") == nil {
		t.Fatalf("scoped: %+v", res)
	}
	_, res = getTraffic(f.h, "/api/v1/networktraffic?namespaces=demo&source=relay", flowReader)
	if res.Redacted || lineOf(res, "ops/probe", "demo/web") == nil {
		t.Fatalf("unscoped: %+v", res)
	}
}

// fakeTraffic answers like the Cilium kind cluster's Prometheus with the tcp and drop metrics.
type fakeTraffic struct {
	available bool
	labels    map[string][]string
	queryErr  error
	queries   []string
}

func (f *fakeTraffic) PrometheusAvailable(context.Context) bool { return f.available }

func (f *fakeTraffic) PrometheusLabels(_ context.Context, label, selector string, since time.Duration, _ int) ([]string, error) {
	if label != "" || since <= 0 {
		return nil, errors.New("unexpected labels call")
	}
	return f.labels[selector], nil
}

func (f *fakeTraffic) PrometheusQuery(_ context.Context, q string) ([]k8s.PrometheusQueryResult, error) {
	f.queries = append(f.queries, q)
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	ends := func(src, dst string) map[string]interface{} {
		return map[string]interface{}{"source_namespace": "flows-demo", "source_workload": src, "source_workload_kind": "Deployment",
			"destination_namespace": "flows-demo", "destination_workload": dst, "destination_workload_kind": "Deployment"}
	}
	with := func(m map[string]interface{}, kv ...string) map[string]interface{} {
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	switch {
	case strings.Contains(q, nettraffic.TCPMetric):
		return []k8s.PrometheusQueryResult{
			{Metric: with(ends("client", "web"), "traffic_direction", "egress"), Value: 1200},
			{Metric: with(ends("client", "web"), "traffic_direction", "ingress"), Value: 1199.6},
			{Metric: with(ends("client", "audit"), "destination_namespace", "ops", "traffic_direction", "egress"), Value: 7},
			{Metric: with(ends("client", "audit"), "destination_namespace", "ops", "traffic_direction", "ingress"), Value: 7},
			// dropped at web: seen leaving stranger only
			{Metric: with(ends("stranger", "web"), "traffic_direction", "egress"), Value: 2400},
		}, nil
	case strings.Contains(q, netdrops.Metric):
		return []k8s.PrometheusQueryResult{{Metric: with(ends("stranger", "web"), "reason", "POLICY_DENIED", "traffic_direction", "ingress"), Value: 2400}}, nil
	}
	return nil, nil
}

func (f *fakeTraffic) NetdropsTarget(context.Context, string, string, string, bool) (*netdrops.Workload, []string, bool, error) {
	return nil, nil, false, errors.New("not used")
}

var tcpShape = []string{"__name__", "destination_namespace", "destination_workload", "destination_workload_kind", "family", "flag", "source_namespace", "source_workload", "source_workload_kind", "traffic_direction"}

func TestNetworkTrafficMetrics(t *testing.T) {
	src := &fakeTraffic{available: true, labels: map[string][]string{nettraffic.TCPMetric: tcpShape, netdrops.Metric: dropsShape}}
	store := &memAudit{}
	h := &Handler{netdropsSrc: src, auditStore: store}
	w, res := getTraffic(h, "/api/v1/networktraffic?namespaces=flows-demo&source=metrics&range=24h", flowReader)
	if w.Code != http.StatusOK || !res.Available || res.Source != "metrics" || res.Style != "labels" || res.Range != "24h0m0s" || len(res.Notes) != 0 {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	if l := lineOf(res, "flows-demo/client", "flows-demo/web"); l == nil || l.Allowed != 1200 {
		t.Fatalf("one SYN seen at both ends counts once: %+v", res.Lines)
	}
	if l := lineOf(res, "flows-demo/stranger", "flows-demo/web"); l == nil || l.Allowed != 0 || l.Dropped != 2400 || l.Reasons[0].Reason != "POLICY_DENIED" {
		t.Fatalf("drops: %+v", res.Lines)
	}
	if l := lineOf(res, "flows-demo/client", "ops/audit"); l == nil || l.Allowed != 7 {
		t.Fatalf("another namespace: %+v", res.Lines)
	}
	if len(src.queries) != 2 || len(store.rows) != 0 {
		t.Fatalf("queries %v, audit rows %d", src.queries, len(store.rows))
	}
	for _, q := range src.queries {
		if !strings.Contains(q, `source_namespace=~"flows-demo"`) || !strings.Contains(q, `destination_namespace=~"flows-demo"`) || !strings.Contains(q, "[86400s]") {
			t.Fatalf("query %s", q)
		}
	}
	// a namespace-limited reader: the end outside shows its namespace only
	scoped := flowReader
	scoped.Namespaces = map[string][]string{"self": {"flows-demo"}}
	_, res = getTraffic(h, "/api/v1/networktraffic?namespaces=flows-demo&source=metrics", scoped)
	if l := lineOf(res, "flows-demo/client", "ops/"); l == nil || !res.Redacted || l.To.Kind != "" {
		t.Fatalf("scoped: %+v", res)
	}
}

func TestNetworkTrafficMetricsNotAvailable(t *testing.T) {
	for _, c := range []struct {
		src    *fakeTraffic
		reason string
		notes  []string
	}{
		{&fakeTraffic{}, "no_prometheus", nil},
		{&fakeTraffic{available: true}, "no_metrics", nil},
		{&fakeTraffic{available: true, labels: map[string][]string{nettraffic.TCPMetric: {"__name__", "flag", "family"}}}, "no_context_labels", nil},
		{&fakeTraffic{available: true, labels: map[string][]string{netdrops.Metric: dropsShape}}, "", []string{nettraffic.NoteNoTCPMetric}},
		{&fakeTraffic{available: true, labels: map[string][]string{nettraffic.TCPMetric: tcpShape, netdrops.Metric: {"reason"}}}, "", []string{nettraffic.NoteNoDropMetric}},
	} {
		w, res := getTraffic(&Handler{netdropsSrc: c.src}, "/api/v1/networktraffic?namespaces=flows-demo&source=metrics", flowReader)
		if w.Code != http.StatusOK || res.Reason != c.reason || res.Available != (c.reason == "") || !reflect.DeepEqual(res.Notes, c.notes) || res.Lines == nil {
			t.Errorf("%s: %d %s", c.reason, w.Code, w.Body)
		}
	}
	// a bad range, and a Prometheus that fails
	if w, _ := getTraffic(&Handler{netdropsSrc: &fakeTraffic{available: true}}, "/api/v1/networktraffic?namespaces=flows-demo&source=metrics&range=2d", flowReader); w.Code != http.StatusBadRequest {
		t.Fatalf("range: %d", w.Code)
	}
	failing := &fakeTraffic{available: true, labels: map[string][]string{nettraffic.TCPMetric: tcpShape}, queryErr: errors.New("prometheus: 503")}
	if w, _ := getTraffic(&Handler{netdropsSrc: failing}, "/api/v1/networktraffic?namespaces=flows-demo&source=metrics", flowReader); w.Code < 500 {
		t.Fatalf("query error: %d", w.Code)
	}
}
