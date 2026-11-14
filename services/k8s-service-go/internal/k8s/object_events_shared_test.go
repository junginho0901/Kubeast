package k8s

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// eventsCluster answers as an API server does, by the identity a request impersonates: access reviews, the ConfigMaps
// shop/app* and the events about them and about Node n1, noting every list of events and every review.
type eventsCluster struct {
	// may says whether user may list events in namespace ("" = across the cluster); list decides a real list when set,
	// as an authorizer that reads the field selector may decide otherwise than a review
	may  func(user, namespace string) bool
	list func(user, namespace string) bool
	// cacheRefused refuses the events to kubeast:cache; hold holds its lists of events until closed
	cacheRefused bool
	hold         chan struct{}

	mu                  sync.Mutex
	lists               map[string]int
	reviews             []apiCall
	cacheNow, cacheMost int
}

var eventsMade = metav1.NewTime(time.Date(2026, 11, 1, 2, 3, 4, 0, time.UTC))

// clusterEvents are the events the cluster holds: three about each ConfigMap of shop, two about Node n1 in two
// namespaces, and one about something else.
func clusterEvents() []corev1.Event {
	var out []corev1.Event
	event := func(ns, kind, name, reason string, minute int) corev1.Event {
		var uid types.UID
		if kind == "ConfigMap" {
			uid = "c0f1" // the UID eventsCluster gives every ConfigMap
		}
		return corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Name: name + "." + reason, Namespace: ns, ResourceVersion: "9"},
			InvolvedObject: corev1.ObjectReference{Kind: kind, Name: name, Namespace: ns, UID: uid},
			Reason:         reason, Message: reason + " of " + name, Type: corev1.EventTypeNormal, Count: int32(minute + 1),
			FirstTimestamp: eventsMade, LastTimestamp: metav1.NewTime(eventsMade.Add(time.Duration(minute) * time.Minute)),
			Source: corev1.EventSource{Component: "controller"},
		}
	}
	for i := 0; i < 30; i++ {
		name := fmt.Sprintf("app%02d", i)
		out = append(out, event("shop", "ConfigMap", name, "Updated", 2), event("shop", "ConfigMap", name, "Synced", 0), event("shop", "ConfigMap", name, "Rejected", 1))
	}
	out = append(out, event("shop", "ConfigMap", "app", "Updated", 2), event("shop", "ConfigMap", "app", "Synced", 0))
	out = append(out, event("default", "Node", "n1", "NodeReady", 3), event("kube-system", "Node", "n1", "Rebooted", 1))
	return append(out, event("shop", "Pod", "web-0", "Pulled", 0))
}

func (a *eventsCluster) listsBy(user string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lists[user]
}

// listsByCallers is the lists of events made as anyone but kubeast:cache.
func (a *eventsCluster) listsByCallers() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for user, c := range a.lists {
		if user != overviewCacheUser {
			n += c
		}
	}
	return n
}

func (a *eventsCluster) reviewsSeen() []apiCall {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]apiCall(nil), a.reviews...)
}

