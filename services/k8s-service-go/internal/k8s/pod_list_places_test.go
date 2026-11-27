package k8s

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	typedcorev1 "k8s.io/client-go/kubernetes/typed/core/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// rowPlacesFor gives the test the places of a server with n for the rows, and the process's own back when it ends.
func rowPlacesFor(t *testing.T, n int) {
	t.Helper()
	rows, lists := podRowSlots, podRowLists
	podRowSlots, podRowLists = make(chan struct{}, n), newPodListPlaces(n)
	t.Cleanup(func() { podRowSlots, podRowLists = rows, lists })
}

// placesTaken is how many places the rows and the lists hold now.
func placesTaken() (rows, lists int) { return len(podRowSlots), podRowLists.all.InUse() }

// heldLists is a cluster that keeps no informers, so its pods are listed as each caller, and answers a list with one pod
// once release has closed (at once when it is nil), or with fail's status.
type heldLists struct {
	release chan struct{}
	fail    int

	mu        sync.Mutex
	now, most int
	wg        sync.WaitGroup
	errs      []error
}

func (h *heldLists) start(t *testing.T, id cluster.ID) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		h.now++
		h.most = max(h.most, h.now)
		h.mu.Unlock()
		defer func() {
			h.mu.Lock()
			h.now--
			h.mu.Unlock()
		}()
		if h.release != nil {
			select {
			case <-h.release:
			case <-r.Context().Done():
				return
			}
		}
		if h.fail != 0 {
			writeStatus(w, h.fail, "Failed", "no list")
			return
		}
		writeJSON(w, &corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, Items: []corev1.Pod{nodePod("a", "web-1", "n1")}})
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs, id: id, noInformers: true})
	return s
}

func (h *heldLists) underWay() (now, most int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.now, h.most
}

// open has people open the Pods page and Cluster View of s, half each, and returns what waits for their answers.
func (h *heldLists) open(ctx context.Context, s *Service, people int) (wait func() []error) {
	for i := range people {
		h.wg.Add(1)
		go func() {
			defer h.wg.Done()
			var err error
			if i%2 == 0 {
				_, err = s.GetPodPage(ctx, PodPageQuery{Limit: 50})
			} else {
				_, err = s.GetPodNodeSummary(ctx, "", "", "")
			}
			h.mu.Lock()
			h.errs = append(h.errs, err)
			h.mu.Unlock()
		}()
	}
	return func() []error {
		h.wg.Wait()
		return h.errs
	}
}

