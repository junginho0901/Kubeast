package k8s

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// Allocation sets as OpenCost 1.121 answers /allocation/compute (kubeast-b,
// 2026-10-13), trimmed to the fields this service reads.
const costNamespaceSet = `{"code":200,"data":[{
 "kube-system":{"name":"kube-system","properties":{"cluster":"kubeast-b","namespace":"kube-system"},"window":{"start":"2026-10-13T02:00:00Z","end":"2026-10-13T03:00:00Z"},"cpuCoreHours":0.01487,"cpuCost":0.00047,"ramByteHours":11362151.80698,"ramCost":0.00004,"pvCost":0,"networkCost":0,"gpuCost":0,"loadBalancerCost":0,"totalCost":0.00051,"cpuEfficiency":0.1,"ramEfficiency":0.2,"totalEfficiency":0.13666,"minutes":9.8},
 "monitoring":{"name":"monitoring","properties":{"cluster":"kubeast-b","namespace":"monitoring"},"window":{"start":"2026-10-13T02:00:00Z","end":"2026-10-13T03:00:00Z"},"cpuCoreHours":0.005,"cpuCost":0.00016,"ramByteHours":3000000,"ramCost":0.00001,"pvCost":0.00002,"networkCost":0,"gpuCost":0,"loadBalancerCost":0,"totalCost":0.00019,"cpuEfficiency":0.3,"ramEfficiency":0.4,"totalEfficiency":0.35,"minutes":9.8},
 "__idle__":{"name":"__idle__","totalCost":9}
}]}`

const costControllerSet = `{"code":200,"data":[{
 "kube-system/daemonset:kindnet":{"name":"kube-system/daemonset:kindnet","properties":{"namespace":"kube-system","controller":"kindnet","controllerKind":"daemonset"},"window":{"start":"2026-10-13T02:00:00Z","end":"2026-10-13T03:00:00Z"},"cpuCoreHours":0.01,"cpuCost":0.0003,"ramByteHours":5000000,"ramCost":0.00002,"totalCost":0.00032},
 "kube-system/__unallocated__":{"name":"kube-system/__unallocated__","properties":{"namespace":"kube-system"},"window":{"start":"2026-10-13T02:00:00Z","end":"2026-10-13T03:00:00Z"},"cpuCoreHours":0.004,"cpuCost":0.00013,"totalCost":0.00013},
 "monitoring/deployment:prometheus":{"name":"monitoring/deployment:prometheus","properties":{},"window":{"start":"2026-10-13T02:00:00Z","end":"2026-10-13T03:00:00Z"},"cpuCoreHours":0.005,"cpuCost":0.00016,"totalCost":0.00016}
}]}`

// costServer stands in for a cluster API server: with found, the opencost
// namespace holds a Service "opencost" on 9003 whose proxy answers /healthz and
// /allocation/compute; every other Service list is empty. With healthz403 the
// proxy refuses /healthz the way a cluster refuses an identity without
// services/proxy.
type costServer struct {
	found      bool
	healthz403 bool
	mu         sync.Mutex
	lists      int
	allocs     int
	query      url.Values
	srv        *httptest.Server
}

func (c *costServer) counts() (lists, allocs int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lists, c.allocs
}

func (c *costServer) lastQuery() url.Values {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.query
}

func newCostServer(t *testing.T, found bool) (*Service, *costServer) {
	t.Helper()
	cs := &costServer{found: found}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, "/services"):
			cs.mu.Lock()
			cs.lists++
			cs.mu.Unlock()
			if cs.found && p == "/api/v1/namespaces/opencost/services" {
				_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"opencost-ui","namespace":"opencost"},"spec":{"ports":[{"port":9090}]}},{"metadata":{"name":"opencost","namespace":"opencost"},"spec":{"ports":[{"name":"api","port":9003}]}}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"items":[]}`))
		case p == "/api/v1/namespaces/opencost/services/opencost:9003/proxy/healthz":
			if cs.healthz403 {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}`))
				return
			}
			w.WriteHeader(http.StatusOK)
		case p == "/api/v1/namespaces/opencost/services/opencost:9003/proxy/allocation/compute":
			cs.mu.Lock()
			cs.allocs++
			cs.query = r.URL.Query()
			cs.mu.Unlock()
			if r.URL.Query().Get("aggregate") == "namespace,controller" {
				_, _ = w.Write([]byte(costControllerSet))
				return
			}
			_, _ = w.Write([]byte(costNamespaceSet))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		}
	}))
	t.Cleanup(srv.Close)
	cs.srv = srv
	k, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: k, cost: &costCache{}})
	return s, cs
}

