package k8s

import (
	"context"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// rolloutKinds are the apps kinds the Timeline's rollouts read.
var rolloutKinds = []string{"deployments", "replicasets", "controllerrevisions"}

// rolloutCluster answers as an API server does, by the identity a request goes as: access reviews, the rollout kinds
// of its objects in pages of the asked limit, and empty lists of events. It notes every page of those kinds by who
// asked it.
type rolloutCluster struct {
	// may says whether user may list resource in namespace ("" = across the cluster); list decides a real list when
	// set, as an authorizer that reads more than a review asks may decide otherwise
	may  func(user, resource, namespace string) bool
	list func(user, resource, namespace string) bool
	// cacheRefused refuses those kinds to kubeast:cache; reviewFails answers every review 500; hold holds kubeast:cache's
	// first pages of the rollout kinds until closed
	cacheRefused map[string]bool
	reviewFails  bool
	hold         chan struct{}
	released     sync.Once

	deploys []appsv1.Deployment
	sets    []appsv1.ReplicaSet
	revs    []appsv1.ControllerRevision

	mu         sync.Mutex
	pages      map[string]map[string]int // user → kind → pages
	firstPages map[string]map[string]int // user → kind → first pages, one a read
	reviews    int
}

func (a *rolloutCluster) release() {
	a.released.Do(func() {
		if a.hold != nil {
			close(a.hold)
		}
	})
}

// count is the pages and the reads of resource asked as user.
func (a *rolloutCluster) count(user, resource string) (pages, reads int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.pages[user][resource], a.firstPages[user][resource]
}

func (a *rolloutCluster) reviewsSeen() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.reviews
}

// pagesByCallers is the pages of the rollout kinds asked as anyone but kubeast:cache.
func (a *rolloutCluster) pagesByCallers() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for user, kinds := range a.pages {
		if user != overviewCacheUser {
			for _, c := range kinds {
				n += c
			}
		}
	}
	return n
}

