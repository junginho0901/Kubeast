// gpu_dashboard.go — GPU 대시보드 (노드/포드/디바이스플러그인/타임슬라이싱) 통합 응답.
//
// gpu.go 에서 분리. GetGPUDashboard 가 5-fan-out goroutine (Nodes / Pods /
// DevicePlugin DS / TimeSlicing CM / DRA ResourceClaims) 로 모은 데이터를 노드·포드 단위로 정제.
// GPU 수량은 "Schedule GPUs" 문서의 세 회사(NVIDIA·AMD·Intel) device plugin 이
// 장치 하나씩 광고하는 이름을 더한 값 (gpuVendorOf).

package k8s

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	resourcehelper "k8s.io/component-helpers/resource"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/drarow"
)

// ========== GPU Dashboard ==========

func (s *Service) GetGPUDashboard(ctx context.Context) (map[string]interface{}, error) {
	return s.gpuDashboard(ctx, false)
}

// GetGPUPods is the dashboard's answer for the GPU Pods screen of a grant limited to namespaces, which the cluster
// does not let list nodes: the pods it may see that ask for GPUs, and nothing about the nodes.
func (s *Service) GetGPUPods(ctx context.Context) (map[string]interface{}, error) {
	return s.gpuDashboard(ctx, true)
}

var (
	gpuSideBudget = 15 * time.Second
	// the nodes and pods wait their turn behind the cluster's other reads within what an AI tool waits for this (45 s)
	gpuNeededBudget = 40 * time.Second
)

