package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// apiCall is one request the cluster saw, with the identity it went out as ("" = Kubeast's own credential).
type apiCall struct {
	user, groups, verb, resource, namespace, selector string
}

// clusterAPI answers as an API server does, by the identity a request impersonates, and notes every request.
type clusterAPI struct {
	mu         sync.Mutex
	pods       []corev1.Pod
	namespaces []string
	// review answers a SelfSubjectAccessReview; may decides a real request, as review does when nil
	review func(user string, ra authorizationv1.ResourceAttributes) bool
	may    func(user, verb, resource, namespace, fieldSelector string) bool
	// holdCache, when set, holds every list as kubeast:cache until it is closed
	holdCache chan struct{}
	// holdCallers, when set, holds every list of a node's pods as a caller until it is closed
	holdCallers chan struct{}
	calls       []apiCall
	// cacheNow and cacheMost are the requests as kubeast:cache under way now and at most
	cacheNow, cacheMost int
	// callerNow and callerMost are the lists of a node's pods as a caller under way now and at most
	callerNow, callerMost int
}

func (a *clusterAPI) allowed(user, verb, resource, namespace, selector string) bool {
	if a.may != nil {
		return a.may(user, verb, resource, namespace, selector)
	}
	// the viewer group the chart binds on every managed cluster
	if user == overviewCacheUser {
		return true
	}
	return a.review(user, authorizationv1.ResourceAttributes{Verb: verb, Resource: resource, Namespace: namespace})
}

func (a *clusterAPI) note(c apiCall) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, c)
}

// count is the requests seen with match.
func (a *clusterAPI) count(match func(apiCall) bool) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for _, c := range a.calls {
		if match(c) {
			n++
		}
	}
	return n
}

func (a *clusterAPI) callsOf(user string) []apiCall {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []apiCall
	for _, c := range a.calls {
		if c.user == user {
			out = append(out, c)
		}
	}
	return out
}