func (a *rolloutCluster) serve(w http.ResponseWriter, r *http.Request) {
	user := r.Header.Get(auth.HeaderImpersonateUser)
	if r.Method == http.MethodPost && r.URL.Path == "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" {
		body, _ := io.ReadAll(r.Body)
		review := &authorizationv1.SelfSubjectAccessReview{}
		if _, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, review); err != nil || review.Spec.ResourceAttributes == nil {
			http.Error(w, "unreadable review", http.StatusBadRequest)
			return
		}
		ra := *review.Spec.ResourceAttributes
		a.mu.Lock()
		a.reviews++
		a.mu.Unlock()
		if a.reviewFails {
			writeStatus(w, http.StatusInternalServerError, "InternalError", "the review could not be answered")
			return
		}
		review.APIVersion, review.Kind = "authorization.k8s.io/v1", "SelfSubjectAccessReview"
		review.Status.Allowed = ra.Verb == "list" && a.may(user, ra.Resource, ra.Namespace)
		writeJSON(w, review)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/events") {
		writeJSON(w, &corev1.EventList{TypeMeta: metav1.TypeMeta{Kind: "EventList", APIVersion: "v1"}, ListMeta: metav1.ListMeta{ResourceVersion: "9"}})
		return
	}
	rest, ok := strings.CutPrefix(r.URL.Path, "/apis/apps/v1/")
	if !ok {
		http.NotFound(w, r)
		return
	}
	namespace, resource := "", rest
	if ns, kind, found := strings.Cut(strings.TrimPrefix(rest, "namespaces/"), "/"); found && strings.HasPrefix(rest, "namespaces/") {
		namespace, resource = ns, kind
	}
	q := r.URL.Query()
	first := q.Get("continue") == ""
	a.mu.Lock()
	if a.pages == nil {
		a.pages, a.firstPages = map[string]map[string]int{}, map[string]map[string]int{}
	}
	if a.pages[user] == nil {
		a.pages[user], a.firstPages[user] = map[string]int{}, map[string]int{}
	}
	a.pages[user][resource]++
	if first {
		a.firstPages[user][resource]++
	}
	a.mu.Unlock()
	if user == overviewCacheUser && first && a.hold != nil {
		select {
		case <-a.hold:
		case <-r.Context().Done():
			return
		}
	}
	allowed := !a.cacheRefused[resource]
	if user != overviewCacheUser {
		decide := a.may
		if a.list != nil {
			decide = a.list
		}
		allowed = decide(user, resource, namespace)
	}
	if !allowed {
		where := "at the cluster scope"
		if namespace != "" {
			where = fmt.Sprintf("in the namespace %q", namespace)
		}
		writeStatus(w, http.StatusForbidden, "Forbidden", fmt.Sprintf("%s.apps is forbidden: User %q cannot list resource %q in API group \"apps\" %s", resource, user, resource, where))
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	from, _ := strconv.Atoi(q.Get("continue"))
	cut := func(n int) (int, metav1.ListMeta) {
		to, meta := n, metav1.ListMeta{ResourceVersion: "9"}
		if limit > 0 && from+limit < n {
			to = from + limit
			meta.Continue = strconv.Itoa(to)
		}
		return to, meta
	}
	in := func(ns string) bool { return namespace == "" || ns == namespace }
	switch resource {
	case "deployments":
		var items []appsv1.Deployment
		for _, d := range a.deploys {
			if in(d.Namespace) {
				items = append(items, d)
			}
		}
		to, meta := cut(len(items))
		writeJSON(w, &appsv1.DeploymentList{TypeMeta: metav1.TypeMeta{Kind: "DeploymentList", APIVersion: "apps/v1"}, ListMeta: meta, Items: items[from:to]})
	case "replicasets":
		var items []appsv1.ReplicaSet
		for _, rs := range a.sets {
			if in(rs.Namespace) {
				items = append(items, rs)
			}
		}
		to, meta := cut(len(items))
		writeJSON(w, &appsv1.ReplicaSetList{TypeMeta: metav1.TypeMeta{Kind: "ReplicaSetList", APIVersion: "apps/v1"}, ListMeta: meta, Items: items[from:to]})
	case "controllerrevisions":
		var items []appsv1.ControllerRevision
		for _, cr := range a.revs {
			if in(cr.Namespace) {
				items = append(items, cr)
			}
		}
		to, meta := cut(len(items))
		writeJSON(w, &appsv1.ControllerRevisionList{TypeMeta: metav1.TypeMeta{Kind: "ControllerRevisionList", APIVersion: "apps/v1"}, ListMeta: meta, Items: items[from:to]})
	default:
		http.NotFound(w, r)
	}
}

// start serves a to a bundle that calls it as each caller and as kubeast:cache, and to a second one with no cache
// identity, whose every read is the caller's own.
func (a *rolloutCluster) start(t *testing.T) (shared, own *Service) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(srv.Close)
	t.Cleanup(a.release)
	userCfg := &rest.Config{Host: srv.URL, QPS: -1}
	userCfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return auth.ImpersonationRoundTripper(rt, "default") })
	cs, err := kubernetes.NewForConfig(userCfg)
	if err != nil {
		t.Fatal(err)
	}
	cacheCfg := &rest.Config{Host: srv.URL, QPS: -1, Impersonate: rest.ImpersonationConfig{UserName: overviewCacheUser, Groups: []string{auth.GroupAuthenticated, auth.GroupViewer}}}
	cacheClient, err := kubernetes.NewForConfig(cacheCfg)
	if err != nil {
		t.Fatal(err)
	}
	shared = &Service{cache: cache.New("", 0, 0, "")}
	shared.defaultBundle.Store(&clientBundle{clientset: cs, authz: cs.AuthorizationV1(), cacheClient: cacheClient, id: "default"})
	own = &Service{cache: cache.New("", 0, 0, "")}
	own.defaultBundle.Store(&clientBundle{clientset: cs, id: "default"})
	return shared, own
}

