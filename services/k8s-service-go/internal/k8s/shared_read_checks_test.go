package k8s

import (
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
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
	b.id, b.sharesChecks = "default", true
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
// answer: a refusal of one and the allow of another.
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
		review.APIVersion, review.Kind = "authorization.k8s.io/v1", "SelfSubjectAccessReview"
		review.Status.Allowed = r.Header.Get(auth.HeaderImpersonateUser) == "allowed@example.com"
		writeJSON(w, review)
	}))
	t.Cleanup(srv.Close)
	b := &clientBundle{authz: reviewClient(t, srv.URL), id: "default", sharesChecks: true}
	s := &Service{}
	for person, want := range map[string]bool{"refused@example.com": false, "allowed@example.com": true} {
		if ok, err := s.mayListShown(wideCaller(person), b, "", "nodes", ""); err != nil || ok != want {
			t.Errorf("%s: answer = %v, %v, want the person's own %v", person, ok, err, want)
		}
	}
	if n := shared.Load(); n != 1 {
		t.Errorf("the shared name was tried %d times, want once and its refusal kept", n)
	}
}

// An allow of one cluster's groups is no answer on another: the same people, allowed on a and refused on b.
func TestAGroupsAllowIsKeptPerCluster(t *testing.T) {
	asked := map[string]*atomic.Int32{"a": {}, "b": {}}
	bundles := map[string]*clientBundle{}
	for id, allows := range map[string]bool{"a": true, "b": false} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			asked[id].Add(1)
			body, _ := io.ReadAll(r.Body)
			review := &authorizationv1.SelfSubjectAccessReview{}
			_, _, _ = scheme.Codecs.UniversalDeserializer().Decode(body, nil, review)
			review.APIVersion, review.Kind, review.Status.Allowed = "authorization.k8s.io/v1", "SelfSubjectAccessReview", allows
			writeJSON(w, review)
		}))
		t.Cleanup(srv.Close)
		cfg := &rest.Config{Host: srv.URL, QPS: -1}
		wrapPerson(cfg, id)
		cs, err := kubernetes.NewForConfig(cfg)
		if err != nil {
			t.Fatal(err)
		}
		bundles[id] = &clientBundle{authz: cs.AuthorizationV1(), id: cluster.ID(id), sharesChecks: true}
	}
	s := &Service{}
	reader := func(user string) context.Context {
		return auth.WithPayload(context.Background(), auth.TokenPayload{UserID: user, Email: user, Roles: map[string]string{"a": "Read", "b": "Read"}})
	}
	if ok, _ := s.mayListShown(reader("alice@example.com"), bundles["a"], "", "pods", ""); !ok {
		t.Fatal("refused on a, which allows the group")
	}
	if ok, _ := s.mayListShown(reader("bob@example.com"), bundles["b"], "", "pods", ""); ok {
		t.Error("allowed on b by a's answer for the same groups")
	}
	if a, b := asked["a"].Load(), asked["b"].Load(); a != 1 || b != 2 {
		t.Errorf("asked a %d times and b %d, want once on a and on b as the groups and then as bob", a, b)
	}
}