// A cluster that does not answer its pod lists keeps no one waiting on another cluster: what the informers answer there
// (the Pods page, the node map, a drawer's pods, the pod metrics' limits, the flows' workloads) and, where two can list
// at once, a page listed as its caller.
func TestAClusterThatDoesNotAnswerItsPodListsKeepsNoOtherClusterWaiting(t *testing.T) {
	for _, n := range []int{1, 2, 8} {
		t.Run(fmt.Sprintf("%d places", n), func(t *testing.T) {
			rowPlacesFor(t, n)
			slow := &heldLists{release: make(chan struct{})}
			ctx, cancel := context.WithCancel(context.Background())
			wait := slow.open(ctx, slow.start(t, "slow"), 3*n+2)
			t.Cleanup(func() { cancel(); wait() })
			if !eventually(t, 5*time.Second, func() bool { now, _ := slow.underWay(); return now >= podRowLists.each }) {
				t.Fatal("the lists of the cluster that does not answer never started")
			}
			time.Sleep(100 * time.Millisecond) // the others are waiting for a place by now

			fast, b, _ := pageBundle(t, fake.NewSimpleClientset(pagePods()...), func(string) bool { return true })
			b.id = "fast"
			if !b.overviewInformers().waitSynced(context.Background(), 10*time.Second) {
				t.Fatal("the informers of the cluster that answers did not sync")
			}
			soon := func() context.Context {
				c, stop := context.WithTimeout(context.Background(), 3*time.Second)
				t.Cleanup(stop)
				return c
			}
			if p, err := fast.GetPodPage(soon(), PodPageQuery{Limit: 50}); err != nil || p.Source != "index" || p.Total != 4 {
				t.Errorf("the Pods page the informers answer: %+v, %v", p, err)
			}
			if sum, err := fast.GetPodNodeSummary(soon(), "", "", ""); err != nil || sum.Source != "index" || sum.Total != 4 {
				t.Errorf("the node map the informers answer: %+v, %v", sum, err)
			}
			if _, ok := fast.ownedPodRows(soon(), "a", "ReplicaSet", "web", labels.Everything()); !ok {
				t.Error("a drawer's pods did not come from the informers")
			}
			row := map[string]interface{}{"namespace": "a", "name": "p1"}
			fast.AddPodLimits(soon(), "a", []map[string]interface{}{row})
			if _, ok := row["cpu_limit_millicores"]; !ok {
				t.Error("the pod metrics got no limits")
			}
			if _, err := fast.NetflowsWorkloads(soon(), "a"); err != nil {
				t.Errorf("the flows' workloads: %v", err)
			}
			if n > 1 {
				other := (&heldLists{}).start(t, "other")
				if p, err := other.GetPodPage(soon(), PodPageQuery{Limit: 50}); err != nil || p.Source != "list" || p.Total != 1 {
					t.Errorf("the Pods page listed as its caller: %+v, %v", p, err)
				}
			}

			close(slow.release)
			for i, err := range wait() {
				if err != nil {
					t.Errorf("person %d of the cluster that answered at last: %v", i, err)
				}
			}
			if rows, lists := placesTaken(); rows != 0 || lists != 0 {
				t.Errorf("%d places of the rows and %d of the lists still taken", rows, lists)
			}
		})
	}
}

// No request to a cluster goes out while its caller holds a place of the rows, neither the access checks before the
// informers' rows nor the lists as the caller, which hold a place of the lists instead; each caller gives its place back.
func TestNoRequestGoesOutWhileAPlaceOfThePodRowsIsHeld(t *testing.T) {
	rowPlacesFor(t, 4)
	type request struct {
		what        string
		rows, lists int
	}
	var mu sync.Mutex
	var seen []request
	note := func(what string) {
		rows, lists := placesTaken()
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, request{what, rows, lists})
	}
	api := &clusterAPI{
		pods: podsOnNodes(),
		review: func(_ string, ra authorizationv1.ResourceAttributes) bool {
			note("review " + ra.Verb + " " + ra.Resource)
			return true
		},
		may: func(_, verb, resource, _, _ string) bool {
			note(verb + " " + resource)
			return true
		},
	}
	var objs []k8sruntime.Object
	for _, p := range podsOnNodes() {
		objs = append(objs, &p)
	}
	s, b := api.start(t, objs...)
	asks := map[string]func(ctx context.Context) error{
		"the Pods page": func(ctx context.Context) error {
			p, err := s.GetPodPage(ctx, PodPageQuery{Limit: 50})
			if err == nil && p.Total != 10 {
				return fmt.Errorf("%d pods, want 10", p.Total)
			}
			return err
		},
		"the node map": func(ctx context.Context) error {
			_, err := s.GetPodNodeSummary(ctx, "", "", "")
			return err
		},
		"the pod metrics' limits": func(ctx context.Context) error {
			row := map[string]interface{}{"namespace": "a", "name": "a-web-1"}
			s.AddPodLimits(ctx, "a", []map[string]interface{}{row})
			if _, ok := row["cpu_limit_millicores"]; !ok {
				return errors.New("no limits")
			}
			return nil
		},
		"the flows' workloads": func(ctx context.Context) error {
			_, err := s.NetflowsWorkloads(ctx, "a")
			return err
		},
	}
	person := 0
	for _, path := range []struct {
		name, request string
		lists         int
		set           func()
	}{
		{"from the informers", "review list pods", 0, func() {}},
		{"listed as the caller", "list pods", 1, func() { b.inf, b.noInformers = nil, true }},
	} {
		path.set()
		for name, ask := range asks {
			seen = nil
			person++
			// another person each time, whose access is not remembered
			if err := ask(wideCaller(fmt.Sprintf("u%d@example.com", person))); err != nil {
				t.Errorf("%s %s: %v", name, path.name, err)
			}
			asked := false
			for _, r := range seen {
				if r.rows != 0 || r.lists != path.lists {
					t.Errorf("%s %s: %s went out with %d places of the rows and %d of the lists held, want 0 and %d", name, path.name, r.what, r.rows, r.lists, path.lists)
				}
				asked = asked || r.what == path.request
			}
			if !asked {
				t.Errorf("%s %s: no %s among %+v", name, path.name, path.request, seen)
			}
			if rows, lists := placesTaken(); rows != 0 || lists != 0 {
				t.Errorf("%s %s: %d places of the rows and %d of the lists not given back", name, path.name, rows, lists)
			}
		}
	}
}