// randomRollouts fills a with Deployments, ReplicaSets and ControllerRevisions of three namespaces, created at whole
// seconds over span before base, many at the same second: owned by a Deployment that is there or not, by two, by
// another kind first or by nothing; with a revision, none or one that is no number; StatefulSets', DaemonSets' and
// other kinds' revisions, controlling or not, with data of images, of no template or none.
func randomRollouts(r *rand.Rand, base time.Time, span time.Duration) *rolloutCluster {
	a := &rolloutCluster{}
	yes, no := true, false
	created := func(last *time.Time) time.Time {
		if !last.IsZero() && r.IntN(4) == 0 {
			return *last
		}
		*last = base.Add(-time.Duration(r.Int64N(int64(span/time.Second))) * time.Second)
		return *last
	}
	for _, ns := range []string{"alpha", "beta", "gamma"} {
		for d := 0; d < 8; d++ {
			if r.IntN(10) < 7 {
				a.deploys = append(a.deploys, appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("d-%d", d), Namespace: ns}})
			}
		}
		var last time.Time
		for i, n := 0, 250+r.IntN(300); i < n; i++ {
			rs := appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("rs-%d", i), Namespace: ns, CreationTimestamp: metav1.NewTime(created(&last)),
				Annotations: map[string]string{"other": strings.Repeat("x", 50)}}}
			deploy := func() metav1.OwnerReference {
				return metav1.OwnerReference{Kind: "Deployment", Name: fmt.Sprintf("d-%d", r.IntN(10)), Controller: &yes}
			}
			switch r.IntN(5) {
			case 1, 4:
				rs.OwnerReferences = []metav1.OwnerReference{deploy()}
			case 2:
				rs.OwnerReferences = []metav1.OwnerReference{deploy(), deploy()}
			case 3:
				rs.OwnerReferences = []metav1.OwnerReference{{Kind: "Rollout", Name: "d-1"}, deploy()}
			}
			switch v := r.IntN(6); v {
			case 0:
			case 1:
				rs.Annotations["deployment.kubernetes.io/revision"] = "x"
			default:
				rs.Annotations["deployment.kubernetes.io/revision"] = strconv.Itoa(r.IntN(20) + 1)
			}
			switch r.IntN(3) {
			case 0:
				rs.Annotations["kubernetes.io/change-cause"] = fmt.Sprintf("cause %d", i)
			case 1:
				rs.Annotations["kubernetes.io/change-cause"] = ""
			}
			if r.IntN(4) > 0 {
				replicas := int32(r.IntN(5))
				rs.Spec.Replicas = &replicas
			}
			for c := r.IntN(3); c > 0; c-- {
				rs.Spec.Template.Spec.Containers = append(rs.Spec.Template.Spec.Containers, corev1.Container{Name: fmt.Sprintf("c%d", c), Image: fmt.Sprintf("img:%d.%d", i, c)})
			}
			a.sets = append(a.sets, rs)
		}
		last = time.Time{}
		for i, n := 0, 150+r.IntN(250); i < n; i++ {
			cr := appsv1.ControllerRevision{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("cr-%d", i), Namespace: ns, CreationTimestamp: metav1.NewTime(created(&last))},
				Revision: int64(r.IntN(30))}
			owner := func(controller *bool) metav1.OwnerReference {
				kind := []string{"StatefulSet", "DaemonSet", "Other"}[r.IntN(3)]
				return metav1.OwnerReference{Kind: kind, Name: fmt.Sprintf("o-%d", r.IntN(4)), Controller: controller}
			}
			switch r.IntN(5) {
			case 1:
				cr.OwnerReferences = []metav1.OwnerReference{owner(&yes)}
			case 2:
				cr.OwnerReferences = []metav1.OwnerReference{owner(nil), owner(&no)}
			case 3:
				cr.OwnerReferences = []metav1.OwnerReference{owner(&no), owner(&yes)}
			case 4:
				cr.OwnerReferences = []metav1.OwnerReference{owner(&yes), owner(nil)}
			}
			switch r.IntN(3) {
			case 0:
				cr.Data = runtime.RawExtension{Raw: []byte(fmt.Sprintf(`{"spec":{"template":{"spec":{"containers":[{"name":"a","image":"cr:%d"},{"name":"b","image":"side:%d"}]}}}}`, i, i%3))}
			case 1:
				cr.Data = runtime.RawExtension{Raw: []byte(`{"spec":{"replicas":2}}`)}
			}
			a.revs = append(a.revs, cr)
		}
	}
	return a
}

// The rollouts before they were read for everyone, copied as they were: each kind's rows of whole lists, the answer
// each person's own reads gave.