func writeStatus(w http.ResponseWriter, code int, reason, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": reason, "code": code, "message": msg})
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (a *clusterAPI) serve(w http.ResponseWriter, r *http.Request) {
	user := r.Header.Get(auth.HeaderImpersonateUser)
	groups := strings.Join(r.Header.Values(auth.HeaderImpersonateGroup), ",")
	path := strings.TrimPrefix(r.URL.Path, "/api/v1")
	selector := r.URL.Query().Get("fieldSelector")
	if r.Method == http.MethodPost && r.URL.Path == "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" {
		body, _ := io.ReadAll(r.Body)
		review := &authorizationv1.SelfSubjectAccessReview{}
		if _, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, review); err != nil || review.Spec.ResourceAttributes == nil {
			http.Error(w, "unreadable review", http.StatusBadRequest)
			return
		}
		ra := *review.Spec.ResourceAttributes
		a.note(apiCall{user: user, groups: groups, verb: "review", resource: ra.Verb + " " + ra.Resource, namespace: ra.Namespace})
		review.APIVersion, review.Kind = "authorization.k8s.io/v1", "SelfSubjectAccessReview"
		review.Status.Allowed = a.review(user, ra)
		writeJSON(w, review)
		return
	}
	var resource, namespace, name string
	switch parts := strings.Split(strings.Trim(path, "/"), "/"); {
	case len(parts) == 1:
		resource = parts[0]
	case len(parts) == 2 && (parts[0] == "namespaces" || parts[0] == "nodes"):
		resource, name = parts[0], parts[1]
	case len(parts) == 3 && parts[0] == "namespaces":
		namespace, resource = parts[1], parts[2]
	default:
		http.NotFound(w, r)
		return
	}
	verb := "list"
	if name != "" {
		verb = "get"
	}
	a.note(apiCall{user: user, groups: groups, verb: verb, resource: resource, namespace: namespace, selector: selector})
	if user == overviewCacheUser {
		a.mu.Lock()
		a.cacheNow++
		a.cacheMost = max(a.cacheMost, a.cacheNow)
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			a.cacheNow--
			a.mu.Unlock()
		}()
	}
	if user == overviewCacheUser && a.holdCache != nil {
		<-a.holdCache
	}
	if user != overviewCacheUser && resource == "pods" && strings.HasPrefix(selector, "spec.nodeName=") {
		a.mu.Lock()
		a.callerNow++
		a.callerMost = max(a.callerMost, a.callerNow)
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			a.callerNow--
			a.mu.Unlock()
		}()
		if a.holdCallers != nil {
			<-a.holdCallers
		}
	}
	if !a.allowed(user, verb, resource, namespace, selector) {
		writeStatus(w, http.StatusForbidden, "Forbidden", fmt.Sprintf("%s is forbidden: User %q cannot %s resource %q", resource, user, verb, resource))
		return
	}
	switch resource {
	case "pods":
		// the fields the API server selects pods by here: the node and the phase
		fieldSel, err := fields.ParseSelector(selector)
		if err != nil {
			writeStatus(w, http.StatusBadRequest, "BadRequest", err.Error())
			return
		}
		a.mu.Lock()
		list := &corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, ListMeta: metav1.ListMeta{ResourceVersion: "7"}}
		for _, p := range a.pods {
			if (namespace == "" || p.Namespace == namespace) && fieldSel.Matches(fields.Set{"spec.nodeName": p.Spec.NodeName, "status.phase": string(p.Status.Phase)}) {
				list.Items = append(list.Items, p)
			}
		}
		a.mu.Unlock()
		slices.SortFunc(list.Items, func(x, y corev1.Pod) int { return strings.Compare(x.Namespace+"/"+x.Name, y.Namespace+"/"+y.Name) })
		writeJSON(w, list)
	case "namespaces":
		made := metav1.NewTime(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC))
		item := func(ns string) corev1.Namespace {
			return corev1.Namespace{
				TypeMeta:   metav1.TypeMeta{Kind: "Namespace", APIVersion: "v1"},
				ObjectMeta: metav1.ObjectMeta{Name: ns, CreationTimestamp: made, Labels: map[string]string{"kubernetes.io/metadata.name": ns}},
				Status:     corev1.NamespaceStatus{Phase: corev1.NamespaceActive},
			}
		}
		if name != "" {
			if !slices.Contains(a.namespaces, name) {
				writeStatus(w, http.StatusNotFound, "NotFound", "namespaces "+name+" not found")
				return
			}
			ns := item(name)
			writeJSON(w, &ns)
			return
		}
		list := &corev1.NamespaceList{TypeMeta: metav1.TypeMeta{Kind: "NamespaceList", APIVersion: "v1"}}
		for _, ns := range slices.Sorted(slices.Values(a.namespaces)) { // by the store key, as the API server lists
			list.Items = append(list.Items, item(ns))
		}
		writeJSON(w, list)
	case "nodes":
		if name != "" {
			full := resourceList("cpu", "4", "memory", "16Gi", "ephemeral-storage", "100Gi", "hugepages-2Mi", "1Gi", "hugepages-1Gi", "0", "pods", "110", "nvidia.com/gpu", "8", "example.com/dongle", "3")
			writeJSON(w, &corev1.Node{TypeMeta: metav1.TypeMeta{Kind: "Node", APIVersion: "v1"}, ObjectMeta: metav1.ObjectMeta{Name: name}, Status: corev1.NodeStatus{Capacity: full, Allocatable: full}})
			return
		}
		writeJSON(w, &corev1.NodeList{TypeMeta: metav1.TypeMeta{Kind: "NodeList", APIVersion: "v1"}})
	default:
		http.NotFound(w, r)
	}
}

