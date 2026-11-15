package handler

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func drainTestPod(name string) corev1.Pod {
	return corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "app", UID: types.UID("uid-" + name)}}
}

// evictionReactor answers the Eviction subresource: 429 for the first `reject`
// calls, then success (and the pod disappears, as the API server would do).
func evictionReactor(cs *fake.Clientset, reject int) *int {
	calls := 0
	cs.PrependReactor("create", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.GetSubresource() != "eviction" {
			return false, nil, nil
		}
		calls++
		if calls <= reject {
			return true, nil, apierrors.NewTooManyRequests("Cannot evict pod as it would violate the pod's disruption budget.", 5)
		}
		name := action.(k8stesting.CreateAction).GetObject().(metav1.Object).GetName()
		_ = cs.Tracker().Delete(corev1.SchemeGroupVersion.WithResource("pods"), action.GetNamespace(), name)
		return true, nil, nil
	})
	return &calls
}

func TestEvictAll_RetriesPDBThenSucceeds(t *testing.T) {
	evictRetryInterval = time.Millisecond
	pod := drainTestPod("web-1")
	cs := fake.NewSimpleClientset(&pod)
	calls := evictionReactor(cs, 2)

	blocked := evictAll(context.Background(), cs, []corev1.Pod{pod}, nil)
	if len(blocked) != 0 {
		t.Fatalf("expected eviction to succeed after PDB retries, got %v", blocked)
	}
	if *calls != 3 {
		t.Fatalf("expected 3 eviction attempts (2 rejected + 1 ok), got %d", *calls)
	}
	if err := waitForPodsGone(context.Background(), cs, []corev1.Pod{pod}, nil); err != nil {
		t.Fatalf("pod should be gone: %v", err)
	}
}

func TestEvictAll_PDBBlockedIsReportedNeverForceDeleted(t *testing.T) {
	evictRetryInterval = time.Millisecond
	pod := drainTestPod("db-0")
	cs := fake.NewSimpleClientset(&pod)
	evictionReactor(cs, 1<<30)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	blocked := evictAll(ctx, cs, []corev1.Pod{pod}, nil)
	if len(blocked) != 1 || !strings.Contains(blocked[0], "PodDisruptionBudget") {
		t.Fatalf("expected the PDB-blocked pod to be reported, got %v", blocked)
	}
	for _, a := range cs.Actions() {
		if a.GetVerb() == "delete" {
			t.Fatalf("drain must never force-delete a pod, saw %v", a)
		}
	}
	if _, err := cs.CoreV1().Pods("app").Get(context.Background(), "db-0", metav1.GetOptions{}); err != nil {
		t.Fatalf("pod must still exist: %v", err)
	}
}

func TestEvictAll_BlockedPodDoesNotStarveTheOthers(t *testing.T) {
	evictRetryInterval = time.Millisecond
	held := drainTestPod("db-0")  // PDB holds it forever
	free := drainTestPod("web-1") // evictable
	cs := fake.NewSimpleClientset(&held, &free)
	cs.PrependReactor("create", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.GetSubresource() != "eviction" {
			return false, nil, nil
		}
		name := action.(k8stesting.CreateAction).GetObject().(metav1.Object).GetName()
		if name == "db-0" {
			return true, nil, apierrors.NewTooManyRequests("pdb", 5)
		}
		_ = cs.Tracker().Delete(corev1.SchemeGroupVersion.WithResource("pods"), action.GetNamespace(), name)
		return true, nil, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	blocked := evictAll(ctx, cs, []corev1.Pod{held, free}, nil)
	if len(blocked) != 1 || !strings.HasPrefix(blocked[0], "app/db-0") {
		t.Fatalf("only the PDB-held pod must be reported, got %v", blocked)
	}
	if _, err := cs.CoreV1().Pods("app").Get(context.Background(), "web-1", metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Fatalf("the free pod must have been evicted while db-0 was retrying, err=%v", err)
	}
}

func TestEvictAll_OtherErrorsAreReportedWithoutRetry(t *testing.T) {
	evictRetryInterval = time.Millisecond
	pod := drainTestPod("job-1")
	cs := fake.NewSimpleClientset(&pod)
	calls := 0
	cs.PrependReactor("create", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.GetSubresource() != "eviction" {
			return false, nil, nil
		}
		calls++
		return true, nil, apierrors.NewForbidden(corev1.Resource("pods"), "job-1", nil)
	})
	blocked := evictAll(context.Background(), cs, []corev1.Pod{pod}, nil)
	if len(blocked) != 1 || calls != 1 {
		t.Fatalf("forbidden must be reported after one attempt, got blocked=%v calls=%d", blocked, calls)
	}
}

// While the drain is held (ready waits) no eviction is made; when ready lets it go the pod is evicted,
// and when ready ends with an error the pod is reported with it, never evicted.
func TestEvictAll_WaitsForReadyBeforeEachEviction(t *testing.T) {
	evictRetryInterval = time.Millisecond
	pod := drainTestPod("web-1")
	cs := fake.NewSimpleClientset(&pod)
	calls := evictionReactor(cs, 0)
	release := make(chan struct{})
	waited := make(chan struct{})
	ready := func(ctx context.Context) error {
		close(waited)
		<-release
		return nil
	}
	done := make(chan []string, 1)
	go func() { done <- evictAll(context.Background(), cs, []corev1.Pod{pod}, ready) }()
	<-waited
	time.Sleep(50 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("evictAll returned while ready held it")
	default:
	}
	if evictions(cs) != 0 {
		t.Fatal("a pod was evicted while ready held the drain")
	}
	close(release)
	if blocked := <-done; len(blocked) != 0 || *calls != 1 {
		t.Fatalf("after ready let it go: blocked %v, %d eviction calls", blocked, *calls)
	}

	held := drainTestPod("web-2")
	cs = fake.NewSimpleClientset(&held)
	evictionReactor(cs, 0)
	stopped := func(context.Context) error {
		return errors.New("held while this server could not save its drain heartbeat")
	}
	if blocked := evictAll(context.Background(), cs, []corev1.Pod{held}, stopped); len(blocked) != 1 || !strings.Contains(blocked[0], "held while") {
		t.Fatalf("a drain that ended while held: %v", blocked)
	}
	if evictions(cs) != 0 {
		t.Fatal("a pod was evicted after ready ended with an error")
	}
}

func evictions(cs *fake.Clientset) int {
	n := 0
	for _, a := range cs.Actions() {
		if a.GetVerb() == "create" && a.GetSubresource() == "eviction" {
			n++
		}
	}
	return n
}
