package k8s

import (
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	authorizationv1client "k8s.io/client-go/kubernetes/typed/authorization/v1"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// sharingBundle is api's bundle of cluster "default" with the read checks shared, as buildClientBundle makes it with the
// switch on.
func sharingBundle(t testing.TB, api *reviewAPI) *clientBundle {
	b := api.bundle(t)
	b.id, b.groupCheckUser = "default", groupCheckUser
	return b
}

func hasGroup(groups []string, g string) bool { return slices.Contains(groups, g) }

// An allow of one person's groups answers the next person of them with no call to the cluster, and a crowd of them asks
// once; the check goes out as the shared name with the person's groups exactly.
func TestAnAllowOfOnePersonsGroupsAnswersTheOthersOfThemWithNoCallToTheCluster(t *testing.T) {
	var mu sync.Mutex
	var sent [][]string
	api := &reviewAPI{delay: 20 * time.Millisecond, allow: func(user string, groups []string, _ authorizationv1.ResourceAttributes) bool {
		if user == groupCheckUser {
			mu.Lock()
			sent = append(sent, groups)
			mu.Unlock()
		}
		return hasGroup(groups, auth.GroupViewer)
	}}
	b := sharingBundle(t, api)
	s := &Service{}
	for _, person := range []string{"alice@example.com", "bob@example.com"} {
		if ok, err := s.mayListShown(wideCaller(person), b, "", "pods", ""); err != nil || !ok {
			t.Fatalf("%s: answer = %v, %v", person, ok, err)
		}
	}
	if n := api.count("alice@example.com") + api.count("bob@example.com"); n != 0 {
		t.Errorf("%d reviews as the people, want 0", n)
	}
	if n := api.count(groupCheckUser); n != 1 {
		t.Errorf("%d reviews as %s for two people of one group set, want 1", n, groupCheckUser)
	}
	if want := []string{auth.GroupAuthenticated, auth.GroupViewer}; len(sent) != 1 || !slices.Equal(sent[0], want) {
		t.Errorf("the shared check went out with groups %v, want exactly %v", sent, want)
	}

	var wg sync.WaitGroup
	for i := 0; i < 80; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, err := s.mayListShown(wideCaller(fmt.Sprintf("crowd-%02d@example.com", i)), b, "apps", "deployments", ""); err != nil || !ok {
				t.Errorf("crowd %d: answer = %v, %v", i, ok, err)
			}
		}()
	}
	wg.Wait()
	t.Logf("reviews for 2 people and a crowd of 80 of one group set, two questions: %d as %s, none as a person", api.count(groupCheckUser), groupCheckUser)
	if n := api.count(groupCheckUser); n != 2 {
		t.Errorf("%d reviews as %s, want one per question", n, groupCheckUser)
	}
	for user, n := range api.asks {
		if user != groupCheckUser && n != 0 {
			t.Errorf("%s was asked %d times", user, n)
		}
	}
}

// A grant limited to namespaces shares the answers of its groups' questions, and is shown nothing of a namespace outside
// its grant whatever another grant of the same groups was allowed there.
func TestAGrantLimitedToNamespacesUsesNoSharedAnswerOutsideItsNamespaces(t *testing.T) {
	api := &reviewAPI{allow: func(_ string, groups []string, ra authorizationv1.ResourceAttributes) bool {
		return hasGroup(groups, "kubeast:role:read") && (ra.Namespace == "team-a" || ra.Namespace == "team-b")
	}}
	b := sharingBundle(t, api)
	s := &Service{}
	a, other := grantCaller("a@example.com", "team-a"), grantCaller("b@example.com", "team-b")
	if all, allowed, err := s.podListAccess(a, b, ""); err != nil || all || !slices.Equal(allowed, []string{"team-a"}) {
		t.Fatalf("team-a's grant: %v %v %v", all, allowed, err)
	}
	if _, _, err := s.podListAccess(other, b, "team-a"); !apierrors.IsForbidden(err) {
		t.Errorf("team-b's grant asking for team-a: %v, want refused as outside its grant", err)
	}
	if all, allowed, err := s.podListAccess(other, b, ""); err != nil || all || !slices.Equal(allowed, []string{"team-b"}) {
		t.Errorf("team-b's grant: %v %v %v, want team-b alone", all, allowed, err)
	}
	if n, persons := api.count(groupCheckUser), api.count("a@example.com")+api.count("b@example.com"); n != 2 || persons != 0 {
		t.Errorf("%d shared reviews (want one per namespace asked), %d as the people (want 0)", n, persons)
	}
}

