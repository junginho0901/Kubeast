package handler

import (
	"context"
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

	blocked := evictAll(context.Background(), cs, []corev1.Pod{pod})
	if len(blocked) != 0 {
		t.Fatalf("expected eviction to succeed after PDB retries, got %v", blocked)
	}
	if *calls != 3 {
		t.Fatalf("expected 3 eviction attempts (2 rejected + 1 ok), got %d", *calls)
	}
	if err := waitForPodsGone(context.Background(), cs, []corev1.Pod{pod}); err != nil {
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
	blocked := evictAll(ctx, cs, []corev1.Pod{pod})
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
	blocked := evictAll(ctx, cs, []corev1.Pod{held, free})
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
	blocked := evictAll(context.Background(), cs, []corev1.Pod{pod})
	if len(blocked) != 1 || calls != 1 {
		t.Fatalf("forbidden must be reported after one attempt, got blocked=%v calls=%d", blocked, calls)
	}
}
