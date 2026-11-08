package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// reviewAPI answers SelfSubjectAccessReviews as the API server does, by the identity the request impersonates, and
// counts them per user.
type reviewAPI struct {
	delay time.Duration
	allow func(user string, groups []string, ra authorizationv1.ResourceAttributes) bool

	mu            sync.Mutex
	asks          map[string]int
	running, most int
}

func (a *reviewAPI) bundle(t testing.TB) *clientBundle {
	t.Helper()
	a.asks = map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		user := r.Header.Get(auth.HeaderImpersonateUser)
		a.asks[user]++
		a.running++
		if a.running > a.most {
			a.most = a.running
		}
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			a.running--
			a.mu.Unlock()
		}()
		time.Sleep(a.delay)
		body, _ := io.ReadAll(r.Body)
		review := &authorizationv1.SelfSubjectAccessReview{}
		if _, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, review); err != nil || review.Spec.ResourceAttributes == nil {
			http.Error(w, "unreadable review", http.StatusBadRequest)
			return
		}
		review.APIVersion, review.Kind = "authorization.k8s.io/v1", "SelfSubjectAccessReview"
		review.Status.Allowed = a.allow(user, r.Header.Values(auth.HeaderImpersonateGroup), *review.Spec.ResourceAttributes)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(review)
	}))
	t.Cleanup(srv.Close)
	cfg := &rest.Config{Host: srv.URL, QPS: -1}
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return auth.ImpersonationRoundTripper(rt, "default") })
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return &clientBundle{authz: cs.AuthorizationV1()}
}

func (a *reviewAPI) count(user string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.asks[user]
}

func (a *reviewAPI) mostAtOnce() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.most
}

func callerCtx(user string) context.Context {
	return auth.WithPayload(context.Background(), auth.TokenPayload{UserID: user, Email: user})
}

// overviewInformersWithPods are synced informers with a Deployment in each of b, e and f.
func overviewInformersWithPods(t *testing.T) *clusterInformers {
	t.Helper()
	objs := []runtime.Object{}
	for _, ns := range []string{"b", "e", "f"} {
		objs = append(objs,
			&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "d"}},
			&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "s"}},
			overviewPod(ns, "p", corev1.PodRunning))
	}
	ci := newClusterInformers(fake.NewSimpleClientset(objs...), time.Hour, nil)
	t.Cleanup(ci.stopNow)
	if !ci.waitSynced(context.Background(), 5*time.Second) {
		t.Fatal("informers did not sync")
	}
	return ci
}

// Fifty requests of one person at the same moment are one question to the cluster.
func TestAccessChecksOfOneCallerAtOnceAskTheClusterOnce(t *testing.T) {
	api := &reviewAPI{delay: 30 * time.Millisecond, allow: func(string, []string, authorizationv1.ResourceAttributes) bool { return true }}
	b := api.bundle(t)
	s := &Service{cache: cache.New("", 0, 0, "")}
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := s.mayListGroup(callerCtx("alice"), b, "apps", "deployments", "")
			if err != nil || !ok {
				t.Errorf("answer = %v, %v", ok, err)
			}
		}()
	}
	wg.Wait()
	t.Logf("reviews for 50 requests of one caller: %d", api.count("alice"))
	if got := api.count("alice"); got != 1 {
		t.Errorf("the cluster was asked %d times for 50 requests of one caller, want 1", got)
	}
}

// Each identity gets the cluster's answer about itself, with others asking the same question at the same moment:
// other people, and one person whose role on the cluster differs.
func TestAccessChecksAreNotSharedBetweenIdentities(t *testing.T) {
	api := &reviewAPI{delay: 20 * time.Millisecond, allow: func(user string, groups []string, _ authorizationv1.ResourceAttributes) bool {
		if user == "alice" {
			return true
		}
		for _, g := range groups {
			if g == auth.GroupOperator {
				return true
			}
		}
		return false
	}}
	b := api.bundle(t)
	s := &Service{cache: cache.New("", 0, 0, "")}
	cases := []struct {
		name string
		ctx  context.Context
		want bool
	}{
		{"alice", callerCtx("alice"), true},
		{"bob", callerCtx("bob"), false},
		{"carol with Read", auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "carol", Email: "carol", Roles: map[string]string{"default": "read"}}), false},
		{"carol with Write", auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "carol", Email: "carol", Roles: map[string]string{"default": "write"}}), true},
	}
	var wg sync.WaitGroup
	for _, c := range cases {
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ok, err := s.mayListGroup(c.ctx, b, "", "pods", "")
				if err != nil || ok != c.want {
					t.Errorf("%s: answer = %v, %v, want %v", c.name, ok, err, c.want)
				}
			}()
		}
	}
	wg.Wait()
	for user, want := range map[string]int{"alice": 1, "bob": 1, "carol": 2} {
		t.Logf("reviews for %s: %d", user, api.count(user))
		if got := api.count(user); got != want {
			t.Errorf("%s was asked about %d times, want %d", user, got, want)
		}
	}
}