// The transport sends a marked check under the shared name with exactly the person's groups, or sends nothing.
func TestTheGroupCheckGoesOutAsTheSharedNameWithThePersonsGroupsOrNotAtAll(t *testing.T) {
	var got *http.Request
	base := roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		got = r
		return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Request: r}, nil
	})
	cfg := &rest.Config{}
	wrapPerson(cfg, "prod")
	rt := cfg.WrapTransport(base)
	alice := auth.TokenPayload{Email: "alice@example.com", Roles: map[string]string{"prod": "Read"}}
	_, groups := alice.Impersonation("prod")
	send := func(p *auth.TokenPayload, mark *groupCheck) error {
		got = nil
		ctx := context.Background()
		if mark != nil {
			ctx = context.WithValue(ctx, groupCheckCtx{}, mark)
		}
		if p != nil {
			ctx = auth.WithPayload(ctx, *p)
		}
		_, err := rt.RoundTrip(httptest.NewRequest("POST", "https://k8s/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", nil).WithContext(ctx))
		return err
	}
	mark := &groupCheck{groups: groups}
	if err := send(&alice, mark); err != nil {
		t.Fatal(err)
	}
	if user := got.Header.Get(auth.HeaderImpersonateUser); user != groupCheckUser || !mark.sent.Load() {
		t.Errorf("sent as %q (marked sent %v), want %q", user, mark.sent.Load(), groupCheckUser)
	}
	if g := got.Header.Values(auth.HeaderImpersonateGroup); !slices.Equal(g, groups) {
		t.Errorf("groups %v, want the person's %v", g, groups)
	}
	person := func(email string, roles map[string]string) *auth.TokenPayload {
		return &auth.TokenPayload{Email: email, Roles: roles}
	}
	read := map[string]string{"prod": "Read"}
	for _, c := range []struct {
		name string
		p    *auth.TokenPayload
		mark *groupCheck
	}{
		{"no person", nil, &groupCheck{groups: groups}},
		{"the alert investigator", &auth.TokenPayload{UserID: "system", Email: auth.UserInvestigator, System: auth.SystemInvestigator}, &groupCheck{groups: []string{auth.GroupInvestigator}}},
		{"another token of no person", &auth.TokenPayload{UserID: "probe", System: "probe"}, &groupCheck{groups: []string{auth.GroupAuthenticated}}},
		{"other groups than the person's", &alice, &groupCheck{groups: []string{auth.GroupAdmin, auth.GroupAuthenticated}}},
		{"no groups", &alice, &groupCheck{}},
		{"a person named as the shared checks", person(groupCheckUser, read), &groupCheck{groups: groups}},
		{"a person under the shared prefix", person(groupCheckUserPrefix+"other", read), &groupCheck{groups: groups}},
		{"system:anonymous", person("system:anonymous", read), &groupCheck{groups: groups}},
		{"system:kube-controller-manager", person("system:kube-controller-manager", read), &groupCheck{groups: groups}},
	} {
		if err := send(c.p, c.mark); err == nil || got != nil || c.mark.sent.Load() {
			t.Errorf("%s: sent %v (marked %v), err %v; want nothing sent", c.name, got != nil, c.mark.sent.Load(), err)
		}
	}
	// an unmarked request goes out as the person
	if err := send(&alice, nil); err != nil || got.Header.Get(auth.HeaderImpersonateUser) != "alice@example.com" {
		t.Errorf("an unmarked request: %v, sent as %q", err, got.Header.Get(auth.HeaderImpersonateUser))
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// A client without the shared checks' transport shares nothing: the review it sends is the person's, which is no
// group's answer.
func TestAClientWithoutTheGroupCheckTransportSharesNothing(t *testing.T) {
	var mu sync.Mutex
	users := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := r.Header.Get(auth.HeaderImpersonateUser)
		mu.Lock()
		users[user]++
		mu.Unlock()
		body, _ := io.ReadAll(r.Body)
		review := &authorizationv1.SelfSubjectAccessReview{}
		_, _, _ = scheme.Codecs.UniversalDeserializer().Decode(body, nil, review)
		review.APIVersion, review.Kind = "authorization.k8s.io/v1", "SelfSubjectAccessReview"
		review.Status.Allowed = user == "alice@example.com" // a binding of alice by name
		writeJSON(w, review)
	}))
	t.Cleanup(srv.Close)
	cfg := &rest.Config{Host: srv.URL, QPS: -1}
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return auth.ImpersonationRoundTripper(rt, "default") })
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	b := &clientBundle{authz: cs.AuthorizationV1(), id: "default", sharesChecks: true}
	s := &Service{}
	if ok, _ := s.mayListShown(wideCaller("alice@example.com"), b, "", "pods", ""); !ok {
		t.Error("alice refused, whom the cluster allows by name")
	}
	if ok, _ := s.mayListShown(wideCaller("bob@example.com"), b, "", "pods", ""); ok {
		t.Error("bob allowed by alice's answer")
	}
	mu.Lock()
	defer mu.Unlock()
	if users[groupCheckUser] != 0 {
		t.Errorf("%d reviews under the shared name without its transport", users[groupCheckUser])
	}
}