// What the groups are refused is asked again as the person, so a binding of a User still counts; the same people as
// TestAccessChecksAreNotSharedBetweenIdentities with the checks shared.
func TestAGroupsRefusalIsAskedAgainAsThePerson(t *testing.T) {
	api := &reviewAPI{delay: 20 * time.Millisecond, allow: func(user string, groups []string, _ authorizationv1.ResourceAttributes) bool {
		return user == "alice" || hasGroup(groups, auth.GroupOperator)
	}}
	b := sharingBundle(t, api)
	s := &Service{cache: cache.New("", 0, 0, "")}
	cases := []struct {
		name string
		ctx  context.Context
		want bool
	}{
		{"alice", callerCtx("alice"), true},
		{"bob", callerCtx("bob"), false},
		{"carol with Read", auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "carol", Email: "carol", Roles: map[string]string{"default": "Read"}}), false},
		{"carol with Write", auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "carol", Email: "carol", Roles: map[string]string{"default": "Write"}}), true},
	}
	var wg sync.WaitGroup
	for _, c := range cases {
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ok, err := s.mayListShown(c.ctx, b, "", "pods", "")
				if err != nil || ok != c.want {
					t.Errorf("%s: answer = %v, %v, want %v", c.name, ok, err, c.want)
				}
			}()
		}
	}
	wg.Wait()
	// one shared review per group set; carol's Write is allowed by its groups, so carol is asked for Read alone
	for user, want := range map[string]int{"alice": 1, "bob": 1, "carol": 1, groupCheckUser: 3} {
		t.Logf("reviews as %s: %d", user, api.count(user))
		if got := api.count(user); got != want {
			t.Errorf("%s was asked about %d times, want %d", user, got, want)
		}
	}
	// another person of the refused groups is asked as itself, the groups not again
	if ok, err := s.mayListShown(callerCtx("dave"), b, "", "pods", ""); err != nil || ok {
		t.Errorf("dave: answer = %v, %v, want false", ok, err)
	}
	if api.count("dave") != 1 || api.count(groupCheckUser) != 3 {
		t.Errorf("dave asked %d times and the groups %d, want 1 and still 3", api.count("dave"), api.count(groupCheckUser))
	}
}

// A cluster that does not let Kubeast ask under the shared name leaves each check to the person, with the person's
// answer.
func TestAClusterThatRefusesTheSharedNameLeavesTheCheckToThePerson(t *testing.T) {
	var shared atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(auth.HeaderImpersonateUser) == groupCheckUser {
			shared.Add(1)
			writeStatus(w, http.StatusForbidden, "Forbidden", "users \""+groupCheckUser+"\" is forbidden")
			return
		}
		body, _ := io.ReadAll(r.Body)
		review := &authorizationv1.SelfSubjectAccessReview{}
		_, _, _ = scheme.Codecs.UniversalDeserializer().Decode(body, nil, review)
		review.APIVersion, review.Kind, review.Status.Allowed = "authorization.k8s.io/v1", "SelfSubjectAccessReview", true
		writeJSON(w, review)
	}))
	t.Cleanup(srv.Close)
	b := &clientBundle{authz: reviewClient(t, srv.URL), id: "default", groupCheckUser: groupCheckUser}
	s := &Service{}
	for _, person := range []string{"a@example.com", "b@example.com"} {
		if ok, err := s.mayListShown(wideCaller(person), b, "", "nodes", ""); err != nil || !ok {
			t.Errorf("%s: answer = %v, %v, want the person's own allow", person, ok, err)
		}
	}
	if n := shared.Load(); n != 1 {
		t.Errorf("the shared name was tried %d times, want once and its refusal kept", n)
	}
}

