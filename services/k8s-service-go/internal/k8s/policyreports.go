package k8s

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
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
	// also holds the resources a result names after its first: the row is about them too (a drawer's rows)
	also []policyReportRef
	// picks holds Selector parsed: the row is about each resource of its namespace whose labels match (a drawer's rows)
	picks labels.Selector

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
	// APIVersion is the resource's (the result's resources, else the report's scope), so a Kind two groups serve
	// opens the right group's object.
	APIVersion string `json:"api_version,omitempty"`
	// Selector is what the result picks by label instead of naming a resource, as kubectl writes a selector.
	Selector string `json:"selector,omitempty"`
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
	// ClusterReportsError says why rows the ClusterPolicyReports hold may be missing.
	ClusterReportsError string `json:"cluster_reports_error,omitempty"`
}

// PolicyReportFilter narrows GET /api/v1/policyreports/results and picks a
// page: Offset rows skipped, Limit rows kept, in Sort order ("result",
// "policy", "namespace" or "name", else worst first). Force reads the cluster
// again instead of the minute cache (the page's refresh button).
type PolicyReportFilter struct {
	Namespace  string
	Policy     string
	Source     string
	Kind       string
	Search     string
	Results    []string
	Severities []string
	Offset     int
	Limit      int
	Sort       string
	Desc       bool
	Force      bool
}

// PolicyReportResults is one page of the filtered rows; Total counts every
// match. Truncated says the cluster held more reports than one read takes.
type PolicyReportResults struct {
	GeneratedAt string               `json:"generated_at"`
	Truncated   bool                 `json:"truncated"`
	Scoped      bool                 `json:"scoped"`
	Total       int                  `json:"total"`
	Rows        []PolicyReportResult `json:"rows"`
	// ClusterReportsError says why rows the ClusterPolicyReports hold may be missing.
	ClusterReportsError string `json:"cluster_reports_error,omitempty"`
}

// PolicyReportResource is one resource's rows (a workload includes its pods).
type PolicyReportResource struct {
	GeneratedAt string               `json:"generated_at"`
	Kind        string               `json:"kind"`
	Name        string               `json:"name"`
	Namespace   string               `json:"namespace"`
	Totals      PolicyReportCounts   `json:"totals"`
	Rows        []PolicyReportResult `json:"rows"`
	// SelectorError says why the results that pick by label could not be held to this resource (its labels unread).
	SelectorError string `json:"selector_error,omitempty"`
	// ClusterReportsError says why the rows the ClusterPolicyReports hold about this resource may be missing.
	ClusterReportsError string `json:"cluster_reports_error,omitempty"`
}

// policyReportSet is one parsed read, cached per cluster, namespace and identity.
type policyReportSet struct {
	at        time.Time
	reports   int
	truncated bool
	results   []PolicyReportResult
	// clusterError says why the cluster reports a view should hold were not read.
	clusterError string
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
	set, scoped, err := s.policyReportView(ctx, namespace, force)
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

		ClusterReportsError: set.clusterError,
	}
	// a policy is its name within its source: two engines may name a policy alike
	policies := map[string]*PolicyReportPolicyRow{}
	policyNS := map[string]map[string]bool{}
	namespaces := map[string]*PolicyReportNamespaceRow{}
	nsPolicies := map[string]map[string]bool{}
	for _, r := range set.results {
		out.Totals.add(r.Result)
		key := r.Source + "\x00" + r.Policy
		p, ok := policies[key]
		if !ok {
			p = &PolicyReportPolicyRow{Policy: r.Policy, Source: r.Source}
			policies[key] = p
			policyNS[key] = map[string]bool{}
		}
		if p.Category == "" {
			p.Category = r.Category
		}
		if p.Severity == "" {
			p.Severity = r.Severity
		}
		p.add(r.Result)
		if r.Namespace != "" {
			policyNS[key][r.Namespace] = true
		}
		n, ok := namespaces[r.Namespace]
		if !ok {
			n = &PolicyReportNamespaceRow{Namespace: r.Namespace}
			namespaces[r.Namespace] = n
			nsPolicies[r.Namespace] = map[string]bool{}
		}
		n.add(r.Result)
		nsPolicies[r.Namespace][key] = true
	}
	for key, p := range policies {
		for ns := range policyNS[key] {
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
		if a.Policy != b.Policy {
			return a.Policy < b.Policy
		}
		return a.Source < b.Source
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
	set, scoped, err := s.policyReportView(ctx, f.Namespace, f.Force)
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
		if f.Source != "" && r.Source != f.Source {
			continue
		}
		if kind != "" && strings.ToLower(r.Kind) != kind {
			continue
		}
		if len(sev) > 0 && !sev[strings.ToLower(r.Severity)] {
			continue
		}
		if search != "" && !strings.Contains(strings.ToLower(r.Policy+" "+r.Rule+" "+r.Name+" "+r.Selector+" "+r.Namespace+" "+r.Message), search) {
			continue
		}
		rows = append(rows, r)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if c := policyReportCompare(rows[i], rows[j], f.Sort); c != 0 {
			if f.Desc {
				return c > 0
			}
			return c < 0
		}
		return policyReportCompare(rows[i], rows[j], "") < 0
	})
	out := &PolicyReportResults{GeneratedAt: set.at.UTC().Format(time.RFC3339), Truncated: set.truncated, Scoped: scoped, Total: len(rows), ClusterReportsError: set.clusterError}
	limit := f.Limit
	if limit <= 0 {
		limit = policyReportResultsDef
	}
	if limit > PolicyReportResultsCap {
		limit = PolicyReportResultsCap
	}
	start := min(max(f.Offset, 0), len(rows))
	out.Rows = rows[start:min(start+limit, len(rows))]
	return out, nil
}

