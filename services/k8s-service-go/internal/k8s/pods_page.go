package k8s

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"slices"
	"strconv"
	"strings"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	typedcorev1 "k8s.io/client-go/kubernetes/typed/core/v1"
	"k8s.io/client-go/tools/cache"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// The Pods list asks for one page: the server filters, sorts and counts the
// pod rows (pod_index.go) and sends the page, the number that matched and the
// counts of the namespace chosen, so the page no longer holds every pod of a
// large cluster. The rows come from the pod informer, watched as
// kubeast:cache, after the caller's own identity is asked whether it may list
// those pods; until the informer has synced, or when it cannot run, they come
// from listing the cluster as the caller, 500 pods at a time.

const (
	PodPageMaxLimit = 500
	podPageSyncWait = 5 * time.Second
	podListChunk    = 500
	podAccessTTL    = 60 * time.Second
)

// PodSortKeys are the columns the Pods list sorts by.
var PodSortKeys = []string{"name", "ready", "status", "restarts", "pod_ip", "node_name", "age", "health"}

// PodHealthNames are the health filter's values: the Cluster View card colours.
var PodHealthNames = []string{"ok", "warn", "error"}

type PodPageQuery struct {
	Namespace string // "" = every namespace the caller may list
	Search    string // in name, namespace, node or pod IP
	Sort      string // one of PodSortKeys; "" = the API's order (namespace/name)
	Desc      bool
	Offset    int
	Limit     int
	Revision  string // the revision the caller's page is from
	// OwnerKind and OwnerName keep one owner's pods (the Resource Graph's pod group list); the summary
	// counts them only
	OwnerKind, OwnerName string
	Health               string // one of PodHealthNames: the rows of that card colour, counted before it
	// the Dashboard pod window and the drawers' pod lists, counted before them like the search
	Phase, RuntimeClass, PriorityClass string
	ServiceAccounts                    []string // <namespace>/<name>; a pod running as any of them
}

type PodListItem struct {
	Name              string `json:"name"`
	Namespace         string `json:"namespace"`
	Status            string `json:"status"` // the Status column (podListStatus)
	Phase             string `json:"phase"`
	Ready             string `json:"ready"`
	RestartCount      int32  `json:"restart_count"`
	NodeName          string `json:"node_name"`
	PodIP             string `json:"pod_ip"`
	CreatedAt         string `json:"created_at"`
	DeletionTimestamp string `json:"deletion_timestamp,omitempty"`
	ServiceAccount    string `json:"service_account_name,omitempty"`
}

type PodReasonCount struct {
	Reason string `json:"reason"`
	Count  int    `json:"count"`
}

// PodStats are the Pods list's summary cards, over the namespace chosen
// (the search does not change them).
type PodStats struct {
	Total      int              `json:"total"`
	Ready      int              `json:"ready"`
	NotReady   int              `json:"not_ready"`
	Pending    int              `json:"pending"`
	Error      int              `json:"error"`
	Restarted  int              `json:"restarted"`
	Completed  int              `json:"completed"`
	TopReasons []PodReasonCount `json:"top_reasons"`
	Health     PodHealthCounts  `json:"health"`
}

// PodHealthCounts counts the rows by the Cluster View card colour (podHealth).
type PodHealthCounts struct {
	OK    int `json:"ok"`
	Warn  int `json:"warn"`
	Error int `json:"error"`
}

type PodPage struct {
	Items []PodListItem `json:"items"`
	Total int           `json:"total"` // rows the search matched
	Stats PodStats      `json:"stats"`
	// Revision changes when a row the caller may see could show something new;
	// "" when the rows were listed (no informer to say).
	Revision  string `json:"revision"`
	Unchanged bool   `json:"unchanged,omitempty"` // the caller's Revision is current: nothing else is sent
	Source    string `json:"source"`              // "index" or "list"
}

var errPodsForbidden = apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "",
	errors.New("your identity in this cluster may not list pods in every namespace"))