// start serves a to a bundle that calls it as each caller and as kubeast:cache, with synced informers over informerObjs.
func (a *clusterAPI) start(t *testing.T, informerObjs ...k8sruntime.Object) (*Service, *clientBundle) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(srv.Close)
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
	b := &clientBundle{clientset: cs, authz: cs.AuthorizationV1(), cacheClient: cacheClient, id: "default", inf: readyInformers(t, informerObjs...)}
	s := &Service{cache: cache.New("", 0, 0, "")}
	s.defaultBundle.Store(b)
	return s, b
}

func readyInformers(t *testing.T, objs ...k8sruntime.Object) *clusterInformers {
	t.Helper()
	ci := newClusterInformers(fake.NewSimpleClientset(objs...), time.Hour, nil)
	t.Cleanup(ci.stopNow)
	if !ci.waitSynced(context.Background(), 5*time.Second) {
		t.Fatal("informers did not sync")
	}
	return ci
}

func nodePod(ns, name, node string) corev1.Pod {
	p := listedPod(ns, node, 0)
	p.Name, p.GenerateName = name, ""
	return p
}

// podsOnNodes are three namespaces' pods on n1 and n2 and one not scheduled.
func podsOnNodes() []corev1.Pod {
	var out []corev1.Pod
	for _, ns := range []string{"a", "b", "c"} {
		out = append(out, nodePod(ns, ns+"-web-1", "n1"), nodePod(ns, ns+"-web-2", "n2"), nodePod(ns, ns+"-db-0", "n1"))
	}
	return append(out, nodePod("b", "b-pending", ""))
}

func grantCaller(user string, namespaces ...string) context.Context {
	return auth.WithPayload(context.Background(), auth.TokenPayload{UserID: user, Email: user, Roles: map[string]string{"default": "Read"}, Namespaces: map[string][]string{"default": namespaces}})
}

func wideCaller(user string) context.Context {
	return auth.WithPayload(context.Background(), auth.TokenPayload{UserID: user, Email: user, Roles: map[string]string{"default": "Read"}})
}

// rbac is a review answer: the users named list pods in the namespaces given ("" = everywhere), and anyone else nothing.
func rbac(grants map[string][]string) func(string, authorizationv1.ResourceAttributes) bool {
	return func(user string, ra authorizationv1.ResourceAttributes) bool {
		for _, ns := range grants[user] {
			if ns == "" || ns == ra.Namespace {
				return true
			}
		}
		return false
	}
}

func answerJSON(t *testing.T, v interface{}) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The pods of a node are what the caller's own list of them shows, row for row, in every way a caller asks.
func TestPodsOnNodeAreWhatTheCallersOwnListShows(t *testing.T) {
	grants := map[string][]string{"wide@example.com": {""}, "ac@example.com": {"a", "c"}, "b@example.com": {"b"}, "inb@example.com": {"b"}}
	api := &clusterAPI{pods: podsOnNodes(), review: rbac(grants)}
	s, b := api.start(t)
	cases := []struct {
		name            string
		ctx             context.Context
		node, namespace string
	}{
		{"every namespace", wideCaller("wide@example.com"), "n1", ""},
		{"one namespace chosen", wideCaller("wide@example.com"), "n1", "c"},
		{"not scheduled", wideCaller("wide@example.com"), "", ""},
		{"a grant of two namespaces", grantCaller("ac@example.com", "c", "a"), "n1", ""},
		{"a grant of one namespace", grantCaller("b@example.com", "b"), "n2", ""},
		{"one namespace allowed of a wide grant", wideCaller("inb@example.com"), "n1", "b"},
	}
	for _, c := range cases {
		got, err := s.GetPodsOnNode(c.ctx, c.node, c.namespace)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		namespaces, _ := callerNamespaces(c.ctx, c.namespace)
		want, err := listPodsOnNode(c.ctx, b.id, b.clientset.CoreV1(), c.node, namespaces)
		if err != nil {
			t.Fatalf("%s: the caller's own list: %v", c.name, err)
		}
		if len(want) == 0 {
			t.Fatalf("%s: the case lists nothing", c.name)
		}
		if answerJSON(t, got) != answerJSON(t, want) {
			t.Errorf("%s:\n got %s\nwant %s", c.name, answerJSON(t, got), answerJSON(t, want))
		}
	}
}