// policyReportCompare orders two rows by one column — "result" (worst first),
// "policy", "namespace" or "name" (kind/name) — or, for "", worst first, then
// namespace, resource, policy and the rest, so every page cuts the same order.
func policyReportCompare(a, b PolicyReportResult, by string) int {
	switch by {
	case "result":
		return cmp.Compare(policyReportResultRank[a.Result], policyReportResultRank[b.Result])
	case "policy":
		return cmp.Or(cmp.Compare(a.Policy, b.Policy), cmp.Compare(a.Source, b.Source))
	case "namespace":
		return cmp.Compare(a.Namespace, b.Namespace)
	case "name":
		return cmp.Or(cmp.Compare(a.Kind, b.Kind), cmp.Compare(a.Name, b.Name))
	case "":
		return cmp.Or(
			cmp.Compare(policyReportResultRank[a.Result], policyReportResultRank[b.Result]),
			cmp.Compare(a.Namespace, b.Namespace), cmp.Compare(a.Kind, b.Kind), cmp.Compare(a.Name, b.Name),
			cmp.Compare(a.Policy, b.Policy), cmp.Compare(a.Source, b.Source), cmp.Compare(a.Rule, b.Rule),
			cmp.Compare(a.Report, b.Report), cmp.Compare(a.Message, b.Message),
		)
	}
	return 0
}

var policyReportWorkloadKinds = map[string]bool{"Deployment": true, "StatefulSet": true, "DaemonSet": true, "ReplicaSet": true, "Job": true, "CronJob": true}

// PolicyReportsForResource returns the rows about one resource; for a workload
// the rows of its running pods come along (the pod template is what most
// policies look at), each row naming the pod. With the resource's apiVersion, a
// resource and a pod owner of another group with the same Kind and name are left
// out; a result naming no apiVersion still counts. A ClusterPolicyReport may name the resource too: those rows come from
// the one read of the cluster reports a minute, and what stops that read is said beside the namespace's rows.
func (s *Service) PolicyReportsForResource(ctx context.Context, namespace, kind, name, apiVersion string, force bool) (*PolicyReportResource, error) {
	set, _, err := s.policyReportSet(ctx, namespace, force)
	if err != nil {
		return nil, err
	}
	clusterRows, clusterReportsError := s.clusterReportsNaming(ctx, namespace, force)
	results := append(set.results[:len(set.results):len(set.results)], clusterRows.results...)
	pods := map[string]bool{}
	picking := policyReportSet{results: results}.picksByLabel()
	var targets []policyReportTarget
	if policyReportWorkloadKinds[kind] {
		cs := s.clientsetCtx(ctx)
		if cs == nil {
			return nil, errNotLoaded
		}
		owner, err := s.workloadOwner(ctx, namespace)
		if err != nil {
			return nil, err
		}
		// a page at a time, keeping the workload's pod names (the whole namespace in one list took k8s-service past 512 Mi)
		err = eachPod(ctx, cs.CoreV1(), namespace, metav1.ListOptions{}, func(p *corev1.Pod) {
			if k, n, v := owner(*p); k == kind && n == name && sameAPIGroup(apiVersion, v) {
				pods[p.Name] = true
				if picking {
					targets = append(targets, policyReportTarget{policyReportRef{namespace, "Pod", p.Name, "v1"}, p.Labels})
				}
			}
		})
		if err != nil {
			return nil, fmt.Errorf("list pods: %w", err)
		}
	}
	out := &PolicyReportResource{GeneratedAt: set.at.UTC().Format(time.RFC3339), Kind: kind, Name: name, Namespace: namespace, ClusterReportsError: clusterReportsError}
	if picking {
		target, err := s.policyReportObject(ctx, namespace, kind, name, apiVersion)
		if err != nil {
			out.SelectorError = err.Error()
		} else {
			targets = append(targets, target)
		}
	}
	out.keep(results, func(ref policyReportRef) bool {
		return ref.Namespace == namespace && ((ref.Kind == kind && ref.Name == name && sameAPIGroup(apiVersion, ref.APIVersion)) || (ref.Kind == "Pod" && pods[ref.Name]))
	}, targets...)
	return out, nil
}