func beforeDeploymentRollouts(deploys []appsv1.Deployment, rsList []appsv1.ReplicaSet, cutoff time.Time) []map[string]interface{} {
	deployKeys := make(map[string]bool, len(deploys))
	for _, d := range deploys {
		deployKeys[d.Namespace+"/"+d.Name] = true
	}
	result := make([]map[string]interface{}, 0)
	for _, rs := range rsList {
		if rs.CreationTimestamp.Time.Before(cutoff) {
			continue
		}
		ownerName := ""
		for _, ref := range rs.OwnerReferences {
			if ref.Kind == "Deployment" && deployKeys[rs.Namespace+"/"+ref.Name] {
				ownerName = ref.Name
				break
			}
		}
		if ownerName == "" {
			continue
		}
		revStr, ok := rs.Annotations["deployment.kubernetes.io/revision"]
		if !ok {
			continue
		}
		rev, err := strconv.ParseInt(revStr, 10, 64)
		if err != nil {
			continue
		}
		replicas := int32(0)
		if rs.Spec.Replicas != nil {
			replicas = *rs.Spec.Replicas
		}
		result = append(result, map[string]interface{}{
			"kind": "Deployment", "name": ownerName, "namespace": rs.Namespace, "revision": rev,
			"change_cause": nilIfEmpty(rs.Annotations["kubernetes.io/change-cause"]), "created_at": toISO(&rs.CreationTimestamp),
			"images": extractContainerImages(rs.Spec.Template.Spec.Containers), "replicas": replicas,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, result[i]["created_at"].(string))
		tj, _ := time.Parse(time.RFC3339, result[j]["created_at"].(string))
		return ti.After(tj)
	})
	return result
}

func beforeRevisionRollouts(crs []appsv1.ControllerRevision, cutoff time.Time) []map[string]interface{} {
	result := make([]map[string]interface{}, 0)
	for i := range crs {
		cr := &crs[i]
		if cr.CreationTimestamp.Time.Before(cutoff) {
			continue
		}
		owner := metav1.GetControllerOf(cr)
		if owner == nil || (owner.Kind != "StatefulSet" && owner.Kind != "DaemonSet") {
			continue
		}
		result = append(result, map[string]interface{}{
			"kind": owner.Kind, "name": owner.Name, "namespace": cr.Namespace, "revision": cr.Revision, "change_cause": nil,
			"created_at": toISO(&cr.CreationTimestamp), "images": extractImagesFromControllerRevision(cr), "replicas": 0,
		})
	}
	return result
}

func beforeOneDeployment(rsList []appsv1.ReplicaSet, namespace, name string, cutoff time.Time) []map[string]interface{} {
	result := make([]map[string]interface{}, 0)
	for i := range rsList {
		rs := &rsList[i]
		owned := false
		for _, ref := range rs.OwnerReferences {
			if ref.Kind == "Deployment" && ref.Name == name {
				owned = true
				break
			}
		}
		revStr, ok := rs.Annotations["deployment.kubernetes.io/revision"]
		rev, err := strconv.ParseInt(revStr, 10, 64)
		if rs.CreationTimestamp.Time.Before(cutoff) || !owned || !ok || err != nil {
			continue
		}
		replicas := int32(0)
		if rs.Spec.Replicas != nil {
			replicas = *rs.Spec.Replicas
		}
		result = append(result, map[string]interface{}{
			"kind": "Deployment", "name": name, "namespace": namespace, "revision": rev,
			"change_cause": nilIfEmpty(rs.Annotations["kubernetes.io/change-cause"]), "created_at": toISO(&rs.CreationTimestamp),
			"images": extractContainerImages(rs.Spec.Template.Spec.Containers), "replicas": replicas,
		})
	}
	sortRolloutRowsByTime(result)
	return result
}

func beforeOneWorkload(crs []appsv1.ControllerRevision, namespace, kind, name string, cutoff time.Time) []map[string]interface{} {
	result := make([]map[string]interface{}, 0)
	for i := range crs {
		cr := &crs[i]
		owned := false
		for _, ref := range cr.OwnerReferences {
			if ref.Kind == kind && ref.Name == name {
				owned = true
				break
			}
		}
		if cr.CreationTimestamp.Time.Before(cutoff) || !owned {
			continue
		}
		result = append(result, map[string]interface{}{
			"kind": kind, "name": name, "namespace": namespace, "revision": cr.Revision, "change_cause": nil,
			"created_at": toISO(&cr.CreationTimestamp), "images": extractImagesFromControllerRevision(cr), "replicas": 0,
		})
	}
	sortRolloutRowsByTime(result)
	return result
}