func (a *eventsCluster) serve(w http.ResponseWriter, r *http.Request) {
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
		a.reviews = append(a.reviews, apiCall{user: user, verb: ra.Verb, resource: ra.Resource, namespace: ra.Namespace})
		a.mu.Unlock()
		review.APIVersion, review.Kind = "authorization.k8s.io/v1", "SelfSubjectAccessReview"
		review.Status.Allowed = ra.Verb == "list" && ra.Resource == "events" && a.may(user, ra.Namespace)
		writeJSON(w, review)
		return
	}
	if name, ok := strings.CutPrefix(r.URL.Path, "/api/v1/namespaces/shop/configmaps/"); ok {
		writeJSON(w, &corev1.ConfigMap{
			TypeMeta:   metav1.TypeMeta{Kind: "ConfigMap", APIVersion: "v1"},
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "shop", UID: "c0f1", ResourceVersion: "5", CreationTimestamp: eventsMade},
		})
		return
	}
	namespace := ""
	switch {
	case r.URL.Path == "/api/v1/events":
	case strings.HasPrefix(r.URL.Path, "/api/v1/namespaces/") && strings.HasSuffix(r.URL.Path, "/events"):
		namespace = strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v1/namespaces/"), "/events")
	default:
		http.NotFound(w, r)
		return
	}
	a.mu.Lock()
	if a.lists == nil {
		a.lists = map[string]int{}
	}
	a.lists[user]++
	if user == overviewCacheUser {
		a.cacheNow++
		a.cacheMost = max(a.cacheMost, a.cacheNow)
	}
	a.mu.Unlock()
	if user == overviewCacheUser {
		defer func() {
			a.mu.Lock()
			a.cacheNow--
			a.mu.Unlock()
		}()
		if a.hold != nil {
			select {
			case <-a.hold:
			case <-r.Context().Done():
				return
			}
		}
	}
	allowed := !a.cacheRefused
	if user != overviewCacheUser {
		decide := a.may
		if a.list != nil {
			decide = a.list
		}
		allowed = decide(user, namespace)
	}
	if !allowed {
		where := "at the cluster scope"
		if namespace != "" {
			where = fmt.Sprintf("in the namespace %q", namespace)
		}
		writeStatus(w, http.StatusForbidden, "Forbidden", fmt.Sprintf("events is forbidden: User %q cannot list resource \"events\" in API group \"\" %s", user, where))
		return
	}
	selector := r.URL.Query().Get("fieldSelector")
	list := &corev1.EventList{TypeMeta: metav1.TypeMeta{Kind: "EventList", APIVersion: "v1"}, ListMeta: metav1.ListMeta{ResourceVersion: "9"}}
	for _, e := range clusterEvents() {
		if (namespace == "" || e.Namespace == namespace) && selector == "involvedObject.name="+e.InvolvedObject.Name+",involvedObject.kind="+e.InvolvedObject.Kind {
			list.Items = append(list.Items, e)
		}
	}
	writeJSON(w, list)
}

// start serves a to a bundle that calls it as each caller and as kubeast:cache.
func (a *eventsCluster) start(t *testing.T) (*Service, *clientBundle) {
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
	b := &clientBundle{clientset: cs, authz: cs.AuthorizationV1(), cacheClient: cacheClient, id: "default"}
	s := &Service{cache: cache.New("", 0, 0, "")}
	s.defaultBundle.Store(b)
	return s, b
}

// ownEventsAnswer is what a describe says of the events the caller's own list gives.
func ownEventsAnswer(t *testing.T, cs kubernetes.Interface, ctx context.Context, namespace, kind, name string) string {
	t.Helper()
	events, err := cs.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=%s", name, kind)})
	want := map[string]interface{}{}
	setEvents(want, events, err, about())
	return answerJSON(t, map[string]interface{}{"events": want["events"], "events_error": want["events_error"]})
}

func eventsAnswer(t *testing.T, s *Service, ctx context.Context, namespace, kind, name string) string {
	t.Helper()
	got := map[string]interface{}{}
	s.setObjectEvents(ctx, got, namespace, kind, name, about())
	return answerJSON(t, map[string]interface{}{"events": got["events"], "events_error": got["events_error"]})
}

// Forty different people opening one drawer at one moment have its events read about twice as kubeast:cache and never
// as themselves, and each drawer shows what that person's own list of them shows.
func TestDescribeEventsOfACrowdAreOneReadForEveryoneWhoMayListThem(t *testing.T) {
	api := &eventsCluster{may: func(string, string) bool { return true }, hold: make(chan struct{})}
	s, b := api.start(t)
	const n = 40
	answers := make([]map[string]interface{}, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i], errs[i] = s.DescribeConfigMap(wideCaller(fmt.Sprintf("u%02d@example.com", i)), "shop", "app")
		}()
	}
	eventually(t, 3*time.Second, func() bool { return len(api.reviewsSeen()) >= n && api.listsBy(overviewCacheUser) >= 1 })
	time.Sleep(100 * time.Millisecond)
	close(api.hold)
	wg.Wait()
	cacheLists, callerLists := api.listsBy(overviewCacheUser), api.listsByCallers()
	t.Logf("%d drawers at once: %d lists of events as kubeast:cache, %d as the callers, %d reviews", n, cacheLists, callerLists, len(api.reviewsSeen()))
	if cacheLists < 1 || cacheLists > 2 || callerLists != 0 {
		t.Errorf("lists of events: %d as kubeast:cache (want 1 or 2), %d as the callers (want 0)", cacheLists, callerLists)
	}
	for i, got := range answers {
		if errs[i] != nil || got["name"] != "app" {
			t.Fatalf("drawer %d: %v %v", i, got["name"], errs[i])
		}
		gotEvents := answerJSON(t, map[string]interface{}{"events": got["events"], "events_error": got["events_error"]})
		if want := ownEventsAnswer(t, b.clientset, wideCaller(fmt.Sprintf("u%02d@example.com", i)), "shop", "ConfigMap", "app"); gotEvents != want {
			t.Errorf("drawer %d:\n got %s\nwant %s", i, gotEvents, want)
		}
	}
}

