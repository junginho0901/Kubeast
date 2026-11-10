package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// heavyFirstPage answers every pod list with a first page of perPage pods, each with a note of noteBytes, and a continue
// token; the page after it waits for next. Every other list is empty. It counts the first pages it answered.
type heavyFirstPage struct {
	perPage, noteBytes int
	next               chan struct{}
	firstPages         atomic.Int64
}

func (a *heavyFirstPage) pageBytes() uint64 { return uint64(a.perPage * a.noteBytes) }

func (a *heavyFirstPage) client(t *testing.T) *kubernetes.Clientset {
	t.Helper()
	note := strings.Repeat("x", a.noteBytes)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !strings.HasSuffix(r.URL.Path, "/pods") {
			fmt.Fprint(w, `{"metadata":{},"items":[]}`)
			return
		}
		if r.URL.Query().Get("continue") != "" {
			select {
			case <-a.next:
			case <-r.Context().Done():
				return
			}
			fmt.Fprint(w, `{"apiVersion":"v1","kind":"PodList","metadata":{},"items":[]}`)
			return
		}
		items := make([]corev1.Pod, a.perPage)
		for i := range items {
			items[i] = corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("p-%d", i), Namespace: "big", Annotations: map[string]string{"note": note}}}
		}
		_ = json.NewEncoder(w).Encode(corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, ListMeta: metav1.ListMeta{Continue: "page-2"}, Items: items})
		a.firstPages.Add(1)
	}))
	t.Cleanup(srv.Close)
	k, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// waitingForAPlace counts the goroutines waiting in a Slots' Take.
func waitingForAPlace() int {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			return strings.Count(string(buf[:n]), "limits.(*Slots).Take(")
		}
		buf = make([]byte, 2*len(buf))
	}
}

func liveHeap() uint64 {
	runtime.GC()
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

// A read of many pages that waits for its place lets go of the page it already read: the reads that wait together
// would otherwise hold a page each, past k8s-service's memory, while they wait.
func TestAReadWaitingForItsNextPageHoldsNoPageItAlreadyRead(t *testing.T) {
	reads := map[string]func(ctx context.Context, k *kubernetes.Clientset) error{
		"eachPod": func(ctx context.Context, k *kubernetes.Clientset) error {
			return eachPod(ctx, k.CoreV1(), "big", metav1.ListOptions{}, func(*corev1.Pod) {})
		},
		"rollout pages": func(ctx context.Context, k *kubernetes.Clientset) error {
			return eachRolloutPage(ctx, func(o metav1.ListOptions) (*corev1.PodList, error) { return k.CoreV1().Pods("big").List(ctx, o) }, func(*corev1.PodList) {})
		},
		"issues": func(ctx context.Context, k *kubernetes.Clientset) error {
			s := &Service{}
			s.defaultBundle.Store(&clientBundle{clientset: k})
			_, err := s.podIssues(ctx, IssuesOptions{})
			return err
		},
		"cluster hygiene": func(ctx context.Context, k *kubernetes.Clientset) error {
			_, err := hygienePodSummaryOf(ctx, k, 0)
			return err
		},
		"resource graph": func(ctx context.Context, k *kubernetes.Clientset) error {
			s := &Service{}
			s.defaultBundle.Store(&clientBundle{clientset: k})
			_, err := s.fetchResourceGraphData(ctx, nil)
			return err
		},
	}
	for _, name := range []string{"eachPod", "rollout pages", "issues", "cluster hygiene", "resource graph"} {
		t.Run(name, func(t *testing.T) {
			const waiting = 2
			api := &heavyFirstPage{perPage: 256, noteBytes: 64 << 10, next: make(chan struct{})}
			k := api.client(t)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			// every place taken, so each read stops before its second page
			var held []func()
			for range bigReadSlots.Cap() {
				release, err := bigReadSlots.Take(ctx)
				if err != nil {
					t.Fatal(err)
				}
				held = append(held, release)
			}
			giveBack := func() {
				for _, release := range held {
					release()
				}
				held = nil
			}
			defer giveBack()

			before, alreadyWaiting := liveHeap(), waitingForAPlace()
			var wg sync.WaitGroup
			errs := make(chan error, waiting)
			for range waiting {
				wg.Add(1)
				go func() {
					defer wg.Done()
					errs <- reads[name](ctx, k)
				}()
			}
			if !eventually(t, 20*time.Second, func() bool {
				return api.firstPages.Load() == waiting && waitingForAPlace() == alreadyWaiting+waiting
			}) {
				t.Fatalf("%d first pages read, %d reads waiting for a place, want %d each", api.firstPages.Load(), waitingForAPlace()-alreadyWaiting, waiting)
			}
			after := liveHeap()
			var perRead uint64
			if after > before {
				perRead = (after - before) / waiting
			}
			t.Logf("each waiting read holds %.1f MiB, a page is %.1f MiB", float64(perRead)/(1<<20), float64(api.pageBytes())/(1<<20))
			if perRead > api.pageBytes()/2 {
				t.Errorf("each of %d reads waiting for a place holds %.1f MiB, %.2f of the page it read (%.1f MiB)", waiting, float64(perRead)/(1<<20), float64(perRead)/float64(api.pageBytes()), float64(api.pageBytes())/(1<<20))
			}

			giveBack()
			close(api.next)
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Errorf("read: %v", err)
				}
			}
			if n := bigReadSlots.InUse(); n != 0 {
				t.Errorf("%d places still taken", n)
			}
		})
	}
}