// before is what the rollouts read gave a caller who may list every kind in namespace ("" = all) before they were read
// for everyone: a workload of kind and name, or the namespace's when kind is empty.
func (a *rolloutCluster) before(namespace, kind, name string, cutoff time.Time) []map[string]interface{} {
	in := func(ns string) bool { return namespace == "" || ns == namespace }
	var deploys []appsv1.Deployment
	var sets []appsv1.ReplicaSet
	var revs []appsv1.ControllerRevision
	for _, d := range a.deploys {
		if in(d.Namespace) {
			deploys = append(deploys, d)
		}
	}
	for _, rs := range a.sets {
		if in(rs.Namespace) {
			sets = append(sets, rs)
		}
	}
	for _, cr := range a.revs {
		if in(cr.Namespace) {
			revs = append(revs, cr)
		}
	}
	switch kind {
	case "":
		result := append(beforeDeploymentRollouts(deploys, sets, cutoff), beforeRevisionRollouts(revs, cutoff)...)
		sortRolloutsNewestFirst(result)
		return result
	case "Deployment":
		return beforeOneDeployment(sets, namespace, name, cutoff)
	}
	return beforeOneWorkload(revs, namespace, kind, name, cutoff)
}

// rolloutsSaid is a rollouts read's answer: its rows or its error.
func rolloutsSaid(t *testing.T, rows []map[string]interface{}, err error) string {
	t.Helper()
	if err != nil {
		return "error: " + err.Error()
	}
	return rolloutRowsJSON(t, rows)
}