// With the switch off the screens' checks go out as before: as the person, as many and the same bytes as the person's
// own check (mayDo, unchanged) sends.
func TestWithTheSwitchOffTheChecksGoOutAsBefore(t *testing.T) {
	var namespaces []string
	for i := 0; i < 20; i++ {
		namespaces = append(namespaces, fmt.Sprintf("ns-%02d", i))
	}
	nodes := []string{"n0", "n1", "n2", "n3"}
	var pods []corev1.Pod
	var objs []k8sruntime.Object
	for i, ns := range namespaces {
		for _, node := range nodes {
			pods = append(pods, nodePod(ns, ns+"-"+node, node))
		}
		objs = append(objs, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}},
			&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: fmt.Sprintf("d%d", i)}},
			overviewPod(ns, "p", corev1.PodRunning))
	}
	grants := map[string][]string{"wide@example.com": {""}, "five@example.com": namespaces[:5], "twenty@example.com": namespaces}
	// the numbers TestFirstScreensOfOnePersonListNoPodsAsThatPerson holds
	people := []struct {
		user string
		ctx  context.Context
		want int
	}{
		{"wide@example.com", wideCaller("wide@example.com"), 8},
		{"five@example.com", grantCaller("five@example.com", namespaces[:5]...), 3*5 + 4},
		{"twenty@example.com", grantCaller("twenty@example.com", namespaces...), 3*20 + 4},
	}
	// each review as sent: who it went out as and its bytes
	reviewsOf := func(a *clusterAPI) []apiCall {
		var out []apiCall
		for _, c := range a.calls {
			if c.verb == "review" {
				out = append(out, apiCall{user: c.user, groups: c.groups, body: c.body})
			}
		}
		slices.SortFunc(out, func(x, y apiCall) int {
			return strings.Compare(x.user+"|"+x.groups+"|"+x.body, y.user+"|"+y.groups+"|"+y.body)
		})
		return out
	}
	for _, p := range people {
		api := &clusterAPI{pods: pods, namespaces: namespaces, review: rbac(grants)}
		s, b := api.start(t, objs...)
		firstScreens(s, b, p.ctx, nodes)
		if n := len(api.callsOf(p.user)); n != p.want {
			t.Errorf("%s: %d requests as the person, want %d", p.user, n, p.want)
		}
		if n := len(api.callsOf(groupCheckUser)); n != 0 {
			t.Errorf("%s: %d requests as %s", p.user, n, groupCheckUser)
		}
		// each review asked again through the person's own check
		again := &clusterAPI{pods: pods, namespaces: namespaces, review: rbac(grants)}
		s2, b2 := again.start(t, objs...)
		sent := reviewsOf(api)
		for i, r := range sent {
			review := &authorizationv1.SelfSubjectAccessReview{}
			if _, _, err := scheme.Codecs.UniversalDeserializer().Decode([]byte(r.body), nil, review); err != nil {
				t.Fatal(err)
			}
			_, _ = s2.mayDo(p.ctx, b2, fmt.Sprintf("again-%d", i), *review.Spec.ResourceAttributes)
		}
		bytes := 0
		for _, r := range sent {
			bytes += len(r.body)
		}
		t.Logf("%s: %d reviews of %d bytes, as the person", p.user, len(sent), bytes)
		if got := reviewsOf(again); !slices.Equal(got, sent) {
			t.Errorf("%s: the reviews differ from the person's own check's:\n%q\n%q", p.user, sent, got)
		}
	}
}

