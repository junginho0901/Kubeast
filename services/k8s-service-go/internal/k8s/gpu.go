package k8s

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// resolveDRAAPIVersion auto-detects whether the cluster uses v1beta1 or v1alpha3 for resource.k8s.io.
// The result is cached for the lifetime of the process.
func (s *Service) resolveDRAAPIVersion(ctx context.Context) string {
	s.draAPIVersionMu.RLock()
	cached := s.draAPIVersionCache
	s.draAPIVersionMu.RUnlock()
	if cached != "" {
		return cached
	}

	s.draAPIVersionMu.Lock()
	defer s.draAPIVersionMu.Unlock()

	// Double-check after acquiring write lock
	if s.draAPIVersionCache != "" {
		return s.draAPIVersionCache
	}

	// Use a short timeout so version probing doesn't block requests
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Try v1beta1 first (Kubernetes 1.32+)
	gvr := schema.GroupVersionResource{
		Group:    "resource.k8s.io",
		Version:  "v1beta1",
		Resource: "deviceclasses",
	}
	_, err := s.dynamic.Resource(gvr).List(probeCtx, metav1.ListOptions{Limit: 1})
	if err == nil {
		s.draAPIVersionCache = "v1beta1"
		slog.Info("DRA API version detected", "version", "v1beta1")
		return "v1beta1"
	}

	// Fall back to v1alpha3 (Kubernetes 1.31)
	probeCtx2, cancel2 := context.WithTimeout(ctx, 5*time.Second)
	defer cancel2()
	gvr.Version = "v1alpha3"
	_, err = s.dynamic.Resource(gvr).List(probeCtx2, metav1.ListOptions{Limit: 1})
	if err == nil {
		s.draAPIVersionCache = "v1alpha3"
		slog.Info("DRA API version detected", "version", "v1alpha3")
		return "v1alpha3"
	}

	// Mark as unavailable so we don't probe again
	s.draAPIVersionCache = "unavailable"
	slog.Warn("DRA API not detected (cluster may be < v1.31)")
	return "unavailable"
}

// draGVR returns the GVR for DRA resources. If DRA is unavailable, version will be "unavailable".
func (s *Service) draGVR(ctx context.Context, resource string) schema.GroupVersionResource {
	return schema.GroupVersionResource{
		Group:    "resource.k8s.io",
		Version:  s.resolveDRAAPIVersion(ctx),
		Resource: resource,
	}
}

// isDRAUnavailable returns true if DRA API was probed and not found.
func (s *Service) isDRAUnavailable(ctx context.Context) bool {
	return s.resolveDRAAPIVersion(ctx) == "unavailable"
}

// ========== DeviceClasses (cluster-scoped) ==========

func (s *Service) GetDeviceClasses(ctx context.Context) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "deviceclasses")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list deviceclasses: %w", err)
	}
	return formatDRAList(list), nil
}

func (s *Service) DescribeDeviceClass(ctx context.Context, name string) (map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return nil, fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "deviceclasses")
	obj, err := s.GetResource(ctx, gvr, "", name)
	if err != nil {
		return nil, fmt.Errorf("get deviceclass %s: %w", name, err)
	}

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	spec := mapMap(obj.Object, "spec")
	if spec != nil {
		if selectors := mapSlice(spec, "selectors"); len(selectors) > 0 {
			result["selectors"] = selectors
		}
		if config := mapMap(spec, "config"); config != nil {
			result["config"] = config
		}
		if suitableNodes := mapMap(spec, "suitableNodes"); suitableNodes != nil {
			result["suitable_nodes"] = suitableNodes
		}
	}

	return result, nil
}

func (s *Service) DeleteDeviceClass(ctx context.Context, name string) error {
	if s.isDRAUnavailable(ctx) {
		return fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "deviceclasses")
	return s.DeleteResource(ctx, gvr, "", name)
}

// ========== ResourceClaims (namespace-scoped) ==========

