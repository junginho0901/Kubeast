package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"runtime/debug"
	"runtime/metrics"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const bulkPods = "/api/v1/namespaces/bulk/pods?force_refresh=false"

// podsAPI answers the pods of the namespace bulk a page at a time as the API server does (limit, continue) and counts
// the pages each identity read. With byUser every pod carries a label naming whom it was read for, so an answer that
// reached another identity shows.
type podsAPI struct {
	pods   int
	byUser bool
	mu     sync.Mutex
	gate   chan struct{} // when set, a first page waits for it
	pages  map[string]int
	firsts map[string]int
	enc    map[string][]byte
}

func newPodsAPI(pods int, byUser bool) *podsAPI {
	return &podsAPI{pods: pods, byUser: byUser, pages: map[string]int{}, firsts: map[string]int{}, enc: map[string][]byte{}}
}

func (a *podsAPI) hold() chan struct{} {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.gate = make(chan struct{})
	return a.gate
}

// reads is how many pages and whole reads (first pages) user made.
func (a *podsAPI) reads(user string) (pages, whole int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.pages[user], a.firsts[user]
}

func (a *podsAPI) forget() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.pages, a.firsts = map[string]int{}, map[string]int{}
}

func (a *podsAPI) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/v1/namespaces/bulk/pods" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	user := r.Header.Get(auth.HeaderImpersonateUser)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = a.pods
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("continue"))
	a.mu.Lock()
	a.pages[user]++
	if offset == 0 {
		a.firsts[user]++
	}
	gate := a.gate
	a.mu.Unlock()
	if gate != nil && offset == 0 {
		select {
		case <-gate:
		case <-r.Context().Done():
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(a.page(user, offset, limit))
}

// page is the list of the pods from offset, kept once made: the stand-in should cost the measurement nothing per read.
func (a *podsAPI) page(user string, offset, limit int) []byte {
	key := fmt.Sprintf("%d/%d", offset, limit)
	if a.byUser {
		key = user + "/" + key
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if b, ok := a.enc[key]; ok {
		return b
	}
	end := min(offset+limit, a.pods)
	list := corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, ListMeta: metav1.ListMeta{ResourceVersion: "7"}}
	if end < a.pods {
		list.Continue = strconv.Itoa(end)
	}
	for i := offset; i < end; i++ {
		answeredFor := ""
		if a.byUser {
			answeredFor = user
		}
		list.Items = append(list.Items, loadPod(i, answeredFor))
	}
	b, _ := json.Marshal(list)
	a.enc[key] = b
	return b
}

// loadPod is a pod as the load kit's KWOK namespace holds them: one container of a ReplicaSet, running on a node.
func loadPod(i int, answeredFor string) corev1.Pod {
	yes := true
	started := metav1.Date(2026, 11, 1, 0, 0, 30, 0, time.UTC)
	labels := map[string]string{"app": "load", "pod-template-hash": "5d8f7c9b6"}
	if answeredFor != "" {
		labels["answered-for"] = answeredFor
	}
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: fmt.Sprintf("load-5d8f7c9b6-%05d", i), Namespace: "bulk", UID: types.UID(fmt.Sprintf("00000000-0000-0000-0000-%012d", i)),
			Labels: labels, CreationTimestamp: metav1.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
			OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: "load-5d8f7c9b6", UID: "rs-uid", Controller: &yes}},
		},
		Spec: corev1.PodSpec{
			NodeName: fmt.Sprintf("kwok-node-%d", i%1000), ServiceAccountName: "default",
			Containers: []corev1.Container{{Name: "app", Image: "fake-image", Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m"), corev1.ResourceMemory: resource.MustParse("16Mi")},
			}}},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning, PodIP: fmt.Sprintf("10.%d.%d.%d", i>>16&255, i>>8&255, i&255), HostIP: fmt.Sprintf("172.18.%d.%d", i%1000/250, i%250),
			StartTime: &started,
			Conditions: []corev1.PodCondition{
				{Type: corev1.PodInitialized, Status: corev1.ConditionTrue, LastTransitionTime: started},
				{Type: corev1.PodReady, Status: corev1.ConditionTrue, LastTransitionTime: started},
				{Type: corev1.ContainersReady, Status: corev1.ConditionTrue, LastTransitionTime: started},
				{Type: corev1.PodScheduled, Status: corev1.ConditionTrue, LastTransitionTime: started},
			},
			ContainerStatuses: []corev1.ContainerStatus{{
				Name: "app", Ready: true, Started: &yes, Image: "fake-image", ImageID: "fake-image",
				State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: started}},
			}},
		},
	}
}