// The events a describe shows are what the caller's own list shows, whatever its identity may list: a refusal, a
// review that refuses what the list would allow, and an object of the cluster, for which the review asks across it.
func TestDescribeEventsKeepToWhatEachIdentityMayList(t *testing.T) {
	may := map[string][]string{"wide@example.com": {"", "shop", "default", "kube-system"}, "shop@example.com": {"shop"}, "selector@example.com": {}}
	lists := map[string][]string{"wide@example.com": may["wide@example.com"], "shop@example.com": {"shop"}, "selector@example.com": {"shop", ""}}
	in := func(grants map[string][]string) func(string, string) bool {
		return func(user, namespace string) bool {
			for _, ns := range grants[user] {
				if ns == namespace {
					return true
				}
			}
			return false
		}
	}
	api := &eventsCluster{may: in(may), list: in(lists)}
	s, b := api.start(t)
	objects := []struct{ namespace, kind, name string }{{"shop", "ConfigMap", "app"}, {"", "Node", "n1"}}
	for _, user := range []string{"wide@example.com", "shop@example.com", "selector@example.com", "none@example.com"} {
		for _, o := range objects {
			got := eventsAnswer(t, s, wideCaller(user), o.namespace, o.kind, o.name)
			want := ownEventsAnswer(t, b.clientset, wideCaller(user), o.namespace, o.kind, o.name)
			if got != want {
				t.Errorf("%s, %s %s:\n got %s\nwant %s", user, o.kind, o.name, got, want)
			}
		}
	}
	for _, r := range api.reviewsSeen() {
		if r.verb != "list" || r.resource != "events" {
			t.Errorf("a review asked %s %s, want list events", r.verb, r.resource)
		}
	}
}

// A drawer of an object of the cluster is shared only with identities that may list events across the cluster, and the
// review asks that question.
func TestNodeEventsAreSharedWithIdentitiesThatMayListEventsAcrossTheCluster(t *testing.T) {
	api := &eventsCluster{may: func(user, namespace string) bool { return user == "wide@example.com" }}
	s, b := api.start(t)
	got := eventsAnswer(t, s, wideCaller("wide@example.com"), "", "Node", "n1")
	if want := ownEventsAnswer(t, b.clientset, wideCaller("wide@example.com"), "", "Node", "n1"); got != want || !strings.Contains(got, "Rebooted") {
		t.Errorf("the node's events:\n got %s\nwant %s", got, want)
	}
	reviews := api.reviewsSeen()
	if api.listsBy(overviewCacheUser) != 1 || api.listsBy("wide@example.com") != 1 || len(reviews) != 1 || reviews[0].namespace != "" {
		t.Errorf("lists as kubeast:cache %d (want 1), as the caller %d (want only the test's own 1), reviews %+v (want one across the cluster)", api.listsBy(overviewCacheUser), api.listsBy("wide@example.com"), reviews)
	}
}

