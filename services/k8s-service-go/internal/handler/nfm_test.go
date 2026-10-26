package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nfm"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nfm/nfmtest"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The handler with a Network Flow Monitor stand-in for cluster self (monitor shop-monitor): web talks to api,
// and pay (another namespace) to web.
type nfmFixture struct {
	h      *Handler
	store  *memAudit
	srv    *nfmtest.Server
	canI   bool
	listed []string
}

type nfmLookup struct{}

func (nfmLookup) Workloads(_ context.Context, ns string) (map[string]netflows.Workload, error) {
	if ns == "pay" {
		return map[string]netflows.Workload{"pay-7f8e6d5c4-xyzab": {Kind: "Deployment", Name: "pay"}}, nil
	}
	return map[string]netflows.Workload{"web-6d9f7c8b5-abcde": {Kind: "Deployment", Name: "web"}, "api-5c8b9d7f4-klmno": {Kind: "Deployment", Name: "api"}}, nil
}
func (nfmLookup) ServiceIPs(context.Context, string) (map[string]bool, error) { return nil, nil }
func (nfmLookup) PodSet(context.Context, string, string) (string, error)      { return "", nil }

func newNFMFixture(t *testing.T, perMinute int) *nfmFixture {
	t.Helper()
	f := &nfmFixture{store: &memAudit{}, srv: nfmtest.NewServer(), canI: true}
	f.srv.Rows["INTRA_AZ"] = []map[string]any{
		nfmtest.Row("INTRA_AZ", "shop", "web-6d9f7c8b5-abcde", "10.0.1.10", "apne2-az1", "shop", "api-5c8b9d7f4-klmno", "10.0.1.20", "apne2-az1", 8080, 5000),
		nfmtest.Row("INTRA_AZ", "pay", "pay-7f8e6d5c4-xyzab", "10.0.1.40", "apne2-az1", "shop", "web-6d9f7c8b5-abcde", "10.0.1.10", "apne2-az1", 80, 700),
	}
	srv := httptest.NewServer(f.srv)
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	for name, v := range map[string]string{"accessKeyId": "test-key-id", "secretAccessKey": "test-key-secret"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(v), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s, err := nfm.New(nfm.Config{Enabled: true, Region: "ap-northeast-2", Endpoint: srv.URL, Clusters: map[string]string{"self": "shop-monitor"},
		DefaultRange: time.Hour, MaxRange: 2 * time.Hour, Limit: 500, Timeout: 5 * time.Second, PerUserPerMinute: perMinute, SecretDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	f.h = &Handler{auditStore: f.store}
	f.h.SetNetworkFlowMonitor(s)
	f.h.netflowsLook = nfmLookup{}
	f.h.nfmCanI = func(_ context.Context, ns string) (bool, error) {
		f.listed = append(f.listed, ns)
		return f.canI, nil
	}
	return f
}

func (f *nfmFixture) get(target, clusterID string, payload auth.TokenPayload) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	f.h.NetworkTopFlows(w, logSearchRequestAs(target, clusterID, "shop", payload))
	return w
}

func (f *nfmFixture) lastRow(t *testing.T) (audit.Record, map[string]interface{}) {
	t.Helper()
	if len(f.store.rows) == 0 {
		t.Fatal("no audit row")
	}
	row := f.store.rows[len(f.store.rows)-1]
	var after map[string]interface{}
	_ = json.Unmarshal(row.After, &after)
	return row, after
}

func TestNetworkTopFlowsReadsAndAudits(t *testing.T) {
	f := newNFMFixture(t, 5)
	w := f.get("/api/v1/namespaces/shop/networktopflows?kind=Deployment&name=web&metric=retransmissions&range=30m", "self", flowReader)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	var res nfm.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res.Cluster != "self" || res.Monitor != "shop-monitor" || res.Metric != "RETRANSMISSIONS" || res.View != "cluster" || len(res.Rows) != 2 {
		t.Fatalf("result %+v", res)
	}
	if res.Rows[0].Remote.Workload == nil || res.Rows[0].Remote.Workload.Name != "api" || res.Rows[1].Local.Workload == nil || res.Rows[1].Local.Workload.Name != "pay" {
		t.Fatalf("workloads named as the user lists the pods: %+v", res.Rows)
	}
	if len(f.listed) != 1 || f.listed[0] != "shop" {
		t.Fatalf("the cluster was asked about list pods in shop: %v", f.listed)
	}
	if got := f.srv.Started[0]; got["metricName"] != "RETRANSMISSIONS" {
		t.Fatalf("start body %v", got)
	}
	row, after := f.lastRow(t)
	if row.Action != "k8s.networkflows.query" || row.Result == audit.ResultFailure || row.TargetType != "deployment" || row.TargetID != "web" || row.Namespace != "shop" ||
		after["provider"] != "nfm" || after["monitor"] != "shop-monitor" || after["metric"] != "RETRANSMISSIONS" || after["view"] != "cluster" ||
		after["range_seconds"] != float64(1800) || after["rows"] != float64(2) {
		t.Fatalf("audit %+v after %v", row, after)
	}
	if strings.Contains(string(row.After), "api-5c8b9d7f4") || strings.Contains(string(row.After), "10.0.1.") {
		t.Fatal("the audit row carries row contents")
	}
}

func TestNetworkTopFlowsRefusals(t *testing.T) {
	podOnly := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"*": {"resource.pod.read"}}}
	cases := []struct {
		name    string
		target  string
		payload auth.TokenPayload
		canI    bool
		status  int
		audited bool
	}{
		{"no networkflow permission", "/api/v1/namespaces/shop/networktopflows", podOnly, true, http.StatusForbidden, false},
		{"the cluster refuses list pods", "/api/v1/namespaces/shop/networktopflows", flowReader, false, http.StatusForbidden, true},
		{"bad range", "/api/v1/namespaces/shop/networktopflows?range=soon", flowReader, true, http.StatusBadRequest, false},
		{"over the range", "/api/v1/namespaces/shop/networktopflows?range=3h", flowReader, true, http.StatusBadRequest, false},
		{"unknown metric", "/api/v1/namespaces/shop/networktopflows?metric=ROUND_TRIP_TIME", flowReader, true, http.StatusBadRequest, false},
		{"unknown view", "/api/v1/namespaces/shop/networktopflows?view=INTER_VPC", flowReader, true, http.StatusBadRequest, false},
		{"bad kind", "/api/v1/namespaces/shop/networktopflows?kind=Service&name=web", flowReader, true, http.StatusBadRequest, false},
	}
	for _, c := range cases {
		f := newNFMFixture(t, 5)
		f.canI = c.canI
		w := f.get(c.target, "self", c.payload)
		if w.Code != c.status || len(f.srv.Started) != 0 {
			t.Errorf("%s: %d %s (queries %d)", c.name, w.Code, w.Body, len(f.srv.Started))
		}
		if c.audited {
			if row, _ := f.lastRow(t); row.Result != audit.ResultFailure || row.Action != "k8s.networkflows.query" {
				t.Errorf("%s: audit %+v", c.name, row)
			}
		} else if len(f.store.rows) != 0 {
			t.Errorf("%s: unexpected audit rows %d", c.name, len(f.store.rows))
		}
	}
	f := newNFMFixture(t, 5)
	if w := f.get("/api/v1/namespaces/shop/networktopflows", "other", flowReader); w.Code != http.StatusNotFound {
		t.Fatalf("a cluster without a monitor: %d", w.Code)
	}
	off := &Handler{auditStore: &memAudit{}}
	w := httptest.NewRecorder()
	off.NetworkTopFlows(w, logSearchRequestAs("/api/v1/namespaces/shop/networktopflows", "self", "shop", flowReader))
	if w.Code != http.StatusNotFound {
		t.Fatalf("feature off: %d", w.Code)
	}
}