// Fifty different people asking for one node's pods at one moment are two reads as kubeast:cache and none as themselves.
func TestPodsOnNodeOfACrowdAreListedAboutTwiceForEveryone(t *testing.T) {
	grants := map[string][]string{}
	var callers []context.Context
	var users []string
	for i := 0; i < 40; i++ {
		u := fmt.Sprintf("wide-%02d@example.com", i)
		grants[u] = []string{""}
		callers, users = append(callers, wideCaller(u)), append(users, u)
	}
	for i := 0; i < 10; i++ {
		u := fmt.Sprintf("scoped-%02d@example.com", i)
		grants[u] = []string{"a", "b", "c", "d", "e"}
		callers, users = append(callers, grantCaller(u, "a", "b", "c", "d", "e")), append(users, u)
	}
	api := &clusterAPI{pods: podsOnNodes(), review: rbac(grants), holdCache: make(chan struct{})}
	s, _ := api.start(t)
	var wg sync.WaitGroup
	answers := make([]int, len(callers))
	for i, ctx := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := s.GetPodsOnNode(ctx, "n1", "")
			if err != nil {
				t.Errorf("%s: %v", users[i], err)
			}
			answers[i] = len(got)
		}()
	}
	reviewed := func() bool { return api.count(func(c apiCall) bool { return c.verb == "review" }) >= 40+10*5 }
	eventually(t, 5*time.Second, reviewed)
	time.Sleep(300 * time.Millisecond)
	close(api.holdCache)
	wg.Wait()
	asCallers := api.count(func(c apiCall) bool { return c.user != overviewCacheUser && c.verb != "review" })
	asCache := api.count(func(c apiCall) bool { return c.user == overviewCacheUser && c.resource == "pods" })
	t.Logf("50 people, one node: lists as the callers %d, as %s %d", asCallers, overviewCacheUser, asCache)
	if asCallers != 0 || asCache > 2 {
		t.Errorf("lists as the callers %d (want 0), as %s %d (want 2 or fewer)", asCallers, overviewCacheUser, asCache)
	}
	for i, n := range answers {
		if want := map[bool]int{true: 6, false: 6}[i < 40]; n != want {
			t.Errorf("%s got %d pods, want %d", users[i], n, want)
		}
	}
}

// Each caller keeps the namespaces its own identity may list pods in, and one refused everywhere gets the cluster's refusal.
func TestPodsOnNodeKeepToWhatTheCallersIdentityMayList(t *testing.T) {
	grants := map[string][]string{"ac@example.com": {"a"}, "one@example.com": {"b"}, "none@example.com": nil}
	api := &clusterAPI{pods: podsOnNodes(), review: rbac(grants)}
	s, _ := api.start(t)
	namespacesOf := func(rows []map[string]interface{}) []string {
		var out []string
		for _, r := range rows {
			out = append(out, r["namespace"].(string)+"/"+r["name"].(string))
		}
		return out
	}

	got, err := s.GetPodsOnNode(grantCaller("ac@example.com", "a", "c"), "n1", "")
	if err != nil || !reflect.DeepEqual(namespacesOf(got), []string{"a/a-db-0", "a/a-web-1"}) {
		t.Errorf("grant a, c with c refused: %v %v", namespacesOf(got), err)
	}
	got, err = s.GetPodsOnNode(grantCaller("one@example.com", "b"), "n1", "")
	if err != nil || !reflect.DeepEqual(namespacesOf(got), []string{"b/b-db-0", "b/b-web-1"}) {
		t.Errorf("a grant of one namespace: %v %v", namespacesOf(got), err)
	}
	if _, err := s.GetPodsOnNode(grantCaller("one@example.com", "b"), "n1", "a"); !apierrors.IsForbidden(err) {
		t.Errorf("a namespace outside the grant: %v", err)
	}
	if _, err := s.GetPodsOnNode(wideCaller("none@example.com"), "n1", ""); !apierrors.IsForbidden(err) {
		t.Errorf("a caller with no right: %v", err)
	}
	if n := api.count(func(c apiCall) bool { return c.user == "none@example.com" && c.verb == "list" }); n != 1 {
		t.Errorf("the caller with no right got its answer from %d lists of its own, want the cluster's one", n)
	}
	for _, c := range api.callsOf(overviewCacheUser) {
		if c.namespace != "" || c.selector != "spec.nodeName=n1" {
			t.Errorf("a read as %s that is not the node's: %+v", overviewCacheUser, c)
		}
	}
}