// The clusters listed out under no registered id are named, so a cluster meant to be left out is not shared from under
// a misspelling.
func TestExcludedClustersThatAreNoRegisteredIdAreNamed(t *testing.T) {
	t.Cleanup(func() { sharedReadChecks.on, sharedReadChecks.exclude = false, nil })
	s := &Service{registry: &mockRegistry{clusters: map[cluster.ID]cluster.Info{"prod": extCluster("prod"), "lab": extCluster("lab")}}}
	sharedReadChecks.on, sharedReadChecks.exclude = true, []string{"prod", "Prod Cluster", "labb"}
	if got := s.unknownExcludes(context.Background()); !slices.Equal(got, []string{"Prod Cluster", "labb"}) {
		t.Errorf("named %v, want the two entries no cluster has", got)
	}
	sharedReadChecks.on = false
	if got := s.unknownExcludes(context.Background()); got != nil {
		t.Errorf("named %v with the switch off", got)
	}
}

// Can-i, writes, logs, Secrets, the events and live lists' checks, an AI tool call's checks and a token that is no
// person's are asked as that identity even while the groups' allow of the same question is kept.
func TestOtherChecksAreAskedAsThePersonWhileTheGroupsAllowIsKept(t *testing.T) {
	api := &clusterAPI{namespaces: []string{"a"}, reviewGroups: func(_ string, groups []string, _ authorizationv1.ResourceAttributes) bool {
		return hasGroup(groups, auth.GroupViewer) || hasGroup(groups, auth.GroupInvestigator)
	}, may: func(string, string, string, string, string) bool { return true }}
	s, b := api.start(t)
	b.sharesChecks = true
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

// The shared checks and their transport are used only from the screens served from kubeast:cache — the overview's
// counts, the namespace list and a grant's namespaces, the node list, the pod rows and the pods of a node — and from
// their own code: every use of their names in the package (calls, method values, package-level values), counted per
// function, and the shared name written nowhere else in the module or the services beside it.
func TestOnlyTheChecksOfScreensServedFromKubeastCacheAreShared(t *testing.T) {
	want := map[string]map[string]int{
		"mayDoShown":          {"mayGetNamespace": 1, "mayListShown": 1},
		"mayListShown":        {"cachedNamespaces": 1, "cachedNodes": 1, "mayListAll": 1, "mayListPods": 1, "overviewIdentityAllowed": 1},
		"mayListAll":          {"keepListable": 1, "keepListableIn": 1, "podListAccess": 1},
		"mayListPods":         {"podListAccess": 1},
		"mayGetNamespace":     {"cachedScopedNamespaces": 1},
		"podListAccess":       {"callerPodRows": 1, "podsOnNodeOf": 1},
		"askAsGroups":         {"mayDoShown": 1},
		"groupCheckCtx":       {"askAsGroups": 1, "groupCheckTransport.RoundTrip": 1},
		"groupCheckTransport": {"wrapPerson": 1},
		"groupCheckUser":      {"groupCheckTransport.RoundTrip": 1},
		"sharesChecks":        {"buildClientBundle": 1, "groupCheckKey": 1, "type clientBundle": 1},
	}
	got := map[string]map[string]int{}
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
		count := func(where string, n ast.Node) {
			ast.Inspect(n, func(n ast.Node) bool {
				if id, ok := n.(*ast.Ident); ok {
					if _, watched := want[id.Name]; watched {
						if got[id.Name] == nil {
							got[id.Name] = map[string]int{}
						}
						got[id.Name][where]++
					}
				}
				return true
			})
		}
		for _, d := range file.Decls {
			switch d := d.(type) {
			case *ast.FuncDecl:
				where := d.Name.Name
				if d.Recv != nil && len(d.Recv.List) == 1 {
					typ := d.Recv.List[0].Type
					if star, ok := typ.(*ast.StarExpr); ok {
						typ = star.X
					}
					if id, ok := typ.(*ast.Ident); ok && id.Name != "Service" {
						where = id.Name + "." + where
					}
				}
				if d.Body != nil {
					count(where, d.Body)
				}
			case *ast.GenDecl:
				for _, spec := range d.Specs {
					switch spec := spec.(type) {
					case *ast.TypeSpec:
						count("type "+spec.Name.Name, spec.Type)
					case *ast.ValueSpec:
						for _, v := range spec.Values {
							count("package level", v)
						}
					}
				}
			}
		}
	}
	for name, uses := range want {
		if fmt.Sprint(got[name]) != fmt.Sprint(uses) {
			t.Errorf("%s is used in %v, want %v: an allow shared by group stands only for what a screen served from kubeast:cache shows", name, got[name], uses)
		}
	}
	// the shared name in the code of this module, tool-server and the shared packages: here only
	for _, root := range []string{"../..", "../../../tool-server", "../../../pkg"} {
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			if filepath.Clean(path) == filepath.Clean("../../internal/k8s/shared_read_checks.go") {
				return nil
			}
			if b, err := os.ReadFile(path); err == nil && strings.Contains(string(b), "kubeast:group-check") {
				t.Errorf("%s names the shared checks' user; only shared_read_checks.go sends it", path)
			}
			return nil
		})
	}
}

