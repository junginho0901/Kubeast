package k8s

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/clustersync"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/limits"
)

// severalClusters makes the big reads those of one of several clusters until the test ends.
func severalClusters(t *testing.T) {
	t.Helper()
	bigReadShare.registered(2)
	t.Cleanup(func() { bigReadShare.registered(1) })
}

// onClusterOfTheRequest is the context ClusterMiddleware gives a request to cluster id.
func onClusterOfTheRequest(ctx context.Context, id cluster.ID) context.Context {
	ctx, _ = WithClusterCalls(cluster.WithID(ctx, id), id, func() {})
	return ctx
}

// twoPageAPI answers every list in two pages of nothing. A second page waits for hold while it is set.
type twoPageAPI struct {
	hold   chan struct{}
	second atomic.Int64 // second pages asked for

	mu        sync.Mutex
	now, most int // second pages under way
}

func (a *twoPageAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Query().Get("continue") == "" {
		fmt.Fprint(w, `{"metadata":{"continue":"2"},"items":[]}`)
		return
	}
	a.second.Add(1)
	a.mu.Lock()
	a.now++
	a.most = max(a.most, a.now)
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.now--
		a.mu.Unlock()
	}()
	if a.hold != nil {
		select {
		case <-a.hold:
		case <-r.Context().Done():
			return
		}
	}
	fmt.Fprint(w, `{"metadata":{},"items":[]}`)
}

func (a *twoPageAPI) mostAtOnce() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.most
}

// addTo makes a the API server of cluster id in s, read as the caller and as kubeast:cache.
func (a *twoPageAPI) addTo(t *testing.T, s *Service, id cluster.ID) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(srv.Close)
	k, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	s.pool().Add(id, &clientBundle{id: id, clientset: k, cacheClient: k})
}

// bigReads are reads past a page, by the context each reads with: the caller's, the one of a read once for everyone,
// which carries nothing of the request but the record of its calls, and the one of a run that outlives its caller.
var bigReads = []struct {
	name   string
	shared bool // one read for everyone asking at a moment
	read   func(ctx context.Context, s *Service) error
}{
	{"pods", false, func(ctx context.Context, s *Service) error {
		return eachPod(ctx, s.clientsetCtx(ctx).CoreV1(), "big", metav1.ListOptions{}, func(*corev1.Pod) {})
	}},
	{"issues", false, func(ctx context.Context, s *Service) error {
		_, err := s.podIssues(ctx, IssuesOptions{Namespace: "big"})
		return err
	}},
	{"warnings of the issues", false, func(ctx context.Context, s *Service) error {
		_, err := s.warningEventRowsIn(ctx, "big", time.Time{})
		return err
	}},
	{"cluster hygiene", false, func(ctx context.Context, s *Service) error {
		_, err := hygienePodSummaryOf(ctx, s.clientsetCtx(ctx), 0)
		return err
	}},
	{"resource graph", false, func(ctx context.Context, s *Service) error {
		_, err := s.fetchResourceGraphData(ctx, nil)
		return err
	}},
	{"events as the caller", false, func(ctx context.Context, s *Service) error {
		_, _, err := s.newestEventsSince(ctx, "big", metav1.ListOptions{}, time.Time{}, 0, "")
		return err
	}},
	{"events for everyone", true, func(ctx context.Context, s *Service) error {
		_, _, err := s.newestEventsSince(ctx, "big", metav1.ListOptions{}, time.Time{}, 10, "")
		return err
	}},
	{"rollouts for everyone", true, func(ctx context.Context, s *Service) error {
		_, err := s.rolloutReplicaSets(ctx, "big", time.Time{})
		return err
	}},
	{"nodes of the timeline's changes", true, func(ctx context.Context, s *Service) error {
		_, err := s.nodeFacts(ctx)
		return err
	}},
}