// GetPodPage returns one page of the Pods list.
func (s *Service) GetPodPage(ctx context.Context, q PodPageQuery) (*PodPage, error) {
	set, err := s.callerPodRows(ctx, q.Namespace, q.Revision)
	if err != nil {
		return nil, err
	}
	if set.unchanged {
		return &PodPage{Items: []PodListItem{}, Stats: PodStats{TopReasons: []PodReasonCount{}}, Revision: set.revision, Unchanged: true, Source: set.source}, nil
	}
	page := buildPodPage(rowsOfOwner(set.rows, q.OwnerKind, q.OwnerName), q, time.Now())
	page.Revision, page.Source = set.revision, set.source
	return page, nil
}

// rowsOfOwner keeps one owner's rows; no kind keeps them all.
func rowsOfOwner(rows []*podRow, kind, name string) []*podRow {
	if kind == "" {
		return rows
	}
	out := make([]*podRow, 0)
	for _, r := range rows {
		if r.ownerKind == kind && r.ownerName == name {
			out = append(out, r)
		}
	}
	return out
}

// podRowSet is the rows a caller may see for one namespace choice.
type podRowSet struct {
	rows      []*podRow
	revision  string // "" when the rows were listed
	unchanged bool   // the caller's revision is current: no rows
	source    string // "index" or "list"
}

// callerPodRows returns the pod rows the caller may see in namespace ("" =
// every namespace it may see): from the informer after podListAccess, or
// listed as the caller until the informer can serve. A revision equal to the
// current one returns unchanged and no rows.
func (s *Service) callerPodRows(ctx context.Context, namespace, revision string) (*podRowSet, error) {
	b := s.bundleForCtx(ctx)
	if b == nil {
		return nil, errNotLoaded
	}
	if ci := b.overviewInformers(); ci != nil && ci.waitSynced(ctx, podPageSyncWait) {
		all, namespaces, err := s.podListAccess(ctx, b, namespace)
		if err != nil {
			return nil, err
		}
		rev := ci.podRevision() + "." + accessPrint(all, namespaces)
		if revision != "" && revision == rev {
			return &podRowSet{revision: rev, unchanged: true, source: "index"}, nil
		}
		accesstrail.Cached(ctx, "pod rows (watched as "+overviewCacheUser+")")
		return &podRowSet{rows: ci.podRows(all, namespaces), revision: rev, source: "index"}, nil
	}
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, errNotLoaded
	}
	namespaces, err := callerNamespaces(ctx, namespace)
	if err != nil {
		return nil, err
	}
	rows, err := listPodRows(ctx, cs.CoreV1(), namespaces)
	if err != nil {
		return nil, err
	}
	return &podRowSet{rows: rows, source: "list"}, nil
}

// callerNamespaces is what a list as the caller covers: the namespace chosen
// (inside a namespace-scoped grant), else the grant's namespaces, else nil
// (every namespace).
func callerNamespaces(ctx context.Context, namespace string) ([]string, error) {
	scope := scopeFromCtx(ctx)
	if namespace == "" {
		return scope, nil
	}
	if len(scope) > 0 && !slices.Contains(scope, namespace) {
		return nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "",
			fmt.Errorf("namespace %q is outside your grant on this cluster", namespace))
	}
	return []string{namespace}, nil
}

// podRevision names the pod rows' state: it changes when a row shows
// something new, and with every new informer set.
func (ci *clusterInformers) podRevision() string {
	return ci.epoch + "-" + strconv.FormatUint(ci.podRev.Load(), 36)
}

// podRows returns the rows of every namespace (all) or of the listed ones.
func (ci *clusterInformers) podRows(all bool, namespaces []string) []*podRow {
	ci.touch()
	var objs []interface{}
	if all {
		objs = ci.pods.List()
	} else {
		for _, ns := range namespaces {
			got, _ := ci.pods.ByIndex(cache.NamespaceIndex, ns)
			objs = append(objs, got...)
		}
	}
	rows := make([]*podRow, 0, len(objs))
	for _, o := range objs {
		if r, ok := o.(*podRow); ok {
			rows = append(rows, r)
		}
	}
	return rows
}