// When kubeast:cache may not list the events, each drawer lists them as its viewer, as before, and the refused read is
// not tried again for every drawer.
func TestDescribeEventsAreTheCallersOwnListWhenTheCacheIdentityIsRefused(t *testing.T) {
	api := &eventsCluster{may: func(user, namespace string) bool { return user != "none@example.com" }, cacheRefused: true}
	s, b := api.start(t)
	users := []string{"a@example.com", "b@example.com", "none@example.com"}
	for _, user := range users {
		got := eventsAnswer(t, s, wideCaller(user), "shop", "ConfigMap", "app")
		if want := ownEventsAnswer(t, b.clientset, wideCaller(user), "shop", "ConfigMap", "app"); got != want {
			t.Errorf("%s:\n got %s\nwant %s", user, got, want)
		}
	}
	for _, user := range users {
		if n := api.listsBy(user); n != 2 {
			t.Errorf("%s listed the events %d times, want its own once and the test's once", user, n)
		}
	}
	if n := api.listsBy(overviewCacheUser); n != 1 {
		t.Errorf("kubeast:cache was asked for the events %d times, want once: its refusal holds for the next drawers", n)
	}
}

// Shared reads of the events of many objects keep to the cluster's places for lists of events.
func TestSharedDescribeEventListsTakeTheirTurn(t *testing.T) {
	api := &eventsCluster{may: func(string, string) bool { return true }, hold: make(chan struct{})}
	s, _ := api.start(t)
	const n = 30
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got := map[string]interface{}{}
			s.setObjectEvents(wideCaller(fmt.Sprintf("u%02d@example.com", i)), got, "shop", "ConfigMap", fmt.Sprintf("app%02d", i), about())
		}()
	}
	eventually(t, 3*time.Second, func() bool { api.mu.Lock(); defer api.mu.Unlock(); return api.cacheNow >= 4 })
	time.Sleep(300 * time.Millisecond)
	api.mu.Lock()
	most := api.cacheMost
	api.mu.Unlock()
	close(api.hold)
	wg.Wait()
	cacheLists, callerLists := api.listsBy(overviewCacheUser), api.listsByCallers()
	t.Logf("%d objects at once: at most %d lists as kubeast:cache at a time, %d in all, %d as the callers", n, most, cacheLists, callerLists)
	if most > defaultEventLists || cacheLists != n || callerLists != 0 {
		t.Errorf("at most %d lists at once (want %d or fewer), %d as kubeast:cache (want %d), %d as the callers (want 0)", most, defaultEventLists, cacheLists, n, callerLists)
	}
}

// A list of events that fails on its way to the API server says so without the server's address; a refusal keeps the
// cluster's words.
func TestAnEventListThatFailsOnTheWayNamesNoAddress(t *testing.T) {
	api := &eventsAPI{hold: make(chan struct{}), refuse: map[string]bool{"refused@example.com": true}}
	s, _ := api.start(t)
	ctx, cancel := context.WithTimeout(wideCaller("late@example.com"), 300*time.Millisecond)
	defer cancel()
	got, err := s.DescribeConfigMap(ctx, "shop", "app")
	close(api.hold)
	reason := fmt.Sprint(got["events_error"])
	if err != nil || got["name"] != "app" || got["events"] != nil || reason == "" || reason == "<nil>" ||
		strings.Contains(reason, "127.0.0.1") || strings.Contains(reason, "http") || strings.Contains(reason, "/api/v1") {
		t.Errorf("the drawer whose list failed: %v, events %v, events_error %q", err, got["events"], reason)
	}
	refused, err := s.DescribeConfigMap(wideCaller("refused@example.com"), "shop", "app")
	if want := `events is forbidden: User "refused@example.com" cannot list resource "events" in the namespace "shop"`; err != nil || refused["events_error"] != want {
		t.Errorf("the refused drawer: %v, events_error %q, want %q", err, refused["events_error"], want)
	}
	dial := &url.Error{Op: "Get", URL: "https://10.0.0.1:6443/api/v1/namespaces/shop/events?fieldSelector=x", Err: errors.New("dial tcp 10.0.0.1:6443: connect: connection refused")}
	answer := map[string]interface{}{}
	setEvents(answer, nil, dial, about())
	if r := fmt.Sprint(answer["events_error"]); strings.Contains(r, "10.0.0.1") || strings.Contains(r, "/api/v1") {
		t.Errorf("a list that could not reach the server says %q", r)
	}
}