// Can-i, writes, logs, Secrets, the events and live lists' checks, an AI tool call's checks and a token that is no
// person's are asked as that identity even while the groups' allow of the same question is kept.
func TestOtherChecksAreAskedAsThePersonWhileTheGroupsAllowIsKept(t *testing.T) {
	api := &clusterAPI{namespaces: []string{"a"}, reviewGroups: func(_ string, groups []string, _ authorizationv1.ResourceAttributes) bool {
		return hasGroup(groups, auth.GroupViewer) || hasGroup(groups, auth.GroupInvestigator)
	}, may: func(string, string, string, string, string) bool { return true }}
	s, b := api.start(t)
	b.groupCheckUser = groupCheckUser
	reviews := func(user string) int {
		return api.count(func(c apiCall) bool { return c.verb == "review" && c.user == user })
	}
	first := wideCaller("first@example.com")
	for _, q := range []listQuestion{{resource: "events", namespace: "a"}, {resource: "nodes"}, {resource: "pods"}} {
		if ok, err := s.mayListShown(first, b, q.group, q.resource, q.namespace); err != nil || !ok {
			t.Fatalf("%v: %v %v", q, ok, err)
		}
	}
	kept := reviews(groupCheckUser)
	recorded := accesstrail.NewContext(wideCaller("tool@example.com"), &accesstrail.Recorder{})
	cases := []struct {
		name, user string
		ask        func()
	}{
		{"a drawer's events", "events@example.com", func() { _, _ = s.objectEvents(wideCaller("events@example.com"), "a", "Pod", "x") }},
		{"a live list", "live@example.com", func() { _, _ = s.MayListKind(wideCaller("live@example.com"), "", "nodes") }},
		{"an AI tool call", "tool@example.com", func() { _, _ = s.mayListShown(recorded, b, "", "nodes", "") }},
		{"the alert investigator", auth.UserInvestigator, func() {
			_, _ = s.mayListShown(auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "system", Email: auth.UserInvestigator, System: auth.SystemInvestigator}), b, "", "pods", "")
		}},
		{"a write", "write@example.com", func() {
			_, _ = s.mayDoShown(wideCaller("write@example.com"), b, "pods_create", authorizationv1.ResourceAttributes{Verb: "create", Resource: "pods"})
		}},
		{"a log", "log@example.com", func() {
			_, _ = s.mayDoShown(wideCaller("log@example.com"), b, "pods_log", authorizationv1.ResourceAttributes{Verb: "get", Resource: "pods", Subresource: "log", Namespace: "a"})
		}},
		{"Secrets", "secrets@example.com", func() { _, _ = s.mayListShown(wideCaller("secrets@example.com"), b, "", "secrets", "") }},
	}
	for _, c := range cases {
		c.ask()
		if n := reviews(c.user); n != 1 {
			t.Errorf("%s: %d reviews as %s, want 1", c.name, n, c.user)
		}
	}
	if n := reviews(groupCheckUser); n != kept {
		t.Errorf("%d more reviews as %s", n-kept, groupCheckUser)
	}
	for _, r := range accesstrail.FromContext(recorded).Snapshot().Requests {
		if r.Source == "cache" {
			t.Errorf("the tool call's trail names an answer it did not ask for: %+v", r)
		}
	}
}