// A cluster that does not answer its lists holds its half of the places and no more, however many of its reads are
// waiting, and every kind of big read of another cluster goes on.
func TestAClusterThatDoesNotAnswerItsListsKeepsNoOtherClustersBigReadsWaiting(t *testing.T) {
	severalClusters(t)
	half := (bigReadSlots.Cap() + 1) / 2
	if half == bigReadSlots.Cap() {
		t.Skip("one place is everyone's")
	}
	slow, fast := &twoPageAPI{hold: make(chan struct{})}, &twoPageAPI{}
	s := &Service{}
	slow.addTo(t, s, "slow")
	fast.addTo(t, s, "fast")
	var let sync.Once
	letGo := func() { let.Do(func() { close(slow.hold) }) }
	t.Cleanup(letGo)

	const each = 3
	want, alreadyWaiting := 0, waitingForAPlace() // the reads of slow that come to take a place
	var wg sync.WaitGroup
	for _, r := range bigReads {
		if want += each; r.shared {
			want += 1 - each
		}
		for range each {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := r.read(onClusterOfTheRequest(context.Background(), "slow"), s); err != nil {
					t.Errorf("%s of slow: %v", r.name, err)
				}
			}()
		}
	}
	if !eventually(t, 10*time.Second, func() bool {
		return slow.second.Load() == int64(half) && waitingForAPlace() == alreadyWaiting+want-half
	}) {
		t.Fatalf("%d second pages asked of slow and %d of its reads waiting for a place, want %d and %d", slow.second.Load(), waitingForAPlace()-alreadyWaiting, half, want-half)
	}

	ctx, cancel := context.WithTimeout(onClusterOfTheRequest(context.Background(), "fast"), 5*time.Second)
	defer cancel()
	var ofFast sync.WaitGroup
	for _, r := range bigReads {
		ofFast.Add(1)
		go func() {
			defer ofFast.Done()
			if err := r.read(ctx, s); err != nil {
				t.Errorf("%s of fast while slow does not answer: %v", r.name, err)
			}
		}()
	}
	ofFast.Wait()
	if got := slow.second.Load(); got != int64(half) {
		t.Errorf("%d second pages asked of slow while it did not answer, want %d", got, half)
	}

	letGo()
	wg.Wait()
	if most := slow.mostAtOnce(); most > half {
		t.Errorf("%d big reads of slow at once, want at most %d", most, half)
	}
	if n, slows, fasts := bigReadSlots.InUse(), bigReadShare.own.on("slow").InUse(), bigReadShare.own.on("fast").InUse(); n != 0 || slows != 0 || fasts != 0 {
		t.Errorf("%d places still taken, %d of slow's half and %d of fast's", n, slows, fasts)
	}
}

// A big read takes a place of the cluster it reads, whatever context it reads with: a read once for everyone counted as
// the default cluster's would share that cluster's half with every other cluster's.
func TestEachBigReadTakesAPlaceOfTheClusterItReads(t *testing.T) {
	severalClusters(t)
	for _, r := range bigReads {
		t.Run(r.name, func(t *testing.T) {
			api := &twoPageAPI{hold: make(chan struct{})}
			s := &Service{}
			api.addTo(t, s, "read-of")
			done := make(chan error, 1)
			go func() { done <- r.read(onClusterOfTheRequest(context.Background(), "read-of"), s) }()
			if !eventually(t, 5*time.Second, func() bool { return api.second.Load() == 1 }) {
				close(api.hold)
				t.Fatal("no second page asked for")
			}
			own, other, all := bigReadShare.own.on("read-of").InUse(), bigReadShare.own.on("default").InUse(), bigReadSlots.InUse()
			close(api.hold)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if own != 1 || other != 0 || all != 1 {
				t.Errorf("%d places of the cluster, %d of the default cluster and %d in all, want 1, 0 and 1", own, other, all)
			}
			if n := bigReadShare.own.on("read-of").InUse() + bigReadSlots.InUse(); n != 0 {
				t.Errorf("%d places still taken", n)
			}
		})
	}
}

