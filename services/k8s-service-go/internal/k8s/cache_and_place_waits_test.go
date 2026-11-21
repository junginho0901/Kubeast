package k8s

import (
	"context"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// gatherPlaceWaits reads m's place wait histogram as a scrape would, by places, failing on any other label.
func gatherPlaceWaits(t *testing.T, m *clientWaitMetrics) map[string]waitSeries {
	t.Helper()
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(m.collectors()...)
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]waitSeries{}
	for _, f := range families {
		if f.GetName() != "kubeast_k8s_read_place_wait_seconds" {
			continue
		}
		for _, s := range f.GetMetric() {
			labels := map[string]string{}
			var names []string
			for _, l := range s.GetLabel() {
				labels[l.GetName()] = l.GetValue()
				names = append(names, l.GetName())
			}
			if !slices.Equal(names, []string{"places", "service"}) || labels["service"] != "k8s" {
				t.Errorf("%s labelled %v", f.GetName(), labels)
			}
			out[labels["places"]] = waitSeries{s.GetHistogram().GetSampleCount(), s.GetHistogram().GetSampleSum()}
		}
	}
	return out
}

// kubeast:cache's requests wait on client-go's token bucket as before, each one observed under limiter="cache": 0 when
// it went at once, else its wait, a request that left while waiting too; there is no passed_over="true" series.
func TestKubeastCachesRateWaitsAreObservedUnderLimiterCache(t *testing.T) {
	m := newClientWaitMetrics()
	l := newCachedRate(10, 1, m.forCache())
	if l.QPS() != 10 {
		t.Fatalf("QPS %v, want 10", l.QPS())
	}
	const calls = 4
	for i := 0; i < calls; i++ {
		if err := l.Wait(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := l.Wait(ctx); err == nil {
		t.Fatal("a request whose context ends before the next token got one")
	}
	seconds, waited := gatherWaits(t, m)
	keys := make([]string, 0, len(seconds))
	for k := range seconds {
		keys = append(keys, k)
	}
	if !slices.Equal(keys, []string{"cache/false"}) {
		t.Fatalf("series %v, want cache/false only", keys)
	}
	got := seconds["cache/false"]
	// at 10 a second and a burst of 1 the first goes at once and the next three wait about 100 ms each
	if got.count != calls+1 || got.sum < 0.25 || got.sum > 2 {
		t.Errorf("%d observations summing %.3f s, want %d summing about 0.3", got.count, got.sum, calls+1)
	}
	if waited["cache"] != calls {
		t.Errorf("%v requests counted as waiting, want %d", waited["cache"], calls)
	}
}

// buildClientBundle gives kubeast:cache that limiter at the clients' rate, and the person's clients their turnLimiter.
func TestABundlesKubeastCacheClientTakesTheObservedRate(t *testing.T) {
	was := clientRates
	clientRates = rates{qps: 7, burst: 3}
	t.Cleanup(func() { clientRates = was })
	b, err := buildClientBundle(cluster.Info{ID: "c1", Mode: cluster.ModeExternal, KubeconfigBlob: testKubeconfig})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })
	cache, ok := b.cacheClient.(*kubernetes.Clientset).CoreV1().RESTClient().GetRateLimiter().(cachedRate)
	if !ok {
		t.Fatalf("kubeast:cache's limiter is %T, want cachedRate", b.cacheClient.(*kubernetes.Clientset).CoreV1().RESTClient().GetRateLimiter())
	}
	if cache.QPS() != 7 || cache.waits != clientWait.forCache() {
		t.Errorf("kubeast:cache's limiter: QPS %v, observed into the cache series %v", cache.QPS(), cache.waits == clientWait.forCache())
	}
	if _, ok := b.clientset.CoreV1().RESTClient().GetRateLimiter().(*turnLimiter); !ok {
		t.Errorf("the person's limiter is %T, want *turnLimiter", b.clientset.CoreV1().RESTClient().GetRateLimiter())
	}
	// the other groups of kubeast:cache share the one bucket, as kubernetes.NewForConfig's own did
	if apps, ok := b.cacheClient.(*kubernetes.Clientset).AppsV1().RESTClient().GetRateLimiter().(cachedRate); !ok || apps != cache {
		t.Error("kubeast:cache's apps client has another limiter")
	}
	// readMetricsGroup's GET /apis/metrics.k8s.io goes through kubeast:cache's discovery client
	if d, ok := b.cacheClient.(*kubernetes.Clientset).Discovery().RESTClient().GetRateLimiter().(cachedRate); !ok || d != cache {
		t.Error("kubeast:cache's discovery client has another limiter")
	}
}