// podsFront is the pods routes behind the middleware that signs the caller in and names the cluster, sharing reads as
// the server does when shared is true; arrived counts the requests that reached it.
func podsFront(t testing.TB, api *podsAPI, shared bool) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	cluster := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(cluster.Close)
	svc, err := k8s.NewService(context.Background(), apiCluster{url: cluster.URL}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{Impersonation: true})
	if err != nil {
		t.Fatal(err)
	}
	h := handler.New(svc, config.Config{}, nil)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			user := req.Header.Get("X-Test-User")
			perms := auth.PermissionMatrix{"alpha": {"resource.*.read"}}
			next.ServeHTTP(w, req.WithContext(auth.WithPayload(req.Context(), auth.TokenPayload{UserID: user, Email: user, Perms: perms, Roles: map[string]string{"alpha": "read"}})))
		})
	})
	r.Use(h.ClusterMiddleware)
	if shared {
		RegisterPods(sharingReads(r, h), h)
	} else {
		RegisterPods(r, h)
	}
	arrived := &atomic.Int64{}
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		arrived.Add(1)
		r.ServeHTTP(w, req)
	}))
	t.Cleanup(front.Close)
	return front, arrived
}

type podsAnswer struct {
	status int
	size   int64
	sum    string
	err    error
}

// askPods reads an answer without holding it, as a browser that renders as it reads: only its size and hash stay.
func askPods(ctx context.Context, srv *httptest.Server, user string) podsAnswer {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+bulkPods, nil)
	if err != nil {
		return podsAnswer{err: err}
	}
	req.Header.Set("X-Test-User", user)
	res, err := srv.Client().Do(req)
	if err != nil {
		return podsAnswer{err: err}
	}
	defer res.Body.Close()
	h := sha256.New()
	n, err := io.Copy(h, res.Body)
	return podsAnswer{status: res.StatusCode, size: n, sum: hex.EncodeToString(h.Sum(nil)), err: err}
}

func waitFor(t testing.TB, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("waited 10 s for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// askTogether sends users' requests while the cluster holds the first page, then lets it go once all have arrived.
func askTogether(t testing.TB, srv *httptest.Server, arrived *atomic.Int64, api *podsAPI, users []string) []podsAnswer {
	t.Helper()
	gate := api.hold()
	before := arrived.Load()
	answers := make([]podsAnswer, len(users))
	var wg sync.WaitGroup
	for i, user := range users {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i] = askPods(context.Background(), srv, user)
		}()
	}
	waitFor(t, "every request to arrive", func() bool { return arrived.Load()-before == int64(len(users)) })
	// past the router, each request takes its place with the read under way before the cluster answers
	time.Sleep(50 * time.Millisecond)
	close(gate)
	wg.Wait()
	return answers
}

const sharedTestPods = 1200 // three pages of eachPod's 500

// Ten reads of a namespace's pods by one person at one moment list the namespace at most twice, a page at a time: the
// one with no read to wait for reads alone, those who came while it read share one more. Every answer is the lone one.
func TestTenReadsOfANamespacesPodsByOnePersonListItAtMostTwice(t *testing.T) {
	api := newPodsAPI(sharedTestPods, false)
	srv, arrived := podsFront(t, api, true)
	lone := askPods(context.Background(), srv, "alice")
	if lone.err != nil || lone.status != http.StatusOK {
		t.Fatalf("lone read: %+v", lone)
	}
	api.forget()
	users := make([]string, 10)
	for i := range users {
		users[i] = "alice"
	}
	answers := askTogether(t, srv, arrived, api, users)
	pages, whole := api.reads("alice")
	t.Logf("10 reads of one person at once: %d whole lists of the namespace, %d pages, answer %d bytes", whole, pages, lone.size)
	if whole < 1 || whole > 2 || pages != whole*3 {
		t.Errorf("%d whole lists in %d pages for 10 reads of one person, want one or two of 3 pages each", whole, pages)
	}
	for i, a := range answers {
		if a.err != nil || a.status != http.StatusOK || a.sum != lone.sum {
			t.Errorf("answer %d: %d, %d bytes, %v; the lone answer is %d bytes", i, a.status, a.size, a.err, lone.size)
		}
	}
}

