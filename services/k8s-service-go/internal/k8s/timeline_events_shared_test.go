package k8s

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// windowCluster answers as an API server does, by the identity a request goes as: access reviews, the events of
// windowEvents in pages of the asked limit with a field selector of involvedObject.name and type, and empty lists of
// the rollout kinds. It notes every list of events by who made it.
type windowCluster struct {
	// may says whether user may list events in namespace ("" = across the cluster); list decides a real list when set,
	// as an authorizer that reads the field selector may decide otherwise than a review
	may  func(user, namespace string) bool
	list func(user, namespace string) bool
	// cacheRefused refuses the events to kubeast:cache; reviewFails answers every review 500, failReview those of the
	// namespaces it names; hold holds kubeast:cache's first pages until closed, onCacheRead runs as each is asked;
	// reviewsTogether holds each review until that many are under way at once, or five seconds have passed
	cacheRefused    bool
	reviewFails     bool
	failReview      func(namespace string) bool
	hold            chan struct{}
	released        sync.Once
	onCacheRead     func(namespace string)
	reviewsTogether int
	events          []corev1.Event

	mu          sync.Mutex
	pages       map[string]int // every page of events asked, by user
	firstPages  map[string]int // the first pages, one a read, by user
	reviews     int
	reviewsNow  int // reviews under way
	reviewsMost int // the most under way at once
	together    chan struct{}
	allTogether bool
}

// release lets the held pages go, once; start makes it run before the server closes, which waits for them.
func (a *windowCluster) release() {
	a.released.Do(func() {
		if a.hold != nil {
			close(a.hold)
		}
	})
}

func (a *windowCluster) count(user string) (pages, reads int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.pages[user], a.firstPages[user]
}

func (a *windowCluster) reviewsSeen() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.reviews
}

// reviewsAtOnce is the most reviews that were under way at one moment.
func (a *windowCluster) reviewsAtOnce() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.reviewsMost
}

// pagesByCallers is the pages of events asked as anyone but kubeast:cache.
func (a *windowCluster) pagesByCallers() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for user, c := range a.pages {
		if user != overviewCacheUser {
			n += c
		}
	}
	return n
}

