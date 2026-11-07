package k8s

import (
	"context"
	"fmt"
	"math/rand"
	"testing"

	corev1 "k8s.io/api/core/v1"
)

// The Namespace window's Pods table says what the Pods list says of a pod, with the phase beside it for the counts.
func TestNamespaceOwnedPods_SayWhatThePodsListSays(t *testing.T) {
	rng := rand.New(rand.NewSource(41))
	api := &listAPI{}
	for i := 0; i < 300; i++ {
		api.pods = append(api.pods, *randomPrintPod(rng, i))
	}
	rows, err := api.serve(t).GetNamespaceOwnedPods(context.Background(), "ns")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != len(api.pods) {
		t.Fatalf("%d rows for %d pods", len(rows), len(api.pods))
	}
	for i := range api.pods {
		pod := &api.pods[i]
		status, ready, total, restarts := podListView(pod)
		want := map[string]interface{}{
			"status": status, "phase": string(pod.Status.Phase), "ready": fmt.Sprintf("%d/%d", ready, total),
			"restart_count": restarts, "restarts": restarts,
		}
		for key, value := range want {
			if rows[i][key] != value {
				t.Errorf("%s %s: %v, want %v", pod.Name, key, rows[i][key], value)
			}
		}
	}
}

func TestNamespaceOwnedPods_ACrashingPodIsNotARunningOne(t *testing.T) {
	running := corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
	crashing := corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}
	api := &listAPI{pods: []corev1.Pod{
		bulkPod(0, "a", corev1.PodRunning, "", ""),
		bulkPod(1, "a", corev1.PodRunning, "", ""),
	}}
	api.pods[0].Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "c", Ready: true, State: running}}
	api.pods[1].Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "c", RestartCount: 4, State: crashing}}
	rows, err := api.serve(t).GetNamespaceOwnedPods(context.Background(), "bulk")
	if err != nil {
		t.Fatal(err)
	}
	got := [][2]interface{}{{rows[0]["status"], rows[0]["ready"]}, {rows[1]["status"], rows[1]["ready"]}}
	want := [][2]interface{}{{"Running", "1/1"}, {"CrashLoopBackOff", "0/1"}}
	if got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("rows %v, want %v", got, want)
	}
	if rows[1]["phase"] != "Running" {
		t.Errorf("the phase beside it: %v", rows[1]["phase"])
	}
}