// Two people asking at once each get the pods their own identity read: a list never answers another identity.
func TestReadsOfANamespacesPodsAreNotSharedBetweenIdentities(t *testing.T) {
	api := newPodsAPI(sharedTestPods, true)
	srv, arrived := podsFront(t, api, true)
	users := []string{"alice", "bob", "alice", "bob", "alice", "bob", "alice", "bob", "alice", "bob"}
	lone := map[string]podsAnswer{}
	for _, user := range []string{"alice", "bob"} {
		lone[user] = askPods(context.Background(), srv, user)
		if lone[user].err != nil || lone[user].status != http.StatusOK {
			t.Fatalf("lone read of %s: %+v", user, lone[user])
		}
	}
	if lone["alice"].sum == lone["bob"].sum {
		t.Fatal("the stand-in answers both identities alike")
	}
	api.forget()
	answers := askTogether(t, srv, arrived, api, users)
	for i, a := range answers {
		if a.err != nil || a.status != http.StatusOK || a.sum != lone[users[i]].sum {
			t.Errorf("%s's answer %d is not what %s reads alone: %d, %v", users[i], i, users[i], a.status, a.err)
		}
	}
	for _, user := range []string{"alice", "bob"} {
		pages, whole := api.reads(user)
		t.Logf("%s, 5 reads at once: %d whole lists, %d pages", user, whole, pages)
		if whole < 1 || whole > 2 || pages != whole*3 {
			t.Errorf("%s: %d whole lists in %d pages for 5 reads, want one or two of 3 pages each", user, whole, pages)
		}
	}
}

// The request a read started for may leave, and so may the first who waited for the next read: the others still get
// the whole answer.
func TestAReaderLeavingFailsNoOtherReaderOfTheNamespacesPods(t *testing.T) {
	api := newPodsAPI(sharedTestPods, false)
	srv, arrived := podsFront(t, api, true)
	lone := askPods(context.Background(), srv, "alice")
	if lone.err != nil || lone.status != http.StatusOK {
		t.Fatalf("lone read: %+v", lone)
	}
	api.forget()
	gate := api.hold()
	before := arrived.Load()
	firstCtx, leaveFirst := context.WithCancel(context.Background())
	defer leaveFirst()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		_ = askPods(firstCtx, srv, "alice")
	}()
	waitFor(t, "the first read to reach the cluster", func() bool { _, whole := api.reads("alice"); return whole == 1 })
	nextCtx, leaveNext := context.WithCancel(context.Background())
	defer leaveNext()
	nextDone := make(chan struct{})
	go func() {
		defer close(nextDone)
		_ = askPods(nextCtx, srv, "alice")
	}()
	waitFor(t, "the second request to arrive", func() bool { return arrived.Load()-before == 2 })
	time.Sleep(50 * time.Millisecond)
	answers := make([]podsAnswer, 8)
	var wg sync.WaitGroup
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i] = askPods(context.Background(), srv, "alice")
		}()
	}
	waitFor(t, "every request to arrive", func() bool { return arrived.Load()-before == 10 })
	time.Sleep(50 * time.Millisecond)
	leaveFirst()
	leaveNext()
	<-firstDone
	<-nextDone
	close(gate)
	wg.Wait()
	for i, a := range answers {
		if a.err != nil || a.status != http.StatusOK || a.sum != lone.sum {
			t.Errorf("answer %d after two readers left: %d, %d bytes, %v; the lone answer is %d bytes", i, a.status, a.size, a.err, lone.size)
		}
	}
}