// clusterReportsNaming are the rows the ClusterPolicyReports hold about objects of namespace and, when something stopped
// that read or cut it, why they may not be all. A cluster serving no such kind has none and nothing to say.
func (s *Service) clusterReportsNaming(ctx context.Context, namespace string, force bool) (policyReportSet, string) {
	clusterSet, err := s.clusterPolicyReportSet(ctx, force)
	switch {
	case err == nil:
		named := policyReportSet{truncated: clusterSet.truncated, results: clusterSet.resultsNaming(namespace)}
		if clusterSet.truncated {
			return named, fmt.Sprintf("the cluster holds more than one read takes (%d reports, %d results), so the rest were not read", policyReportMaxReports, policyReportMaxResults)
		}
		return named, ""
	case apierrors.IsNotFound(err):
		return policyReportSet{}, ""
	}
	return policyReportSet{}, err.Error()
}

// policyReportView is what the page and the AI tool count. For one namespace that is its reports and what the cluster
// reports hold about its objects, each such row named after the object of that namespace, so the numbers are its drawers'.
// The view of the whole cluster has the cluster reports already, or says why not.
func (s *Service) policyReportView(ctx context.Context, namespace string, force bool) (policyReportSet, bool, error) {
	set, scoped, err := s.policyReportSet(ctx, namespace, force)
	if err != nil {
		return set, scoped, err
	}
	if namespace == "" && !scoped {
		return set, scoped, nil
	}
	clusterRows, clusterError := s.clusterReportsNaming(ctx, namespace, force)
	set.clusterError = clusterError
	if namespace == "" {
		return set, scoped, nil
	}
	reports := map[string]bool{}
	results := set.results[:len(set.results):len(set.results)]
	for _, row := range clusterRows.results {
		reports[row.Report] = true
		if row.Namespace != namespace {
			for _, other := range row.also {
				if other.Namespace == namespace {
					row.Namespace, row.Kind, row.Name, row.APIVersion = other.Namespace, other.Kind, other.Name, other.APIVersion
					break
				}
			}
		}
		results = append(results, row)
	}
	set.results = results
	set.reports += len(reports)
	set.truncated = set.truncated || clusterRows.truncated
	return set, scoped, nil
}

// resultsNaming are the results about an object of namespace, by the resource a row names or a later one of its result.
// A cluster report's label selector, naming no namespace, stays with the cluster-scoped objects.
func (set policyReportSet) resultsNaming(namespace string) []PolicyReportResult {
	var out []PolicyReportResult
	for i := range set.results {
		r := &set.results[i]
		if r.Namespace == namespace || slices.ContainsFunc(r.also, func(ref policyReportRef) bool { return ref.Namespace == namespace }) {
			out = append(out, *r)
		}
	}
	return out
}

// picksByLabel says whether any result picks its resources by label, the only reason to read the object's labels.
func (set policyReportSet) picksByLabel() bool {
	for i := range set.results {
		if set.results[i].picks != nil {
			return true
		}
	}
	return false
}

// policyReportTarget is a resource with its labels, held against the results that pick by label.
type policyReportTarget struct {
	ref    policyReportRef
	labels map[string]string
}

