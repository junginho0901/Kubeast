package k8s

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// ========== Policy reports (wgpolicyk8s.io/v1alpha2) ==========
//
// Kyverno and other producers (Trivy Operator, …) write one PolicyReport per
// namespaced resource and one ClusterPolicyReport per cluster resource, each
// holding the results of every policy that looked at that resource. Kubeast
// only reads them — as the caller, so the cluster's RBAC stays the ceiling —
// and aggregates the results by policy and by namespace for the screen. The
// parsed results are kept a minute per cluster, namespace and identity.

var (
	policyReportGVR        = schema.GroupVersionResource{Group: "wgpolicyk8s.io", Version: "v1alpha2", Resource: "policyreports"}
	clusterPolicyReportGVR = schema.GroupVersionResource{Group: "wgpolicyk8s.io", Version: "v1alpha2", Resource: "clusterpolicyreports"}
)

const (
	policyReportPageSize   = 500
	policyReportMaxReports = 5000
	policyReportMaxResults = 50000
	policyReportCacheTTL   = 60 * time.Second
	// PolicyReportResultsCap bounds one results answer.
	PolicyReportResultsCap = 2000
	policyReportResultsDef = 500
)

// PolicyReportsFeatureEnabled reports the operator switch POLICY_REPORTS_ENABLED
// (chart features.policyReports.enabled). Unset counts as on.
func PolicyReportsFeatureEnabled() bool {
	v := os.Getenv("POLICY_REPORTS_ENABLED")
	if v == "" {
		return true
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return true
	}
	return b
}

// PolicyReportsInstalled says whether the cluster serves PolicyReports.
func (s *Service) PolicyReportsInstalled(ctx context.Context) bool {
	return s.ResourceServed(ctx, policyReportGVR.Group, policyReportGVR.Resource)
}