// placesAtMatch is a label selector that keeps every row and notes the places taken while it looks at them.
type placesAtMatch struct {
	labels.Selector
	rows, lists *int
}

func (p placesAtMatch) Matches(labels.Labels) bool {
	*p.rows, *p.lists = placesTaken()
	return true
}

// A caller holds its place, of the rows or of the lists, for as long as it works on the rows.
func TestACallerHoldsItsPlaceWhileItHasThePodRows(t *testing.T) {
	rowPlacesFor(t, 4)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	informers, _, _ := pageBundle(t, fake.NewSimpleClientset(pagePods()...), func(string) bool { return true })
	for _, c := range []struct {
		s           *Service
		source      string
		rows, lists int
	}{{informers, "index", 1, 0}, {(&heldLists{}).start(t, "listed"), "list", 0, 1}} {
		rows, lists := -1, -1
		p, err := c.s.GetPodPage(ctx, PodPageQuery{Limit: 50, LabelSelector: placesAtMatch{labels.Everything(), &rows, &lists}})
		if err != nil || p.Source != c.source {
			t.Fatalf("%s: %+v, %v", c.source, p, err)
		}
		if rows != c.rows || lists != c.lists {
			t.Errorf("%s: %d places of the rows and %d of the lists held with the rows, want %d and %d", c.source, rows, lists, c.rows, c.lists)
		}
		if rows, lists := placesTaken(); rows != 0 || lists != 0 {
			t.Errorf("%s: %d places of the rows and %d of the lists held after the answer", c.source, rows, lists)
		}
	}
}

// The places of the lists by the places of the rows: one fewer, never under two where there are two, and at most half of
// them one cluster's.
func TestPodListPlacesByRowPlaces(t *testing.T) {
	for _, c := range []struct{ rows, all, each int }{
		{1, 1, 1}, {2, 2, 1}, {3, 2, 1}, {4, 3, 2}, {5, 4, 2}, {6, 5, 3}, {7, 6, 3}, {8, 7, 4}, {24, 23, 12},
	} {
		p := newPodListPlaces(c.rows)
		if p.all.Cap() != c.all || p.each != c.each {
			t.Errorf("%d places for the rows: %d lists at once, %d of one cluster, want %d and %d", c.rows, p.all.Cap(), p.each, c.all, c.each)
		}
	}
	if podRowLists.all.Cap() != podListsAtOnce(cap(podRowSlots)) {
		t.Errorf("%d lists at once beside %d places for the rows, want %d", podRowLists.all.Cap(), cap(podRowSlots), podListsAtOnce(cap(podRowSlots)))
	}
}