// What the rollouts reads give each identity is what its own lists give and, for a caller who may list everything, what
// the reads gave before they were shared: across the cluster, a grant limited to namespaces it may or may not list, a
// caller refused one kind (across the cluster or everywhere), a review that refuses what the list allows, a refusal;
// over windows, the namespace's rollouts and one workload's, over random objects.
func TestTheSharedRolloutReadsAreEachIdentitysOwnAnswer(t *testing.T) {
	seed := uint64(time.Now().UnixNano())
	t.Logf("seed %d", seed)
	r := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	base := time.Now().Truncate(time.Second)
	api := randomRollouts(r, base, 30*time.Hour)
	everywhere := func(string, string) bool { return true }
	may := map[string]func(resource, namespace string) bool{
		"wide@example.com":     everywhere,
		"two@example.com":      func(_, ns string) bool { return ns == "alpha" || ns == "beta" },
		"gap@example.com":      func(_, ns string) bool { return ns == "alpha" },
		"nodeploy@example.com": func(resource, _ string) bool { return resource != "deployments" },
		"nocr@example.com":     func(resource, ns string) bool { return resource != "controllerrevisions" || ns != "" },
		"liar@example.com":     func(resource, _ string) bool { return resource != "replicasets" },
		"none@example.com":     func(string, string) bool { return false },
	}
	api.may = func(user, resource, namespace string) bool {
		f := may[user]
		return f != nil && (resource == "events" || f(resource, namespace))
	}
	api.list = func(user, resource, namespace string) bool {
		return user == "liar@example.com" || api.may(user, resource, namespace)
	}
	s, own := api.start(t)
	callers := map[string]context.Context{
		"wide@example.com":     wideCaller("wide@example.com"),
		"two@example.com":      grantCaller("two@example.com", "alpha", "beta"),
		"gap@example.com":      grantCaller("gap@example.com", "alpha", "gamma"),
		"nodeploy@example.com": wideCaller("nodeploy@example.com"),
		"nocr@example.com":     wideCaller("nocr@example.com"),
		"liar@example.com":     wideCaller("liar@example.com"),
		"none@example.com":     wideCaller("none@example.com"),
	}
	// a window starting at the very second of a Deployment's rollout and of a StatefulSet's or DaemonSet's, which it holds
	atRow := func(deployment bool) time.Time {
		var at []time.Time
		for _, row := range api.before("", "", "", time.Time{}) {
			if (row["kind"] == "Deployment") == deployment {
				t, _ := time.Parse(time.RFC3339, row["created_at"].(string))
				at = append(at, t)
			}
		}
		if len(at) == 0 {
			t.Fatal("the objects have no rollout of that kind")
		}
		return at[r.IntN(len(at))]
	}
	cutoffs := []time.Time{{}, base.Add(-time.Hour), base.Add(-6*time.Hour + 500*time.Millisecond), base.Add(-24 * time.Hour), atRow(true), atRow(false)}
	type ask struct {
		user, namespace, kind, name string
		cutoff                      time.Time
	}
	var asks []ask
	for user := range callers {
		for _, cutoff := range cutoffs {
			for _, namespace := range []string{"", "alpha", "beta"} {
				asks = append(asks, ask{user, namespace, "", "", cutoff})
			}
			for _, namespace := range []string{"alpha", "beta"} {
				asks = append(asks, ask{user, namespace, "Deployment", "d-" + strconv.Itoa(r.IntN(10)), cutoff},
					ask{user, namespace, "StatefulSet", "o-" + strconv.Itoa(r.IntN(4)), cutoff}, ask{user, namespace, "DaemonSet", "o-" + strconv.Itoa(r.IntN(4)), cutoff})
			}
		}
	}
	read := func(s *Service, a ask) string {
		if a.kind == "" {
			rows, err := s.getNamespaceRolloutHistory(callers[a.user], a.namespace, a.cutoff)
			return rolloutsSaid(t, rows, err)
		}
		rows, err := s.getResourceRolloutHistory(callers[a.user], a.namespace, a.kind, a.name, a.cutoff)
		return rolloutsSaid(t, rows, err)
	}
	got := make([]string, len(asks))
	for i, a := range asks {
		got[i] = read(s, a)
	}
	callerPages := map[string]map[string]int{}
	for user := range callers {
		callerPages[user] = map[string]int{}
		for _, kind := range rolloutKinds {
			callerPages[user][kind], _ = api.count(user, kind)
		}
	}
	rowsSeen := 0
	for i, a := range asks {
		want := read(own, a)
		if got[i] != want {
			t.Fatalf("%+v:\n got %.400s\nwant %.400s", a, got[i], want)
		}
		if a.user == "wide@example.com" {
			if before := rolloutRowsJSON(t, api.before(a.namespace, a.kind, a.name, a.cutoff)); got[i] != before {
				t.Fatalf("%+v differs from the reads before they were shared:\n got %.400s\nwant %.400s", a, got[i], before)
			}
			rowsSeen += strings.Count(got[i], `"created_at"`)
		}
	}
	// the answers the refusals give
	for i, a := range asks {
		if a.namespace != "" || a.kind != "" || !a.cutoff.IsZero() {
			continue
		}
		prefix := map[string]string{"nodeploy@example.com": "error: list deployments for timeline: deployments.apps is forbidden",
			"nocr@example.com": "error: list controller revisions for timeline: controllerrevisions.apps is forbidden",
			"none@example.com": "error: list deployments for timeline: deployments.apps is forbidden"}[a.user]
		if prefix != "" && !strings.HasPrefix(got[i], prefix) {
			t.Errorf("%s across the cluster: %.200s, want %s…", a.user, got[i], prefix)
		}
		if prefix == "" && !strings.HasPrefix(got[i], "[{") {
			t.Errorf("%s across the cluster: %.200s, want rows", a.user, got[i])
		}
	}
	t.Logf("%d asks, %d rows to the wide caller; pages as the callers %v; kubeast:cache reads %v", len(asks), rowsSeen, callerPages, cacheReads(api))
	if rowsSeen == 0 {
		t.Fatal("the objects gave the wide caller no rollouts")
	}
	// who read what as themselves: the kinds their review allowed, nothing
	for user, want := range map[string][]string{"wide@example.com": nil, "two@example.com": nil, "nocr@example.com": {"controllerrevisions"},
		"nodeploy@example.com": {"deployments"}, "liar@example.com": {"replicasets"}} {
		for _, kind := range rolloutKinds {
			if read := callerPages[user][kind] > 0; read != (len(want) > 0 && want[0] == kind) {
				t.Errorf("%s read %d pages of %s as itself", user, callerPages[user][kind], kind)
			}
		}
	}
	for _, user := range []string{"gap@example.com", "none@example.com"} {
		if callerPages[user]["replicasets"] == 0 {
			t.Errorf("%s read no replicasets as itself, where it may not list them", user)
		}
	}
	for _, kind := range rolloutKinds {
		if _, reads := api.count(overviewCacheUser, kind); reads == 0 {
			t.Errorf("no read of %s as kubeast:cache", kind)
		}
	}
}

