package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A Relay that answers with a real GetFlows capture (internal/netflows/testdata).
type netflowsFixture struct {
	h      *Handler
	store  *memAudit
	calls  int
	asked  []byte // the last GetFlows request
	status int
	relays []netflows.Relay
}

func newNetflowsFixture(t *testing.T, perMinute int) *netflowsFixture {
	t.Helper()
	// the flows in testdata were recorded from a Relay at about this time
	return newNetflowsFixtureFrom(t, perMinute, "getflows-web.bin", time.Date(2026, 10, 24, 14, 5, 30, 0, time.UTC))
}

func newNetflowsFixtureFrom(t *testing.T, perMinute int, file string, now time.Time) *netflowsFixture {
	t.Helper()
	raw, err := os.ReadFile("../netflows/testdata/" + file)
	if err != nil {
		t.Fatal(err)
	}
	f := &netflowsFixture{store: &memAudit{}}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls++
		f.asked, _ = io.ReadAll(r.Body)
		if f.status != 0 {
			w.WriteHeader(f.status)
			return
		}
		w.Header().Set("Content-Type", "application/grpc")
		w.Header().Set("Trailer", "Grpc-Status")
		_, _ = w.Write(raw)
		w.Header().Set("Grpc-Status", "0")
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	s, err := netflows.New(netflows.Config{
		Clusters:     map[string]netflows.Target{"self": {Mode: "proxy", Relay: netflows.Relay{Namespace: "kube-system", Service: "hubble-relay", Port: 443}}},
		DefaultRange: time.Hour, MaxRange: time.Hour, MaxFlows: 50, GraphMaxFlows: 400, Timeout: 2 * time.Second, PerUserPerMinute: perMinute,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.h = &Handler{auditStore: f.store}
	f.h.SetNetworkFlows(s)
	f.h.netflowsCanI = func(_ context.Context, r netflows.Relay) (bool, error) {
		f.relays = append(f.relays, r)
		return true, nil
	}
	f.h.netflowsDial = func(context.Context, netflows.Target) (string, *http.Client, error) {
		return srv.URL + "/observer.Observer/GetFlows", srv.Client(), nil
	}
	f.h.netflowsNow = func() time.Time { return now }
	return f
}

var flowReader = auth.TokenPayload{UserID: "u1", Email: "dev@example.com", Perms: auth.PermissionMatrix{"*": {"resource.*.read"}}}

func (f *netflowsFixture) get(target string, payload auth.TokenPayload) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	f.h.NetworkFlows(w, logSearchRequestAs(target, "self", "demo", payload))
	return w
}

func (f *netflowsFixture) lastRow(t *testing.T) (audit.Record, map[string]interface{}) {
	t.Helper()
	if len(f.store.rows) == 0 {
		t.Fatal("no audit row")
	}
	row := f.store.rows[len(f.store.rows)-1]
	var after map[string]interface{}
	_ = json.Unmarshal(row.After, &after)
	return row, after
}

func TestNetworkFlowsReadsAndAudits(t *testing.T) {
	f := newNetflowsFixture(t, 5)
	w := f.get("/api/v1/namespaces/demo/networkflows?kind=Pod&name=web-5f98b4964-h725v&since=1h", flowReader)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	var res netflows.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res.Cluster != "self" || res.Mode != "proxy" || res.Relay != "kube-system/hubble-relay:443" || len(res.Groups) != 2 {
		t.Fatalf("result %+v", res)
	}
	if len(f.relays) != 1 || f.relays[0].ProxyName() != "https:hubble-relay:443" {
		t.Fatalf("the cluster was asked about the Relay's services/proxy: %+v", f.relays)
	}
	row, after := f.lastRow(t)
	if row.Action != "k8s.networkflows.query" || row.Result == audit.ResultFailure || row.TargetType != "pod" || row.TargetID != "web-5f98b4964-h725v" ||
		row.Namespace != "demo" || after["mode"] != "proxy" || after["groups"] != float64(2) || after["since_seconds"] != float64(3600) {
		t.Fatalf("audit %+v after %v", row, after)
	}
	if strings.Contains(string(row.After), "client-559d6f749c") || strings.Contains(string(row.After), "10.244.") {
		t.Fatal("the audit row carries flow contents")
	}
}

func TestNetworkFlowsRefusals(t *testing.T) {
	podOnly := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"*": {"resource.pod.read"}}}
	cases := []struct {
		name    string
		target  string
		payload auth.TokenPayload
		canI    bool
		status  int
		audited bool
	}{
		{"no networkflow permission", "/api/v1/namespaces/demo/networkflows", podOnly, true, http.StatusForbidden, false},
		{"the cluster refuses the Relay", "/api/v1/namespaces/demo/networkflows", flowReader, false, http.StatusForbidden, true},
		{"bad since", "/api/v1/namespaces/demo/networkflows?since=soon", flowReader, true, http.StatusBadRequest, false},
		{"bad kind", "/api/v1/namespaces/demo/networkflows?kind=Service&name=web", flowReader, true, http.StatusBadRequest, false},
		{"over the window", "/api/v1/namespaces/demo/networkflows?since=2h", flowReader, true, http.StatusBadRequest, false},
	}
	for _, c := range cases {
		f := newNetflowsFixture(t, 5)
		allowed := c.canI
		f.h.netflowsCanI = func(context.Context, netflows.Relay) (bool, error) { return allowed, nil }
		w := f.get(c.target, c.payload)
		if w.Code != c.status || f.calls != 0 {
			t.Errorf("%s: %d %s (relay calls %d)", c.name, w.Code, w.Body, f.calls)
		}
		if c.audited {
			if row, _ := f.lastRow(t); row.Result != audit.ResultFailure || row.Action != "k8s.networkflows.query" {
				t.Errorf("%s: audit %+v", c.name, row)
			}
		} else if len(f.store.rows) != 0 && c.status != http.StatusForbidden {
			t.Errorf("%s: unexpected audit rows %d", c.name, len(f.store.rows))
		}
	}
	// a cluster without flows
	f := newNetflowsFixture(t, 5)
	w := httptest.NewRecorder()
	f.h.NetworkFlows(w, logSearchRequestAs("/api/v1/namespaces/demo/networkflows", "other", "demo", flowReader))
	if w.Code != http.StatusNotFound {
		t.Fatalf("not configured: %d", w.Code)
	}
}

