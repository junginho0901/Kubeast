package nfm

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/smithy-go"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nfm/nfmtest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
)

const (
	webA = "web-6d9f7c8b5-abcde"
	webB = "web-6d9f7c8b5-fghij"
	api  = "api-5c8b9d7f4-klmno"
	db   = "db-0"
	pay  = "pay-7f8e6d5c4-xyzab"
)

// shopRows: web talks to api (seen by both agents), web to db, pay to web, web to pay across zones, a
// host-network flow with no pod names and a flow of another namespace.
func shopRows(f *nfmtest.Server) {
	f.Rows["INTRA_AZ"] = []map[string]any{
		nfmtest.Row("INTRA_AZ", "shop", webA, "10.0.1.10", "apne2-az1", "shop", api, "10.0.1.20", "apne2-az1", 8080, 5000),
		nfmtest.Row("INTRA_AZ", "shop", api, "10.0.1.20", "apne2-az1", "shop", webA, "10.0.1.10", "apne2-az1", 8080, 4900),
		nfmtest.Row("INTRA_AZ", "shop", webB, "10.0.1.11", "apne2-az1", "shop", db, "10.0.1.30", "apne2-az1", 5432, 3000),
		nfmtest.Row("INTRA_AZ", "pay", pay, "10.0.1.40", "apne2-az1", "shop", webA, "10.0.1.10", "apne2-az1", 80, 700),
		nfmtest.Row("INTRA_AZ", "", "", "10.0.1.5", "apne2-az1", "", "", "10.0.1.9", "apne2-az1", 10250, 9999),
		nfmtest.Row("INTRA_AZ", "ops", "agent-x1", "10.0.1.50", "apne2-az1", "ops", "collector-0", "10.0.1.51", "apne2-az1", 4317, 100),
	}
	f.Rows["INTER_AZ"] = []map[string]any{
		nfmtest.Row("INTER_AZ", "shop", webA, "10.0.1.10", "apne2-az1", "pay", pay, "10.0.3.40", "apne2-az3", 9000, 1200),
	}
}

type lookup struct {
	asked []string
	deny  map[string]bool
}

func (l *lookup) Workloads(_ context.Context, ns string) (map[string]netflows.Workload, error) {
	l.asked = append(l.asked, ns)
	if l.deny[ns] {
		return nil, errors.New("pods is forbidden")
	}
	switch ns {
	case "shop":
		return map[string]netflows.Workload{webA: {Kind: "Deployment", Name: "web"}, webB: {Kind: "Deployment", Name: "web"},
			api: {Kind: "Deployment", Name: "api"}, db: {Kind: "StatefulSet", Name: "db"}}, nil
	case "pay":
		return map[string]netflows.Workload{pay: {Kind: "Deployment", Name: "pay"}}, nil
	}
	return nil, nil
}
func (l *lookup) ServiceIPs(context.Context, string) (map[string]bool, error) { return nil, nil }
func (l *lookup) PodSet(context.Context, string, string) (string, error)      { return "", nil }

var testNow = time.Date(2026, 10, 26, 3, 17, 42, 0, time.UTC)

func testConfig(endpoint string) Config {
	return Config{Enabled: true, Region: "ap-northeast-2", Endpoint: endpoint, Clusters: map[string]string{"shop-eks": "shop-monitor"},
		DefaultRange: time.Hour, MaxRange: 2 * time.Hour, Limit: 500, Timeout: 5 * time.Second, PerUserPerMinute: 20}
}