// policyReportObject reads the object as the caller for its labels: a caller the cluster refuses learns nothing of them.
func (s *Service) policyReportObject(ctx context.Context, namespace, kind, name, apiVersion string) (policyReportTarget, error) {
	resource := kind
	if group := apiGroup(apiVersion); group != "" {
		resource = kind + "." + group
	}
	gvr, namespaced, err := s.ResolveResource(ctx, resource)
	if err != nil {
		return policyReportTarget{}, err
	}
	ns := namespace
	if !namespaced {
		ns = ""
	}
	obj, err := s.GetResource(ctx, gvr, ns, name)
	if err != nil {
		return policyReportTarget{}, err
	}
	return policyReportTarget{policyReportRef{namespace, kind, name, apiVersion}, obj.GetLabels()}, nil
}

// sameAPIGroup: whether a reference's apiVersion is of the asked one's group — any when either is not given.
func sameAPIGroup(asked, ref string) bool {
	return asked == "" || ref == "" || apiGroup(asked) == apiGroup(ref)
}

// PolicyReportsForClusterResource returns the rows about one cluster-scoped
// resource (a Namespace, a Node, a ClusterRole, …) from the
// ClusterPolicyReports, read as the caller and kept a minute like the others;
// the apiVersion, when given, as PolicyReportsForResource takes it.
func (s *Service) PolicyReportsForClusterResource(ctx context.Context, kind, name, apiVersion string, force bool) (*PolicyReportResource, error) {
	set, err := s.clusterPolicyReportSet(ctx, force)
	if err != nil {
		return nil, err
	}
	out := &PolicyReportResource{GeneratedAt: set.at.UTC().Format(time.RFC3339), Kind: kind, Name: name}
	var targets []policyReportTarget
	if set.picksByLabel() {
		target, err := s.policyReportObject(ctx, "", kind, name, apiVersion)
		if err != nil {
			out.SelectorError = err.Error()
		} else {
			targets = append(targets, target)
		}
	}
	out.keep(set.results, func(ref policyReportRef) bool {
		return ref.Namespace == "" && ref.Kind == kind && ref.Name == name && sameAPIGroup(apiVersion, ref.APIVersion)
	}, targets...)
	return out, nil
}

// clusterPolicyReportSet reads (or serves from the minute cache, unless force) the ClusterPolicyReports as the caller.
func (s *Service) clusterPolicyReportSet(ctx context.Context, force bool) (policyReportSet, error) {
	if len(scopeFromCtx(ctx)) > 0 {
		// as the summary, which leaves the cluster reports out of a grant limited to namespaces
		return policyReportSet{}, apierrors.NewForbidden(schema.GroupResource{Group: clusterPolicyReportGVR.Group, Resource: clusterPolicyReportGVR.Resource}, "", fmt.Errorf("cluster reports are outside a grant limited to namespaces"))
	}
	// "*" starts no namespace name, so the cluster reports keep a cache entry of their own
	return s.cachedPolicyReports(ctx, "*cluster", force, func() (policyReportSet, error) {
		set := policyReportSet{at: time.Now(), results: []PolicyReportResult{}}
		return set, s.readPolicyReportKind(ctx, clusterPolicyReportGVR, "", &set)
	})
}

// policyReportRef is a resource a result names.
type policyReportRef struct{ Namespace, Kind, Name, APIVersion string }