func (a *windowCluster) serve(w http.ResponseWriter, r *http.Request) {
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
		a.reviewsNow++
		a.reviewsMost = max(a.reviewsMost, a.reviewsNow)
		if a.together == nil {
			a.together = make(chan struct{})
		}
		if a.reviewsTogether > 0 && a.reviewsNow >= a.reviewsTogether && !a.allTogether {
			close(a.together)
			a.allTogether = true
		}
		together := a.together
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			a.reviewsNow--
			a.mu.Unlock()
		}()
		if a.reviewsTogether > 0 {
			select {
			case <-together:
			case <-time.After(5 * time.Second):
			case <-r.Context().Done():
				return
			}
		}
		if a.reviewFails || (a.failReview != nil && a.failReview(ra.Namespace)) {
			writeStatus(w, http.StatusInternalServerError, "InternalError", "the review could not be answered")
			return
		}
		review.APIVersion, review.Kind = "authorization.k8s.io/v1", "SelfSubjectAccessReview"
		review.Status.Allowed = ra.Verb == "list" && ra.Resource == "events" && a.may(user, ra.Namespace)
		writeJSON(w, review)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/apis/apps/v1/") {
		kind := map[string]string{"deployments": "DeploymentList", "replicasets": "ReplicaSetList", "controllerrevisions": "ControllerRevisionList"}[r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]]
		writeJSON(w, map[string]interface{}{"apiVersion": "apps/v1", "kind": kind, "metadata": map[string]string{}, "items": []interface{}{}})
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
	q := r.URL.Query()
	first := q.Get("continue") == ""
	a.mu.Lock()
	if a.pages == nil {
		a.pages, a.firstPages = map[string]int{}, map[string]int{}
	}
	a.pages[user]++
	if first {
		a.firstPages[user]++
	}
	a.mu.Unlock()
	if user == overviewCacheUser && first && a.onCacheRead != nil {
		a.onCacheRead(namespace)
	}
	if user == overviewCacheUser && first && a.hold != nil {
		select {
		case <-a.hold:
		case <-r.Context().Done():
			return
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
	var picked []corev1.Event
	for _, e := range a.events {
		if namespace != "" && e.Namespace != namespace {
			continue
		}
		if !selected(e, q.Get("fieldSelector")) {
			continue
		}
		picked = append(picked, e)
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	from, _ := strconv.Atoi(q.Get("continue"))
	to := len(picked)
	meta := metav1.ListMeta{ResourceVersion: "9"}
	if limit > 0 && from+limit < to {
		to = from + limit
		meta.Continue = strconv.Itoa(to)
	}
	writeJSON(w, &corev1.EventList{TypeMeta: metav1.TypeMeta{Kind: "EventList", APIVersion: "v1"}, ListMeta: meta, Items: picked[from:to]})
}

// selected reads the field selectors the tests send: involvedObject.name and type, comma separated.
func selected(e corev1.Event, selector string) bool {
	for _, term := range strings.Split(selector, ",") {
		field, value, _ := strings.Cut(term, "=")
		switch field {
		case "":
		case "involvedObject.name":
			if e.InvolvedObject.Name != value {
				return false
			}
		case "type":
			if e.Type != value {
				return false
			}
		default:
			return false
		}
	}
	return true
}

// windowEvents: 1 234 events in bulk, 37 in shop and 5 in kube-system, each last seen at a second of its own over the
// 30 hours before base, every third a Warning; every seventh written as events.k8s.io writers write them (eventTime,
// a series), and one with no time but its creation.
func windowEvents(base time.Time) []corev1.Event {
	var out []corev1.Event
	i := 0
	for _, ns := range []struct {
		name string
		n    int
	}{{"bulk", 1234}, {"shop", 37}, {"kube-system", 5}} {
		for j := 0; j < ns.n; j++ {
			at := base.Add(-time.Duration(i*83+30) * time.Second)
			typ := corev1.EventTypeNormal
			if i%3 == 0 {
				typ = corev1.EventTypeWarning
			}
			e := corev1.Event{
				ObjectMeta:     metav1.ObjectMeta{Name: fmt.Sprintf("%s.e-%d", ns.name, j), Namespace: ns.name, CreationTimestamp: metav1.NewTime(at.Add(-time.Hour))},
				InvolvedObject: corev1.ObjectReference{Kind: "Pod", Namespace: ns.name, Name: fmt.Sprintf("pod-%d", j%10), APIVersion: "v1"},
				Type:           typ,
				Reason:         fmt.Sprintf("R%d", i),
				Message:        fmt.Sprintf("event %d of %s", j, ns.name),
				Source:         corev1.EventSource{Component: "kubelet"},
				FirstTimestamp: metav1.NewTime(at.Add(-time.Minute)),
				LastTimestamp:  metav1.NewTime(at),
				Count:          int32(j%4 + 1),
			}
			switch {
			case i == 50:
				e.FirstTimestamp, e.LastTimestamp, e.Count = metav1.Time{}, metav1.Time{}, 0
				e.CreationTimestamp = metav1.NewTime(at)
			case i%7 == 0:
				e.FirstTimestamp, e.LastTimestamp, e.Count = metav1.Time{}, metav1.Time{}, 0
				e.EventTime = metav1.NewMicroTime(at.Add(-2 * time.Minute))
				e.Series = &corev1.EventSeries{Count: 3, LastObservedTime: metav1.NewMicroTime(at)}
			}
			out = append(out, e)
			i++
		}
	}
	return out
}

// start serves a to a bundle that calls it as each caller and as kubeast:cache, and to a second one with no cache
// identity, whose every read is the caller's own.
func (a *windowCluster) start(t *testing.T) (shared, own *Service) {
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

// eventsSaid is what a read's answer says: the events by name in order and the counts, or the error.
func eventsSaid(events []corev1.Event, counts eventCounts, err error) string {
	if err != nil {
		return "error: " + err.Error()
	}
	names := make([]string, len(events))
	for i := range events {
		names[i] = events[i].Namespace + "/" + events[i].Name
	}
	return fmt.Sprintf("%d of %d (%d warnings): %s", len(events), counts.Total, counts.Warning, strings.Join(names, " "))
}

// timelineSaid is a timeline's answer without its time range, which says when it was asked.
func timelineSaid(t *testing.T, res *TimelineResult, err error) string {
	t.Helper()
	if err != nil {
		return "error: " + err.Error()
	}
	summary := map[string]interface{}{}
	for k, v := range res.Summary {
		if k != "time_range" {
			summary[k] = v
		}
	}
	return answerJSON(t, map[string]interface{}{"events": res.Events, "rollouts": res.RolloutHistory, "summary": summary})
}

// Forty different people opening the Timeline of every namespace at one moment have the cluster's events read twice as
// kubeast:cache (the first one's read and one for everyone who came during it) and never as themselves, and each gets
// what its own read gives. One who leaves while it waits gets its own error at once.
func TestACrowdOpeningTheTimelineReadsTheEventsOnceForEveryoneWhoMayListThem(t *testing.T) {
	api := &windowCluster{may: func(string, string) bool { return true }, hold: make(chan struct{}), events: windowEvents(time.Now().Truncate(time.Second))}
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
	// the first caller's read is held at its first page; every other caller waits for the read after it
	b, key := s.defaultBundle.Load(), eventWindowKey("", metav1.ListOptions{}, 500, "")
	if !eventually(t, 5*time.Second, func() bool { return b.eventWindows.Waiting(key) == n-1 }) {
		waiting := b.eventWindows.Waiting(key)
		api.release()
		wg.Wait()
		t.Fatalf("%d callers wait for the next read, want %d", waiting, n-1)
	}
	// one of them asking again, its review answered already, so the only wait is the read's
	ctx, cancel := context.WithTimeout(wideCaller("u00@example.com"), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := s.GetNamespaceTimeline(ctx, "", 24, 500, "")
	if took := time.Since(start); err == nil || !strings.Contains(err.Error(), "events not listed") || took > 2*time.Second {
		t.Errorf("the timeline whose request ended while it waited: %v after %v", err, took)
	}
	api.release()
	wg.Wait()

	pages, reads := api.count(overviewCacheUser)
	t.Logf("%d timelines at once: %d reads of the events as kubeast:cache (%d pages), %d pages as the callers, %d reviews", n, reads, pages, api.pagesByCallers(), api.reviewsSeen())
	if reads != 2 || api.pagesByCallers() != 0 {
		t.Errorf("reads of the events: %d as kubeast:cache (want 2), %d pages as the callers (want 0)", reads, api.pagesByCallers())
	}
	for i, got := range answers {
		res, err := own.GetNamespaceTimeline(wideCaller(fmt.Sprintf("u%02d@example.com", i)), "", 24, 500, "")
		if want := timelineSaid(t, res, err); got != want {
			t.Fatalf("timeline %d:\n got %s\nwant %s", i, got, want)
		}
	}
	if !strings.Contains(answers[0], `"events_shown":500`) || !strings.Contains(answers[0], `"total_events":1041`) {
		t.Errorf("the window holds 1 041 events of the last 24 hours, the newest 500 listed: %.300s", answers[0])
	}
}

// What the events reads give each identity is what its own list gives, whatever it may list: across the cluster, a grant
// limited to namespaces it may or may not list, a review that refuses what the list allows, a refusal; over windows,
// types, limits and a selector.
func TestTheSharedEventReadsAreEachIdentitysOwnAnswer(t *testing.T) {
	base := time.Now().Truncate(time.Second)
	events := windowEvents(base)
	may := map[string][]string{"wide@example.com": {"", "bulk", "shop", "kube-system"}, "two@example.com": {"bulk", "shop"}, "shop@example.com": {"shop"}}
	lists := map[string][]string{"wide@example.com": may["wide@example.com"], "two@example.com": may["two@example.com"], "shop@example.com": {"shop"}, "selector@example.com": {"", "bulk", "shop"}}
	in := func(grants map[string][]string) func(string, string) bool {
		return func(user, namespace string) bool { return slices.Contains(grants[user], namespace) }
	}
	api := &windowCluster{may: in(may), list: in(lists), events: events}
	s, own := api.start(t)
	callers := map[string]context.Context{
		"wide@example.com":     wideCaller("wide@example.com"),
		"two@example.com":      grantCaller("two@example.com", "bulk", "shop"),
		"shop@example.com":     grantCaller("shop@example.com", "shop", "kube-system"),
		"selector@example.com": wideCaller("selector@example.com"),
		"none@example.com":     wideCaller("none@example.com"),
	}
	cutoffs := []time.Time{{}, base.Add(-time.Hour), base.Add(-6 * time.Hour), base.Add(-24 * time.Hour), eventTimestamp(events[100]), eventTimestamp(events[50])}
	type ask struct {
		user, namespace, selector, eventType string
		cutoff                               time.Time
		limit                                int
	}
	var asks []ask
	for user := range callers {
		for _, namespace := range []string{"", "bulk", "shop"} {
			for _, cutoff := range cutoffs {
				for _, eventType := range []string{"", corev1.EventTypeNormal, corev1.EventTypeWarning} {
					for _, limit := range []int{7, 500} {
						asks = append(asks, ask{user, namespace, "", eventType, cutoff, limit})
					}
				}
			}
			asks = append(asks, ask{user, namespace, "involvedObject.name=pod-3", "", base.Add(-24 * time.Hour), 20}, ask{user, namespace, "type=Warning", "", time.Time{}, 20})
		}
	}
	got := make([]string, len(asks))
	for i, a := range asks {
		evs, counts, err := s.newestEventsSince(callers[a.user], a.namespace, metav1.ListOptions{FieldSelector: a.selector}, a.cutoff, a.limit, a.eventType)
		got[i] = eventsSaid(evs, counts, err)
	}
	callerPages := map[string]int{}
	for user := range callers {
		callerPages[user], _ = api.count(user)
	}
	// every event of the cluster, of the two namespaces, of shop alone, and a refusal
	for i, a := range asks {
		if a.namespace != "" || a.selector != "" || !a.cutoff.IsZero() || a.eventType != "" || a.limit != 500 {
			continue
		}
		want := map[string]string{"wide@example.com": "500 of 1276 (426 warnings)", "selector@example.com": "500 of 1276 (426 warnings)",
			"two@example.com": "500 of 1271 (424 warnings)", "shop@example.com": "37 of 37 (12 warnings)", "none@example.com": "error: events is forbidden"}[a.user]
		if !strings.HasPrefix(got[i], want) {
			t.Errorf("%s across the cluster: %.120s, want %s…", a.user, got[i], want)
		}
	}
	for i, a := range asks {
		evs, counts, err := own.newestEventsSince(callers[a.user], a.namespace, metav1.ListOptions{FieldSelector: a.selector}, a.cutoff, a.limit, a.eventType)
		if want := eventsSaid(evs, counts, err); got[i] != want {
			t.Fatalf("%+v:\n got %.400s\nwant %.400s", a, got[i], want)
		}
	}
	// the identities that may list the events read none of them themselves; shop asked kube-system, which it may not
	// list, as itself, and the others had only their own lists
	if callerPages["wide@example.com"] != 0 || callerPages["two@example.com"] != 0 {
		t.Errorf("pages of events as wide %d, as two %d, want 0", callerPages["wide@example.com"], callerPages["two@example.com"])
	}
	if callerPages["shop@example.com"] == 0 || callerPages["selector@example.com"] == 0 || callerPages["none@example.com"] == 0 {
		t.Errorf("pages of events as shop %d, selector %d, none %d: each should have read as itself", callerPages["shop@example.com"], callerPages["selector@example.com"], callerPages["none@example.com"])
	}
	if _, reads := api.count(overviewCacheUser); reads == 0 {
		t.Error("no read as kubeast:cache")
	}
}

// When kubeast:cache may not list the events, each timeline reads them as its viewer, as before, and the refused read
// is not tried again for every timeline.
func TestTimelineEventsAreTheCallersOwnWhenTheCacheIdentityIsRefused(t *testing.T) {
	api := &windowCluster{may: func(user, namespace string) bool { return user != "none@example.com" }, cacheRefused: true, events: windowEvents(time.Now().Truncate(time.Second))}
	s, own := api.start(t)
	cutoff := time.Now().Add(-6 * time.Hour)
	for _, user := range []string{"a@example.com", "b@example.com", "none@example.com", "a@example.com"} {
		for _, namespace := range []string{"", "shop"} {
			evs, counts, err := s.newestEventsSince(wideCaller(user), namespace, metav1.ListOptions{}, cutoff, 50, "")
			got := eventsSaid(evs, counts, err)
			evs, counts, err = own.newestEventsSince(wideCaller(user), namespace, metav1.ListOptions{}, cutoff, 50, "")
			if want := eventsSaid(evs, counts, err); got != want {
				t.Errorf("%s, %q:\n got %.300s\nwant %.300s", user, namespace, got, want)
			}
		}
	}
	if _, reads := api.count(overviewCacheUser); reads != 2 {
		t.Errorf("kubeast:cache was asked for the events %d times, want once in each of the two places: its refusal holds for the next reads", reads)
	}
}

// A review the API server fails (500, not a refusal) reads the events as the caller, as before the review: the answer is
// the caller's own read's, across the cluster, in a namespace and for a grant limited to namespaces, and nothing is read
// as kubeast:cache.
func TestAFailedReviewReadsTheEventsAsTheCaller(t *testing.T) {
	api := &windowCluster{may: func(string, string) bool { return true }, reviewFails: true, events: windowEvents(time.Now().Truncate(time.Second))}
	s, own := api.start(t)
	for _, ctx := range []context.Context{wideCaller("a@example.com"), grantCaller("two@example.com", "bulk", "shop")} {
		for _, namespace := range []string{"", "shop"} {
			evs, counts, err := s.newestEventsSince(ctx, namespace, metav1.ListOptions{}, time.Time{}, 50, "")
			got := eventsSaid(evs, counts, err)
			evs, counts, err = own.newestEventsSince(ctx, namespace, metav1.ListOptions{}, time.Time{}, 50, "")
			if want := eventsSaid(evs, counts, err); err != nil || got != want {
				t.Errorf("%q:\n got %.300s\nwant %.300s", namespace, got, want)
			}
		}
	}
	res, err := s.GetNamespaceTimeline(wideCaller("a@example.com"), "", 24, 500, "")
	got := timelineSaid(t, res, err)
	res, err = own.GetNamespaceTimeline(wideCaller("a@example.com"), "", 24, 500, "")
	if want := timelineSaid(t, res, err); err != nil || got != want {
		t.Errorf("the timeline:\n got %.300s\nwant %.300s", got, want)
	}
	if api.reviewsSeen() == 0 {
		t.Error("no review was asked")
	}
	if pages, reads := api.count(overviewCacheUser); reads != 0 {
		t.Errorf("%d reads of the events as kubeast:cache (%d pages), want none", reads, pages)
	}
}

// People woken by one read take its events and the Timeline's rows as that read made them, once: no copy each.
func TestPeopleAnsweredByOneEventReadShareItsEventsAndRows(t *testing.T) {
	api := &windowCluster{may: func(string, string) bool { return true }, hold: make(chan struct{}), events: windowEvents(time.Now().Truncate(time.Second))}
	s, _ := api.start(t)
	const n = 12
	rows := make([]uintptr, n)
	events := make([]*corev1.Event, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			res, err := s.GetNamespaceTimeline(wideCaller(fmt.Sprintf("t%02d@example.com", i)), "", 24, 500, "")
			if err != nil || len(res.Events) != 500 {
				t.Errorf("timeline %d: %v", i, err)
				return
			}
			rows[i] = reflect.ValueOf(res.Events[0]).Pointer()
		}()
		go func() {
			defer wg.Done()
			evs, _, err := s.newestEventsSince(wideCaller(fmt.Sprintf("e%02d@example.com", i)), "", metav1.ListOptions{}, time.Time{}, 500, "")
			if err != nil || len(evs) != 500 {
				t.Errorf("events %d: %v", i, err)
				return
			}
			events[i] = &evs[0]
		}()
	}
	// the first read is held at its first page; the others wait for the one after it, the same read for both kinds
	b, key := s.defaultBundle.Load(), eventWindowKey("", metav1.ListOptions{}, 500, "")
	if !eventually(t, 5*time.Second, func() bool { return b.eventWindows.Waiting(key) == 2*n-1 }) {
		waiting := b.eventWindows.Waiting(key)
		api.release()
		wg.Wait()
		t.Fatalf("%d callers wait for the next read, want %d", waiting, 2*n-1)
	}
	api.release()
	wg.Wait()
	distinctRows, distinctEvents := map[uintptr]bool{}, map[*corev1.Event]bool{}
	for i := 0; i < n; i++ {
		distinctRows[rows[i]], distinctEvents[events[i]] = true, true
	}
	t.Logf("%d timelines: %d sets of rows; %d event lists: %d sets of events", n, len(distinctRows), n, len(distinctEvents))
	if len(distinctRows) > 2 || len(distinctEvents) > 2 {
		t.Errorf("%d sets of rows and %d sets of events for two reads each, want at most 2 each", len(distinctRows), len(distinctEvents))
	}
}