// newTestStore makes the store as New does, with keys from a Secret directory, against the fake server.
func newTestStore(t *testing.T, f *nfmtest.Server, edit func(*Config)) *Store {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	for name, v := range map[string]string{"accessKeyId": "test-key-id", "secretAccessKey": "test-key-secret"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(v+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cfg := testConfig(srv.URL)
	cfg.SecretDir = dir
	if edit != nil {
		edit(&cfg)
	}
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s.poll = time.Millisecond
	s.now = func() time.Time { return testNow }
	return s
}

func read(t *testing.T, s *Store, req Request) *Result {
	t.Helper()
	if err := s.Normalize(&req); err != nil {
		t.Fatal(err)
	}
	res, err := s.Read(context.Background(), "shop-eks", req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func ends(res *Result) []string {
	var out []string
	for _, r := range res.Rows {
		out = append(out, r.Local.Pod+">"+r.Remote.Pod+":"+strconv.Itoa(int(r.Value)))
	}
	return out
}

func TestReadWorkloadKeepsItsRowsAtEitherEnd(t *testing.T) {
	f := nfmtest.NewServer()
	shopRows(f)
	s := newTestStore(t, f, nil)
	l := &lookup{}
	res := read(t, s, Request{Namespace: "shop", Kind: "Deployment", Name: "web", Lookup: l})

	// both categories of the cluster view, over the hour that ends at the current minute, as many rows as NFM gives
	if got := f.Categories(); !reflect.DeepEqual(got, []string{"INTRA_AZ", "INTER_AZ"}) {
		t.Fatalf("categories %v", got)
	}
	b := f.Started[0]
	if b["metricName"] != "DATA_TRANSFERRED" || b["limit"] != float64(500) || b["startTime"] != "2026-10-26T02:17:00Z" || b["endTime"] != "2026-10-26T03:17:00Z" {
		t.Fatalf("start body %v", b)
	}
	// the SDK signs at the wall clock, not the store's
	if !regexp.MustCompile(`^AWS4-HMAC-SHA256 Credential=test-key-id/\d{8}/ap-northeast-2/networkflowmonitor/aws4_request`).MatchString(f.Auth[0]) {
		t.Fatalf("signed with %q", f.Auth[0])
	}
	if f.MaxAsked[0] != "500" || len(f.Stopped) != 0 {
		t.Fatalf("maxResults %v, stopped %v", f.MaxAsked, f.Stopped)
	}

	// the host-network row has no pod and pay's own row to pay is not web's; largest first
	want := []string{webA + ">" + api + ":5000", api + ">" + webA + ":4900", webB + ">" + db + ":3000", webA + ">" + pay + ":1200", pay + ">" + webA + ":700"}
	if got := ends(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("rows\n got %v\nwant %v", got, want)
	}
	first := res.Rows[0]
	wantFirst := Row{
		Local:  End{Namespace: "shop", Pod: webA, Workload: &netflows.Workload{Kind: "Deployment", Name: "web"}, IP: "10.0.1.10", AZ: "apne2-az1", VPC: "vpc-0a1", Instance: "i-0local"},
		Remote: End{Namespace: "shop", Pod: api, Workload: &netflows.Workload{Kind: "Deployment", Name: "api"}, IP: "10.0.1.20", AZ: "apne2-az1", VPC: "vpc-0a1"},
		Port:   8080, Value: 5000, Category: "INTRA_AZ",
	}
	if !reflect.DeepEqual(first, wantFirst) {
		t.Fatalf("first row\n got %+v\nwant %+v", first, wantFirst)
	}
	if res.Unit != "Bytes" || res.Truncated || res.Redacted || res.Monitor != "shop-monitor" || res.Range != "1h0m0s" || res.View != "cluster" {
		t.Fatalf("result %+v", res)
	}
	// one pod list per namespace at the ends of shop's rows; ops is not asked
	if !reflect.DeepEqual(l.asked, []string{"shop", "pay"}) {
		t.Fatalf("looked up %v", l.asked)
	}
}

func TestReadPodAndNamespace(t *testing.T) {
	f := nfmtest.NewServer()
	shopRows(f)
	s := newTestStore(t, f, nil)
	if got := ends(read(t, s, Request{Namespace: "shop", Kind: "Pod", Name: api})); !reflect.DeepEqual(got, []string{webA + ">" + api + ":5000", api + ">" + webA + ":4900"}) {
		t.Fatalf("pod rows %v", got)
	}
	if got := ends(read(t, s, Request{Namespace: "pay", Lookup: &lookup{}})); !reflect.DeepEqual(got, []string{webA + ">" + pay + ":1200", pay + ">" + webA + ":700"}) {
		t.Fatalf("namespace rows %v", got)
	}
	// a workload is named only with a lookup: without one, no row matches it
	if got := ends(read(t, s, Request{Namespace: "shop", Kind: "Deployment", Name: "web"})); got != nil {
		t.Fatalf("rows without a lookup %v", got)
	}
}

func TestReadHidesPeersOutsideTheReadersNamespaces(t *testing.T) {
	f := nfmtest.NewServer()
	shopRows(f)
	s := newTestStore(t, f, nil)
	res := read(t, s, Request{Namespace: "shop", Kind: "Deployment", Name: "web", Lookup: &lookup{}, Scope: []string{"shop"}})
	if !res.Redacted {
		t.Fatal("not marked redacted")
	}
	for _, r := range res.Rows {
		for _, e := range []End{r.Local, r.Remote} {
			if e.Namespace == "pay" && (e.Pod != "" || e.Workload != nil || e.Service != "" || e.IP == "") {
				t.Fatalf("pay end kept its names: %+v", e)
			}
			if e.Namespace == "shop" && e.Pod == "" {
				t.Fatalf("shop end lost its pod: %+v", e)
			}
		}
	}
}

func TestReadHidesPeersInNamespacesTheReaderCannotList(t *testing.T) {
	f := nfmtest.NewServer()
	shopRows(f)
	s := newTestStore(t, f, nil)
	res := read(t, s, Request{Namespace: "shop", Kind: "Pod", Name: webA, Lookup: &lookup{deny: map[string]bool{"pay": true}}})
	if !res.Redacted || len(res.Rows) != 4 {
		t.Fatalf("redacted %v, rows %v", res.Redacted, ends(res))
	}
	for _, r := range res.Rows {
		if p := r.Remote; p.Namespace == "pay" && (p.Pod != "" || p.IP != "10.0.3.40") {
			t.Fatalf("pay end %+v", p)
		}
	}
	// past the namespaces one read looks up (shop counts as one), the rest are hidden too
	f2 := nfmtest.NewServer()
	for i := 0; i <= netflows.MaxLookupNamespaces; i++ {
		ns := "peer-" + strconv.Itoa(i)
		f2.Rows["INTRA_AZ"] = append(f2.Rows["INTRA_AZ"], nfmtest.Row("INTRA_AZ", "shop", webA, "10.0.1.10", "apne2-az1", ns, "p-"+ns, "10.0.9."+strconv.Itoa(i), "apne2-az1", 80, 1000-i))
	}
	res = read(t, newTestStore(t, f2, nil), Request{Namespace: "shop", Kind: "Pod", Name: webA, Lookup: &lookup{}})
	for i, r := range res.Rows {
		if named := r.Remote.Pod != ""; named != (i < netflows.MaxLookupNamespaces-1) {
			t.Fatalf("row %d (%s): named %v", i, r.Remote.Namespace, named)
		}
	}
}

func TestReadAsksEachCategoryOfTheView(t *testing.T) {
	for view, want := range map[string][]string{"aws": {"AMAZON_S3", "AMAZON_DYNAMODB"}, "external": {"UNCLASSIFIED"}} {
		f := nfmtest.NewServer()
		f.Rows["AMAZON_S3"] = []map[string]any{nfmtest.Row("AMAZON_S3", "shop", webA, "10.0.1.10", "apne2-az1", "", "", "52.95.1.1", "", 443, 800)}
		s := newTestStore(t, f, nil)
		res := read(t, s, Request{Namespace: "shop", Kind: "Pod", Name: webA, View: view, Metric: "RETRANSMISSIONS"})
		if got := f.Categories(); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: categories %v", view, got)
		}
		if f.Started[0]["metricName"] != "RETRANSMISSIONS" {
			t.Fatalf("%s: metric %v", view, f.Started[0]["metricName"])
		}
		if view == "aws" && (len(res.Rows) != 1 || res.Rows[0].Remote.IP != "52.95.1.1" || res.Rows[0].Category != "AMAZON_S3") {
			t.Fatalf("aws rows %+v", res.Rows)
		}
	}
}

func TestReadPagesAndTruncates(t *testing.T) {
	f := nfmtest.NewServer()
	shopRows(f)
	f.PageSize = 2
	s := newTestStore(t, f, nil)
	if got := ends(read(t, s, Request{Namespace: "shop"})); len(got) != 5 {
		t.Fatalf("every page read: %v", got)
	}
	if len(f.MaxAsked) != 4 { // INTRA_AZ: 2+2+1, INTER_AZ: 1
		t.Fatalf("results calls %d", len(f.MaxAsked))
	}

	f2 := nfmtest.NewServer()
	shopRows(f2)
	s2 := newTestStore(t, f2, func(c *Config) { c.Limit = 3 })
	res := read(t, s2, Request{Namespace: "shop"})
	if !res.Truncated || f2.Started[0]["limit"] != float64(3) {
		t.Fatalf("truncated %v, limit %v", res.Truncated, f2.Started[0]["limit"])
	}
}

func TestReadCachesTheMinute(t *testing.T) {
	f := nfmtest.NewServer()
	shopRows(f)
	s := newTestStore(t, f, nil)
	read(t, s, Request{Namespace: "shop"})
	read(t, s, Request{Namespace: "shop", Kind: "Pod", Name: api})
	if n := len(f.Categories()); n != 2 {
		t.Fatalf("same minute: %d queries", n)
	}
	s.now = func() time.Time { return testNow.Add(time.Minute) }
	read(t, s, Request{Namespace: "shop"})
	read(t, s, Request{Namespace: "shop", Metric: "TIMEOUTS"})
	if n := len(f.Categories()); n != 6 {
		t.Fatalf("next minute and another metric: %d queries", n)
	}
}

func TestReadWaitsForTheQuery(t *testing.T) {
	f := nfmtest.NewServer()
	shopRows(f)
	f.Statuses = []string{"QUEUED", "RUNNING", "SUCCEEDED"}
	s := newTestStore(t, f, nil)
	if got := ends(read(t, s, Request{Namespace: "pay"})); len(got) != 2 {
		t.Fatalf("rows %v", got)
	}
	if f.Polls["q1"] != 3 {
		t.Fatalf("status calls %d", f.Polls["q1"])
	}
}

func TestReadStopsAQueryThatDoesNotFinish(t *testing.T) {
	// the time runs out while waiting between status calls, and while a status call is under way
	for name, slow := range map[string]bool{"waiting": false, "asking": true} {
		f := nfmtest.NewServer()
		f.Statuses = []string{"RUNNING"}
		if slow {
			f.StatusDelay = 300 * time.Millisecond
		}
		s := newTestStore(t, f, func(c *Config) { c.Timeout = 100 * time.Millisecond })
		if !slow {
			s.poll = time.Second
		}
		req := Request{Namespace: "shop"}
		_ = s.Normalize(&req)
		if _, err := s.Read(context.Background(), "shop-eks", req); !errors.Is(err, ErrTimeout) {
			t.Fatalf("%s: err %v", name, err)
		}
		stopped, polls := f.Seen()
		if !reflect.DeepEqual(stopped, []string{"q1"}) || (!slow && polls["q1"] != 1) {
			t.Fatalf("%s: stopped %v after %d status calls", name, stopped, polls["q1"])
		}
	}
}

func TestReadErrors(t *testing.T) {
	failed := nfmtest.NewServer()
	failed.Statuses = []string{"FAILED"}
	denied := nfmtest.NewServer()
	denied.ErrCode = "AccessDeniedException"
	for name, c := range map[string]struct {
		f       *nfmtest.Server
		cluster string
		edit    func(*Config)
		want    error
	}{
		"failed query":    {failed, "shop-eks", nil, ErrUnavailable},
		"denied":          {denied, "shop-eks", nil, ErrForbidden},
		"unknown monitor": {nfmtest.NewServer(), "shop-eks", func(c *Config) { c.Clusters["shop-eks"] = "gone" }, ErrNoMonitor},
		"no monitor":      {nfmtest.NewServer(), "other", nil, ErrNoMonitor},
	} {
		s := newTestStore(t, c.f, c.edit)
		req := Request{Namespace: "shop"}
		_ = s.Normalize(&req)
		if _, err := s.Read(context.Background(), c.cluster, req); !errors.Is(err, c.want) {
			t.Errorf("%s: err %v, want %v", name, err, c.want)
		}
	}
	if len(failed.Stopped) != 0 {
		t.Fatalf("a failed query stopped: %v", failed.Stopped)
	}
}

func TestAPIErrorCodes(t *testing.T) {
	s := newStore(testConfig(""), nil)
	for code, want := range map[string]error{
		"AccessDeniedException": ErrForbidden, "ExpiredTokenException": ErrForbidden, "ResourceNotFoundException": ErrNoMonitor,
		"ValidationException": ErrInvalidRequest, "ThrottlingException": ErrBusy, "ServiceQuotaExceededException": ErrBusy,
		"InternalServerException": ErrUnavailable,
	} {
		if err := s.apiError(context.Background(), &smithy.GenericAPIError{Code: code, Message: "m"}); !errors.Is(err, want) {
			t.Errorf("%s: %v", code, err)
		}
	}
	if err := s.apiError(context.Background(), errors.New("dial tcp: refused")); !errors.Is(err, ErrUnavailable) {
		t.Errorf("network error: %v", err)
	}
	done, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.apiError(done, errors.New("context canceled")); !errors.Is(err, ErrTimeout) {
		t.Errorf("ended context: %v", err)
	}
}

func TestNormalize(t *testing.T) {
	s := newStore(testConfig(""), nil)
	r := Request{Namespace: "shop"}
	if err := s.Normalize(&r); err != nil || r.Metric != "DATA_TRANSFERRED" || r.View != "cluster" || r.Range != time.Hour {
		t.Fatalf("defaults: %v %+v", err, r)
	}
	for name, r := range map[string]Request{
		"no namespace":    {},
		"unknown kind":    {Namespace: "shop", Kind: "Service", Name: "web"},
		"kind, no name":   {Namespace: "shop", Kind: "Pod"},
		"name, no kind":   {Namespace: "shop", Name: "web"},
		"round trip time": {Namespace: "shop", Metric: "ROUND_TRIP_TIME"},
		"unknown view":    {Namespace: "shop", View: "INTER_VPC"},
		"range too long":  {Namespace: "shop", Range: 3 * time.Hour},
		"range too short": {Namespace: "shop", Range: 30 * time.Second},
	} {
		if err := s.Normalize(&r); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestAllowPerUser(t *testing.T) {
	cfg := testConfig("")
	cfg.PerUserPerMinute = 2
	s := newStore(cfg, nil)
	if !s.Allow("a") || !s.Allow("a") || s.Allow("a") || !s.Allow("b") {
		t.Fatal("budget of two per user")
	}
}

func TestNewKeysFromTheSecret(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "accessKeyId"), []byte("test-key-id"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig("http://127.0.0.1:1")
	cfg.SecretDir = dir
	if _, err := New(cfg); err == nil || !strings.Contains(err.Error(), "both") {
		t.Fatalf("one key of two: %v", err)
	}
	cfg.SecretDir = t.TempDir() // no files: the SDK's default chain (IRSA)
	if _, err := New(cfg); err != nil {
		t.Fatal(err)
	}
}
