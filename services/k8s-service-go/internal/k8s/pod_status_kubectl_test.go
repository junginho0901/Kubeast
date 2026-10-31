package k8s

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// A Running pod whose containers are not all ready reads Running, as kubectl's STATUS (printPod, v1.37) says; the
// READY column carries readiness and the list draws it yellow. Until 10-31 the list said NotReady. Finding a pod by
// name still ranks it below a ready one, as before.
func TestPodListStatus_RunningNotReadyIsRunning(t *testing.T) {
	pod := func(ready bool) *corev1.Pod {
		return &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "a"},
			Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
			Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{
				Name: "app", Ready: ready, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
			}}},
		}
	}
	in := newInterner()
	notReady, ready := toPodRow(pod(false), in), toPodRow(pod(true), in)
	if notReady.status != "Running" {
		t.Fatalf("Running pod not ready: status %q, want Running (kubectl's STATUS)", notReady.status)
	}
	if got := podListStatus(pod(false), 0, 1); got != "Running" {
		t.Fatalf("podListStatus = %q, want Running", got)
	}
	if a, b := findScore(notReady), findScore(ready); a != 0 || b != 11 {
		t.Fatalf("find scores: not ready %d, ready %d — want 0 and 11, as when the status read NotReady", a, b)
	}
}
