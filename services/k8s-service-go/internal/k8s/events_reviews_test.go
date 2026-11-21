package k8s

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// A drawer whose access review the API server fails (500, not a refusal) lists the object's events as the caller, as
// before the review: it shows what the caller's own list shows, with no events_error, in a namespace and for an object
// of the cluster, and nothing is listed as kubeast:cache.
func TestAFailedReviewListsTheDrawersEventsAsTheCaller(t *testing.T) {
	api := &eventsCluster{may: func(string, string) bool { return true }, reviewFails: true}
	s, b := api.start(t)
	for _, o := range []struct{ namespace, kind, name string }{{"shop", "ConfigMap", "app"}, {"", "Node", "n1"}} {
		got := eventsAnswer(t, s, wideCaller("a@example.com"), o.namespace, o.kind, o.name)
		want := ownEventsAnswer(t, b.clientset, wideCaller("a@example.com"), o.namespace, o.kind, o.name)
		if got != want || strings.Contains(got, "events not listed") || !strings.Contains(got, " of "+o.name) {
			t.Errorf("%s %s:\n got %s\nwant %s", o.kind, o.name, got, want)
		}
	}
	if len(api.reviewsSeen()) == 0 {
		t.Error("no review was asked")
	}
	if n := api.listsBy(overviewCacheUser); n != 0 {
		t.Errorf("%d lists of events as kubeast:cache, want none", n)
	}
}

// A grant limited to namespaces has its namespaces' event reviews asked side by side before the first read, not one
// before each read, and the answers are kept as before: the same read again within the minute asks none. The answer is
// the caller's own read's.
func TestAGrantsEventReviewsAreAskedSideBySide(t *testing.T) {
	scope := []string{"bulk", "shop", "kube-system", "four", "five", "six"}
	api := &windowCluster{may: func(string, string) bool { return true }, reviewsTogether: len(scope), events: windowEvents(time.Now().Truncate(time.Second))}
	s, own := api.start(t)
	ctx := grantCaller("six@example.com", scope...)
	got := eventsSaid(s.newestEventsSince(ctx, "", metav1.ListOptions{}, time.Time{}, 50, ""))
	most, asked := api.reviewsAtOnce(), api.reviewsSeen()
	_, reads := api.count(overviewCacheUser)
	want := eventsSaid(own.newestEventsSince(ctx, "", metav1.ListOptions{}, time.Time{}, 50, ""))
	if got != want || !strings.HasPrefix(got, "50 of 1276 (426 warnings)") {
		t.Errorf("the grant's events:\n got %.300s\nwant %.300s", got, want)
	}
	if most != len(scope) || asked != len(scope) {
		t.Errorf("%d reviews, at most %d at once, want %d side by side", asked, most, len(scope))
	}
	if reads != len(scope) {
		t.Errorf("%d reads of the events as kubeast:cache, want one for each of the %d namespaces", reads, len(scope))
	}
	again := eventsSaid(s.newestEventsSince(ctx, "", metav1.ListOptions{}, time.Time{}, 50, ""))
	if more := api.reviewsSeen() - asked; again != want || more != 0 {
		t.Errorf("the same read again asked %d more reviews (want 0, the answers are kept for the minute): %.120s", more, again)
	}
}

// A review the API server fails for one of a grant's namespaces reads only that namespace as the caller; the other is
// still read once for everyone, and the answer is the caller's own read's.
func TestOneNamespacesFailedReviewReadsOnlyThatNamespaceAsTheCaller(t *testing.T) {
	api := &windowCluster{may: func(string, string) bool { return true }, failReview: func(namespace string) bool { return namespace == "bulk" }, events: windowEvents(time.Now().Truncate(time.Second))}
	s, own := api.start(t)
	ctx := grantCaller("two@example.com", "bulk", "shop")
	got := eventsSaid(s.newestEventsSince(ctx, "", metav1.ListOptions{}, time.Time{}, 50, ""))
	callerPages, callerReads := api.count("two@example.com")
	cachePages, cacheReads := api.count(overviewCacheUser)
	want := eventsSaid(own.newestEventsSince(ctx, "", metav1.ListOptions{}, time.Time{}, 50, ""))
	if got != want || !strings.HasPrefix(got, "50 of 1271 (424 warnings)") {
		t.Errorf("the grant's events:\n got %.300s\nwant %.300s", got, want)
	}
	// bulk's 1 234 events as the caller, three pages of 500; shop's 37 once as kubeast:cache
	if callerReads != 1 || callerPages != 3 || cacheReads != 1 || cachePages != 1 {
		t.Errorf("as the caller %d reads (%d pages), want 1 (3); as kubeast:cache %d reads (%d pages), want 1 (1)", callerReads, callerPages, cacheReads, cachePages)
	}
}

// A grant's events review allowed before the reads, revoked once its kept answer ended, is asked again before that
// namespace's read and reads it as the caller; the review still kept asks none.
func TestAnAllowedEventReviewIsAskedAgainOnceItsAnswerEnded(t *testing.T) {
	ctx := grantCaller("again@example.com", "bulk", "shop")
	what, _ := listCheck("", "events", "shop")
	var revoked atomic.Bool
	var s, own *Service
	api := &windowCluster{
		may:    func(_, namespace string) bool { return namespace != "shop" || !revoked.Load() },
		events: windowEvents(time.Now().Truncate(time.Second)),
		onCacheRead: func(namespace string) {
			if namespace == "bulk" {
				revoked.Store(true)
				s.accessAnswers.set(s.clusterCacheKey(ctx, what), true, time.Now().Add(-time.Millisecond))
			}
		},
	}
	s, own = api.start(t)
	got := eventsSaid(s.newestEventsSince(ctx, "", metav1.ListOptions{}, time.Time{}, 50, ""))
	asked := api.reviewsSeen()
	callerPages, callerReads := api.count("again@example.com")
	cachePages, cacheReads := api.count(overviewCacheUser)
	want := eventsSaid(own.newestEventsSince(ctx, "", metav1.ListOptions{}, time.Time{}, 50, ""))
	if got != want || !strings.HasPrefix(got, "50 of 1234 (412 warnings)") {
		t.Errorf("the grant's events:\n got %.300s\nwant %.300s", got, want)
	}
	// two reviews before the reads and shop's again; shop refused to the caller on its first page; bulk's 1 234 events
	// once as kubeast:cache, three pages of 500
	if asked != 3 || callerReads != 1 || callerPages != 1 || cacheReads != 1 || cachePages != 3 {
		t.Errorf("%d reviews, want 3; as the caller %d reads (%d pages), want 1 (1); as kubeast:cache %d reads (%d pages), want 1 (3)", asked, callerReads, callerPages, cacheReads, cachePages)
	}
}