// cacheReads is kubeast:cache's reads of each rollout kind.
func cacheReads(api *rolloutCluster) map[string]int {
	out := map[string]int{}
	for _, kind := range rolloutKinds {
		_, out[kind] = api.count(overviewCacheUser, kind)
	}
	return out
}

// Forty different people opening the Timeline of every namespace at one moment have each rollout kind of the cluster
// read twice as kubeast:cache (the first one's read and one for everyone who came during it) and never as themselves,
// and each gets what its own reads give. One who leaves while it waits gets its own error at once.
func TestACrowdOpeningTheTimelineReadsTheRolloutsOnceForEveryoneWhoMayListThem(t *testing.T) {
	r := rand.New(rand.NewPCG(7, 11))
	api := randomRollouts(r, time.Now().Truncate(time.Second), 20*time.Hour)
	api.may = func(string, string, string) bool { return true }
	api.hold = make(chan struct{})
	s, own := api.start(t)
	const n = 40
	answers := make([]string, n)
	var wg sync.WaitGroup
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := s.GetNamespaceTimeline(wideCaller(fmt.Sprintf("u%02d@example.com", i)), "", 24, 500, "")
			answers[i] = timelineSaid(t, res, err)
		}()
	}
	// the first caller's read of each kind is held at its first page; every other caller waits for the read after it
	b := s.defaultBundle.Load()
	waiting := func() []int {
		return []int{b.deploymentWindows.Waiting(""), b.replicaSetWindows.Waiting(""), b.revisionWindows.Waiting("")}
	}
	if !eventually(t, 10*time.Second, func() bool { w := waiting(); return w[0] == n-1 && w[1] == n-1 && w[2] == n-1 }) {
		w := waiting()
		api.release()
		wg.Wait()
		t.Fatalf("callers waiting for the next read of deployments, replicasets, controllerrevisions: %v, want %d each", w, n-1)
	}
	// one of them asking again, its reviews answered already, so the only wait is the reads'
	ctx, cancel := context.WithTimeout(wideCaller("u00@example.com"), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := s.getNamespaceRolloutHistory(ctx, "", time.Now().Add(-24*time.Hour))
	if took := time.Since(start); err == nil || !strings.Contains(err.Error(), "not listed") || took > 2*time.Second {
		t.Errorf("the rollouts whose request ended while they waited: %v after %v", err, took)
	}
	api.release()
	wg.Wait()

	reads := cacheReads(api)
	t.Logf("%d timelines at once: reads as kubeast:cache %v, %d pages as the callers, %d reviews", n, reads, api.pagesByCallers(), api.reviewsSeen())
	for _, kind := range rolloutKinds {
		if reads[kind] != 2 {
			t.Errorf("%d reads of %s as kubeast:cache, want 2", reads[kind], kind)
		}
	}
	if api.pagesByCallers() != 0 {
		t.Errorf("%d pages of the rollout kinds as the callers, want 0", api.pagesByCallers())
	}
	for i, got := range answers {
		res, err := own.GetNamespaceTimeline(wideCaller(fmt.Sprintf("u%02d@example.com", i)), "", 24, 500, "")
		if want := timelineSaid(t, res, err); got != want {
			t.Fatalf("timeline %d:\n got %.400s\nwant %.400s", i, got, want)
		}
	}
	if !strings.Contains(answers[0], `"created_at"`) || strings.Contains(answers[0], "rollouts_error") {
		t.Errorf("the timeline has no rollouts: %.300s", answers[0])
	}
}

