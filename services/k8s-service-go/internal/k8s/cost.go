package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// ========== OpenCost ==========
//
// Cost allocation comes from an OpenCost running in the TARGET cluster, read
// through the API server service proxy the way Prometheus is (prometheus.go):
// a Service whose name contains "opencost" on port 9003 that answers /healthz.
// Nothing is stored here — OpenCost computes from the cluster's Prometheus and
// answers /allocation/compute; this file normalizes the rows, applies the
// caller's namespace scope and keeps each answer for a minute.
//
// Identities: the allocation is read as the caller (impersonation), so the
// cluster's RBAC stays the ceiling — a viewer whose groups lack services/proxy
// is refused by the cluster, and answers are cached per identity so nobody is
// served what another identity read. Discovery (which Service) runs as the
// overview cache identity, so one caller's rights never decide what the whole
// cluster remembers.

// ErrCostNotFound: the cluster has no OpenCost the proxy can reach.
var ErrCostNotFound = errors.New("OpenCost not found in this cluster")

const (
	openCostPort = 9003
	// A found OpenCost is re-verified this often; a cluster without one is
	// probed again sooner, so installing it shows up within minutes.
	costHitTTL  = 10 * time.Minute
	costMissTTL = 5 * time.Minute
	// One allocation answer per cluster, window and aggregate.
	costAllocTTL = 60 * time.Second

	CostAggregateNamespace  = "namespace"
	CostAggregateController = "controller"

	costHoursPerMonth = 730
)

// costNamespaces are probed concurrently, in preference order.
var costNamespaces = []string{"opencost", "kubecost", "monitoring", "cost"}

// costWindows are the OpenCost windows the API accepts.
var costWindows = []string{"1h", "6h", "12h", "24h", "48h", "7d", "14d", "30d"}

// CostWindows lists the accepted windows, for the API's error text.
func CostWindows() []string { return append([]string(nil), costWindows...) }

func CostWindowAllowed(window string) bool {
	for _, w := range costWindows {
		if w == window {
			return true
		}
	}
	return false
}

func CostAggregateAllowed(aggregate string) bool {
	return aggregate == CostAggregateNamespace || aggregate == CostAggregateController
}

// CostFeatureEnabled reports the operator switch COST_ENABLED (chart
// features.cost.enabled). Unset counts as on, like PROMETHEUS_ENABLED.
func CostFeatureEnabled() bool {
	v := os.Getenv("COST_ENABLED")
	if v == "" {
		return true
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return true
	}
	return b
}

// costServiceInfo is the discovered OpenCost Service.
type costServiceInfo struct {
	Namespace string
	Name      string
	Port      int32
}

func (i costServiceInfo) proxyBase() string {
	return fmt.Sprintf("/api/v1/namespaces/%s/services/%s:%d/proxy", i.Namespace, i.Name, i.Port)
}

// costCache lives on a clientBundle — one per cluster, dropped with it — and
// holds the discovered OpenCost plus recent allocation answers, keyed by
// window, aggregate and the identity that read them.
type costCache struct {
	mu       sync.RWMutex
	svc      *costServiceInfo
	probed   bool
	probedAt time.Time
	alloc    map[string]costAllocEntry
}

type costAllocEntry struct {
	at    time.Time
	rows  []CostRow
	start string
	end   string
}

func (c *costCache) fresh() bool {
	if !c.probed {
		return false
	}
	ttl := costMissTTL
	if c.svc != nil {
		ttl = costHitTTL
	}
	return time.Since(c.probedAt) < ttl
}

// CostRow is one allocation: a namespace, or a workload (controller) inside one.
// Costs are the window's total in the cluster's currency (USD unless OpenCost
// is configured otherwise); hours are what the cost was computed over.
type CostRow struct {
	Name             string  `json:"name"`
	Namespace        string  `json:"namespace"`
	Kind             string  `json:"kind,omitempty"`
	CPUCost          float64 `json:"cpu_cost"`
	RAMCost          float64 `json:"ram_cost"`
	GPUCost          float64 `json:"gpu_cost"`
	PVCost           float64 `json:"pv_cost"`
	NetworkCost      float64 `json:"network_cost"`
	LoadBalancerCost float64 `json:"load_balancer_cost"`
	TotalCost        float64 `json:"total_cost"`
	CPUCoreHours     float64 `json:"cpu_core_hours"`
	RAMByteHours     float64 `json:"ram_byte_hours"`
	CPUEfficiency    float64 `json:"cpu_efficiency"`
	RAMEfficiency    float64 `json:"ram_efficiency"`
	TotalEfficiency  float64 `json:"total_efficiency"`
	Minutes          float64 `json:"minutes"`
}