// Ten people on each of three clusters that do not answer list no more at once than the places, at most half of them one
// cluster's, so the third cluster's lists go on beside the first's; all get their answer.
func TestThePodListsOfOneClusterTakeAtMostHalfThePlaces(t *testing.T) {
	rowPlacesFor(t, 8)
	release := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	clusters := make([]*heldLists, 3)
	waits := make([]func() []error, 3)
	for i := range clusters {
		clusters[i] = &heldLists{release: release}
		waits[i] = clusters[i].open(ctx, clusters[i].start(t, cluster.ID(fmt.Sprintf("c%d", i))), 10)
		if i == 0 {
			// the first has all it may take before the others come
			if !eventually(t, 5*time.Second, func() bool { now, _ := clusters[0].underWay(); return now >= podRowLists.each }) {
				t.Fatal("the first cluster's lists never started")
			}
		}
	}
	all := func() (n int) {
		for _, c := range clusters {
			now, _ := c.underWay()
			n += now
		}
		return n
	}
	if !eventually(t, 5*time.Second, func() bool { return all() >= podRowLists.all.Cap() }) {
		t.Errorf("%d lists at once, want %d", all(), podRowLists.all.Cap())
	}
	time.Sleep(200 * time.Millisecond)
	if n := all(); n > podRowLists.all.Cap() {
		t.Errorf("%d lists at once, want at most %d", n, podRowLists.all.Cap())
	}
	if rows, _ := placesTaken(); rows != 0 {
		t.Errorf("%d places of the rows held by callers whose lists are under way", rows)
	}
	close(release)
	for i, wait := range waits {
		for _, err := range wait() {
			if err != nil {
				t.Errorf("cluster %d: %v", i, err)
			}
		}
		if _, most := clusters[i].underWay(); most > podRowLists.each || most == 0 {
			t.Errorf("cluster %d: %d lists at once, want 1 to %d", i, most, podRowLists.each)
		}
	}
	if rows, lists := placesTaken(); rows != 0 || lists != 0 {
		t.Errorf("%d places of the rows and %d of the lists still taken", rows, lists)
	}
}

// A caller that leaves while it waits for a place, its cluster's or one of all, holds none, and neither does one whose
// list failed or whose request ended before the cluster answered.
func TestAPodListThatGivesUpHoldsNoPlace(t *testing.T) {
	ctx := context.Background()
	p := newPodListPlaces(4) // three, two of one cluster
	short := func() context.Context {
		c, stop := context.WithTimeout(ctx, 50*time.Millisecond)
		t.Cleanup(stop)
		return c
	}
	take := func(id cluster.ID) func() {
		t.Helper()
		give, err := p.take(short(), id)
		if err != nil {
			t.Fatalf("a place of %s: %v", id, err)
		}
		return give
	}
	first, second := take("a"), take("a")
	if _, err := p.take(short(), "a"); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("a third list of one cluster: %v", err)
	}
	if p.of["a"].InUse() != 2 || p.all.InUse() != 2 {
		t.Errorf("after it left: %d of the cluster's and %d of all taken, want 2 and 2", p.of["a"].InUse(), p.all.InUse())
	}
	third := take("b")
	if _, err := p.take(short(), "c"); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("a fourth list: %v", err)
	}
	if p.of["c"].InUse() != 0 || p.all.InUse() != 3 {
		t.Errorf("after it left: %d of its cluster's and %d of all taken, want 0 and 3", p.of["c"].InUse(), p.all.InUse())
	}
	first()
	fourth := take("c")
	for _, give := range []func(){second, third, fourth} {
		give()
	}
	if p.all.InUse() != 0 || p.of["a"].InUse() != 0 || p.of["b"].InUse() != 0 || p.of["c"].InUse() != 0 {
		t.Error("a place was not given back")
	}

	rowPlacesFor(t, 2)
	failed := (&heldLists{fail: http.StatusInternalServerError}).start(t, "failed")
	if _, err := failed.GetPodPage(ctx, PodPageQuery{Limit: 50}); err == nil {
		t.Error("a page of a list that failed")
	}
	held := &heldLists{release: make(chan struct{})}
	if _, err := held.start(t, "held").GetPodPage(short(), PodPageQuery{Limit: 50}); err == nil {
		t.Error("a page of a list that did not answer")
	}
	close(held.release)
	if rows, lists := placesTaken(); rows != 0 || lists != 0 {
		t.Errorf("%d places of the rows and %d of the lists still taken", rows, lists)
	}
}

