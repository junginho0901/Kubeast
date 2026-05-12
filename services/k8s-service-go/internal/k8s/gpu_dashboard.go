// gpu_dashboard.go — GPU 대시보드 (노드/포드/디바이스플러그인/타임슬라이싱) 통합 응답.
//
// gpu.go 에서 분리. GetGPUDashboard 가 4-fan-out goroutine (Nodes / Pods /
// DevicePlugin DS / TimeSlicing CM) 로 모은 데이터를 노드·포드 단위로 정제.
// GPU 수량 계산은 nvidia.com/gpu + nvidia.com/mig-* 합산 정책.

package k8s

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== GPU Dashboard ==========

func (s *Service) GetGPUDashboard(ctx context.Context) (map[string]interface{}, error) {
	// Use a bounded context so slow external calls don't block the whole request
	dashCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	var (
		nodeList           *corev1.NodeList
		podList            *corev1.PodList
		nodeErr            error
		podErr             error
		devicePluginStatus map[string]interface{}
		timeSlicingConfig  map[string]interface{}
	)

	// Fetch nodes, pods, device plugin, and time-slicing config all in parallel
	var wg sync.WaitGroup
	wg.Add(4)
	go func() {
		defer wg.Done()
		nodeList, nodeErr = s.Clientset().CoreV1().Nodes().List(dashCtx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		podList, podErr = s.Clientset().CoreV1().Pods("").List(dashCtx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		devicePluginStatus = getDevicePluginStatus(dashCtx, s)
	}()
	go func() {
		defer wg.Done()
		timeSlicingConfig = getTimeSlicingConfig(dashCtx, s)
	}()
	wg.Wait()

	if nodeErr != nil {
		return nil, fmt.Errorf("list nodes for GPU dashboard: %w", nodeErr)
	}
	if podErr != nil {
		return nil, fmt.Errorf("list pods for GPU dashboard: %w", podErr)
	}

	// Filter GPU nodes
	gpuNodes := make([]map[string]interface{}, 0)
	totalCapacity := 0
	totalAllocatable := 0

	for _, node := range nodeList.Items {
		gpuCap := getGPUQuantity(node.Status.Capacity)
		if gpuCap == 0 {
			continue
		}
		gpuAlloc := getGPUQuantity(node.Status.Allocatable)
		totalCapacity += gpuCap
		totalAllocatable += gpuAlloc

		gpuNode := map[string]interface{}{
			"name":            node.Name,
			"gpu_capacity":    gpuCap,
			"gpu_allocatable": gpuAlloc,
			"status":          nodeReadyStatus(&node),
		}

		labels := node.Labels
		if v, ok := labels["nvidia.com/gpu.product"]; ok {
			gpuNode["gpu_model"] = v
		}
		if v, ok := labels["nvidia.com/gpu.memory"]; ok {
			gpuNode["gpu_memory"] = v
		}
		if v, ok := labels["nvidia.com/mig.strategy"]; ok {
			gpuNode["mig_strategy"] = v
		}
		if v, ok := labels["nvidia.com/cuda.driver.major"]; ok {
			minor := labels["nvidia.com/cuda.driver.minor"]
			gpuNode["driver_version"] = v + "." + minor
		}

		gpuNodes = append(gpuNodes, gpuNode)
	}

	// Filter GPU pods and calculate used GPUs
	gpuPods := make([]map[string]interface{}, 0)
	totalUsed := 0

	for _, pod := range podList.Items {
		gpuReq := getPodGPURequest(&pod)
		if gpuReq == 0 {
			continue
		}
		// Only count running/pending pods toward used GPUs
		if pod.Status.Phase == corev1.PodRunning || pod.Status.Phase == corev1.PodPending {
			totalUsed += gpuReq
		}

		gpuPods = append(gpuPods, map[string]interface{}{
			"name":          pod.Name,
			"namespace":     pod.Namespace,
			"node_name":     pod.Spec.NodeName,
			"gpu_requested": gpuReq,
			"status":        string(pod.Status.Phase),
			"created_at":    toISO(&pod.CreationTimestamp),
		})
	}

	// MIG / Time-Slicing detection
	migEnabled := false
	timeSlicingEnabled := false
	for _, gn := range gpuNodes {
		if _, ok := gn["mig_strategy"]; ok {
			migEnabled = true
			break
		}
	}
	if timeSlicingConfig != nil {
		timeSlicingEnabled = true
	}

	return map[string]interface{}{
		"total_gpu_capacity":    totalCapacity,
		"total_gpu_allocatable": totalAllocatable,
		"total_gpu_used":        totalUsed,
		"gpu_nodes":             gpuNodes,
		"gpu_pods":              gpuPods,
		"device_plugin_status":  devicePluginStatus,
		"mig_enabled":           migEnabled,
		"time_slicing_enabled":  timeSlicingEnabled,
		"time_slicing_config":   timeSlicingConfig,
	}, nil
}

// ========== GPU helpers ==========

func getGPUQuantity(resources corev1.ResourceList) int {
	// Check nvidia.com/gpu first (primary GPU resource)
	if qty, ok := resources["nvidia.com/gpu"]; ok {
		val, _ := qty.AsInt64()
		if val > 0 {
			return int(val)
		}
	}
	// Fall back to MIG resources
	total := 0
	for key, qty := range resources {
		k := string(key)
		if strings.HasPrefix(k, "nvidia.com/mig-") {
			val, _ := qty.AsInt64()
			total += int(val)
		}
	}
	return total
}

func getPodGPURequest(pod *corev1.Pod) int {
	total := 0
	for _, c := range pod.Spec.Containers {
		containerGPU := 0
		// Check requests first
		if qty, ok := c.Resources.Requests["nvidia.com/gpu"]; ok {
			val, _ := qty.AsInt64()
			containerGPU += int(val)
		}
		for key, qty := range c.Resources.Requests {
			if strings.HasPrefix(string(key), "nvidia.com/mig-") {
				val, _ := qty.AsInt64()
				containerGPU += int(val)
			}
		}
		// Fall back to limits if no requests found
		if containerGPU == 0 {
			if qty, ok := c.Resources.Limits["nvidia.com/gpu"]; ok {
				val, _ := qty.AsInt64()
				containerGPU += int(val)
			}
			for key, qty := range c.Resources.Limits {
				if strings.HasPrefix(string(key), "nvidia.com/mig-") {
					val, _ := qty.AsInt64()
					containerGPU += int(val)
				}
			}
		}
		total += containerGPU
	}
	return total
}

func nodeReadyStatus(node *corev1.Node) string {
	for _, c := range node.Status.Conditions {
		if c.Type == corev1.NodeReady {
			if c.Status == corev1.ConditionTrue {
				return "Ready"
			}
			return "NotReady"
		}
	}
	return "Unknown"
}