// CostTotals sums the rows that were returned (after the namespace scope).
type CostTotals struct {
	CPUCost          float64 `json:"cpu_cost"`
	RAMCost          float64 `json:"ram_cost"`
	GPUCost          float64 `json:"gpu_cost"`
	PVCost           float64 `json:"pv_cost"`
	NetworkCost      float64 `json:"network_cost"`
	LoadBalancerCost float64 `json:"load_balancer_cost"`
	TotalCost        float64 `json:"total_cost"`
	CPUCoreHours     float64 `json:"cpu_core_hours"`
	RAMByteHours     float64 `json:"ram_byte_hours"`
}

type CostSource struct {
	Namespace string `json:"namespace"`
	Service   string `json:"service"`
	Port      int32  `json:"port"`
}

// CostResult is GET /api/v1/cost. Scoped says the caller's namespace grant
// narrowed the rows (and the totals) to their namespaces.
type CostResult struct {
	Window      string     `json:"window"`
	Aggregate   string     `json:"aggregate"`
	Currency    string     `json:"currency"`
	Start       string     `json:"start,omitempty"`
	End         string     `json:"end,omitempty"`
	Source      CostSource `json:"source"`
	Scoped      bool       `json:"scoped"`
	GeneratedAt string     `json:"generated_at"`
	Rows        []CostRow  `json:"rows"`
	Totals      CostTotals `json:"totals"`
}

// CostUnitPrices are hourly unit prices read back from one allocation answer
// (cost ÷ hours over every namespace in the window). The optimization table
// turns requests into money with them.
type CostUnitPrices struct {
	CPUCoreHourUSD float64 `json:"cpu_core_hour_usd"`
	RAMByteHourUSD float64 `json:"ram_byte_hour_usd"`
	Window         string  `json:"window"`
	Source         string  `json:"source"`
}

// openCostAllocation is the part of one OpenCost allocation this service reads.
type openCostAllocation struct {
	Name       string `json:"name"`
	Properties struct {
		Namespace      string `json:"namespace"`
		Controller     string `json:"controller"`
		ControllerKind string `json:"controllerKind"`
	} `json:"properties"`
	Window struct {
		Start string `json:"start"`
		End   string `json:"end"`
	} `json:"window"`
	CPUCost          float64 `json:"cpuCost"`
	RAMCost          float64 `json:"ramCost"`
	GPUCost          float64 `json:"gpuCost"`
	PVCost           float64 `json:"pvCost"`
	NetworkCost      float64 `json:"networkCost"`
	LoadBalancerCost float64 `json:"loadBalancerCost"`
	TotalCost        float64 `json:"totalCost"`
	CPUCoreHours     float64 `json:"cpuCoreHours"`
	RAMByteHours     float64 `json:"ramByteHours"`
	CPUEfficiency    float64 `json:"cpuEfficiency"`
	RAMEfficiency    float64 `json:"ramEfficiency"`
	TotalEfficiency  float64 `json:"totalEfficiency"`
	Minutes          float64 `json:"minutes"`
}

type openCostResponse struct {
	Code    int                             `json:"code"`
	Message string                          `json:"message"`
	Data    []map[string]openCostAllocation `json:"data"`
}

// CostStatus says whether this cluster has an OpenCost and where.
func (s *Service) CostStatus(ctx context.Context) map[string]interface{} {
	if !CostFeatureEnabled() {
		return map[string]interface{}{
			"available": false,
			"source":    "none",
			"message":   "Cost integration disabled (features.cost.enabled=false)",
		}
	}
	info := s.getCostService(ctx)
	if info == nil {
		return map[string]interface{}{
			"available": false,
			"source":    "none",
			"message":   "OpenCost not found in this cluster (a Service named *opencost* on port 9003 answering /healthz)",
		}
	}
	return map[string]interface{}{
		"available": true,
		"source":    "proxy",
		"endpoint":  fmt.Sprintf("%s/%s:%d (via K8s API proxy)", info.Namespace, info.Name, info.Port),
	}
}