// The shared checks are called only from the screens served from kubeast:cache: the overview's counts, the namespace
// list and a grant's namespaces, the node list, the pod rows and the pods of a node.
func TestOnlyTheChecksOfScreensServedFromKubeastCacheAreShared(t *testing.T) {
	want := map[string][]string{
		"mayDoShown":      {"mayGetNamespace", "mayListShown"},
		"mayListShown":    {"cachedNamespaces", "cachedNodes", "mayListAll", "mayListPods", "overviewIdentityAllowed"},
		"mayListAll":      {"keepListable", "keepListableIn", "podListAccess"},
		"mayListPods":     {"podListAccess"},
		"mayGetNamespace": {"cachedScopedNamespaces"},
		"podListAccess":   {"callerPodRows", "podsOnNodeOf"},
	}
	got := map[string][]string{}
	files, _ := filepath.Glob("*.go")
	fset := token.NewFileSet()
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range file.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if call, ok := n.(*ast.CallExpr); ok {
					if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
						if _, watched := want[sel.Sel.Name]; watched && !slices.Contains(got[sel.Sel.Name], fn.Name.Name) {
							got[sel.Sel.Name] = append(got[sel.Sel.Name], fn.Name.Name)
						}
					}
				}
				return true
			})
		}
	}
	for helper, callers := range want {
		slices.Sort(got[helper])
		if !slices.Equal(got[helper], callers) {
			t.Errorf("%s is called from %v, want %v: an allow shared by group stands only for what a screen served from kubeast:cache shows", helper, got[helper], callers)
		}
	}
}

// reviewClient is the authorization client of a config that sends to url as the person in each request's context.
func reviewClient(t *testing.T, url string) authorizationv1client.AuthorizationV1Interface {
	t.Helper()
	cfg := &rest.Config{Host: url, QPS: -1}
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return auth.ImpersonationRoundTripper(rt, "default") })
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return cs.AuthorizationV1()
}

// The switch is per cluster and needs the groups sent, and a shared check takes its turn on the same client rate as the
// person's checks.
func TestTheSharedChecksAreSwitchedPerClusterAndTakeThePersonsRate(t *testing.T) {
	var mu sync.Mutex
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		review := &authorizationv1.SelfSubjectAccessReview{}
		if _, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, review); err != nil {
			http.Error(w, "unreadable review", http.StatusBadRequest)
			return
		}
		mu.Lock()
		asked = append(asked, r.Header.Get(auth.HeaderImpersonateUser)+" "+strings.Join(r.Header.Values(auth.HeaderImpersonateGroup), ","))
		mu.Unlock()
		review.APIVersion, review.Kind, review.Status.Allowed = "authorization.k8s.io/v1", "SelfSubjectAccessReview", true
		writeJSON(w, review)
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() {
		impersonationEnabled, clientRates = false, rates{}
		sharedReadChecks.on, sharedReadChecks.exclude = false, nil
	})
	kubeconfig := strings.Replace(testKubeconfig, "https://127.0.0.1:6443", srv.URL, 1)
	build := func(id string) *clientBundle {
		b, err := buildClientBundle(cluster.Info{ID: cluster.ID(id), KubeconfigBlob: kubeconfig})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	for _, c := range []struct {
		name          string
		id            string
		on, groupSent bool
		want          string
	}{
		{"on", "a", true, true, groupCheckUser},
		{"the cluster listed out", "b", true, true, ""},
		{"the switch off", "a", false, true, ""},
		{"no groups sent (auth.impersonation.enabled off)", "a", true, false, ""},
	} {
		impersonationEnabled = c.groupSent
		sharedReadChecks.on, sharedReadChecks.exclude = c.on, []string{"b"}
		if got := build(c.id).groupCheckUser; got != c.want {
			t.Errorf("%s: shared as %q, want %q", c.name, got, c.want)
		}
	}

	impersonationEnabled, sharedReadChecks.on = true, true
	reader := func(user string) context.Context {
		return auth.WithPayload(context.Background(), auth.TokenPayload{UserID: user, Email: user, Roles: map[string]string{"a": "Read", "b": "Read"}})
	}
	for _, c := range []struct {
		name   string
		set    rates
		review bool // the checks on their own rate (multicluster.reviewQPS)
	}{
		{"the clients' rate", rates{qps: 1, burst: 1}, false},
		{"the checks' own rate", rates{qps: 100, burst: 200, reviewQPS: 1, reviewBurst: 1}, true},
	} {
		clientRates = c.set
		for _, id := range []string{"a", "b"} {
			b := build(id)
			s := &Service{}
			if ok, err := s.mayListShown(reader("reader@example.com"), b, "", "pods", ""); err != nil || !ok {
				t.Fatalf("%s, %s: %v %v", c.name, id, ok, err)
			}
			mu.Lock()
			last := asked[len(asked)-1]
			mu.Unlock()
			want := "reader@example.com " + auth.GroupAuthenticated + "," + auth.GroupViewer
			if id == "a" {
				want = groupCheckUser + " " + auth.GroupAuthenticated + "," + auth.GroupViewer
			}
			if last != want {
				t.Errorf("%s, cluster %s: the check went out as %q, want %q", c.name, id, last, want)
			}
			clients, reviews := b.clientset.CoreV1().RESTClient().GetRateLimiter(), b.authz.RESTClient().GetRateLimiter()
			// the one token of a second's rate is the one the check took
			if reviews.TryAccept() {
				t.Errorf("%s, cluster %s: the checks' limiter had a token left, want the check's turn taken there", c.name, id)
			}
			if c.review && !clients.TryAccept() {
				t.Errorf("%s, cluster %s: the clients' limiter had no token, want the check's turn on the checks' own", c.name, id)
			}
		}
	}
}