// Each take of a cluster's read places is one observation under its places only, never by cluster: about 0 when a
// place was free, else the wait, a take whose context ended too.
func TestEachTakeOfAReadPlaceIsObservedByPlacesOnly(t *testing.T) {
	m := newClientWaitMetrics()
	c := newClusterPlaces("node pods read", 1, m.forPlaces(placesNodePods))
	ctx := context.Background()
	first, err := c.take(ctx, "c1")
	if err != nil {
		t.Fatal(err)
	}
	other, err := c.take(ctx, "c2") // another cluster's places are its own
	if err != nil {
		t.Fatal(err)
	}
	other()
	time.AfterFunc(100*time.Millisecond, first)
	second, err := c.take(ctx, "c1")
	if err != nil {
		t.Fatal(err)
	}
	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := c.take(short, "c1"); err == nil {
		t.Fatal("a take whose context ended while the place was held got one")
	}
	second()
	got := gatherPlaceWaits(t, m)
	if len(got) != 1 {
		t.Fatalf("series %v, want node_pods only", got)
	}
	s := got[placesNodePods]
	if s.count != 4 || s.sum < 0.14 || s.sum > 2 {
		t.Errorf("%d observations summing %.3f s, want 4 summing about 0.15", s.count, s.sum)
	}
}

// A read past its first page takes one of k8s-service's big read places once, before its second page, and keeps it to
// the end: one observation under places="big_read" on the service's histogram, about 0 when a place was free, else its
// wait, a read whose context ended while waiting too. A read of one page takes none.
func TestEachTakeOfTheBigReadPlacesIsObservedUnderBigRead(t *testing.T) {
	pages := func(n int) func(metav1.ListOptions) (*corev1.PodList, error) {
		return func(o metav1.ListOptions) (*corev1.PodList, error) {
			l := &corev1.PodList{}
			if i, _ := strconv.Atoi(o.Continue); i+1 < n {
				l.Continue = strconv.Itoa(i + 1)
			}
			return l, nil
		}
	}
	read := func(ctx context.Context, n int) error {
		return eachPage(ctx, metav1.ListOptions{}, pages(n), func(*corev1.PodList) {})
	}
	since := func(before waitSeries) waitSeries {
		now := gatherPlaceWaits(t, clientWait)[placesBigRead]
		return waitSeries{now.count - before.count, now.sum - before.sum}
	}
	ctx := context.Background()

	before := gatherPlaceWaits(t, clientWait)[placesBigRead]
	if err := read(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if got := since(before); got.count != 0 {
		t.Errorf("a read of one page took a big read place %d times, want none", got.count)
	}
	if err := read(ctx, 3); err != nil {
		t.Fatal(err)
	}
	if got := since(before); got.count != 1 || got.sum > 0.5 {
		t.Errorf("a read of three pages with a place free: %d observations summing %.3f s, want 1 of about 0", got.count, got.sum)
	}

	// every place held: one read's context ends after 50 ms, the next gets a place given back after 100 ms
	held := make([]func(), 0, bigReadSlots.Cap())
	for range bigReadSlots.Cap() {
		release, err := bigReadSlots.Take(ctx)
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, release)
	}
	defer func() {
		for _, release := range held {
			release()
		}
	}()
	before = gatherPlaceWaits(t, clientWait)[placesBigRead]
	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if err := read(short, 2); err == nil {
		t.Fatal("a read whose context ended while every place was held got one")
	}
	given := held[0]
	held = held[1:]
	time.AfterFunc(100*time.Millisecond, given)
	if err := read(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if got := since(before); got.count != 2 || got.sum < 0.14 || got.sum > 2 {
		t.Errorf("%d observations summing %.3f s, want 2 summing about 0.15", got.count, got.sum)
	}
}

// The node pods reads and the event lists observe into the service's histogram under their own places.
func TestTheReadPlacesObserveUnderTheirNames(t *testing.T) {
	if nodeReadPlaces.waited != clientWait.forPlaces(placesNodePods) || eventListPlaces.waited != clientWait.forPlaces(placesEventList) {
		t.Error("a read's places observe under another name")
	}
}
