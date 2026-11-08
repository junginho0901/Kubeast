package k8s

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	"k8s.io/client-go/kubernetes/scheme"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// When people arrive while the client's rate to a cluster is taken, an access check asked for the first time gets the
// next turns before the checks of screens already open asking again after their answer ran out; the number of checks
// and the rate stay as they were.
func TestAFirstAccessCheckGoesBeforeChecksAskedAgain(t *testing.T) {
	var mu sync.Mutex
	var order []string
	var at []time.Time
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		review := &authorizationv1.SelfSubjectAccessReview{}
		if _, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, review); err != nil || review.Spec.ResourceAttributes == nil {
			http.Error(w, "unreadable review", http.StatusBadRequest)
			return
		}
		mu.Lock()
		order = append(order, review.Spec.ResourceAttributes.Namespace)
		at = append(at, time.Now())
		mu.Unlock()
		review.APIVersion, review.Kind, review.Status.Allowed = "authorization.k8s.io/v1", "SelfSubjectAccessReview", true
		writeJSON(w, review)
	}))
	t.Cleanup(srv.Close)
	impersonationEnabled, clientRates = true, rates{qps: 10, burst: 1}
	t.Cleanup(func() { impersonationEnabled, clientRates = false, rates{} })
	b, err := buildClientBundle(cluster.Info{ID: "default", KubeconfigBlob: strings.Replace(testKubeconfig, "https://127.0.0.1:6443", srv.URL, 1)})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{cache: cache.New("", 0, 0, "")}
	s.defaultBundle.Store(b)
	ctx := wideCaller("reader@example.com")
	again := []string{"again-1", "again-2", "again-3", "again-4", "again-5", "again-6"}
	first := []string{"first-1", "first-2", "first-3", "first-4", "first-5", "first-6"}
	// screens already open asked these once, and their answers ran out
	for _, ns := range again {
		if _, err := s.mayList(ctx, b, "pods", ns); err != nil {
			t.Fatal(err)
		}
		s.cache.Delete(ctx, s.clusterCacheKey(ctx, "pods_list_allowed:"+ns))
	}
	mu.Lock()
	order, at = nil, nil
	mu.Unlock()
	var wg sync.WaitGroup
	ask := func(ns string) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.mayList(ctx, b, "pods", ns); err != nil {
				t.Error(err)
			}
		}()
	}
	for _, ns := range again {
		ask(ns)
	}
	time.Sleep(150 * time.Millisecond)
	for _, ns := range first {
		ask(ns)
	}
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	lastFirst, againBefore := -1, 0
	for i, ns := range order {
		if strings.HasPrefix(ns, "first") {
			lastFirst = i
		}
	}
	for _, ns := range order[:lastFirst+1] {
		if strings.HasPrefix(ns, "again") {
			againBefore++
		}
	}
	t.Logf("order the cluster got the checks in: %v", order)
	if len(order) != len(again)+len(first) {
		t.Fatalf("%d checks reached the cluster, want %d", len(order), len(again)+len(first))
	}
	if againBefore > 2 {
		t.Errorf("%d checks asked again went before the last first check, want at most the 2 already on their way", againBefore)
	}
	if took := at[len(at)-1].Sub(at[0]); took < time.Second {
		t.Errorf("12 checks at 10 a second with a burst of 1 took %v, want at least 1 s: the rate must stay", took)
	}
}