func (s *Service) GetResourceClaims(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "resourceclaims")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list resourceclaims: %w", err)
	}
	return formatDRAList(list), nil
}

func (s *Service) GetAllResourceClaims(ctx context.Context) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "resourceclaims")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all resourceclaims: %w", err)
	}
	return formatDRAList(list), nil
}

func (s *Service) DescribeResourceClaim(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return nil, fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceclaims")
	obj, err := s.GetResource(ctx, gvr, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get resourceclaim %s/%s: %w", namespace, name, err)
	}

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"namespace":   obj.GetNamespace(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	spec := mapMap(obj.Object, "spec")
	if spec != nil {
		if devices := mapMap(spec, "devices"); devices != nil {
			result["devices"] = devices
		}
	}

	status := mapMap(obj.Object, "status")
	if status != nil {
		if allocation := mapMap(status, "allocation"); allocation != nil {
			result["allocation"] = allocation
		}
		if reservedFor := mapSlice(status, "reservedFor"); len(reservedFor) > 0 {
			result["reserved_for"] = reservedFor
		}
		if deallocationRequested, ok := status["deallocationRequested"]; ok {
			result["deallocation_requested"] = deallocationRequested
		}
	}

	return result, nil
}

func (s *Service) DeleteResourceClaim(ctx context.Context, namespace, name string) error {
	if s.isDRAUnavailable(ctx) {
		return fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceclaims")
	return s.DeleteResource(ctx, gvr, namespace, name)
}

// ========== ResourceClaimTemplates (namespace-scoped) ==========

func (s *Service) GetResourceClaimTemplates(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "resourceclaimtemplates")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list resourceclaimtemplates: %w", err)
	}
	return formatDRAList(list), nil
}

func (s *Service) GetAllResourceClaimTemplates(ctx context.Context) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "resourceclaimtemplates")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all resourceclaimtemplates: %w", err)
	}
	return formatDRAList(list), nil
}

func (s *Service) DescribeResourceClaimTemplate(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return nil, fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceclaimtemplates")
	obj, err := s.GetResource(ctx, gvr, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get resourceclaimtemplate %s/%s: %w", namespace, name, err)
	}

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"namespace":   obj.GetNamespace(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	spec := mapMap(obj.Object, "spec")
	if spec != nil {
		if claimSpec := mapMap(spec, "spec"); claimSpec != nil {
			result["claim_spec"] = claimSpec
		}
	}

	return result, nil
}

func (s *Service) DeleteResourceClaimTemplate(ctx context.Context, namespace, name string) error {
	if s.isDRAUnavailable(ctx) {
		return fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceclaimtemplates")
	return s.DeleteResource(ctx, gvr, namespace, name)
}

// ========== ResourceSlices (cluster-scoped) ==========

func (s *Service) GetResourceSlices(ctx context.Context) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "resourceslices")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list resourceslices: %w", err)
	}
	return formatResourceSliceList(list), nil
}

func (s *Service) DescribeResourceSlice(ctx context.Context, name string) (map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return nil, fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceslices")
	obj, err := s.GetResource(ctx, gvr, "", name)
	if err != nil {
		return nil, fmt.Errorf("get resourceslice %s: %w", name, err)
	}

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	if v := mapStr(obj.Object, "nodeName"); v != "" {
		result["node_name"] = v
	}
	if v := mapStr(obj.Object, "driverName"); v != "" {
		result["driver_name"] = v
	}

	pool := mapMap(obj.Object, "pool")
	if pool != nil {
		result["pool"] = pool
	}

	if devices := mapSlice(obj.Object, "devices"); len(devices) > 0 {
		result["devices"] = devices
	}

	return result, nil
}