// CostAllocation returns OpenCost's allocation for the window, by namespace or
// by workload (OpenCost aggregate namespace,controller), narrowed to the
// caller's namespace scope. ErrCostNotFound when the cluster has no OpenCost.
func (s *Service) CostAllocation(ctx context.Context, window, aggregate string) (*CostResult, error) {
	if !CostWindowAllowed(window) || !CostAggregateAllowed(aggregate) {
		return nil, fmt.Errorf("window %q or aggregate %q not allowed", window, aggregate)
	}
	b := s.bundleForCtx(ctx)
	if b == nil {
		return nil, errNotLoaded
	}
	info := s.getCostService(ctx)
	if info == nil {
		return nil, ErrCostNotFound
	}
	entry, err := s.costAllocationCached(ctx, b.cost, *info, window, aggregate)
	if err != nil {
		return nil, err
	}
	rows := entry.rows
	scope := scopeFromCtx(ctx)
	if len(scope) > 0 {
		rows = filterCostRows(rows, scope)
	}
	return &CostResult{
		Window:      window,
		Aggregate:   aggregate,
		Currency:    "USD",
		Start:       entry.start,
		End:         entry.end,
		Source:      CostSource{Namespace: info.Namespace, Service: info.Name, Port: info.Port},
		Scoped:      len(scope) > 0,
		GeneratedAt: entry.at.UTC().Format(time.RFC3339),
		Rows:        rows,
		Totals:      costTotals(rows),
	}, nil
}

// costUnitPricesForCtx prices the optimization table: nil when the feature is
// off, the cluster has no OpenCost or the call fails — the table then carries
// no cost columns. Reads the namespace allocation (shared with the Cost page's
// cache) over the window that covers windowHours.
func (s *Service) costUnitPricesForCtx(ctx context.Context, windowHours int) *CostUnitPrices {
	if !CostFeatureEnabled() {
		return nil
	}
	b := s.bundleForCtx(ctx)
	if b == nil {
		return nil
	}
	info := s.getCostService(ctx)
	if info == nil {
		return nil
	}
	window := costWindowForHours(windowHours)
	entry, err := s.costAllocationCached(ctx, b.cost, *info, window, CostAggregateNamespace)
	if err != nil {
		slog.Warn("OpenCost allocation for the optimization table failed", "err", err)
		return nil
	}
	return costUnitPrices(entry.rows, window)
}

// costWindowForHours picks the smallest accepted window that covers hours.
func costWindowForHours(hours int) string {
	switch {
	case hours <= 1:
		return "1h"
	case hours <= 6:
		return "6h"
	case hours <= 12:
		return "12h"
	case hours <= 24:
		return "24h"
	case hours <= 48:
		return "48h"
	case hours <= 7*24:
		return "7d"
	case hours <= 14*24:
		return "14d"
	default:
		return "30d"
	}
}

func costUnitPrices(rows []CostRow, window string) *CostUnitPrices {
	t := costTotals(rows)
	p := &CostUnitPrices{Window: window, Source: "opencost"}
	if t.CPUCoreHours > 0 {
		p.CPUCoreHourUSD = t.CPUCost / t.CPUCoreHours
	}
	if t.RAMByteHours > 0 {
		p.RAMByteHourUSD = t.RAMCost / t.RAMByteHours
	}
	if p.CPUCoreHourUSD == 0 && p.RAMByteHourUSD == 0 {
		return nil
	}
	return p
}

// applyCostPricing adds the monthly cost of each row's requests (730 h) and the
// monthly saving its recommendation would bring (never below zero), plus totals.
func applyCostPricing(res *OptimizationResult, p *CostUnitPrices) {
	if res == nil || p == nil {
		return
	}
	res.Pricing = p
	var cost, saving float64
	for i := range res.Rows {
		r := &res.Rows[i]
		n := float64(r.Pods)
		c := (float64(r.CPURequestM)/1000*p.CPUCoreHourUSD + float64(r.MemRequestBytes)*p.RAMByteHourUSD) * costHoursPerMonth * n
		r.CostMonthUSD = &c
		cost += c
		var sv float64
		has := false
		if r.CPURecommendM != nil {
			sv += float64(r.CPURequestM-*r.CPURecommendM) / 1000 * p.CPUCoreHourUSD
			has = true
		}
		if r.MemRecommendBytes != nil {
			sv += float64(r.MemRequestBytes-*r.MemRecommendBytes) * p.RAMByteHourUSD
			has = true
		}
		if !has {
			continue
		}
		sv *= costHoursPerMonth * n
		if sv < 0 {
			sv = 0
		}
		r.SavingMonthUSD = &sv
		saving += sv
	}
	res.Totals.CostMonthUSD = &cost
	res.Totals.SavingMonthUSD = &saving
}

// costCacheIdentity names the caller for the answer cache (auth.TokenPayload.
// CacheIdentity: the user and the groups the cluster sees), "" when no one is
// signed in.
func costCacheIdentity(ctx context.Context, clusterID string) string {
	if p, ok := auth.FromContext(ctx); ok {
		return p.CacheIdentity(clusterID)
	}
	return ""
}