// A namespace the review refuses without the node's selector is listed as the caller, so an authorizer reading the selector decides.
func TestPodsOnNodeANamespaceTheReviewRefusesIsAskedOfTheCluster(t *testing.T) {
	api := &clusterAPI{
		pods:   podsOnNodes(),
		review: rbac(map[string][]string{"hook@example.com": {"a"}}),
		may: func(user, verb, resource, namespace, selector string) bool {
			if user == overviewCacheUser {
				return true
			}
			return user == "hook@example.com" && resource == "pods" && (namespace == "a" || namespace == "b" && selector == "spec.nodeName=n1")
		},
	}
	s, _ := api.start(t)
	got, err := s.GetPodsOnNode(grantCaller("hook@example.com", "a", "b", "c"), "n1", "")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, r := range got {
		names = append(names, r["namespace"].(string)+"/"+r["name"].(string))
	}
	if want := []string{"a/a-db-0", "a/a-web-1", "b/b-db-0", "b/b-web-1"}; !reflect.DeepEqual(names, want) {
		t.Errorf("pods %v, want %v", names, want)
	}
}

// A cluster that refuses kubeast:cache the node's pods still shows each caller what its own list shows.
func TestPodsOnNodeAreTheCallersOwnListWhenTheCacheIdentityIsRefused(t *testing.T) {
	review := rbac(map[string][]string{"wide@example.com": {""}, "ac@example.com": {"a", "c"}})
	api := &clusterAPI{pods: podsOnNodes(), review: review, may: func(user, verb, resource, namespace, _ string) bool {
		return user != overviewCacheUser && review(user, authorizationv1.ResourceAttributes{Verb: verb, Resource: resource, Namespace: namespace})
	}}
	s, b := api.start(t)
	for _, ctx := range []context.Context{wideCaller("wide@example.com"), grantCaller("ac@example.com", "a", "c")} {
		got, err := s.GetPodsOnNode(ctx, "n1", "")
		if err != nil {
			t.Fatal(err)
		}
		namespaces, _ := callerNamespaces(ctx, "")
		want, _ := listPodsOnNode(ctx, b.id, b.clientset.CoreV1(), "n1", namespaces)
		if len(want) == 0 || answerJSON(t, got) != answerJSON(t, want) {
			t.Errorf("got %d pods, the caller's own list %d", len(got), len(want))
		}
	}
}

// Without informers already synced the node's pods and the namespaces are the caller's own lists at once, and none is started.
func TestPodsOnNodeAndNamespacesWaitForNoInformers(t *testing.T) {
	api := &clusterAPI{pods: podsOnNodes(), namespaces: []string{"a", "b", "c"}, review: rbac(map[string][]string{"wide@example.com": {""}})}
	s, b := api.start(t)
	b.inf = nil
	ctx := wideCaller("wide@example.com")
	start := time.Now()
	pods, err := s.GetPodsOnNode(ctx, "n1", "")
	if err != nil || len(pods) != 6 {
		t.Fatalf("pods: %d %v", len(pods), err)
	}
	namespaces, err := s.GetNamespaces(ctx)
	if err != nil || len(namespaces) != 3 {
		t.Fatalf("namespaces: %d %v", len(namespaces), err)
	}
	if took := time.Since(start); took > time.Second || b.inf != nil {
		t.Errorf("took %v, informers started: %v", took, b.inf != nil)
	}
	if n := api.count(func(c apiCall) bool { return c.user == "wide@example.com" && c.verb == "list" }); n != 2 {
		t.Errorf("%d lists as the caller, want its two own", n)
	}
}