func TestNetworkFlowsLimitAndRelayFailure(t *testing.T) {
	f := newNetflowsFixture(t, 1)
	if w := f.get("/api/v1/namespaces/demo/networkflows", flowReader); w.Code != http.StatusOK {
		t.Fatalf("first: %d", w.Code)
	}
	w := f.get("/api/v1/namespaces/demo/networkflows", flowReader)
	if w.Code != http.StatusTooManyRequests || f.calls != 1 {
		t.Fatalf("second within the minute: %d calls %d", w.Code, f.calls)
	}
	if row, _ := f.lastRow(t); row.Result != audit.ResultFailure {
		t.Fatalf("a refused read is recorded: %+v", row)
	}
	g := newNetflowsFixture(t, 5)
	g.status = http.StatusServiceUnavailable
	w = g.get("/api/v1/namespaces/demo/networkflows", flowReader)
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "hubble.relay.tls.server.enabled") {
		t.Fatalf("plain Relay behind the proxy: %d %s", w.Code, w.Body)
	}
	if row, _ := g.lastRow(t); row.Result != audit.ResultFailure || row.Error == "" {
		t.Fatalf("the failed read is recorded: %+v", row)
	}
}

// The token's namespaces reach the query. NamespaceScopeMiddleware keeps such a
// reader in those namespaces; here every end is outside them, so all are redacted.
func TestNetworkFlowsPassesTheScope(t *testing.T) {
	f := newNetflowsFixture(t, 5)
	scoped := flowReader
	scoped.Namespaces = map[string][]string{"self": {"shop"}}
	w := f.get("/api/v1/namespaces/demo/networkflows", scoped)
	var res netflows.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if w.Code != http.StatusOK || !res.Redacted || len(res.Groups) == 0 {
		t.Fatalf("status %d %+v", w.Code, res)
	}
	for _, g := range res.Groups {
		if g.Source.Pod != "" || g.Destination.Pod != "" || g.Source.Workload != nil {
			t.Fatalf("an end outside the scope is named: %+v", g)
		}
	}
}

// A read the audit store cannot record is refused before the Relay is asked.
func TestNetworkFlowsWithoutAudit(t *testing.T) {
	f := newNetflowsFixture(t, 5)
	f.h.auditStore = &downAudit{}
	w := f.get("/api/v1/namespaces/demo/networkflows", flowReader)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "audit unavailable") || f.calls != 0 {
		t.Fatalf("status %d calls %d %s", w.Code, f.calls, w.Body)
	}
}

func TestNetworkFlowsFeature(t *testing.T) {
	if got := (&Handler{}).networkFlowsFeature(); got["enabled"] != false {
		t.Fatalf("off: %v", got)
	}
	f := newNetflowsFixture(t, 5)
	got := f.h.networkFlowsFeature()
	if got["enabled"] != true || strings.Join(got["clusters"].([]string), ",") != "self" {
		t.Fatalf("on: %v", got)
	}
}