// The cluster a read is of: the one its context targets before the one the request came to, and the default cluster for
// a context that names none.
func TestTheClusterAReadIsOf(t *testing.T) {
	bg := context.Background()
	for _, c := range []struct {
		name string
		ctx  context.Context
		want cluster.ID
	}{
		{"none", bg, "default"},
		{"an empty one", cluster.WithID(bg, ""), "default"},
		{"the target", cluster.WithID(bg, "prod"), "prod"},
		{"the request's", onClusterOfTheRequest(bg, "prod"), "prod"},
		{"another target than the request's", cluster.WithID(onClusterOfTheRequest(bg, "prod"), "stage"), "stage"},
		{"a read apart from the request's values", carryClusterCalls(bg, onClusterOfTheRequest(bg, "prod")), "prod"},
	} {
		if got := clusterOf(c.ctx); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

// takes takes n places of id one after another, each within a second.
func takes(t *testing.T, c *clusterShare, id cluster.ID, n int) []func() {
	t.Helper()
	var held []func()
	for i := range n {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		give, err := c.take(ctx, id)
		cancel()
		if err != nil {
			t.Fatalf("place %d of %s: %v", i+1, id, err)
		}
		held = append(held, give)
	}
	return held
}

// refuses says c has no place for id now.
func refuses(c *clusterShare, id cluster.ID) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	give, err := c.take(ctx, id)
	if err == nil {
		give()
	}
	return err != nil
}

// The only cluster takes every place, as before there was a share. One of several takes half of them, rounded up, and
// the others what is left.
func TestOneOfSeveralClustersTakesHalfThePlacesAndTheOnlyOneAllOfThem(t *testing.T) {
	for places, half := range map[int]int{1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 8: 4} {
		t.Run(fmt.Sprintf("%d places", places), func(t *testing.T) {
			c := newClusterShare("test", limits.NewSlots("test", places))
			for _, clusters := range []int{0, 1} {
				c.registered(clusters)
				held := takes(t, c, "prod", places)
				if !refuses(c, "prod") || !refuses(c, "stage") {
					t.Errorf("a place past %d with %d clusters", places, clusters)
				}
				for _, give := range held {
					give()
				}
			}
			c.registered(2)
			held := takes(t, c, "prod", half)
			if !refuses(c, "prod") {
				t.Errorf("one of two clusters took more than %d places of %d", half, places)
			}
			held = append(held, takes(t, c, "stage", places-half)...)
			if !refuses(c, "stage") || !refuses(c, "dev") {
				t.Errorf("a place past %d in all", places)
			}
			for _, give := range held {
				give()
			}
			if n := c.all.InUse() + c.own.on("prod").InUse() + c.own.on("stage").InUse() + c.own.on("dev").InUse(); n != 0 {
				t.Errorf("%d places still taken", n)
			}
		})
	}
}

// A second cluster registered while the only one held every place waits for one of its reads to end, and from then on
// the first takes no more than its half. One cluster again, it takes them all.
func TestAClusterRegisteredLaterTakesItsHalfFromTheReadsThatEnd(t *testing.T) {
	c := newClusterShare("test", limits.NewSlots("test", 2))
	c.registered(1)
	prod := takes(t, c, "prod", 2)
	c.registered(2)
	got := make(chan func(), 1)
	go func() {
		give, err := c.take(context.Background(), "stage")
		if err != nil {
			t.Error(err)
		}
		got <- give
	}()
	select {
	case <-got:
		t.Fatal("a third place of two")
	case <-time.After(50 * time.Millisecond):
	}
	prod[0]()
	stage := <-got
	prod[1]()
	prod = takes(t, c, "prod", 1)
	if !refuses(c, "prod") {
		t.Error("the first cluster took every place again")
	}
	stage()
	if !refuses(c, "prod") {
		t.Error("the first cluster took the place the second gave back")
	}
	c.registered(1)
	prod = append(prod, takes(t, c, "prod", 1)...)
	for _, give := range prod {
		give()
	}
	if n := c.all.InUse() + c.own.on("prod").InUse() + c.own.on("stage").InUse(); n != 0 {
		t.Errorf("%d places still taken", n)
	}
}

// The reads of a cluster take their places in the order they asked for them, and a read of a cluster that holds none
// waits for one place given back, not for the queues of the clusters that asked before it.
func TestTheClustersTakeTurnsAndEachItsReadsInOrder(t *testing.T) {
	c := newClusterShare("test", limits.NewSlots("test", 2))
	c.registered(3)
	var mu sync.Mutex
	var order []string
	gives := make(chan func(), 16)
	var wg sync.WaitGroup
	ask := func(id cluster.ID, n int) {
		t.Helper()
		before := waitingForAPlace()
		wg.Add(1)
		go func() {
			defer wg.Done()
			give, err := c.take(context.Background(), id)
			if err != nil {
				t.Error(err)
				return
			}
			mu.Lock()
			order = append(order, fmt.Sprintf("%s-%d", id, n))
			mu.Unlock()
			gives <- give
		}()
		if !eventually(t, 5*time.Second, func() bool { return waitingForAPlace() == before+1 }) {
			t.Fatalf("read %d of %s does not wait", n, id)
		}
	}
	held := append(takes(t, c, "a", 1), takes(t, c, "b", 1)...)
	for n := range 4 {
		ask("a", n)
		ask("b", n)
	}
	ask("c", 0)
	taken := func(n int) []string {
		t.Helper()
		if !eventually(t, 5*time.Second, func() bool { mu.Lock(); defer mu.Unlock(); return len(order) == n }) {
			t.Fatalf("not %d places taken", n)
		}
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(order)
	}
	held[0]()
	if got := taken(1); got[0] != "c-0" {
		t.Errorf("the first place given back went to %s, want c-0: its cluster held none", got[0])
	}
	held[1]()
	for n := 2; n <= 9; n++ {
		taken(n)
		(<-gives)()
	}
	(<-gives)()
	wg.Wait()
	var a, b []string
	for _, r := range taken(9) {
		switch r[0] {
		case 'a':
			a = append(a, r)
		case 'b':
			b = append(b, r)
		}
	}
	if !slices.IsSorted(a) || !slices.IsSorted(b) {
		t.Errorf("reads out of order: %v, %v", a, b)
	}
	if n := c.all.InUse() + c.own.on("a").InUse() + c.own.on("b").InUse() + c.own.on("c").InUse(); n != 0 {
		t.Errorf("%d places still taken", n)
	}
}

// A read that stops waiting, for its cluster's half or for a place of all, holds neither.
func TestABigReadThatStopsWaitingHoldsNoPlace(t *testing.T) {
	c := newClusterShare("test", limits.NewSlots("test", 2))
	c.registered(2)
	prod := takes(t, c, "prod", 1)
	if !refuses(c, "prod") { // its cluster's half is taken
		t.Fatal("a second place of prod's half of two")
	}
	if n := c.all.InUse(); n != 1 {
		t.Errorf("%d places taken after a wait for the half ended, want 1", n)
	}
	stage := takes(t, c, "stage", 1)
	if !refuses(c, "dev") { // every place is taken, dev's half is not
		t.Fatal("a third place of two")
	}
	if n := c.own.on("dev").InUse(); n != 0 {
		t.Errorf("%d places of dev's half held by a read that stopped waiting", n)
	}
	prod[0]()
	stage[0]()
	for _, give := range append(takes(t, c, "dev", 1), takes(t, c, "prod", 1)...) {
		give()
	}
	if n := c.all.InUse() + c.own.on("prod").InUse() + c.own.on("stage").InUse() + c.own.on("dev").InUse(); n != 0 {
		t.Errorf("%d places still taken", n)
	}
}

// Reads of four clusters come and go, some leaving while they wait, as a cluster is registered and deleted again: never
// more places than there are, and none taken after.
func TestThePlacesAllComeBackWhileClustersAreRegisteredAndDeleted(t *testing.T) {
	c := newClusterShare("test", limits.NewSlots("test", 3))
	var running, most atomic.Int64
	stop := make(chan struct{})
	toggled := make(chan struct{})
	go func() {
		defer close(toggled)
		for n := 0; ; n++ {
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
				c.registered(1 + n%2)
			}
		}
	}()
	var wg sync.WaitGroup
	for i := range 64 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := cluster.ID(fmt.Sprintf("c%d", i%4))
			for n := range 20 {
				ctx, cancel := context.WithTimeout(context.Background(), time.Duration(1+(i+n)%9)*2*time.Millisecond)
				give, err := c.take(ctx, id)
				cancel()
				if err != nil {
					continue
				}
				now := running.Add(1)
				for m := most.Load(); now > m && !most.CompareAndSwap(m, now); m = most.Load() {
				}
				time.Sleep(200 * time.Microsecond)
				running.Add(-1)
				give()
			}
		}()
	}
	wg.Wait()
	close(stop)
	<-toggled
	if most.Load() > 3 {
		t.Errorf("%d places taken at once of 3", most.Load())
	}
	n := c.all.InUse()
	for i := range 4 {
		n += c.own.on(cluster.ID(fmt.Sprintf("c%d", i))).InUse()
	}
	if n != 0 {
		t.Errorf("%d places still taken", n)
	}
}