// A review the API server fails (500, not a refusal) reads the rollouts as the caller, as before the review: the answer
// is the caller's own reads', across the cluster, in a namespace, for one workload and for a grant limited to
// namespaces, and nothing is read as kubeast:cache.
func TestAFailedReviewReadsTheRolloutsAsTheCaller(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 5))
	api := randomRollouts(r, time.Now().Truncate(time.Second), 20*time.Hour)
	api.may, api.reviewFails = func(string, string, string) bool { return true }, true
	s, own := api.start(t)
	cutoff := time.Now().Add(-6 * time.Hour)
	for _, ctx := range []context.Context{wideCaller("a@example.com"), grantCaller("two@example.com", "alpha", "beta")} {
		for _, namespace := range []string{"", "beta"} {
			rows, err := s.getNamespaceRolloutHistory(ctx, namespace, cutoff)
			got := rolloutsSaid(t, rows, err)
			rows, err = own.getNamespaceRolloutHistory(ctx, namespace, cutoff)
			if want := rolloutsSaid(t, rows, err); err != nil || got != want {
				t.Errorf("%q:\n got %.300s\nwant %.300s", namespace, got, want)
			}
		}
		for _, kind := range []string{"Deployment", "StatefulSet"} {
			name := map[string]string{"Deployment": "d-2", "StatefulSet": "o-1"}[kind]
			rows, err := s.getResourceRolloutHistory(ctx, "alpha", kind, name, cutoff)
			got := rolloutsSaid(t, rows, err)
			rows, err = own.getResourceRolloutHistory(ctx, "alpha", kind, name, cutoff)
			if want := rolloutsSaid(t, rows, err); err != nil || got != want {
				t.Errorf("%s %s:\n got %.300s\nwant %.300s", kind, name, got, want)
			}
		}
	}
	if api.reviewsSeen() == 0 {
		t.Error("no review was asked")
	}
	for kind, n := range cacheReads(api) {
		if n != 0 {
			t.Errorf("%d reads of %s as kubeast:cache, want none", n, kind)
		}
	}
}

// When kubeast:cache may not list a kind, each timeline reads that kind as its viewer, as before, the refused read is
// not tried again for every timeline, and the other kinds are still read for everyone.
func TestTimelineRolloutsAreTheCallersOwnWhenTheCacheIdentityIsRefused(t *testing.T) {
	r := rand.New(rand.NewPCG(13, 17))
	api := randomRollouts(r, time.Now().Truncate(time.Second), 20*time.Hour)
	api.may = func(user, _, _ string) bool { return user != "none@example.com" }
	api.cacheRefused = map[string]bool{"replicasets": true}
	s, own := api.start(t)
	cutoff := time.Now().Add(-12 * time.Hour)
	callers := []context.Context{wideCaller("a@example.com"), wideCaller("b@example.com"), wideCaller("none@example.com"), wideCaller("a@example.com"), grantCaller("two@example.com", "alpha", "beta")}
	namespaces := []string{"", "alpha"}
	var got []string
	for _, ctx := range callers {
		for _, namespace := range namespaces {
			rows, err := s.getNamespaceRolloutHistory(ctx, namespace, cutoff)
			got = append(got, rolloutsSaid(t, rows, err))
		}
	}
	reads := cacheReads(api)
	rsPages, _ := api.count("a@example.com", "replicasets")
	deployPages, _ := api.count("a@example.com", "deployments")
	for i, ctx := range callers {
		for j, namespace := range namespaces {
			rows, err := own.getNamespaceRolloutHistory(ctx, namespace, cutoff)
			if want := rolloutsSaid(t, rows, err); got[i*len(namespaces)+j] != want {
				t.Errorf("%d, %q:\n got %.300s\nwant %.300s", i, namespace, got[i*len(namespaces)+j], want)
			}
		}
	}
	// "" and alpha by the wide callers, beta by the grant (its alpha refused already)
	if reads["replicasets"] != 3 {
		t.Errorf("kubeast:cache was asked for the replicasets %d times, want once in each of the three places: its refusal holds for the next reads", reads["replicasets"])
	}
	if reads["deployments"] == 0 || reads["controllerrevisions"] == 0 {
		t.Errorf("reads as kubeast:cache %v: the kinds it may list are read for everyone", reads)
	}
	if rsPages == 0 {
		t.Error("the replicasets kubeast:cache was refused were not read as the caller")
	}
	if deployPages != 0 {
		t.Errorf("%d pages of deployments as the caller, which kubeast:cache reads for everyone", deployPages)
	}
}