// podListAccess decides which pods the caller may be shown from the informer,
// asking the cluster as the caller (SelfSubjectAccessReview "list pods",
// remembered podAccessTTL): every namespace (all) for a cluster-wide grant,
// else the namespaces it may list. A namespace-scoped grant is asked per
// namespace of its scope, as its lists are made; one the cluster refuses is
// left out, as listAcrossNamespaces skips it, and only when every one is
// refused is the answer a refusal.
func (s *Service) podListAccess(ctx context.Context, b *clientBundle, namespace string) (bool, []string, error) {
	scope := scopeFromCtx(ctx)
	if len(scope) == 0 {
		ok, err := s.mayListPods(ctx, b, "")
		if err != nil {
			return false, nil, err
		}
		if ok && namespace == "" {
			return true, nil, nil
		}
		if ok {
			return false, []string{namespace}, nil
		}
		if namespace == "" {
			return false, nil, errPodsForbidden
		}
		scope = []string{namespace}
	} else if namespace != "" {
		if !slices.Contains(scope, namespace) {
			return false, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "",
				fmt.Errorf("namespace %q is outside your grant on this cluster", namespace))
		}
		scope = []string{namespace}
	}
	allowed := make([]string, 0, len(scope))
	for _, ns := range scope {
		ok, err := s.mayListPods(ctx, b, ns)
		if err != nil {
			return false, nil, err
		}
		if ok {
			allowed = append(allowed, ns)
		}
	}
	if len(allowed) == 0 {
		return false, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "",
			errors.New("your identity in this cluster may not list pods in these namespaces"))
	}
	return false, allowed, nil
}

// mayListPods asks whether the caller may list pods in namespace ("" = every
// namespace), from the cache or by a SelfSubjectAccessReview.
func (s *Service) mayListPods(ctx context.Context, b *clientBundle, namespace string) (bool, error) {
	if b.authz == nil {
		return true, nil
	}
	key := s.clusterCacheKey(ctx, "pods_list_allowed:"+namespace)
	var allowed bool
	if s.cache != nil && s.cache.Get(ctx, key, &allowed) {
		return allowed, nil
	}
	review, err := b.authz.SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{
			Verb: "list", Resource: "pods", Namespace: namespace,
		}},
	}, metav1.CreateOptions{})
	if err != nil {
		return false, err
	}
	allowed = review.Status.Allowed
	if s.cache != nil {
		s.cache.Set(ctx, key, allowed, podAccessTTL)
	}
	return allowed, nil
}

// accessPrint is part of the revision, so a page is sent again when the
// namespaces the caller may see change.
func accessPrint(all bool, namespaces []string) string {
	if all {
		return "all"
	}
	h := fnv.New32a()
	for _, ns := range namespaces {
		h.Write([]byte(ns))
		h.Write([]byte{0})
	}
	return strconv.FormatUint(uint64(h.Sum32()), 36)
}

// listPodRows lists pods as the caller, podListChunk at a time, keeping only
// the rows: every namespace for nil namespaces, else each listed one, where a
// namespace the cluster refuses or does not have is skipped unless every one
// is (listAcrossNamespaces).
func listPodRows(ctx context.Context, pods typedcorev1.PodsGetter, namespaces []string) ([]*podRow, error) {
	in := newInterner()
	list := func(ns string) ([]*podRow, error) {
		var rows []*podRow
		opts := metav1.ListOptions{Limit: podListChunk}
		for {
			l, err := pods.Pods(ns).List(ctx, opts)
			if err != nil {
				return nil, fmt.Errorf("list pods: %w", err)
			}
			for i := range l.Items {
				rows = append(rows, toPodRow(&l.Items[i], in))
			}
			if l.Continue == "" {
				return rows, nil
			}
			opts.Continue = l.Continue
		}
	}
	if len(namespaces) == 0 {
		return list("")
	}
	return fanOutNamespaces(namespaces, list)
}