// The overview's identity check is one question at a time per identity too.
func TestOverviewIdentityChecksOfOneCallerAtOnceAskTheClusterOnce(t *testing.T) {
	api := &reviewAPI{delay: 30 * time.Millisecond, allow: func(string, []string, authorizationv1.ResourceAttributes) bool { return true }}
	b := api.bundle(t)
	s := &Service{cache: cache.New("", 0, 0, "")}
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.overviewIdentityAllowed(callerCtx("alice"), b); err != nil {
				t.Errorf("answer: %v", err)
			}
		}()
	}
	wg.Wait()
	t.Logf("identity reviews for 50 requests: %d", api.count("alice"))
	if got := api.count("alice"); got != 1 {
		t.Errorf("the cluster was asked %d times, want 1", got)
	}
}

// One request's questions go side by side, a bounded number at a time, and the answer reads as they did in turn.
func TestOverviewOfALimitedGrantAsksSideBySideAndAnswersTheSame(t *testing.T) {
	scope := []string{"a", "b", "c", "d", "e", "f"}
	// deployments in two namespaces only, services nowhere, the rest everywhere
	api := &reviewAPI{delay: 15 * time.Millisecond, allow: func(_ string, _ []string, ra authorizationv1.ResourceAttributes) bool {
		switch ra.Resource {
		case "deployments":
			return ra.Namespace == "b" || ra.Namespace == "e"
		case "services":
			return false
		}
		return true
	}}
	b := api.bundle(t)
	s := &Service{}
	ctx := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "scoped", Email: "scoped", Namespaces: map[string][]string{"default": scope}})
	ci := overviewInformersWithPods(t)
	ov := ci.overviewFor(scope)
	if err := s.keepListable(ctx, b, ci, scope, ov); err != nil {
		t.Fatal(err)
	}
	t.Logf("questions at once: %d (reviews %d)", api.mostAtOnce(), api.count("scoped"))
	if got := api.mostAtOnce(); got < 2 || got > 8 {
		t.Errorf("%d questions at once, want side by side and at most 8", got)
	}
	if got := api.count("scoped"); got != 4*len(scope) {
		t.Errorf("%d reviews, want one per kind and namespace (%d)", got, 4*len(scope))
	}
	refused, _ := ov["refused"].([]string)
	if fmt.Sprint(refused) != "[services]" {
		t.Errorf("refused = %v, want services alone", refused)
	}
	if ov["total_services"] != nil {
		t.Errorf("total_services = %v, want null", ov["total_services"])
	}
	if ov["total_deployments"] != ci.overviewFor([]string{"b", "e"})["total_deployments"] {
		t.Errorf("total_deployments = %v, want the two namespaces' count", ov["total_deployments"])
	}
}

// The pods' access check of a limited grant too, keeping the grant's order.
func TestPodAccessOfALimitedGrantAsksSideBySideInTheGrantsOrder(t *testing.T) {
	scope := make([]string, 20)
	for i := range scope {
		scope[i] = fmt.Sprintf("ns-%02d", i)
	}
	api := &reviewAPI{delay: 15 * time.Millisecond, allow: func(_ string, _ []string, ra authorizationv1.ResourceAttributes) bool {
		return ra.Namespace != "ns-03" && ra.Namespace != "ns-17"
	}}
	b := api.bundle(t)
	s := &Service{}
	ctx := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "scoped", Email: "scoped", Namespaces: map[string][]string{"default": scope}})
	all, allowed, err := s.podListAccess(ctx, b, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("questions at once: %d", api.mostAtOnce())
	if got := api.mostAtOnce(); got < 2 || got > 8 {
		t.Errorf("%d questions at once, want side by side and at most 8", got)
	}
	want := make([]string, 0, len(scope))
	for _, ns := range scope {
		if ns != "ns-03" && ns != "ns-17" {
			want = append(want, ns)
		}
	}
	if all || fmt.Sprint(allowed) != fmt.Sprint(want) {
		t.Errorf("all = %v, allowed = %v, want %v", all, allowed, want)
	}
}

// A remembered answer does not outlive its promised minute, and people who came together stop asking together.
func TestAccessCheckMemoriesEndAtDifferentMomentsWithinTheMinute(t *testing.T) {
	seen := map[time.Duration]bool{}
	least, longest := time.Hour, time.Duration(0)
	for i := 0; i < 2000; i++ {
		d := accessCheckTTL()
		seen[d] = true
		if d < least {
			least = d
		}
		if d > longest {
			longest = d
		}
	}
	t.Logf("memory between %v and %v, %d different values", least, longest, len(seen))
	if longest > podAccessTTL {
		t.Errorf("an answer kept %v, past the promised %v", longest, podAccessTTL)
	}
	if least < podAccessTTL*7/10 {
		t.Errorf("an answer kept only %v", least)
	}
	if longest-least < 8*time.Second {
		t.Errorf("memories end within %v of each other", longest-least)
	}
}