func asUser(ctx context.Context, id string, namespaces map[string][]string) context.Context {
	return auth.WithPayload(ctx, auth.TokenPayload{UserID: id, Email: id + "@example.com", Namespaces: namespaces})
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestCostAllocation_NormalizesScopesAndCaches(t *testing.T) {
	s, srv := newCostServer(t, true)
	ctx := context.Background()

	res, err := s.CostAllocation(ctx, "1h", CostAggregateNamespace)
	if err != nil {
		t.Fatal(err)
	}
	if q := srv.lastQuery(); q.Get("window") != "1h" || q.Get("aggregate") != "namespace" || q.Get("accumulate") != "true" || q.Get("includeIdle") != "false" {
		t.Fatalf("OpenCost query = %v", q)
	}
	var names []string
	for _, r := range res.Rows {
		names = append(names, r.Name)
	}
	if want := []string{"kube-system", "monitoring"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("rows = %v, want %v (idle left out, highest total first)", names, want)
	}
	ks := res.Rows[0]
	if ks.Namespace != "kube-system" || ks.Kind != "" || !near(ks.RAMByteHours, 11362151.80698) || !near(ks.TotalEfficiency, 0.13666) || !near(ks.Minutes, 9.8) {
		t.Fatalf("kube-system row = %+v", ks)
	}
	if !near(res.Totals.TotalCost, 0.0007) || !near(res.Totals.CPUCost, 0.00063) || !near(res.Totals.PVCost, 0.00002) || !near(res.Totals.CPUCoreHours, 0.01987) {
		t.Fatalf("totals = %+v", res.Totals)
	}
	if res.Source != (CostSource{Namespace: "opencost", Service: "opencost", Port: 9003}) || res.Currency != "USD" || res.Scoped ||
		res.Start != "2026-10-13T02:00:00Z" || res.End != "2026-10-13T03:00:00Z" || res.Window != "1h" || res.Aggregate != "namespace" {
		t.Fatalf("result header = %+v", res)
	}
	if st := s.CostStatus(ctx); st["available"] != true || st["source"] != "proxy" || st["endpoint"] != "opencost/opencost:9003 (via K8s API proxy)" {
		t.Fatalf("status = %v", st)
	}

	// A second read within the minute comes from the cache, and discovery ran
	// one round over the candidate namespaces.
	if _, err := s.CostAllocation(ctx, "1h", CostAggregateNamespace); err != nil {
		t.Fatal(err)
	}
	if lists, allocs := srv.counts(); allocs != 1 || lists != len(costNamespaces) {
		t.Fatalf("allocation calls = %d (want 1), service lists = %d (want %d)", allocs, lists, len(costNamespaces))
	}

	// Workload rows take namespace, kind and name from the properties, or from
	// the "ns/kind:name" key when OpenCost leaves them out.
	wl, err := s.CostAllocation(ctx, "1h", CostAggregateController)
	if err != nil {
		t.Fatal(err)
	}
	if q := srv.lastQuery(); q.Get("aggregate") != "namespace,controller" {
		t.Fatalf("workload aggregate sent as %q", q.Get("aggregate"))
	}
	got := map[string]string{}
	var order []string
	for _, r := range wl.Rows {
		got[r.Name] = r.Namespace + "/" + r.Kind
		order = append(order, r.Name)
	}
	want := map[string]string{"kindnet": "kube-system/DaemonSet", "__unallocated__": "kube-system/", "prometheus": "monitoring/Deployment"}
	if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(order, []string{"kindnet", "prometheus", "__unallocated__"}) {
		t.Fatalf("workload rows = %v in order %v", got, order)
	}
	if wl.Aggregate != "controller" {
		t.Fatalf("aggregate echoed as %q", wl.Aggregate)
	}

	// A namespace-scoped grant narrows the rows and the totals. Another identity
	// is never served the first one's answer: it reads for itself (and is then
	// cached for itself).
	scoped := asUser(ctx, "u1", map[string][]string{"default": {"monitoring"}})
	sres, err := s.CostAllocation(scoped, "1h", CostAggregateNamespace)
	if err != nil {
		t.Fatal(err)
	}
	if !sres.Scoped || len(sres.Rows) != 1 || sres.Rows[0].Name != "monitoring" || !near(sres.Totals.TotalCost, 0.00019) {
		t.Fatalf("scoped result = %+v", sres)
	}
	if _, err := s.CostAllocation(scoped, "1h", CostAggregateNamespace); err != nil {
		t.Fatal(err)
	}
	if _, allocs := srv.counts(); allocs != 3 {
		t.Fatalf("allocation calls = %d, want 3 (anonymous namespace + workload, u1 once)", allocs)
	}
	if _, err := s.CostAllocation(asUser(ctx, "u2", nil), "1h", CostAggregateNamespace); err != nil {
		t.Fatal(err)
	}
	if _, allocs := srv.counts(); allocs != 4 {
		t.Fatalf("allocation calls = %d, want 4 (u2 reads for itself)", allocs)
	}

	// The optimization table's unit prices come from the namespace allocation
	// over the window that covers its hours: cost ÷ hours over every namespace.
	p := s.costUnitPricesForCtx(ctx, 24)
	if p == nil || p.Window != "24h" || p.Source != "opencost" || !near(p.CPUCoreHourUSD, 0.00063/0.01987) || !near(p.RAMByteHourUSD, 0.00005/(11362151.80698+3000000)) {
		t.Fatalf("unit prices = %+v", p)
	}
}

// Discovery runs as the overview cache identity and a refused /healthz still
// counts as found; the allocation is read through the caller's own client.
func TestCostDiscovery_CacheIdentityAndForbiddenVerify(t *testing.T) {
	ctx := context.Background()

	// The caller's cluster has no OpenCost Service in sight (it may not list the
	// namespace), the cache identity's view has one: found, and the rows are
	// read through the caller's client.
	caller, callerSrv := newCostServer(t, false)
	_, viewSrv := newCostServer(t, true)
	viewClient, err := kubernetes.NewForConfig(&rest.Config{Host: viewSrv.srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	b := caller.defaultBundle.Load()
	b.cacheClient = viewClient
	if st := caller.CostStatus(ctx); st["available"] != true {
		t.Fatalf("status through the cache identity = %v", st)
	}
	if _, err := caller.CostAllocation(ctx, "1h", CostAggregateNamespace); err != nil {
		t.Fatal(err)
	}
	if _, a := callerSrv.counts(); a != 1 {
		t.Fatalf("caller's allocation calls = %d, want 1", a)
	}
	if _, a := viewSrv.counts(); a != 0 {
		t.Fatalf("the cache identity read the allocation %d times, want 0", a)
	}

	// A cluster that refuses the discovery identity's /healthz still has the
	// Service: found, not remembered as missing for everyone.
	s2, srv2 := newCostServer(t, true)
	srv2.healthz403 = true
	if st := s2.CostStatus(ctx); st["available"] != true {
		t.Fatalf("status with a refused healthz = %v", st)
	}
}

func TestCostAllocation_NotFoundIsRememberedForAWhile(t *testing.T) {
	s, srv := newCostServer(t, false)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if _, err := s.CostAllocation(ctx, "24h", CostAggregateNamespace); !errors.Is(err, ErrCostNotFound) {
			t.Fatalf("call %d: err = %v, want ErrCostNotFound", i+1, err)
		}
	}
	if lists, _ := srv.counts(); lists != len(costNamespaces) {
		t.Fatalf("a cluster without OpenCost was probed %d times, want one round of %d", lists, len(costNamespaces))
	}
	if st := s.CostStatus(ctx); st["available"] != false || st["source"] != "none" || !strings.Contains(st["message"].(string), "OpenCost not found") {
		t.Fatalf("status = %v", st)
	}
	if s.costUnitPricesForCtx(ctx, 24) != nil {
		t.Fatal("no OpenCost must mean no pricing for the optimization table")
	}
	// A window or aggregate OpenCost would not take never reaches the cluster.
	if _, err := s.CostAllocation(ctx, "2h", CostAggregateNamespace); err == nil || errors.Is(err, ErrCostNotFound) {
		t.Fatalf("window 2h: err = %v", err)
	}
	if _, err := s.CostAllocation(ctx, "24h", "pod"); err == nil || errors.Is(err, ErrCostNotFound) {
		t.Fatalf("aggregate pod: err = %v", err)
	}
}

func TestCostFeatureEnabled(t *testing.T) {
	for v, want := range map[string]bool{"": true, "true": true, "false": false, "0": false, "1": true, "nonsense": true} {
		t.Setenv("COST_ENABLED", v)
		if got := CostFeatureEnabled(); got != want {
			t.Errorf("COST_ENABLED=%q: %v, want %v", v, got, want)
		}
	}
	t.Setenv("COST_ENABLED", "false")
	if st := (&Service{}).CostStatus(context.Background()); st["available"] != false || !strings.Contains(st["message"].(string), "features.cost.enabled") {
		t.Fatalf("status with the switch off = %v", st)
	}
}

func TestCostWindowForHours(t *testing.T) {
	for hours, want := range map[int]string{1: "1h", 6: "6h", 7: "12h", 24: "24h", 25: "48h", 168: "7d", 200: "14d", 720: "30d", 1000: "30d"} {
		if got := costWindowForHours(hours); got != want {
			t.Errorf("%d h → %s, want %s", hours, got, want)
		}
	}
	for _, w := range []string{"1h", "6h", "12h", "24h", "48h", "7d", "14d", "30d"} {
		if !CostWindowAllowed(w) {
			t.Errorf("%s must be allowed", w)
		}
	}
	for _, w := range []string{"", "2h", "today", "1w", "24h "} {
		if CostWindowAllowed(w) {
			t.Errorf("%q must not be allowed", w)
		}
	}
}

func TestCostUnitPrices(t *testing.T) {
	rows := []CostRow{{CPUCost: 0.4, CPUCoreHours: 10, RAMCost: 0.2, RAMByteHours: 100}, {CPUCost: 0.2, CPUCoreHours: 10}}
	p := costUnitPrices(rows, "24h")
	if p == nil || !near(p.CPUCoreHourUSD, 0.03) || !near(p.RAMByteHourUSD, 0.002) || p.Window != "24h" || p.Source != "opencost" {
		t.Fatalf("prices = %+v", p)
	}
	if costUnitPrices([]CostRow{{TotalCost: 1}}, "1h") != nil {
		t.Fatal("rows without hours give no prices")
	}
	if costUnitPrices(nil, "1h") != nil {
		t.Fatal("no rows give no prices")
	}
}

// Each row's requests priced for a month (730 h, every pod), the saving its
// recommendation brings never below zero, no saving without a recommendation.
func TestApplyCostPricing(t *testing.T) {
	gib := float64(1 << 30)
	p := &CostUnitPrices{CPUCoreHourUSD: 0.04, RAMByteHourUSD: 0.005 / gib, Window: "24h", Source: "opencost"}
	cpuRec, memRec, under := int64(100), int64(256<<20), int64(200)
	res := &OptimizationResult{Rows: []OptimizationRow{
		{Kind: "Deployment", Name: "web", Pods: 2, CPURequestM: 500, MemRequestBytes: 1 << 30, CPURecommendM: &cpuRec, MemRecommendBytes: &memRec},
		{Kind: "DaemonSet", Name: "agent", Pods: 1, CPURequestM: 100, CPURecommendM: &under},
		{Kind: "Pod", Name: "bare", Pods: 1, CPURequestM: 50, MemRequestBytes: 64 << 20},
	}}
	applyCostPricing(res, p)
	if res.Pricing != p {
		t.Fatal("pricing not attached")
	}
	web, agent, bare := res.Rows[0], res.Rows[1], res.Rows[2]
	if web.CostMonthUSD == nil || !near(*web.CostMonthUSD, (0.5*0.04+0.005)*730*2) {
		t.Fatalf("web cost = %v", web.CostMonthUSD)
	}
	if web.SavingMonthUSD == nil || !near(*web.SavingMonthUSD, (0.4*0.04+0.75*0.005)*730*2) {
		t.Fatalf("web saving = %v", web.SavingMonthUSD)
	}
	if agent.CostMonthUSD == nil || !near(*agent.CostMonthUSD, 0.1*0.04*730) || agent.SavingMonthUSD == nil || *agent.SavingMonthUSD != 0 {
		t.Fatalf("agent (recommended above its request) cost=%v saving=%v, want saving 0", agent.CostMonthUSD, agent.SavingMonthUSD)
	}
	if bare.CostMonthUSD == nil || !near(*bare.CostMonthUSD, (0.05*0.04+0.005/16)*730) || bare.SavingMonthUSD != nil {
		t.Fatalf("bare (no recommendation) cost=%v saving=%v", bare.CostMonthUSD, bare.SavingMonthUSD)
	}
	if res.Totals.CostMonthUSD == nil || !near(*res.Totals.CostMonthUSD, *web.CostMonthUSD+*agent.CostMonthUSD+*bare.CostMonthUSD) ||
		res.Totals.SavingMonthUSD == nil || !near(*res.Totals.SavingMonthUSD, *web.SavingMonthUSD) {
		t.Fatalf("totals = %+v", res.Totals)
	}

	// Without prices the table is as before: no cost fields anywhere.
	plain := &OptimizationResult{Rows: []OptimizationRow{{Pods: 1, CPURequestM: 100}}}
	applyCostPricing(plain, nil)
	if plain.Pricing != nil || plain.Rows[0].CostMonthUSD != nil || plain.Totals.CostMonthUSD != nil {
		t.Fatalf("no prices must add nothing: %+v", plain)
	}
}

func TestCostKind(t *testing.T) {
	for in, want := range map[string]string{"deployment": "Deployment", "daemonset": "DaemonSet", "statefulset": "StatefulSet", "cronjob": "CronJob", "replicationcontroller": "ReplicationController", "rollout": "Rollout", "": ""} {
		if got := costKind(in); got != want {
			t.Errorf("costKind(%q) = %q, want %q", in, got, want)
		}
	}
}
