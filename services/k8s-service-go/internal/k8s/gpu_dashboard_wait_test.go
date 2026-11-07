package k8s

import (
	"context"
	"fmt"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// The nodes and pods the dashboard needs wait their turn behind the other reads of the cluster (its client's rate
// limit) instead of failing when its optional reads' time is up.
func TestGPUDashboard_WaitsItsTurnForTheNodesAndPodsItNeeds(t *testing.T) {
	saved := gpuSideBudget
	gpuSideBudget = 50 * time.Millisecond
	t.Cleanup(func() { gpuSideBudget = saved })
	api := &listAPI{}
	for i := 0; i <= podListChunk; i++ {
		api.pods = append(api.pods, gpuPodObj(fmt.Sprintf("gpu-%04d", i), "a", corev1.PodRunning, nil, gpuBox("app", "nvidia.com/gpu", "1")))
	}
	s := api.serve(t)
	base := s.clientsetCtx(context.Background()).CoreV1().RESTClient().Get().URL()
	// one request each 200 ms: the second page waits past the optional reads' 50 ms
	slow, err := kubernetes.NewForConfig(&rest.Config{Host: base.Scheme + "://" + base.Host, QPS: 5, Burst: 1})
	if err != nil {
		t.Fatal(err)
	}
	s.defaultBundle.Store(&clientBundle{clientset: slow})
	for _, podsOnly := range []bool{true, false} {
		res, err := s.gpuDashboard(context.Background(), podsOnly)
		if err != nil {
			t.Fatalf("pods only %v: %v", podsOnly, err)
		}
		if n := len(res["gpu_pods"].([]map[string]interface{})); n != podListChunk+1 {
			t.Errorf("pods only %v: %d GPU pods, want %d", podsOnly, n, podListChunk+1)
		}
	}
}