// The shared name is Kubeast's prefix and a part made at each start, and a person who has such a name is asked as
// itself, its answer kept for no one else.
func TestTheSharedNameIsKubeastsOwnMadeAtEachStartAndNoPersons(t *testing.T) {
	suffix, ok := strings.CutPrefix(groupCheckUser, auth.GroupCheckUserPrefix)
	if !ok || !regexp.MustCompile(`^[0-9a-f]{8}$`).MatchString(suffix) {
		t.Errorf("shared name %q, want %s and eight hex digits", groupCheckUser, auth.GroupCheckUserPrefix)
	}
	made := map[string]bool{}
	for i := 0; i < 50; i++ {
		made[groupCheckSuffix()] = true
	}
	if len(made) != 50 {
		t.Errorf("%d different parts in 50 starts", len(made))
	}
	api := &reviewAPI{allow: func(_ string, groups []string, _ authorizationv1.ResourceAttributes) bool {
		return hasGroup(groups, auth.GroupViewer)
	}}
	b := sharingBundle(t, api)
	s := &Service{}
	for _, name := range []string{groupCheckUser, auth.GroupCheckUserPrefix + "other"} {
		if ok, err := s.mayListShown(wideCaller(name), b, "", "nodes", ""); err != nil || !ok {
			t.Fatalf("%s: %v %v", name, ok, err)
		}
	}
	if ok, err := s.mayListShown(wideCaller("next@example.com"), b, "", "nodes", ""); err != nil || !ok {
		t.Fatalf("next: %v %v", ok, err)
	}
	// one as the person of that name, one shared for next: neither person's answer was kept for the groups
	if n, other := api.count(groupCheckUser), api.count(auth.GroupCheckUserPrefix+"other"); n != 2 || other != 1 {
		t.Errorf("%d reviews under the shared name (want 2) and %d as the prefixed person (want 1)", n, other)
	}
}

