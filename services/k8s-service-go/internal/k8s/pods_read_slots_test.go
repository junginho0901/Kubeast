package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// pagedPods answers pod lists in pages as the API server does, per namespace: "big-*" has many pages, anything else
// one. It counts the requests for a page past the first, the ones a place is for.
type pagedPods struct {
	perNamespace int
	delay        time.Duration
	hold         chan struct{} // when set, a page past the first waits for it
	failOnPage2  bool

	mu            sync.Mutex
	later, most   int
	laterRequests atomic.Int64
}

func (a *pagedPods) client(t testing.TB) *kubernetes.Clientset {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		parts := strings.Split(r.URL.Path, "/")
		ns := parts[4]
		total := a.perNamespace
		if !strings.HasPrefix(ns, "big-") {
			total = 3
		}
		limit, _ := strconv.Atoi(q.Get("limit"))
		from, _ := strconv.Atoi(q.Get("continue"))
		if from > 0 {
			a.laterRequests.Add(1)
			a.mu.Lock()
			a.later++
			if a.later > a.most {
				a.most = a.later
			}
			a.mu.Unlock()
			defer func() {
				a.mu.Lock()
				a.later--
				a.mu.Unlock()
			}()
			if a.hold != nil {
				select {
				case <-a.hold:
				case <-r.Context().Done():
					return
				}
			}
			if a.failOnPage2 {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
		}
		time.Sleep(a.delay)
		to := min(from+limit, total)
		meta := metav1.ListMeta{}
		if to < total {
			meta.Continue = strconv.Itoa(to)
		}
		items := make([]corev1.Pod, 0, to-from)
		for i := from; i < to; i++ {
			items = append(items, corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("p-%d", i), Namespace: ns}})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, ListMeta: meta, Items: items})
	}))
	t.Cleanup(srv.Close)
	k, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func (a *pagedPods) mostAtOnce() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.most
}

// Reads of many pages wait their turn instead of being refused, each reads every pod, and every place comes back.
func TestBigPodReadsTakeTurnsAndEveryPodIsRead(t *testing.T) {
	api := &pagedPods{perNamespace: 3*podListChunk + 1, delay: 5 * time.Millisecond}
	k := api.client(t)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n := 0
			err := eachPod(context.Background(), k.CoreV1(), fmt.Sprintf("big-%d", i), metav1.ListOptions{}, func(*corev1.Pod) { n++ })
			if err != nil || n != api.perNamespace {
				t.Errorf("read %d: %d pods, %v", i, n, err)
			}
		}()
	}
	wg.Wait()
	t.Logf("pages past the first at once: %d, for 12 reads of 4 pages", api.mostAtOnce())
	if got := api.mostAtOnce(); got > 2 {
		t.Errorf("%d big reads at once, want at most 2", got)
	}
	if n := bigReadSlots.InUse(); n != 0 {
		t.Errorf("%d places still taken", n)
	}
}

// A namespace that fits one page waits for no one, with every place taken.
func TestAOnePagePodReadWaitsForNoBigRead(t *testing.T) {
	api := &pagedPods{perNamespace: 2 * podListChunk, hold: make(chan struct{})}
	k := api.client(t)
	var wg sync.WaitGroup
	for i := 0; i < bigReadSlots.Cap(); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := eachPod(context.Background(), k.CoreV1(), fmt.Sprintf("big-%d", i), metav1.ListOptions{}, func(*corev1.Pod) {}); err != nil {
				t.Error(err)
			}
		}()
	}
	if !eventually(t, 5*time.Second, func() bool { return api.laterRequests.Load() == int64(bigReadSlots.Cap()) }) {
		t.Fatalf("%d big reads got past the first page", api.laterRequests.Load())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	n := 0
	if err := eachPod(ctx, k.CoreV1(), "small", metav1.ListOptions{}, func(*corev1.Pod) { n++ }); err != nil || n != 3 {
		t.Errorf("a small namespace with every place taken: %d pods, %v", n, err)
	}
	close(api.hold)
	wg.Wait()
}

// A read waiting for a place ends with its request and takes none.
func TestAWaitingPodReadEndsWithItsRequest(t *testing.T) {
	api := &pagedPods{perNamespace: 2 * podListChunk, hold: make(chan struct{})}
	k := api.client(t)
	var wg sync.WaitGroup
	for i := 0; i < bigReadSlots.Cap(); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = eachPod(context.Background(), k.CoreV1(), fmt.Sprintf("big-%d", i), metav1.ListOptions{}, func(*corev1.Pod) {})
		}()
	}
	if !eventually(t, 5*time.Second, func() bool { return api.laterRequests.Load() == int64(bigReadSlots.Cap()) }) {
		t.Fatalf("%d big reads got past the first page", api.laterRequests.Load())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	err := eachPod(ctx, k.CoreV1(), "big-waiting", metav1.ListOptions{}, func(*corev1.Pod) {})
	if err == nil || ctx.Err() == nil {
		t.Errorf("the read waiting for a place: %v", err)
	}
	if got := api.laterRequests.Load(); got != int64(bigReadSlots.Cap()) {
		t.Errorf("%d later pages asked for, want the %d under way", got, bigReadSlots.Cap())
	}
	close(api.hold)
	wg.Wait()
	if n := bigReadSlots.InUse(); n != 0 {
		t.Errorf("%d places still taken", n)
	}
}

// A read that fails part-way gives its place back and says why.
func TestAFailedPodReadGivesItsPlaceBack(t *testing.T) {
	api := &pagedPods{perNamespace: 2 * podListChunk, failOnPage2: true}
	k := api.client(t)
	for i := 0; i < 2*bigReadSlots.Cap()+1; i++ {
		if err := eachPod(context.Background(), k.CoreV1(), "big-x", metav1.ListOptions{}, func(*corev1.Pod) {}); err == nil {
			t.Fatal("no error from a page that failed")
		}
	}
	if n := bigReadSlots.InUse(); n != 0 {
		t.Errorf("%d places still taken", n)
	}
}

// The reads that walk pages themselves wait with the rest: the issues, Cluster Hygiene and the Resource Graph.
func TestPagedPodReadsOutsideEachPodTakeTurnsToo(t *testing.T) {
	api := &pagedPods{perNamespace: 3*podListChunk + 1, delay: 5 * time.Millisecond}
	k := api.client(t)
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: k})
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u", Namespaces: map[string][]string{"default": {fmt.Sprintf("big-%d", i)}}})
			if _, err := s.podIssues(ctx, IssuesOptions{}); err != nil {
				t.Errorf("issues %d: %v", i, err)
			}
		}()
	}
	wg.Wait()
	t.Logf("pages past the first at once: %d", api.mostAtOnce())
	if got := api.mostAtOnce(); got > 2 {
		t.Errorf("%d big reads at once, want at most 2", got)
	}
}