func (s *Service) DeleteResourceSlice(ctx context.Context, name string) error {
	if s.isDRAUnavailable(ctx) {
		return fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceslices")
	return s.DeleteResource(ctx, gvr, "", name)
}

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
		nodeList, nodeErr = s.clientset.CoreV1().Nodes().List(dashCtx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		podList, podErr = s.clientset.CoreV1().Pods("").List(dashCtx, metav1.ListOptions{})
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
			"name":              node.Name,
			"gpu_capacity":      gpuCap,
			"gpu_allocatable":   gpuAlloc,
			"status":            nodeReadyStatus(&node),
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

// ========== DRA list formatters ==========

func formatDRAList(list *unstructured.UnstructuredList) []map[string]interface{} {
	if list == nil {
		return []map[string]interface{}{}
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, item := range list.Items {
		entry := map[string]interface{}{
			"name":       item.GetName(),
			"namespace":  item.GetNamespace(),
			"labels":     item.GetLabels(),
			"created_at": toISO(&metav1.Time{Time: item.GetCreationTimestamp().Time}),
		}

		spec := mapMap(item.Object, "spec")
		if spec != nil {
			if devices := mapMap(spec, "devices"); devices != nil {
				if requests := mapSlice(devices, "requests"); len(requests) > 0 {
					entry["request_count"] = len(requests)
				}
			}
			if selectors := mapSlice(spec, "selectors"); len(selectors) > 0 {
				entry["selector_count"] = len(selectors)
			}
			if claimSpec := mapMap(spec, "spec"); claimSpec != nil {
				if devices := mapMap(claimSpec, "devices"); devices != nil {
					if requests := mapSlice(devices, "requests"); len(requests) > 0 {
						entry["request_count"] = len(requests)
					}
				}
			}
		}

		status := mapMap(item.Object, "status")
		if status != nil {
			if allocation := mapMap(status, "allocation"); allocation != nil {
				entry["allocation_status"] = "Allocated"
			} else {
				if reservedFor := mapSlice(status, "reservedFor"); len(reservedFor) > 0 {
					entry["allocation_status"] = "Reserved"
				}
			}
			if conditions := mapSlice(status, "conditions"); len(conditions) > 0 {
				condList := make([]map[string]interface{}, 0, len(conditions))
				for _, c := range conditions {
					if cm, ok := c.(map[string]interface{}); ok {
						condList = append(condList, map[string]interface{}{
							"type":   mapStr(cm, "type"),
							"status": mapStr(cm, "status"),
							"reason": mapStr(cm, "reason"),
						})
					}
				}
				entry["conditions"] = condList
			}
		}

		result = append(result, entry)
	}
	return result
}

func formatResourceSliceList(list *unstructured.UnstructuredList) []map[string]interface{} {
	if list == nil {
		return []map[string]interface{}{}
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, item := range list.Items {
		entry := map[string]interface{}{
			"name":       item.GetName(),
			"labels":     item.GetLabels(),
			"created_at": toISO(&metav1.Time{Time: item.GetCreationTimestamp().Time}),
		}

		if v := mapStr(item.Object, "nodeName"); v != "" {
			entry["node_name"] = v
		}
		if v := mapStr(item.Object, "driverName"); v != "" {
			entry["driver_name"] = v
		}

		pool := mapMap(item.Object, "pool")
		if pool != nil {
			if v := mapStr(pool, "name"); v != "" {
				entry["pool_name"] = v
			}
			if v, ok := pool["generation"]; ok {
				entry["pool_generation"] = v
			}
			if v, ok := pool["resourceSliceCount"]; ok {
				entry["resource_slice_count"] = v
			}
		}

		if devices := mapSlice(item.Object, "devices"); len(devices) > 0 {
			entry["device_count"] = len(devices)
		}

		result = append(result, entry)
	}
	return result
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
		ds, err := s.clientset.AppsV1().DaemonSets(c.namespace).Get(tryCtx, c.name, metav1.GetOptions{})
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
			cm, err := s.clientset.CoreV1().ConfigMaps(ns).Get(tryCtx, name, metav1.GetOptions{})
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