// A permission taken from the groups stops counting when the answer's minute ends, as a person's own does; one given
// by name the same.
func TestARevokedPermissionOfTheGroupsEndsWithItsAnswersMinute(t *testing.T) {
	var groupAllowed, carolBound atomic.Bool
	groupAllowed.Store(true)
	carolBound.Store(true)
	api := &reviewAPI{allow: func(user string, groups []string, _ authorizationv1.ResourceAttributes) bool {
		if user == "carol@example.com" {
			return carolBound.Load()
		}
		return groupAllowed.Load() && hasGroup(groups, auth.GroupViewer)
	}}
	b := sharingBundle(t, api)
	s := &Service{}
	what, attrs := listCheck("", "pods", "")
	start := time.Now()
	if ok, _ := s.mayListShown(wideCaller("alice@example.com"), b, "", "pods", ""); !ok {
		t.Fatal("alice refused")
	}
	key, _, _ := groupCheckKey(wideCaller("alice@example.com"), b, what, attrs)
	end := time.Unix(0, s.accessAnswers.kept[key].end)
	if end.After(time.Now().Add(podAccessTTL)) || end.Before(start.Add(podAccessTTL*4/5-time.Second)) {
		t.Errorf("the groups' allow ends %v after it was asked, want within the answer's minute", end.Sub(start))
	}
	groupAllowed.Store(false)
	if ok, _ := s.mayListShown(wideCaller("bob@example.com"), b, "", "pods", ""); !ok {
		t.Error("bob refused within the answer's minute, which stands as a person's own does")
	}
	s.accessAnswers.set(key, true, time.Now().Add(-time.Millisecond)) // the minute over
	if ok, _ := s.mayListShown(wideCaller("bob@example.com"), b, "", "pods", ""); ok {
		t.Error("bob allowed after the groups' answer ended")
	}
	if api.count(groupCheckUser) != 2 || api.count("bob@example.com") != 1 {
		t.Errorf("asked %d times as the groups and %d as bob, want 2 and 1", api.count(groupCheckUser), api.count("bob@example.com"))
	}

	carol := callerCtx("carol@example.com")
	if ok, _ := s.mayListShown(carol, b, "", "pods", ""); !ok {
		t.Fatal("carol refused while bound by name")
	}
	carolBound.Store(false)
	s.accessAnswers.set(s.clusterCacheKey(carol, what), true, time.Now().Add(-time.Millisecond))
	if ok, _ := s.mayListShown(carol, b, "", "pods", ""); ok {
		t.Error("carol allowed after her binding went and her answer ended")
	}
}

