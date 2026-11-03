// gpu_dashboard.go — GPU 대시보드 (노드/포드/디바이스플러그인/타임슬라이싱) 통합 응답.
//
// gpu.go 에서 분리. GetGPUDashboard 가 4-fan-out goroutine (Nodes / Pods /
// DevicePlugin DS / TimeSlicing CM) 로 모은 데이터를 노드·포드 단위로 정제.
// GPU 수량은 nvidia.com/gpu 와 nvidia.com/mig-* 를 더한 값 (isGPUResource).

package k8s

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	resourcehelper "k8s.io/component-helpers/resource"
)

// ========== GPU Dashboard ==========

func (s *Service) GetGPUDashboard(ctx context.Context) (map[string]interface{}, error) {
	// Use a bounded context so slow external calls don't block the whole request
	dashCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	var (
		nodeList           *corev1.NodeList
		nodeErr            error
		podErr             error
		devicePluginStatus map[string]interface{}
		timeSlicingConfig  map[string]interface{}
		gpuPods            = make([]map[string]interface{}, 0)
		usedByNode         = map[string]int{}
		totalUsed          int
		totalWaiting       int
	)

	// Fetch nodes, pods, device plugin, and time-slicing config all in parallel
	var wg sync.WaitGroup
	wg.Add(4)
	go func() {
		defer wg.Done()
		nodeList, nodeErr = s.clientsetCtx(ctx).CoreV1().Nodes().List(dashCtx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		// a page at a time, keeping the pods that ask for a GPU (every pod in one list took k8s-service past 512 Mi)
		podErr = eachPod(dashCtx, s.clientsetCtx(ctx).CoreV1(), "", metav1.ListOptions{}, func(pod *corev1.Pod) {
			gpuReq := getPodGPURequest(pod)
			if gpuReq == 0 {
				return
			}
			// in use = kubectl describe node's "Allocated resources": the pods on a node that have not ended; a pod
			// no node has taken yet waits for one and is counted apart
			if pod.Status.Phase != corev1.PodSucceeded && pod.Status.Phase != corev1.PodFailed {
				if pod.Spec.NodeName != "" {
					usedByNode[pod.Spec.NodeName] += gpuReq
				} else {
					totalWaiting += gpuReq
				}
			}
			status, _, _, _ := podListView(pod)
			row := map[string]interface{}{
				"name":          pod.Name,
				"namespace":     pod.Namespace,
				"gpu_requested": gpuReq,
				"status":        status,
				"phase":         string(pod.Status.Phase),
				"created_at":    toISO(&pod.CreationTimestamp),
			}
			if pod.Spec.NodeName != "" {
				row["node_name"] = pod.Spec.NodeName
			}
			gpuPods = append(gpuPods, row)
		})
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
	for _, n := range usedByNode {
		totalUsed += n
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
			"gpu_used":        usedByNode[node.Name],
			"status":          nodeStatusText(&node),
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
		if v := gpuDriverVersion(labels); v != "" {
			gpuNode["driver_version"] = v
		}

		gpuNodes = append(gpuNodes, gpuNode)
	}

	// MIG / Time-Slicing detection
	migEnabled := false
	timeSlicingEnabled := false
	for _, gn := range gpuNodes {
		// GPU Feature Discovery's strategies are none, single and mixed; none (its default) uses no MIG device
		if v, _ := gn["mig_strategy"].(string); v != "" && v != "none" {
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
		"total_gpu_waiting":     totalWaiting,
		"gpu_nodes":             gpuNodes,
		"gpu_pods":              gpuPods,
		"device_plugin_status":  devicePluginStatus,
		"mig_enabled":           migEnabled,
		"time_slicing_enabled":  timeSlicingEnabled,
		"time_slicing_config":   timeSlicingConfig,
	}, nil
}

// ========== GPU helpers ==========

// isGPUResource names the NVIDIA device plugin's resources: whole GPUs (nvidia.com/gpu) and, under the mixed MIG
// strategy, each MIG profile (nvidia.com/mig-<profile>) next to them. Each device of either is one GPU here.
func isGPUResource(name corev1.ResourceName) bool {
	n := string(name)
	return n == "nvidia.com/gpu" || strings.HasPrefix(n, "nvidia.com/mig-")
}

func getGPUQuantity(resources corev1.ResourceList) int {
	total := 0
	for name, qty := range resources {
		if isGPUResource(name) {
			total += int(qty.Value())
		}
	}
	return total
}

// getPodGPURequest is the GPUs the scheduler holds for the pod, which kubectl describe node adds up under
// "Allocated resources" (component-helpers PodRequests: the containers and sidecars summed, an init container's
// peak when higher). The API server sets a request to the limit where only the limit was written.
func getPodGPURequest(pod *corev1.Pod) int {
	return getGPUQuantity(resourcehelper.PodRequests(pod, resourcehelper.PodResourcesOptions{}))
}

// gpuDriverVersion is the NVIDIA driver's version from GPU Feature Discovery's labels: cuda.driver-version.full, or
// the deprecated cuda.driver.major, .minor and .rev ("" when GFD wrote no revision).
func gpuDriverVersion(labels map[string]string) string {
	if v := labels["nvidia.com/cuda.driver-version.full"]; v != "" {
		return v
	}
	major, ok := labels["nvidia.com/cuda.driver.major"]
	if !ok {
		return ""
	}
	v := major + "." + labels["nvidia.com/cuda.driver.minor"]
	if rev := labels["nvidia.com/cuda.driver.rev"]; rev != "" {
		v += "." + rev
	}
	return v
}

func getDevicePluginStatus(ctx context.Context, s *Service) map[string]interface{} {
	// Try common NVIDIA device plugin DaemonSet names and namespaces
	candidates := []struct {
		namespace string
		name      string
	}{
		{"kube-system", "nvidia-device-plugin-daemonset"},
		{"gpu-operator", "nvidia-device-plugin-daemonset"},
		{"nvidia-gpu-operator", "nvidia-device-plugin-daemonset"},
		{"kube-system", "nvidia-device-plugin"},
	}

	for _, c := range candidates {
		// Short timeout per candidate so we don't block if the namespace doesn't exist
		tryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		ds, err := s.clientsetCtx(ctx).AppsV1().DaemonSets(c.namespace).Get(tryCtx, c.name, metav1.GetOptions{})
		cancel()
		if err != nil {
			continue
		}
		return map[string]interface{}{
			"name":      ds.Name,
			"namespace": ds.Namespace,
			"desired":   ds.Status.DesiredNumberScheduled,
			"ready":     ds.Status.NumberReady,
			"available": ds.Status.NumberAvailable,
		}
	}

	return nil
}

func getTimeSlicingConfig(ctx context.Context, s *Service) map[string]interface{} {
	namespaces := []string{"gpu-operator", "nvidia-gpu-operator", "kube-system"}
	names := []string{"time-slicing-config", "nvidia-plugin-configs", "time-slicing"}

	for _, ns := range namespaces {
		for _, name := range names {
			tryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			cm, err := s.clientsetCtx(ctx).CoreV1().ConfigMaps(ns).Get(tryCtx, name, metav1.GetOptions{})
			cancel()
			if err != nil {
				continue
			}
			result := map[string]interface{}{
				"name":      cm.Name,
				"namespace": cm.Namespace,
			}
			if cm.Data != nil {
				// Try to extract replica count info
				for k, v := range cm.Data {
					if strings.Contains(v, "replicas") {
						result["config_key"] = k
						// Parse replicas count from config
						if idx := strings.Index(v, "replicas:"); idx >= 0 {
							rest := v[idx+len("replicas:"):]
							rest = strings.TrimSpace(rest)
							parts := strings.Fields(rest)
							if len(parts) > 0 {
								if n, err := strconv.Atoi(parts[0]); err == nil {
									result["replicas"] = n
								}
							}
						}
						break
					}
				}
			}
			return result
		}
	}

	return nil
}