// PolicyReportResult is one row of a report: what one policy rule said about one resource.
type PolicyReportResult struct {
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Policy    string `json:"policy"`
	Rule      string `json:"rule,omitempty"`
	Result    string `json:"result"`
	Severity  string `json:"severity,omitempty"`
	Category  string `json:"category,omitempty"`
	Message   string `json:"message,omitempty"`
	Source    string `json:"source,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
	Report    string `json:"report"`
}

// PolicyReportCounts are result counts in the order the report API names them.
type PolicyReportCounts struct {
	Pass  int `json:"pass"`
	Fail  int `json:"fail"`
	Warn  int `json:"warn"`
	Error int `json:"error"`
	Skip  int `json:"skip"`
}

func (c *PolicyReportCounts) add(result string) {
	switch result {
	case "pass":
		c.Pass++
	case "fail":
		c.Fail++
	case "warn":
		c.Warn++
	case "error":
		c.Error++
	case "skip":
		c.Skip++
	}
}

type PolicyReportPolicyRow struct {
	Policy     string   `json:"policy"`
	Category   string   `json:"category,omitempty"`
	Severity   string   `json:"severity,omitempty"`
	Source     string   `json:"source,omitempty"`
	Namespaces []string `json:"namespaces"`
	PolicyReportCounts
}

type PolicyReportNamespaceRow struct {
	Namespace string `json:"namespace"`
	Policies  int    `json:"policies"`
	PolicyReportCounts
}

// PolicyReportSummary is GET /api/v1/policyreports/summary.
type PolicyReportSummary struct {
	GeneratedAt string                     `json:"generated_at"`
	Namespace   string                     `json:"namespace,omitempty"`
	Reports     int                        `json:"reports"`
	Truncated   bool                       `json:"truncated"`
	Scoped      bool                       `json:"scoped"`
	Totals      PolicyReportCounts         `json:"totals"`
	Policies    []PolicyReportPolicyRow    `json:"policies"`
	Namespaces  []PolicyReportNamespaceRow `json:"namespaces"`
}

// PolicyReportFilter narrows GET /api/v1/policyreports/results. Force reads
// the cluster again instead of the minute cache (the page's refresh button).
type PolicyReportFilter struct {
	Namespace  string
	Policy     string
	Kind       string
	Search     string
	Results    []string
	Severities []string
	Limit      int
	Force      bool
}

// PolicyReportResults is the filtered rows; Total counts the matches before Limit.
type PolicyReportResults struct {
	GeneratedAt string               `json:"generated_at"`
	Truncated   bool                 `json:"truncated"`
	Scoped      bool                 `json:"scoped"`
	Total       int                  `json:"total"`
	Rows        []PolicyReportResult `json:"rows"`
}

// PolicyReportResource is one resource's rows (a workload includes its pods).
type PolicyReportResource struct {
	GeneratedAt string               `json:"generated_at"`
	Kind        string               `json:"kind"`
	Name        string               `json:"name"`
	Namespace   string               `json:"namespace"`
	Totals      PolicyReportCounts   `json:"totals"`
	Rows        []PolicyReportResult `json:"rows"`
}

// policyReportSet is one parsed read, cached per cluster, namespace and identity.
type policyReportSet struct {
	at        time.Time
	reports   int
	truncated bool
	results   []PolicyReportResult
}

type policyReportCache struct {
	mu   sync.Mutex
	sets map[string]policyReportSet
}

var policyReportCaches = struct {
	mu sync.Mutex
	m  map[string]*policyReportCache
}{m: map[string]*policyReportCache{}}

func policyReportCacheFor(cluster string) *policyReportCache {
	policyReportCaches.mu.Lock()
	defer policyReportCaches.mu.Unlock()
	c, ok := policyReportCaches.m[cluster]
	if !ok {
		c = &policyReportCache{sets: map[string]policyReportSet{}}
		policyReportCaches.m[cluster] = c
	}
	return c
}

// PolicyReportSummary aggregates the cluster's (or one namespace's) results by
// policy and by namespace. A namespace-scoped grant sees its namespaces only.
func (s *Service) PolicyReportSummary(ctx context.Context, namespace string, force bool) (*PolicyReportSummary, error) {
	set, scoped, err := s.policyReportSet(ctx, namespace, force)
	if err != nil {
		return nil, err
	}
	out := &PolicyReportSummary{
		GeneratedAt: set.at.UTC().Format(time.RFC3339),
		Namespace:   namespace,
		Reports:     set.reports,
		Truncated:   set.truncated,
		Scoped:      scoped,
		Policies:    []PolicyReportPolicyRow{},
		Namespaces:  []PolicyReportNamespaceRow{},
	}
	policies := map[string]*PolicyReportPolicyRow{}
	policyNS := map[string]map[string]bool{}
	namespaces := map[string]*PolicyReportNamespaceRow{}
	nsPolicies := map[string]map[string]bool{}
	for _, r := range set.results {
		out.Totals.add(r.Result)
		p, ok := policies[r.Policy]
		if !ok {
			p = &PolicyReportPolicyRow{Policy: r.Policy, Category: r.Category, Severity: r.Severity, Source: r.Source}
			policies[r.Policy] = p
			policyNS[r.Policy] = map[string]bool{}
		}
		p.add(r.Result)
		if r.Namespace != "" {
			policyNS[r.Policy][r.Namespace] = true
		}
		n, ok := namespaces[r.Namespace]
		if !ok {
			n = &PolicyReportNamespaceRow{Namespace: r.Namespace}
			namespaces[r.Namespace] = n
			nsPolicies[r.Namespace] = map[string]bool{}
		}
		n.add(r.Result)
		nsPolicies[r.Namespace][r.Policy] = true
	}
	for name, p := range policies {
		for ns := range policyNS[name] {
			p.Namespaces = append(p.Namespaces, ns)
		}
		sort.Strings(p.Namespaces)
		if p.Namespaces == nil {
			p.Namespaces = []string{}
		}
		out.Policies = append(out.Policies, *p)
	}
	sort.Slice(out.Policies, func(i, j int) bool {
		a, b := out.Policies[i], out.Policies[j]
		if a.Fail != b.Fail {
			return a.Fail > b.Fail
		}
		if a.Warn != b.Warn {
			return a.Warn > b.Warn
		}
		return a.Policy < b.Policy
	})
	for ns, n := range namespaces {
		n.Policies = len(nsPolicies[ns])
		out.Namespaces = append(out.Namespaces, *n)
	}
	sort.Slice(out.Namespaces, func(i, j int) bool {
		a, b := out.Namespaces[i], out.Namespaces[j]
		if a.Fail != b.Fail {
			return a.Fail > b.Fail
		}
		if a.Warn != b.Warn {
			return a.Warn > b.Warn
		}
		return a.Namespace < b.Namespace
	})
	return out, nil
}

var policyReportResultRank = map[string]int{"fail": 0, "error": 1, "warn": 2, "pass": 3, "skip": 4}

// PolicyReportResults returns the rows a filter keeps, worst result first.
// Without a result filter only fail, warn and error rows are returned.
func (s *Service) PolicyReportResults(ctx context.Context, f PolicyReportFilter) (*PolicyReportResults, error) {
	set, scoped, err := s.policyReportSet(ctx, f.Namespace, f.Force)
	if err != nil {
		return nil, err
	}
	want := map[string]bool{}
	if len(f.Results) == 0 {
		want["fail"], want["warn"], want["error"] = true, true, true
	}
	for _, r := range f.Results {
		want[strings.ToLower(strings.TrimSpace(r))] = true
	}
	sev := map[string]bool{}
	for _, v := range f.Severities {
		sev[strings.ToLower(strings.TrimSpace(v))] = true
	}
	search := strings.ToLower(strings.TrimSpace(f.Search))
	kind := strings.ToLower(strings.TrimSpace(f.Kind))
	rows := make([]PolicyReportResult, 0)
	for _, r := range set.results {
		if !want[r.Result] {
			continue
		}
		if f.Policy != "" && r.Policy != f.Policy {
			continue
		}
		if kind != "" && strings.ToLower(r.Kind) != kind {
			continue
		}
		if len(sev) > 0 && !sev[strings.ToLower(r.Severity)] {
			continue
		}
		if search != "" && !strings.Contains(strings.ToLower(r.Policy+" "+r.Rule+" "+r.Name+" "+r.Namespace+" "+r.Message), search) {
			continue
		}
		rows = append(rows, r)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if policyReportResultRank[a.Result] != policyReportResultRank[b.Result] {
			return policyReportResultRank[a.Result] < policyReportResultRank[b.Result]
		}
		if a.Namespace != b.Namespace {
			return a.Namespace < b.Namespace
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.Policy < b.Policy
	})
	out := &PolicyReportResults{GeneratedAt: set.at.UTC().Format(time.RFC3339), Truncated: set.truncated, Scoped: scoped, Total: len(rows)}
	limit := f.Limit
	if limit <= 0 {
		limit = policyReportResultsDef
	}
	if limit > PolicyReportResultsCap {
		limit = PolicyReportResultsCap
	}
	if len(rows) > limit {
		rows = rows[:limit]
		out.Truncated = true
	}
	out.Rows = rows
	return out, nil
}

var policyReportWorkloadKinds = map[string]bool{"Deployment": true, "StatefulSet": true, "DaemonSet": true, "ReplicaSet": true, "Job": true, "CronJob": true}

// PolicyReportsForResource returns the rows about one resource; for a workload
// the rows of its running pods come along (the pod template is what most
// policies look at), each row naming the pod.
func (s *Service) PolicyReportsForResource(ctx context.Context, namespace, kind, name string, force bool) (*PolicyReportResource, error) {
	set, _, err := s.policyReportSet(ctx, namespace, force)
	if err != nil {
		return nil, err
	}
	pods := map[string]bool{}
	if policyReportWorkloadKinds[kind] {
		cs := s.clientsetCtx(ctx)
		if cs == nil {
			return nil, errNotLoaded
		}
		owner, err := s.workloadOwner(ctx, namespace)
		if err != nil {
			return nil, err
		}
		podList, err := cs.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list pods: %w", err)
		}
		for _, p := range podList.Items {
			if k, n := owner(p); k == kind && n == name {
				pods[p.Name] = true
			}
		}
	}
	out := &PolicyReportResource{GeneratedAt: set.at.UTC().Format(time.RFC3339), Kind: kind, Name: name, Namespace: namespace, Rows: []PolicyReportResult{}}
	for _, r := range set.results {
		if r.Namespace != namespace {
			continue
		}
		if (r.Kind == kind && r.Name == name) || (r.Kind == "Pod" && pods[r.Name]) {
			out.Rows = append(out.Rows, r)
			out.Totals.add(r.Result)
		}
	}
	sort.SliceStable(out.Rows, func(i, j int) bool {
		a, b := out.Rows[i], out.Rows[j]
		if policyReportResultRank[a.Result] != policyReportResultRank[b.Result] {
			return policyReportResultRank[a.Result] < policyReportResultRank[b.Result]
		}
		if a.Policy != b.Policy {
			return a.Policy < b.Policy
		}
		return a.Name < b.Name
	})
	return out, nil
}

// policyReportSet reads (or serves from the minute cache, unless force) the
// results the caller may see: one namespace, the grant's namespaces, or the
// whole cluster including ClusterPolicyReports. A forced read refreshes the cache.
func (s *Service) policyReportSet(ctx context.Context, namespace string, force bool) (policyReportSet, bool, error) {
	scope := scopeFromCtx(ctx)
	scoped := len(scope) > 0
	if scoped && namespace != "" && !containsString(scope, namespace) {
		return policyReportSet{}, true, apierrors.NewForbidden(schema.GroupResource{Group: policyReportGVR.Group, Resource: policyReportGVR.Resource}, "", fmt.Errorf("namespace %q is outside your grant", namespace))
	}
	cluster := string(ctxClusterID(ctx))
	identity := ""
	if p, ok := auth.FromContext(ctx); ok {
		identity = p.CacheIdentity(cluster)
	}
	key := namespace + "|as:" + identity
	c := policyReportCacheFor(cluster)
	if !force {
		c.mu.Lock()
		if set, ok := c.sets[key]; ok && time.Since(set.at) < policyReportCacheTTL {
			c.mu.Unlock()
			return set, scoped, nil
		}
		c.mu.Unlock()
	}

	set, err := s.readPolicyReports(ctx, namespace, scope)
	if err != nil {
		return policyReportSet{}, scoped, err
	}
	c.mu.Lock()
	c.sets[key] = set
	c.mu.Unlock()
	return set, scoped, nil
}

func (s *Service) readPolicyReports(ctx context.Context, namespace string, scope []string) (policyReportSet, error) {
	set := policyReportSet{at: time.Now(), results: []PolicyReportResult{}}
	namespaces := []string{namespace}
	if namespace == "" && len(scope) > 0 {
		namespaces = scope
	}
	for _, ns := range namespaces {
		if err := s.readPolicyReportKind(ctx, policyReportGVR, ns, &set); err != nil {
			return set, err
		}
		if set.truncated {
			return set, nil
		}
	}
	// Cluster-scoped resources only belong to a whole-cluster view.
	if namespace == "" && len(scope) == 0 {
		if err := s.readPolicyReportKind(ctx, clusterPolicyReportGVR, "", &set); err != nil && !apierrors.IsNotFound(err) && !apierrors.IsForbidden(err) {
			return set, err
		}
	}
	return set, nil
}

func (s *Service) readPolicyReportKind(ctx context.Context, gvr schema.GroupVersionResource, ns string, set *policyReportSet) error {
	opts := metav1.ListOptions{Limit: policyReportPageSize}
	for {
		list, err := s.ListResources(ctx, gvr, ns, opts)
		if err != nil {
			return err
		}
		for i := range list.Items {
			set.reports++
			set.results = append(set.results, policyReportRows(&list.Items[i])...)
			if set.reports >= policyReportMaxReports || len(set.results) >= policyReportMaxResults {
				set.truncated = true
				return nil
			}
		}
		if list.GetContinue() == "" {
			return nil
		}
		opts.Continue = list.GetContinue()
	}
}

// policyReportRows flattens one report. The resource a row is about comes from
// the result's own resources list, else from the report's scope.
func policyReportRows(obj *unstructured.Unstructured) []PolicyReportResult {
	scopeKind, _, _ := unstructured.NestedString(obj.Object, "scope", "kind")
	scopeName, _, _ := unstructured.NestedString(obj.Object, "scope", "name")
	scopeNS, _, _ := unstructured.NestedString(obj.Object, "scope", "namespace")
	if scopeNS == "" {
		scopeNS = obj.GetNamespace()
	}
	results, _, _ := unstructured.NestedSlice(obj.Object, "results")
	rows := make([]PolicyReportResult, 0, len(results))
	for _, raw := range results {
		m, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		row := PolicyReportResult{
			Namespace: scopeNS, Kind: scopeKind, Name: scopeName,
			Policy:   str(m["policy"]),
			Rule:     str(m["rule"]),
			Result:   strings.ToLower(str(m["result"])),
			Severity: str(m["severity"]),
			Category: str(m["category"]),
			Message:  str(m["message"]),
			Source:   str(m["source"]),
			Report:   obj.GetName(),
		}
		if res, ok := m["resources"].([]interface{}); ok && len(res) > 0 {
			if first, ok := res[0].(map[string]interface{}); ok {
				if k := str(first["kind"]); k != "" {
					row.Kind = k
				}
				if n := str(first["name"]); n != "" {
					row.Name = n
				}
				if n := str(first["namespace"]); n != "" {
					row.Namespace = n
				}
			}
		}
		if ts, ok := m["timestamp"].(map[string]interface{}); ok {
			if secs, ok := ts["seconds"].(int64); ok && secs > 0 {
				row.Timestamp = time.Unix(secs, 0).UTC().Format(time.RFC3339)
			} else if secs, ok := ts["seconds"].(float64); ok && secs > 0 {
				row.Timestamp = time.Unix(int64(secs), 0).UTC().Format(time.RFC3339)
			}
		}
		if row.Result == "" {
			continue
		}
		rows = append(rows, row)
	}
	return rows
}

func str(v interface{}) string {
	s, _ := v.(string)
	return s
}