func (s *Service) costAllocationCached(ctx context.Context, c *costCache, info costServiceInfo, window, aggregate string) (costAllocEntry, error) {
	key := window + "|" + aggregate + "|as:" + costCacheIdentity(ctx, string(ctxClusterID(ctx)))
	if c != nil {
		c.mu.RLock()
		e, ok := c.alloc[key]
		c.mu.RUnlock()
		if ok && time.Since(e.at) < costAllocTTL {
			return e, nil
		}
	}
	rows, start, end, err := s.fetchOpenCostAllocation(ctx, info, window, aggregate)
	if err != nil {
		return costAllocEntry{}, err
	}
	e := costAllocEntry{at: time.Now(), rows: rows, start: start, end: end}
	if c != nil {
		c.mu.Lock()
		if c.alloc == nil {
			c.alloc = map[string]costAllocEntry{}
		}
		c.alloc[key] = e
		c.mu.Unlock()
	}
	return e, nil
}

// fetchOpenCostAllocation calls /allocation/compute through the proxy: one
// accumulated set over the window, idle left out, by namespace or by
// namespace,controller so every workload row knows its namespace.
func (s *Service) fetchOpenCostAllocation(ctx context.Context, info costServiceInfo, window, aggregate string) ([]CostRow, string, string, error) {
	agg := aggregate
	if aggregate == CostAggregateController {
		agg = "namespace,controller"
	}
	result := s.clientsetCtx(ctx).CoreV1().RESTClient().Get().
		AbsPath(info.proxyBase()).
		Suffix("allocation", "compute").
		Param("window", window).
		Param("aggregate", agg).
		Param("accumulate", "true").
		Param("includeIdle", "false").
		Do(ctx)
	body, err := result.Raw()
	if err != nil {
		var statusCode int
		result.StatusCode(&statusCode)
		return nil, "", "", fmt.Errorf("opencost allocation request failed (status %d): %w", statusCode, err)
	}
	var resp openCostResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, "", "", fmt.Errorf("parse opencost response: %w (body: %s)", err, string(body[:min(len(body), 200)]))
	}
	if resp.Code != 0 && resp.Code != 200 {
		return nil, "", "", fmt.Errorf("opencost answered %d: %s", resp.Code, resp.Message)
	}
	if len(resp.Data) == 0 {
		return []CostRow{}, "", "", nil
	}
	rows, start, end := normalizeCostRows(resp.Data[0], aggregate)
	return rows, start, end, nil
}

// normalizeCostRows turns one allocation set into rows: the namespace rows keep
// their name; a workload row takes namespace, kind and name from the
// allocation's properties, falling back to its "ns/kind:name" key. The idle
// allocation, if any, is left out. Rows come back by total cost, highest first.
func normalizeCostRows(set map[string]openCostAllocation, aggregate string) ([]CostRow, string, string) {
	rows := make([]CostRow, 0, len(set))
	var start, end string
	for key, a := range set {
		if key == "__idle__" {
			continue
		}
		if start == "" {
			start, end = a.Window.Start, a.Window.End
		}
		r := CostRow{
			CPUCost: a.CPUCost, RAMCost: a.RAMCost, GPUCost: a.GPUCost, PVCost: a.PVCost,
			NetworkCost: a.NetworkCost, LoadBalancerCost: a.LoadBalancerCost, TotalCost: a.TotalCost,
			CPUCoreHours: a.CPUCoreHours, RAMByteHours: a.RAMByteHours,
			CPUEfficiency: a.CPUEfficiency, RAMEfficiency: a.RAMEfficiency, TotalEfficiency: a.TotalEfficiency,
			Minutes: a.Minutes,
		}
		if aggregate == CostAggregateNamespace {
			r.Name, r.Namespace = key, key
			rows = append(rows, r)
			continue
		}
		ns, rest := key, ""
		if i := strings.Index(key, "/"); i >= 0 {
			ns, rest = key[:i], key[i+1:]
		}
		kind, name := "", rest
		if i := strings.Index(rest, ":"); i >= 0 {
			kind, name = rest[:i], rest[i+1:]
		}
		if a.Properties.Namespace != "" {
			ns = a.Properties.Namespace
		}
		if a.Properties.ControllerKind != "" {
			kind = a.Properties.ControllerKind
		}
		if a.Properties.Controller != "" {
			name = a.Properties.Controller
		}
		r.Namespace, r.Kind, r.Name = ns, costKind(kind), name
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].TotalCost != rows[j].TotalCost {
			return rows[i].TotalCost > rows[j].TotalCost
		}
		if rows[i].Namespace != rows[j].Namespace {
			return rows[i].Namespace < rows[j].Namespace
		}
		return rows[i].Name < rows[j].Name
	})
	return rows, start, end
}