// A crowd of first screens, 100 people of whom 80 share one group set (wide Read) and 20 another (Read limited to 5 or
// 20 namespaces), as the code asks them with the checks shared and not, played through the client's 100 a second and
// burst of 200 as TestACrowdsFirstChecksFinishSoonerAndChecksAskedAgainWaitAtMostTheBound plays them.
func TestACrowdOfOneGroupSetQueuesItsAllowedChecksOnce(t *testing.T) {
	var namespaces []string
	for i := 0; i < 20; i++ {
		namespaces = append(namespaces, fmt.Sprintf("ns-%02d", i))
	}
	nodes := []string{"n0", "n1", "n2", "n3"}
	var pods []corev1.Pod
	var objs []k8sruntime.Object
	for i, ns := range namespaces {
		for _, node := range nodes {
			pods = append(pods, nodePod(ns, ns+"-"+node, node))
		}
		objs = append(objs, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}},
			&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: fmt.Sprintf("d%d", i)}},
			overviewPod(ns, "p", corev1.PodRunning))
	}
	type person struct {
		user  string
		ctx   context.Context
		scope []string
	}
	var people []person
	for i := 0; i < 80; i++ {
		u := fmt.Sprintf("wide-%02d@example.com", i)
		people = append(people, person{u, wideCaller(u), nil})
	}
	for i := 0; i < 20; i++ {
		scope := namespaces[:5]
		if i >= 10 {
			scope = namespaces
		}
		u := fmt.Sprintf("bound-%02d@example.com", i)
		people = append(people, person{u, grantCaller(u, scope...), scope})
	}
	scopes := map[string][]string{}
	for _, p := range people {
		scopes[p.user] = p.scope
	}
	// Read: kubeast:viewer everywhere, kubeast:role:read bound in the 20 namespaces; nobody creates pods
	reviewGroups := func(_ string, groups []string, ra authorizationv1.ResourceAttributes) bool {
		switch {
		case ra.Verb == "create":
			return false
		case hasGroup(groups, auth.GroupViewer):
			return true
		case hasGroup(groups, "kubeast:role:read"):
			return slices.Contains(namespaces, ra.Namespace)
		}
		return false
	}
	may := func(user, _, resource, namespace, _ string) bool {
		if user == overviewCacheUser || strings.HasPrefix(user, "wide-") {
			return true
		}
		return resource != "nodes" && slices.Contains(scopes[user], namespace)
	}
	type tally struct {
		own    map[string]int // requests as each person
		shared map[string]int // reviews as the shared name, by group set
		total  int
	}
	run := func(shared bool) tally {
		api := &clusterAPI{pods: pods, namespaces: namespaces, reviewGroups: reviewGroups, may: may}
		s, b := api.start(t, objs...)
		if shared {
			b.groupCheckUser = groupCheckUser
		}
		var wg sync.WaitGroup
		for _, p := range people {
			wg.Add(1)
			go func() { defer wg.Done(); firstScreens(s, b, p.ctx, nodes) }()
		}
		wg.Wait()
		out := tally{own: map[string]int{}, shared: map[string]int{}}
		for _, c := range api.calls {
			switch c.user {
			case overviewCacheUser:
				continue // kubeast:cache's own client and rate
			case groupCheckUser:
				out.shared[c.groups]++
			default:
				out.own[c.user]++
			}
			out.total++
		}
		return out
	}
	// each person's requests eight side by side, the shared ones of a group set as one more; a person is done when its
	// own and its group set's are
	play := func(c tally) (last, half time.Duration) {
		var reqs []turnRequest
		add := func(id, calls int) {
			for c := 0; c < 8; c++ {
				length := calls / 8
				if c < calls%8 {
					length++
				}
				if length > 0 {
					reqs = append(reqs, turnRequest{person: id, chain: make([]bool, length-1)})
				}
			}
		}
		groupID := map[string]int{}
		for g, n := range c.shared {
			groupID[g] = 1000 + len(groupID)
			add(groupID[g], n)
		}
		for i, p := range people {
			add(i, c.own[p.user])
		}
		grants := runTurns(newTurnLimiter(100, 200, clientWait.forLimiter(limiterUser)), time.Unix(0, 0), reqs, 10*time.Millisecond)
		done := map[int]time.Duration{}
		for _, g := range grants {
			done[g.req.person] = max(done[g.req.person], g.given)
		}
		var times []time.Duration
		for i, p := range people {
			groups := auth.GroupAuthenticated + ",kubeast:role:read"
			if p.scope == nil {
				groups = auth.GroupAuthenticated + "," + auth.GroupViewer
			}
			times = append(times, max(done[i], done[groupID[groups]]))
		}
		slices.Sort(times)
		return times[len(times)-1], times[len(times)/2]
	}
	round := func(d time.Duration) time.Duration { return d.Round(100 * time.Millisecond) }
	before, after := run(false), run(true)
	lastBefore, halfBefore := play(before)
	lastAfter, halfAfter := play(after)
	queued := func(n int) int { return max(0, n-200) }
	t.Logf("checks asked as each person: %d requests on the user rate, %d past the burst of 200; the last person %v, half by %v", before.total, queued(before.total), round(lastBefore), round(halfBefore))
	t.Logf("allowed read checks shared by group set: %d requests (%v by group set), %d past the burst; the last person %v, half by %v", after.total, after.shared, queued(after.total), round(lastAfter), round(halfAfter))
	if len(before.shared) != 0 {
		t.Errorf("shared reviews with the switch off: %v", before.shared)
	}
	wide := auth.GroupAuthenticated + "," + auth.GroupViewer
	if n := after.shared[wide]; n != 7 {
		t.Errorf("%d shared reviews for the 80 wide people, want one per kind shown (7)", n)
	}
	for _, p := range people[:80] {
		if before.own[p.user] != 8 || after.own[p.user] != 1 {
			t.Fatalf("%s: %d requests as the person, %d shared; want 8 and its can-i alone", p.user, before.own[p.user], after.own[p.user])
		}
	}
	if after.total*3 > before.total || lastAfter >= lastBefore {
		t.Errorf("shared: %d requests, the last person %v; as each person %d, %v — want a third of the requests or fewer, sooner", after.total, lastAfter, before.total, lastBefore)
	}
}