// madePods lists n typical pods a page at a time.
type madePods struct {
	typedcorev1.PodInterface
	n int
}

func (m madePods) Pods(string) typedcorev1.PodInterface { return m }

func (m madePods) List(_ context.Context, o metav1.ListOptions) (*corev1.PodList, error) {
	from, _ := strconv.Atoi(o.Continue)
	to := min(from+int(o.Limit), m.n)
	rng := rand.New(rand.NewSource(int64(from)))
	l := &corev1.PodList{}
	for i := from; i < to; i++ {
		l.Items = append(l.Items, *typicalPod(rng, i))
	}
	if to < m.n {
		l.Continue = strconv.Itoa(to)
	}
	return l, nil
}

// What the lists and the callers of the informers' rows hold together, every place taken, on 50 000 pods: no more than
// the same number of lists, which is what the places held when they were for both, with three or more; with one or two,
// the callers of the informers' rows on top. Each list holds its rows and the page it reads.
func TestPodListsAndRowPlacesHoldNoMoreThanRowPlacesLists(t *testing.T) {
	if testing.Short() {
		t.Skip("lists 50 000 pods")
	}
	const n = 50_000
	before := heapInUse()
	rows, err := listPodRows(context.Background(), madePods{n: n}, nil)
	if err != nil || len(rows) != n {
		t.Fatalf("%d rows, %v", len(rows), err)
	}
	listed := heapInUse() - before
	before = heapInUse()
	last, err := madePods{n: n}.List(context.Background(), metav1.ListOptions{Limit: podListChunk})
	if err != nil || len(last.Items) != podListChunk {
		t.Fatal("no page", err)
	}
	listed += heapInUse() - before
	runtime.KeepAlive(last)

	// a caller of the informers holds pointers to rows they share: all it allocates counts as held
	store := cache.NewIndexer(cache.DeletionHandlingMetaNamespaceKeyFunc, podRowIndexers())
	for _, r := range rows {
		if err := store.Add(r); err != nil {
			t.Fatal(err)
		}
	}
	ci := &clusterInformers{pods: store}
	runtime.GC()
	var from, to runtime.MemStats
	runtime.ReadMemStats(&from)
	page := buildPodPage(ci.podRows(true, nil), PodPageQuery{Limit: 50}, time.Now())
	runtime.ReadMemStats(&to)
	shared := to.TotalAlloc - from.TotalAlloc
	if page.Total != n {
		t.Fatalf("%d rows in the page, want %d", page.Total, n)
	}
	runtime.KeepAlive(rows)
	mb := func(b uint64) float64 { return float64(b) / 1e6 }
	t.Logf("%d pods: a caller listing holds %.1f MB of rows with the page it reads, one of the informers' rows %.1f MB", n, mb(listed), mb(shared))
	for places := uint64(1); places <= maxPodRowPlaces; places++ {
		lists := uint64(podListsAtOnce(int(places)))
		was, now := places*listed, lists*listed+places*shared
		t.Logf("%d places for the rows: %.1f MB when they were for both, %.1f MB with %d lists apart", places, mb(was), mb(now), lists)
		if over := places <= 2; !over && now > was || over && now > was+places*shared {
			t.Errorf("%d places for the rows and %d for the lists hold %.1f MB, the %d places for both held %.1f", places, lists, mb(now), places, mb(was))
		}
	}
}