// buildPodPage counts, filters, sorts and cuts the rows.
func buildPodPage(rows []*podRow, q PodPageQuery, now time.Time) *PodPage {
	page := &PodPage{Stats: podStats(rows), Items: []PodListItem{}}
	matched := rows
	if needle := strings.ToLower(strings.TrimSpace(q.Search)); needle != "" {
		matched = make([]*podRow, 0, len(rows))
		for _, r := range rows {
			// names, namespaces and nodes are lower-case DNS names
			if strings.Contains(r.name, needle) || strings.Contains(r.namespace, needle) ||
				strings.Contains(r.node, needle) || strings.Contains(strings.ToLower(r.podIP), needle) {
				matched = append(matched, r)
			}
		}
	} else {
		matched = slices.Clone(rows)
	}
	if h := slices.Index(PodHealthNames, q.Health); h >= 0 {
		matched = slices.DeleteFunc(matched, func(r *podRow) bool { return int(r.health) != h })
	}
	if q.Phase != "" {
		matched = slices.DeleteFunc(matched, func(r *podRow) bool { return r.phase != q.Phase })
	}
	if q.RuntimeClass != "" {
		matched = slices.DeleteFunc(matched, func(r *podRow) bool { return r.runtimeClass != q.RuntimeClass })
	}
	if q.PriorityClass != "" {
		matched = slices.DeleteFunc(matched, func(r *podRow) bool { return r.priorityClass != q.PriorityClass })
	}
	if len(q.ServiceAccounts) > 0 {
		matched = slices.DeleteFunc(matched, func(r *podRow) bool {
			return r.serviceAccount == "" || !slices.Contains(q.ServiceAccounts, r.namespace+"/"+r.serviceAccount)
		})
	}
	sortPodRows(matched, q.Sort, q.Desc, now)
	page.Total = len(matched)
	limit := q.Limit
	if limit <= 0 || limit > PodPageMaxLimit {
		limit = PodPageMaxLimit
	}
	start := min(max(q.Offset, 0), len(matched))
	end := min(start+limit, len(matched))
	for _, r := range matched[start:end] {
		page.Items = append(page.Items, r.item())
	}
	return page
}

func (r *podRow) item() PodListItem {
	it := PodListItem{
		Name: r.name, Namespace: r.namespace, Status: r.status, Phase: r.phase,
		Ready:        strconv.Itoa(int(r.ready)) + "/" + strconv.Itoa(int(r.containers)),
		RestartCount: r.restarts, NodeName: r.node, PodIP: r.podIP, ServiceAccount: r.serviceAccount,
	}
	if r.created != 0 {
		it.CreatedAt = time.Unix(r.created, 0).UTC().Format(time.RFC3339)
	}
	if r.deleted != 0 {
		it.DeletionTimestamp = time.Unix(r.deleted, 0).UTC().Format(time.RFC3339)
	}
	return it
}