// reviewClient is the authorization client of a config that sends to url as the person in each request's context.
func reviewClient(t *testing.T, url string) authorizationv1client.AuthorizationV1Interface {
	t.Helper()
	cfg := &rest.Config{Host: url, QPS: -1}
	wrapPerson(cfg, "default")
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
		name                string
		id                  string
		on, groupSent, want bool
	}{
		{"on", "a", true, true, true},
		{"the cluster listed out", "b", true, true, false},
		{"the switch off", "a", false, true, false},
		{"no groups sent (auth.impersonation.enabled off)", "a", true, false, false},
	} {
		impersonationEnabled = c.groupSent
		sharedReadChecks.on, sharedReadChecks.exclude = c.on, []string{"b"}
		if got := build(c.id).sharesChecks; got != c.want {
			t.Errorf("%s: shares %v, want %v", c.name, got, c.want)
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
	suffix, ok := strings.CutPrefix(groupCheckUser, groupCheckUserPrefix)
	if !ok || !regexp.MustCompile(`^[0-9a-f]{8}$`).MatchString(suffix) {
		t.Errorf("shared name %q, want %s and eight hex digits", groupCheckUser, groupCheckUserPrefix)
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
	for _, name := range []string{groupCheckUser, groupCheckUserPrefix + "other", "system:anonymous"} {
		if ok, err := s.mayListShown(wideCaller(name), b, "", "nodes", ""); err != nil || !ok {
			t.Fatalf("%s: %v %v", name, ok, err)
		}
	}
	if ok, err := s.mayListShown(wideCaller("next@example.com"), b, "", "nodes", ""); err != nil || !ok {
		t.Fatalf("next: %v %v", ok, err)
	}
	// one as the person of that name, one shared for next: no such person's answer was kept for the groups
	if n, other, anon := api.count(groupCheckUser), api.count(groupCheckUserPrefix+"other"), api.count("system:anonymous"); n != 2 || other != 1 || anon != 1 {
		t.Errorf("%d reviews under the shared name (want 2), %d as the prefixed person and %d as system:anonymous (want 1 each)", n, other, anon)
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
			b.sharesChecks = true
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