// What holds for the reads of the only cluster holds for those of one of several: they take turns, every object is
// read, a place comes back from a read that fails, a read waiting for either place holds no page, and each take is
// observed once.
func TestTheBigReadsOfOneOfSeveralClusters(t *testing.T) {
	severalClusters(t)
	t.Run("pods", TestBigPodReadsTakeTurnsAndEveryPodIsRead)
	t.Run("issues", TestPagedPodReadsOutsideEachPodTakeTurnsToo)
	t.Run("events", TestBigEventReadsTakeTurnsWithTheOtherBigReads)
	t.Run("failed", TestAFailedPodReadGivesItsPlaceBack)
	t.Run("pages held", TestAReadWaitingForItsNextPageHoldsNoPageItAlreadyRead)
	t.Run("observed", TestEachTakeOfTheBigReadPlacesIsObservedUnderBigRead)
}

// The share follows the registry: with more than one cluster there one takes half, the only one all of the places.
func TestTheShareFollowsTheRegistry(t *testing.T) {
	t.Cleanup(func() { bigReadShare.registered(1) })
	reg := &mockRegistry{def: "prod", clusters: map[cluster.ID]cluster.Info{"prod": versioned("prod", 1)}}
	s := newTestService(t, reg)
	changes := clustersync.New(registryVersions{reg}, nil)
	several := func() bool {
		changes.Compare(context.Background(), s)
		return bigReadShare.several.Load()
	}
	if several() {
		t.Error("the only registered cluster is one of several")
	}
	reg.clusters["dev"] = versioned("dev", 1)
	if !several() {
		t.Error("one of two registered clusters is the only one")
	}
	delete(reg.clusters, "dev")
	if several() {
		t.Error("the cluster left is one of several")
	}
}