func TestNetworkTopFlowsBudgetAndAWSRefusal(t *testing.T) {
	f := newNFMFixture(t, 1)
	if w := f.get("/api/v1/namespaces/shop/networktopflows", "self", flowReader); w.Code != http.StatusOK {
		t.Fatalf("first: %d %s", w.Code, w.Body)
	}
	w := f.get("/api/v1/namespaces/shop/networktopflows", "self", flowReader)
	if w.Code != http.StatusTooManyRequests || len(f.srv.Started) != 2 {
		t.Fatalf("second within the minute: %d, queries %d", w.Code, len(f.srv.Started))
	}
	if row, _ := f.lastRow(t); row.Result != audit.ResultFailure {
		t.Fatalf("a refused read is recorded: %+v", row)
	}
	// AWS refusing Kubeast's identity is the install's configuration: a bad gateway, recorded with the error
	g := newNFMFixture(t, 5)
	g.srv.ErrCode = "AccessDeniedException"
	w = g.get("/api/v1/namespaces/shop/networktopflows", "self", flowReader)
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "AccessDeniedException") {
		t.Fatalf("AWS refused: %d %s", w.Code, w.Body)
	}
	if row, _ := g.lastRow(t); row.Result != audit.ResultFailure || row.Error == "" {
		t.Fatalf("the failed read is recorded: %+v", row)
	}
}

func TestNetworkTopFlowsPassesTheScope(t *testing.T) {
	f := newNFMFixture(t, 5)
	scoped := flowReader
	scoped.Namespaces = map[string][]string{"self": {"shop"}}
	w := f.get("/api/v1/namespaces/shop/networktopflows", "self", scoped)
	var res nfm.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if w.Code != http.StatusOK || !res.Redacted || len(res.Rows) != 2 {
		t.Fatalf("status %d %+v", w.Code, res)
	}
	if pay := res.Rows[1].Local; pay.Namespace != "pay" || pay.Pod != "" || pay.Workload != nil || pay.IP != "10.0.1.40" {
		t.Fatalf("pay end %+v", pay)
	}
}

func TestNetworkFlowMonitorFeature(t *testing.T) {
	if got := (&Handler{}).networkFlowMonitorFeature(); got["enabled"] != false {
		t.Fatalf("off: %v", got)
	}
	f := newNFMFixture(t, 5)
	if got := f.h.networkFlowMonitorFeature(); got["enabled"] != true || len(got["clusters"].([]string)) != 1 || got["clusters"].([]string)[0] != "self" {
		t.Fatalf("on: %v", got)
	}
}