// podStats counts the summary cards as the page did: Ready = Running with
// every container ready, Not Ready = the other Running ones, Error = Failed or
// a status that names an error, the four most common statuses (ties in the
// API's order).
func podStats(rows []*podRow) PodStats {
	st := PodStats{Total: len(rows), TopReasons: []PodReasonCount{}}
	type reason struct {
		count int
		first *podRow
	}
	reasons := map[string]*reason{}
	for _, r := range rows {
		phase := r.phase
		if phase == "" {
			phase = r.status
		}
		switch phase {
		case string(corev1.PodPending):
			st.Pending++
		case string(corev1.PodSucceeded):
			st.Completed++
		case string(corev1.PodRunning):
			if r.containers > 0 && r.ready == r.containers {
				st.Ready++
			} else {
				st.NotReady++
			}
		}
		if r.restarts > 0 {
			st.Restarted++
		}
		switch r.health {
		case podHealthOK:
			st.Health.OK++
		case podHealthWarn:
			st.Health.Warn++
		default:
			st.Health.Error++
		}
		if phase == string(corev1.PodFailed) || statusNamesError(r.status) {
			st.Error++
		}
		if c := reasons[r.status]; c != nil {
			c.count++
			if apiOrder(r, c.first) < 0 {
				c.first = r
			}
		} else {
			reasons[r.status] = &reason{count: 1, first: r}
		}
	}
	names := make([]string, 0, len(reasons))
	for n := range reasons {
		names = append(names, n)
	}
	slices.SortFunc(names, func(a, b string) int {
		if d := reasons[b].count - reasons[a].count; d != 0 {
			return d
		}
		return apiOrder(reasons[a].first, reasons[b].first)
	})
	for _, n := range names[:min(4, len(names))] {
		st.TopReasons = append(st.TopReasons, PodReasonCount{Reason: n, Count: reasons[n].count})
	}
	return st
}

func statusNamesError(status string) bool {
	s := strings.ToLower(status)
	for _, w := range []string{"error", "failed", "backoff", "errimagepull", "oomkilled"} {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

// sortPodRows sorts by the column, ties and no column in the API's order.
// Strings compare letters without case first, as the page's localeCompare did
// for these ASCII values.
func sortPodRows(rows []*podRow, key string, desc bool, now time.Time) {
	dir := 1
	if desc {
		dir = -1
	}
	age := func(r *podRow) int64 {
		if r.created == 0 {
			return 0
		}
		return max(0, now.Unix()-r.created)
	}
	ratio := func(r *podRow) float64 {
		if r.containers == 0 {
			return 0
		}
		return float64(r.ready) / float64(r.containers)
	}
	slices.SortFunc(rows, func(a, b *podRow) int {
		c := 0
		switch key {
		case "name":
			c = foldCompare(a.name, b.name)
		case "ready":
			c = compareOrdered(ratio(a), ratio(b))
		case "status":
			c = foldCompare(a.status, b.status)
		case "restarts":
			c = compareOrdered(a.restarts, b.restarts)
		case "pod_ip":
			c = foldCompare(a.podIP, b.podIP)
		case "node_name":
			c = foldCompare(a.node, b.node)
		case "age":
			c = compareOrdered(age(a), age(b))
		case "health":
			// errors first, then warnings
			c = compareOrdered(int32(b.health), int32(a.health))
		}
		if c != 0 {
			return c * dir
		}
		return apiOrder(a, b)
	})
}

func compareOrdered[T int32 | int64 | float64](a, b T) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// apiOrder is the order the API lists pods in: by the store key
// "namespace/name", byte by byte.
func apiOrder(a, b *podRow) int {
	if a.namespace == b.namespace {
		return strings.Compare(a.name, b.name)
	}
	na, nb := a.namespace, b.namespace
	switch {
	case strings.HasPrefix(nb, na): // "a/…" against "a-b/…": '/' against '-'
		return compareOrdered(int32('/'), int32(nb[len(na)]))
	case strings.HasPrefix(na, nb):
		return compareOrdered(int32(na[len(nb)]), int32('/'))
	}
	return strings.Compare(na, nb)
}

// foldCompare compares ASCII letters without case, then exactly.
func foldCompare(a, b string) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		ca, cb := lowerASCII(a[i]), lowerASCII(b[i])
		if ca != cb {
			return compareOrdered(int32(ca), int32(cb))
		}
	}
	if len(a) != len(b) {
		return compareOrdered(int32(len(a)), int32(len(b)))
	}
	return strings.Compare(a, b)
}

func lowerASCII(c byte) byte {
	if 'A' <= c && c <= 'Z' {
		return c + 'a' - 'A'
	}
	return c
}