// A read of a node's pods under way when a caller asks does not answer it: the caller sees what was there when it asked.
func TestPodsOnNodeReadStartedBeforeTheCallerDoesNotAnswerIt(t *testing.T) {
	grants := map[string][]string{"first@example.com": {""}, "second@example.com": {""}}
	api := &clusterAPI{pods: podsOnNodes(), review: rbac(grants), holdCache: make(chan struct{})}
	s, _ := api.start(t)
	first := make(chan int, 1)
	go func() {
		got, _ := s.GetPodsOnNode(wideCaller("first@example.com"), "n1", "")
		first <- len(got)
	}()
	started := func() bool {
		return api.count(func(c apiCall) bool {
			return c.user == overviewCacheUser || c.user == "first@example.com" && c.verb == "list"
		}) > 0
	}
	if !eventually(t, 5*time.Second, started) {
		t.Fatal("the first read never started")
	}
	api.mu.Lock()
	api.pods = append(api.pods, nodePod("c", "c-new", "n1"))
	api.mu.Unlock()
	second := make(chan []map[string]interface{}, 1)
	go func() {
		got, _ := s.GetPodsOnNode(wideCaller("second@example.com"), "n1", "")
		second <- got
	}()
	time.Sleep(200 * time.Millisecond)
	close(api.holdCache)
	<-first
	got := <-second
	if !slices.ContainsFunc(got, func(r map[string]interface{}) bool { return r["name"] == "c-new" }) {
		t.Errorf("the caller who asked after the pod came did not get it: %d pods", len(got))
	}
}

// The shared read of a node's pods goes out as kubeast:cache, never as a caller nor as Kubeast's own credential.
func TestPodsOnNodeSharedReadCarriesNoCallersIdentity(t *testing.T) {
	impersonationEnabled = true
	t.Cleanup(func() { impersonationEnabled = false })
	api := &clusterAPI{pods: podsOnNodes(), review: rbac(map[string][]string{"wide@example.com": {""}, "ac@example.com": {"a", "c"}})}
	srv := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(srv.Close)
	b, err := buildClientBundle(cluster.Info{ID: "default", KubeconfigBlob: strings.Replace(testKubeconfig, "https://127.0.0.1:6443", srv.URL, 1)})
	if err != nil {
		t.Fatal(err)
	}
	b.inf = readyInformers(t)
	s := &Service{cache: cache.New("", 0, 0, "")}
	s.defaultBundle.Store(b)
	for _, ctx := range []context.Context{wideCaller("wide@example.com"), grantCaller("ac@example.com", "a", "c")} {
		if _, err := s.GetPodsOnNode(ctx, "n1", ""); err != nil {
			t.Fatal(err)
		}
	}
	shared := api.callsOf(overviewCacheUser)
	if len(shared) == 0 {
		t.Fatal("no read as " + overviewCacheUser)
	}
	for _, c := range shared {
		if c.groups != auth.GroupAuthenticated+","+auth.GroupViewer {
			t.Errorf("the shared read went out with groups %q", c.groups)
		}
	}
	if n := api.count(func(c apiCall) bool { return c.user == "" }); n != 0 {
		t.Errorf("%d requests went out as Kubeast's own credential", n)
	}
	for _, c := range api.calls {
		if c.user != overviewCacheUser && c.verb == "list" {
			t.Errorf("a list went out as a caller: %+v", c)
		}
	}
}