// A read of a namespace's whole pod list holds little more than the answer it writes, not every row as a map besides:
// that read of a 50 000-pod namespace alone took k8s-service near its 461 MiB GC limit, so a crowd's one shared read did too.
func TestAWholeReadOfANamespacesPodsHoldsLittleMoreThanItsAnswer(t *testing.T) {
	const pods = 10000
	api := newPodsAPI(pods, false)
	srv, _ := podsFront(t, api, true)
	if warm := askPods(context.Background(), srv, "warm"); warm.status != http.StatusOK {
		t.Fatalf("warm read: %+v", warm)
	}
	old := debug.SetGCPercent(10)
	defer debug.SetGCPercent(old)
	runtime.GC()
	base := heapNow()
	stop := make(chan struct{})
	peak := heapPeak(stop)
	a := askPods(context.Background(), srv, "alice")
	close(stop)
	top := <-peak
	if a.err != nil || a.status != http.StatusOK {
		t.Fatalf("read: %+v", a)
	}
	held := top - min(top, base)
	t.Logf("a read of %d pods: answer %.1f MiB, heap above the start %.1f MiB (%.1f times the answer)", pods, float64(a.size)/(1<<20), float64(held)/(1<<20), float64(held)/float64(a.size))
	if held > 5*uint64(a.size) {
		t.Errorf("the read held %d bytes above the start for an answer of %d, want at most 5 times the answer", held, a.size)
	}
}

// heapPeak samples the heap's objects until stop is closed and returns the most it saw.
func heapPeak(stop <-chan struct{}) <-chan uint64 {
	out := make(chan uint64, 1)
	go func() {
		sample := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
		var peak uint64
		tick := time.NewTicker(500 * time.Microsecond)
		defer tick.Stop()
		for {
			metrics.Read(sample)
			peak = max(peak, sample[0].Value.Uint64())
			select {
			case <-stop:
				out <- peak
				return
			case <-tick.C:
			}
		}
	}()
	return out
}

// BenchmarkTenReadersOfOneNamespacesPods measures the heap ten readers of one namespace's whole pod list take at once
// (BENCH_PODS pods, 20 000 by default): one alone, ten of one person shared as the server does, the same ten with
// nothing shared, and ten people. GOGC is 10 meanwhile, so the peak is close to what was live. Run with -benchtime=1x.
func BenchmarkTenReadersOfOneNamespacesPods(b *testing.B) {
	pods := 20000
	if n, err := strconv.Atoi(os.Getenv("BENCH_PODS")); err == nil && n > 0 {
		pods = n
	}
	people := make([]string, 10)
	for i := range people {
		people[i] = fmt.Sprintf("p%02d", i)
	}
	samePerson := make([]string, 10)
	for i := range samePerson {
		samePerson[i] = "alice"
	}
	cases := []struct {
		name   string
		shared bool
		users  []string
	}{
		{"one-alone", true, []string{"alice"}},
		{"ten-same-person-shared", true, samePerson},
		{"ten-same-person-not-shared", false, samePerson},
		{"ten-people-shared", true, people},
	}
	for _, c := range cases {
		b.Run(c.name, func(b *testing.B) {
			api := newPodsAPI(pods, false)
			srv, arrived := podsFront(b, api, c.shared)
			// the stand-in's pages are made before the measurement
			if warm := askPods(context.Background(), srv, "warm"); warm.status != http.StatusOK {
				b.Fatalf("warm read: %+v", warm)
			}
			for b.Loop() {
				api.forget()
				old := debug.SetGCPercent(10)
				runtime.GC()
				base := heapNow()
				var before runtime.MemStats
				runtime.ReadMemStats(&before)
				stop := make(chan struct{})
				peak := heapPeak(stop)
				answers := askTogether(b, srv, arrived, api, c.users)
				close(stop)
				top := <-peak
				var after runtime.MemStats
				runtime.ReadMemStats(&after)
				debug.SetGCPercent(old)
				pages, whole := 0, 0
				for _, u := range uniq(c.users) {
					p, w := api.reads(u)
					pages, whole = pages+p, whole+w
				}
				for i, a := range answers {
					if a.err != nil || a.status != http.StatusOK {
						b.Fatalf("answer %d: %+v", i, a)
					}
				}
				b.ReportMetric(float64(top)/(1<<20), "peak-heap-MiB")
				b.ReportMetric(float64(top-min(top, base))/(1<<20), "above-start-MiB")
				b.ReportMetric(float64(after.TotalAlloc-before.TotalAlloc)/(1<<20), "allocated-MiB")
				b.ReportMetric(float64(whole), "whole-lists")
				b.ReportMetric(float64(pages), "pages")
				b.ReportMetric(float64(answers[0].size)/(1<<20), "answer-MiB")
			}
		})
	}
}

func heapNow() uint64 {
	sample := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	metrics.Read(sample)
	return sample[0].Value.Uint64()
}

func uniq(users []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, u := range users {
		if !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	return out
}