// keep takes the rows about the resource match picks — a result naming several
// resources counts for each, its row named after the one that matched — and, for
// a result that picks by label, one row per target in its namespace whose labels
// match, named after it; worst result first, then by policy and resource name.
func (out *PolicyReportResource) keep(results []PolicyReportResult, match func(policyReportRef) bool, targets ...policyReportTarget) {
	out.Rows = []PolicyReportResult{}
	for _, r := range results {
		if r.picks != nil {
			for _, t := range targets {
				if t.ref.Namespace == r.Namespace && r.picks.Matches(labels.Set(t.labels)) {
					row := r
					row.Namespace, row.Kind, row.Name, row.APIVersion, row.picks = t.ref.Namespace, t.ref.Kind, t.ref.Name, t.ref.APIVersion, nil
					out.Rows = append(out.Rows, row)
					out.Totals.add(row.Result)
				}
			}
			continue
		}
		ref := policyReportRef{r.Namespace, r.Kind, r.Name, r.APIVersion}
		ok := match(ref)
		for _, other := range r.also {
			if ok {
				break
			}
			ref, ok = other, match(other)
		}
		if !ok {
			continue
		}
		r.Namespace, r.Kind, r.Name, r.APIVersion, r.also = ref.Namespace, ref.Kind, ref.Name, ref.APIVersion, nil
		out.Rows = append(out.Rows, r)
		out.Totals.add(r.Result)
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
	set, err := s.cachedPolicyReports(ctx, namespace, force, func() (policyReportSet, error) {
		return s.readPolicyReports(ctx, namespace, scope)
	})
	return set, scoped, err
}

// cachedPolicyReports serves one read (a namespace, "" for the whole view) from
// the minute cache of the cluster and the caller's identity, unless force; else
// it reads and keeps the answer.
func (s *Service) cachedPolicyReports(ctx context.Context, what string, force bool, read func() (policyReportSet, error)) (policyReportSet, error) {
	cluster := string(ctxClusterID(ctx))
	identity := ""
	if p, ok := auth.FromContext(ctx); ok {
		identity = p.CacheIdentity(cluster)
	}
	key := what + "|as:" + identity
	c := policyReportCacheFor(cluster)
	if !force {
		c.mu.Lock()
		if set, ok := c.sets[key]; ok && time.Since(set.at) < policyReportCacheTTL {
			c.mu.Unlock()
			return set, nil
		}
		c.mu.Unlock()
	}

	set, err := read()
	if err != nil {
		return policyReportSet{}, err
	}
	c.mu.Lock()
	c.sets[key] = set
	c.mu.Unlock()
	return set, nil
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
		err := s.readPolicyReportKind(ctx, clusterPolicyReportGVR, "", &set)
		switch {
		case apierrors.IsForbidden(err):
			set.clusterError = err.Error()
		case err != nil && !apierrors.IsNotFound(err):
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

// policyReportSelector parses a report's label selector field; one the API could not have written counts as none.
func policyReportSelector(raw interface{}) (labels.Selector, string) {
	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil, ""
	}
	var ls metav1.LabelSelector
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(m, &ls); err != nil {
		return nil, ""
	}
	sel, err := metav1.LabelSelectorAsSelector(&ls)
	if err != nil {
		return nil, ""
	}
	return sel, metav1.FormatLabelSelector(&ls)
}

// policyReportRows flattens one report. The resource a row is about comes from
// the result's own resources list, else what its resourceSelector picks, else
// the report's scope, else what the report's scopeSelector picks.
func policyReportRows(obj *unstructured.Unstructured) []PolicyReportResult {
	scopeAPIVersion, _, _ := unstructured.NestedString(obj.Object, "scope", "apiVersion")
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
			Namespace: scopeNS, Kind: scopeKind, Name: scopeName, APIVersion: scopeAPIVersion,
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
					row.Kind, row.APIVersion = k, str(first["apiVersion"])
				}
				if n := str(first["name"]); n != "" {
					row.Name = n
				}
				if n := str(first["namespace"]); n != "" {
					row.Namespace = n
				}
			}
		} else if sel, text := policyReportSelector(m["resourceSelector"]); sel != nil {
			row.Kind, row.Name, row.APIVersion, row.picks, row.Selector = "", "", "", sel, text
		} else if scopeKind == "" && scopeName == "" {
			row.picks, row.Selector = policyReportSelector(obj.Object["scopeSelector"])
		}
		row.also = policyReportOthers(m["resources"], scopeNS)
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

// policyReportOthers lists the resources a result names after the first (which
// its row names), each in the report's namespace unless it names its own.
func policyReportOthers(raw interface{}, namespace string) []policyReportRef {
	res, _ := raw.([]interface{})
	var out []policyReportRef
	for i := 1; i < len(res); i++ {
		m, _ := res[i].(map[string]interface{})
		ref := policyReportRef{Namespace: str(m["namespace"]), Kind: str(m["kind"]), Name: str(m["name"]), APIVersion: str(m["apiVersion"])}
		if ref.Kind == "" || ref.Name == "" {
			continue
		}
		if ref.Namespace == "" {
			ref.Namespace = namespace
		}
		out = append(out, ref)
	}
	return out
}

func str(v interface{}) string {
	s, _ := v.(string)
	return s
}