// costKind maps OpenCost's lower-case controllerKind to the Kubernetes kind.
func costKind(k string) string {
	switch strings.ToLower(k) {
	case "":
		return ""
	case "deployment":
		return "Deployment"
	case "statefulset":
		return "StatefulSet"
	case "daemonset":
		return "DaemonSet"
	case "replicaset":
		return "ReplicaSet"
	case "job":
		return "Job"
	case "cronjob":
		return "CronJob"
	case "replicationcontroller":
		return "ReplicationController"
	default:
		return strings.ToUpper(k[:1]) + k[1:]
	}
}

func filterCostRows(rows []CostRow, scope []string) []CostRow {
	allowed := make(map[string]bool, len(scope))
	for _, ns := range scope {
		allowed[ns] = true
	}
	out := make([]CostRow, 0, len(rows))
	for _, r := range rows {
		if allowed[r.Namespace] {
			out = append(out, r)
		}
	}
	return out
}

func costTotals(rows []CostRow) CostTotals {
	var t CostTotals
	for _, r := range rows {
		t.CPUCost += r.CPUCost
		t.RAMCost += r.RAMCost
		t.GPUCost += r.GPUCost
		t.PVCost += r.PVCost
		t.NetworkCost += r.NetworkCost
		t.LoadBalancerCost += r.LoadBalancerCost
		t.TotalCost += r.TotalCost
		t.CPUCoreHours += r.CPUCoreHours
		t.RAMByteHours += r.RAMByteHours
	}
	return t
}

// --- discovery (the Prometheus pattern, as the overview cache identity: client.go discoveryClient) ---

func (s *Service) getCostService(ctx context.Context) *costServiceInfo {
	b := s.bundleForCtx(ctx)
	if b == nil || b.cost == nil {
		return nil
	}
	c := b.cost
	c.mu.RLock()
	if c.fresh() {
		cached := c.svc
		c.mu.RUnlock()
		return cached
	}
	c.mu.RUnlock()

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fresh() {
		return c.svc
	}
	c.svc = s.discoverOpenCost(ctx)
	c.probed, c.probedAt = true, time.Now()
	return c.svc
}

func (s *Service) discoverOpenCost(ctx context.Context) *costServiceInfo {
	cs := s.discoveryClient(ctx)
	if cs == nil {
		return nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	hits := make([]*costServiceInfo, len(costNamespaces))
	var wg sync.WaitGroup
	for i, ns := range costNamespaces {
		wg.Add(1)
		go func(i int, ns string) {
			defer wg.Done()
			hits[i] = probeOpenCostNamespace(probeCtx, cs, ns)
		}(i, ns)
	}
	wg.Wait()

	for _, info := range hits {
		if info != nil {
			slog.Info("OpenCost discovered via K8s API proxy", "namespace", info.Namespace, "service", info.Name, "port", info.Port)
			return info
		}
	}
	slog.Info("OpenCost not found in target cluster")
	return nil
}

func probeOpenCostNamespace(ctx context.Context, cs kubernetes.Interface, ns string) *costServiceInfo {
	svcList, err := cs.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil
	}
	for _, svc := range svcList.Items {
		if !strings.Contains(strings.ToLower(svc.Name), "opencost") {
			continue
		}
		for _, port := range svc.Spec.Ports {
			if port.Port == openCostPort {
				info := &costServiceInfo{Namespace: svc.Namespace, Name: svc.Name, Port: port.Port}
				if verifyOpenCostProxy(ctx, cs, info) {
					return info
				}
			}
		}
	}
	return nil
}

// verifyOpenCostProxy asks /healthz through the proxy. A refusal (403) still
// counts as found: the Service is there and the cluster decides on each
// caller's own read, not on the discovery identity's.
func verifyOpenCostProxy(ctx context.Context, cs kubernetes.Interface, info *costServiceInfo) bool {
	result := cs.CoreV1().RESTClient().Get().
		AbsPath(info.proxyBase()).
		Suffix("healthz").
		Do(ctx)
	var statusCode int
	result.StatusCode(&statusCode)
	if _, err := result.Raw(); err != nil {
		if statusCode == http.StatusForbidden {
			return true
		}
		slog.Debug("OpenCost verify failed", "status", statusCode, "err", err)
		return false
	}
	return statusCode == http.StatusOK
}