func (s *Service) gpuDashboard(ctx context.Context, podsOnly bool) (map[string]interface{}, error) {
	// Use a bounded context so slow external calls don't block the whole request
	dashCtx, cancel := context.WithTimeout(ctx, gpuSideBudget)
	defer cancel()
	neededCtx, cancelNeeded := context.WithTimeout(ctx, gpuNeededBudget)
	defer cancelNeeded()

	var (
		nodeList          *corev1.NodeList
		nodeErr           error
		podErr            error
		devicePlugins     map[string]map[string]interface{}
		timeSlicingConfig map[string]interface{}
		draPods           = []map[string]interface{}{}
		gpuPods           = make([]map[string]interface{}, 0)
		usedByNode        = map[string]map[string]int{}
		waitingByVendor   = map[string]int{}
	)

	// Fetch nodes, pods, device plugins, time-slicing config and the DRA claims all in parallel
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		// a page at a time, keeping the pods that ask for a GPU (every pod in one list took k8s-service past 512 Mi)
		podErr = eachCallerNamespace(ctx, "", func(ns string) error {
			return eachPod(neededCtx, s.clientsetCtx(ctx).CoreV1(), ns, metav1.ListOptions{}, func(pod *corev1.Pod) {
				byVendor := getPodGPURequests(pod)
				gpuReq := sumVendors(byVendor)
				if gpuReq == 0 {
					return
				}
				// in use = kubectl describe node's "Allocated resources": the pods on a node that have not ended; a pod
				// no node has taken yet waits for one and is counted apart
				if pod.Status.Phase != corev1.PodSucceeded && pod.Status.Phase != corev1.PodFailed {
					for vendor, n := range byVendor {
						if pod.Spec.NodeName != "" {
							if usedByNode[pod.Spec.NodeName] == nil {
								usedByNode[pod.Spec.NodeName] = map[string]int{}
							}
							usedByNode[pod.Spec.NodeName][vendor] += n
						} else {
							waitingByVendor[vendor] += n
						}
					}
				}
				status, _, _, _ := podListView(pod)
				requested := make([]map[string]interface{}, 0, len(byVendor))
				for _, vendor := range gpuVendorOrder(byVendor) {
					requested = append(requested, map[string]interface{}{"vendor": vendor, "requested": byVendor[vendor]})
				}
				row := map[string]interface{}{
					"name":          pod.Name,
					"namespace":     pod.Namespace,
					"gpu_requested": gpuReq,
					"gpu_vendors":   requested,
					"status":        status,
					"phase":         string(pod.Status.Phase),
					"created_at":    toISO(&pod.CreationTimestamp),
				}
				if pod.Spec.NodeName != "" {
					row["node_name"] = pod.Spec.NodeName
				}
				gpuPods = append(gpuPods, row)
			})
		})
	}()
	if podsOnly {
		nodeList = &corev1.NodeList{}
	} else {
		wg.Add(4)
		go func() {
			defer wg.Done()
			nodeList, nodeErr = s.clientsetCtx(ctx).CoreV1().Nodes().List(neededCtx, metav1.ListOptions{})
		}()
		go func() {
			defer wg.Done()
			devicePlugins = getDevicePlugins(dashCtx, s)
		}()
		go func() {
			defer wg.Done()
			timeSlicingConfig = getTimeSlicingConfig(dashCtx, s)
		}()
		go func() {
			defer wg.Done()
			// the pods that hold devices through DRA, which a GPU's DCGM series may name (none when the claims cannot be read)
			if s.isDRAUnavailable(dashCtx) {
				return
			}
			if claims, err := s.draClaims(dashCtx); err == nil {
				draPods = drarow.ReservedPods(claims)
			}
		}()
	}
	wg.Wait()

	if nodeErr != nil {
		return nil, fmt.Errorf("list nodes for GPU dashboard: %w", nodeErr)
	}
	if podErr != nil {
		return nil, fmt.Errorf("list pods for GPU dashboard: %w", podErr)
	}
	// every node's Allocated resources (a pod on a node that no longer advertises GPUs counts there too)
	totalUsed := 0
	totals := map[string]*gpuVendorTotal{}
	total := func(vendor string) *gpuVendorTotal {
		if totals[vendor] == nil {
			totals[vendor] = &gpuVendorTotal{}
		}
		return totals[vendor]
	}
	for _, byVendor := range usedByNode {
		for vendor, n := range byVendor {
			totalUsed += n
			total(vendor).used += n
		}
	}
	totalWaiting := 0
	for vendor, n := range waitingByVendor {
		totalWaiting += n
		total(vendor).waiting += n
	}

	// Filter GPU nodes
	gpuNodes := make([]map[string]interface{}, 0)
	totalCapacity := 0
	totalAllocatable := 0

	for _, node := range nodeList.Items {
		capByVendor := gpuByVendor(node.Status.Capacity)
		gpuCap := sumVendors(capByVendor)
		if gpuCap == 0 {
			continue
		}
		allocByVendor := gpuByVendor(node.Status.Allocatable)
		gpuAlloc := sumVendors(allocByVendor)
		totalCapacity += gpuCap
		totalAllocatable += gpuAlloc
		used := usedByNode[node.Name]

		gpuNode := map[string]interface{}{
			"name":            node.Name,
			"gpu_capacity":    gpuCap,
			"gpu_allocatable": gpuAlloc,
			"gpu_used":        sumVendors(used),
			"status":          nodeStatusText(&node),
		}

		// each company's GPUs on the node, with the model, memory and driver its labeller writes
		labels := node.Labels
		vendors := make([]map[string]interface{}, 0, len(capByVendor))
		var models, memories, drivers []string
		for _, vendor := range gpuVendors {
			if capByVendor[vendor] == 0 && allocByVendor[vendor] == 0 && used[vendor] == 0 {
				continue
			}
			t := total(vendor)
			t.capacity += capByVendor[vendor]
			t.allocatable += allocByVendor[vendor]
			entry := map[string]interface{}{"vendor": vendor, "capacity": capByVendor[vendor], "allocatable": allocByVendor[vendor], "used": used[vendor]}
			info := gpuNodeLabels(vendor, labels)
			for key, v := range map[string]string{"model": info.model, "memory": info.memory, "driver_version": info.driver} {
				if v != "" {
					entry[key] = v
				}
			}
			models = appendNonEmpty(models, info.model)
			memories = appendNonEmpty(memories, info.memory)
			drivers = appendNonEmpty(drivers, info.driver)
			vendors = append(vendors, entry)
		}
		gpuNode["gpu_vendors"] = vendors
		for key, v := range map[string][]string{"gpu_model": models, "gpu_memory": memories, "driver_version": drivers} {
			if len(v) > 0 {
				gpuNode[key] = strings.Join(v, ", ")
			}
		}
		if v, ok := labels["nvidia.com/mig.strategy"]; ok {
			gpuNode["mig_strategy"] = v
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

	// each company with GPUs on a node or asked for, or a device plugin found: its counts and its plugin
	vendorTotals := make([]map[string]interface{}, 0, len(gpuVendors))
	plugins := make([]map[string]interface{}, 0, len(gpuVendors))
	for _, vendor := range gpuVendors {
		t, counted := totals[vendor]
		plugin := devicePlugins[vendor]
		if counted {
			vendorTotals = append(vendorTotals, map[string]interface{}{
				"vendor": vendor, "capacity": t.capacity, "allocatable": t.allocatable, "used": t.used, "waiting": t.waiting,
			})
		}
		if !counted && plugin == nil {
			continue
		}
		entry := map[string]interface{}{"vendor": vendor, "found": plugin != nil}
		for k, v := range plugin {
			entry[k] = v
		}
		plugins = append(plugins, entry)
	}

	return map[string]interface{}{
		"total_gpu_capacity":    totalCapacity,
		"total_gpu_allocatable": totalAllocatable,
		"total_gpu_used":        totalUsed,
		"total_gpu_waiting":     totalWaiting,
		"vendors":               vendorTotals,
		"gpu_nodes":             gpuNodes,
		"gpu_pods":              gpuPods,
		"device_plugins":        plugins,
		"mig_enabled":           migEnabled,
		"time_slicing_enabled":  timeSlicingEnabled,
		"time_slicing_config":   timeSlicingConfig,
		"dra_pods":              draPods,
	}, nil
}

// ========== GPU helpers ==========

// gpuVendors are the companies Kubernetes' "Schedule GPUs" names, in the order the screens list them.
var gpuVendors = []string{"NVIDIA", "AMD", "Intel"}

// amdPartition is a partition kind the AMD device plugin advertises under its mixed naming strategy: the GPU's compute
// and memory partition as sysfs writes them, lower-cased (amd.com/cpx_nps4).
var amdPartition = regexp.MustCompile(`^amd\.com/(spx|dpx|tpx|qpx|cpx)_nps[0-9]+$`)

// gpuVendorOf names the company of a resource each of whose devices is one GPU, "" for any other: NVIDIA's whole GPUs
// (nvidia.com/gpu, or nvidia.com/gpu.shared when its sharing config renames them) and MIG profiles
// (nvidia.com/mig-<profile>, .shared too), AMD's GPUs and partitions (amd.com/gpu, or
// amd.com/<compute>_<memory> under the mixed strategy), and Intel's GPUs by kernel driver (gpu.intel.com/i915,
// gpu.intel.com/xe). Intel's monitoring resources and its older plugin's millicores, memory.max and tiles are not
// devices, and other accelerators (habana.ai/gaudi, aws.amazon.com/neuron…) are not GPUs.
func gpuVendorOf(name corev1.ResourceName) string {
	n := string(name)
	switch {
	case n == "nvidia.com/gpu" || n == "nvidia.com/gpu.shared" || strings.HasPrefix(n, "nvidia.com/mig-"):
		return "NVIDIA"
	case n == "amd.com/gpu" || amdPartition.MatchString(n):
		return "AMD"
	case n == "gpu.intel.com/i915" || n == "gpu.intel.com/xe":
		return "Intel"
	}
	return ""
}

func isGPUResource(name corev1.ResourceName) bool {
	return gpuVendorOf(name) != ""
}

// gpuByVendor is each company's GPUs in a resource list.
func gpuByVendor(resources corev1.ResourceList) map[string]int {
	out := map[string]int{}
	for name, qty := range resources {
		if vendor := gpuVendorOf(name); vendor != "" {
			out[vendor] += int(qty.Value())
		}
	}
	return out
}

func getGPUQuantity(resources corev1.ResourceList) int {
	return sumVendors(gpuByVendor(resources))
}

func sumVendors(byVendor map[string]int) int {
	total := 0
	for _, n := range byVendor {
		total += n
	}
	return total
}

// gpuVendorOrder is the companies of a count, in the screens' order.
func gpuVendorOrder(byVendor map[string]int) []string {
	out := make([]string, 0, len(byVendor))
	for _, vendor := range gpuVendors {
		if byVendor[vendor] > 0 {
			out = append(out, vendor)
		}
	}
	return out
}

type gpuVendorTotal struct{ capacity, allocatable, used, waiting int }

// getPodGPURequests is each company's GPUs the scheduler holds for the pod, which kubectl describe node adds up under
// "Allocated resources" (component-helpers PodRequests: the containers and sidecars summed, an init container's
// peak when higher). The API server sets a request to the limit where only the limit was written.
func getPodGPURequests(pod *corev1.Pod) map[string]int {
	return gpuByVendor(resourcehelper.PodRequests(pod, resourcehelper.PodResourcesOptions{}))
}

func getPodGPURequest(pod *corev1.Pod) int {
	return sumVendors(getPodGPURequests(pod))
}

type gpuLabelInfo struct{ model, memory, driver string }

// gpuNodeLabels reads a company's GPU model, memory and driver from the labels its tools write: NVIDIA's GPU Feature
// Discovery, AMD's node labeller (amd.com/gpu.*, the beta.amd.com/gpu.* copies, and <name>.<value> when the node's
// GPUs differ) and Intel's NFD rules (gpu.intel.com/product; no memory or driver label).
func gpuNodeLabels(vendor string, labels map[string]string) gpuLabelInfo {
	switch vendor {
	case "NVIDIA":
		return gpuLabelInfo{labels["nvidia.com/gpu.product"], gfdMemory(labels["nvidia.com/gpu.memory"]), gpuDriverVersion(labels)}
	case "AMD":
		return gpuLabelInfo{amdLabel(labels, "product-name"), amdLabel(labels, "vram"), labels["amd.com/gpu.driver-version"]}
	case "Intel":
		return gpuLabelInfo{model: labels["gpu.intel.com/product"]}
	}
	return gpuLabelInfo{}
}

// gfdMemory gives GPU Feature Discovery's label its unit: the label is a number of mebibytes, which the label does not
// say (AMD's writes its own, "192G"). A value someone wrote by hand with a unit stays as written.
func gfdMemory(label string) string {
	if _, err := strconv.ParseUint(label, 10, 64); err != nil {
		return label
	}
	return label + " MiB"
}

// amdLabel is the AMD node labeller's value of a property: amd.com/gpu.<name> (or its beta.amd.com copy) when the
// node's GPUs agree, else the values it writes as amd.com/gpu.<name>.<value>.
func amdLabel(labels map[string]string, name string) string {
	prefixes := []string{"amd.com/gpu.", "beta.amd.com/gpu."}
	for _, prefix := range prefixes {
		if v := labels[prefix+name]; v != "" {
			return v
		}
	}
	for _, prefix := range prefixes {
		var values []string
		for k := range labels {
			if v, ok := strings.CutPrefix(k, prefix+name+"."); ok {
				values = append(values, v)
			}
		}
		if len(values) > 0 {
			sort.Strings(values)
			return strings.Join(values, ", ")
		}
	}
	return ""
}

func appendNonEmpty(list []string, v string) []string {
	if v == "" {
		return list
	}
	return append(list, v)
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

type dsRef struct{ namespace, name string }

// devicePluginNames are the DaemonSets each company's device plugin runs as when installed its documented ways:
// NVIDIA's (static manifest, GPU Operator, its nvidia-device-plugin chart as release nvdp in the namespace its README
// and Amazon EKS's guide use); AMD's manifest k8s-ds-amdgpu-dp.yaml, its amd-gpu chart in kube-system and its GPU
// Operator's DeviceConfig of the example name; Intel's kustomize base in default or kube-system and its operator's
// GpuDevicePlugin of the example and chart name.
var devicePluginNames = map[string][]dsRef{
	"NVIDIA": {
		{"kube-system", "nvidia-device-plugin-daemonset"},
		{"gpu-operator", "nvidia-device-plugin-daemonset"},
		{"nvidia-gpu-operator", "nvidia-device-plugin-daemonset"},
		{"kube-system", "nvidia-device-plugin"},
		{"nvidia-device-plugin", "nvdp-nvidia-device-plugin"},
		{"nvidia", "nvdp-nvidia-device-plugin"},
	},
	"AMD": {
		{"kube-system", "amdgpu-device-plugin-daemonset"},
		{"kube-system", "amd-gpu-device-plugin-daemonset"},
		{"kube-amd-gpu", "gpu-operator-device-plugin"},
	},
	"Intel": {
		{"default", "intel-gpu-plugin"},
		{"kube-system", "intel-gpu-plugin"},
		{"inteldeviceplugins-system", "intel-gpu-plugin-gpudeviceplugin-sample"},
	},
}

// getDevicePlugins is each company's device plugin DaemonSet found under one of its names (a company without one is
// left out).
func getDevicePlugins(ctx context.Context, s *Service) map[string]map[string]interface{} {
	var mu sync.Mutex
	out := map[string]map[string]interface{}{}
	var wg sync.WaitGroup
	for vendor, names := range devicePluginNames {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if st := getDevicePluginStatus(ctx, s, names); st != nil {
				mu.Lock()
				out[vendor] = st
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return out
}

func getDevicePluginStatus(ctx context.Context, s *Service, candidates []dsRef) map[string]interface{} {
	for _, c := range candidates {
		if !inCallerScope(ctx, c.namespace) {
			continue
		}
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
		if !inCallerScope(ctx, ns) {
			continue
		}
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
