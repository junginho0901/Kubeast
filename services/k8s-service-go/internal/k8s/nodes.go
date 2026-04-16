package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"gopkg.in/yaml.v3"
)

// GetNodes lists all nodes.
func (s *Service) GetNodes(ctx context.Context) ([]map[string]interface{}, error) {
	nodeList, err := s.Clientset().CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list nodes: %w", err)
	}

	result := make([]map[string]interface{}, 0, len(nodeList.Items))
	for _, node := range nodeList.Items {
		result = append(result, formatNodeSummary(&node))
	}
	return result, nil
}

// DescribeNode returns detailed info about a node.
func (s *Service) DescribeNode(ctx context.Context, name string) (map[string]interface{}, error) {
	// Fetch node and events in parallel
	var node *corev1.Node
	var events *corev1.EventList
	var nodeErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		node, nodeErr = s.Clientset().CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Node", name),
		})
	}()
	wg.Wait()

	if nodeErr != nil {
		return nil, fmt.Errorf("get node %s: %w", name, nodeErr)
	}

	result := formatNodeSummary(node)

	// Conditions (detailed)
	conditions := make([]map[string]interface{}, 0, len(node.Status.Conditions))
	for _, c := range node.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                   string(c.Type),
			"status":                 string(c.Status),
			"reason":                 c.Reason,
			"message":                c.Message,
			"last_heartbeat_time":    toISO(&c.LastHeartbeatTime),
			"last_transition_time":   toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	// Addresses
	addresses := make([]map[string]interface{}, 0, len(node.Status.Addresses))
	for _, addr := range node.Status.Addresses {
		addresses = append(addresses, map[string]interface{}{
			"type":    string(addr.Type),
			"address": addr.Address,
		})
	}
	result["addresses"] = addresses

	// Capacity
	capacity := make(map[string]string)
	for k, v := range node.Status.Capacity {
		capacity[string(k)] = v.String()
	}
	result["capacity"] = capacity

	// Allocatable
	allocatable := make(map[string]string)
	for k, v := range node.Status.Allocatable {
		allocatable[string(k)] = v.String()
	}
	result["allocatable"] = allocatable

	// System info
	result["system_info"] = map[string]interface{}{
		"machine_id":                node.Status.NodeInfo.MachineID,
		"system_uuid":              node.Status.NodeInfo.SystemUUID,
		"boot_id":                  node.Status.NodeInfo.BootID,
		"kernel_version":           node.Status.NodeInfo.KernelVersion,
		"os_image":                 node.Status.NodeInfo.OSImage,
		"container_runtime_version": node.Status.NodeInfo.ContainerRuntimeVersion,
		"kubelet_version":          node.Status.NodeInfo.KubeletVersion,
		"kube_proxy_version":       node.Status.NodeInfo.KubeProxyVersion,
		"operating_system":         node.Status.NodeInfo.OperatingSystem,
		"architecture":             node.Status.NodeInfo.Architecture,
	}

	// Images
	images := make([]map[string]interface{}, 0, len(node.Status.Images))
	for _, img := range node.Status.Images {
		images = append(images, map[string]interface{}{
			"names": img.Names,
			"size":  img.SizeBytes,
		})
	}
	result["images"] = images

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		eventList := make([]map[string]interface{}, 0, len(events.Items))
		for _, e := range events.Items {
			eventList = append(eventList, map[string]interface{}{
				"type":       e.Type,
				"reason":     e.Reason,
				"message":    e.Message,
				"count":      e.Count,
				"first_time": toISO(&e.FirstTimestamp),
				"last_time":  toISO(&e.LastTimestamp),
				"source":     e.Source.Component,
			})
		}
		result["events"] = eventList
	}

	result["annotations"] = node.Annotations

	return result, nil
}

// GetNodePods returns pods running on a node.
func (s *Service) GetNodePods(ctx context.Context, nodeName string) ([]map[string]interface{}, error) {
	pods, err := s.Clientset().CoreV1().Pods("").List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("spec.nodeName=%s", nodeName),
	})
	if err != nil {
		return nil, fmt.Errorf("list pods on node %s: %w", nodeName, err)
	}
	return formatPodList(pods.Items), nil
}

// GetNodeEvents returns events for a node.
func (s *Service) GetNodeEvents(ctx context.Context, nodeName string) ([]map[string]interface{}, error) {
	events, err := s.Clientset().CoreV1().Events("").List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Node", nodeName),
	})
	if err != nil {
		return nil, fmt.Errorf("get events for node %s: %w", nodeName, err)
	}
	sortEventsByTime(events.Items)

	result := make([]map[string]interface{}, 0, len(events.Items))
	for _, e := range events.Items {
		result = append(result, map[string]interface{}{
			"type":       e.Type,
			"reason":     e.Reason,
			"message":    e.Message,
			"count":      e.Count,
			"first_time": toISO(&e.FirstTimestamp),
			"last_time":  toISO(&e.LastTimestamp),
			"source":     e.Source.Component,
		})
	}
	return result, nil
}

// DeleteNode deletes a node.
func (s *Service) DeleteNode(ctx context.Context, name string) error {
	return s.Clientset().CoreV1().Nodes().Delete(ctx, name, metav1.DeleteOptions{})
}

// CordonNode marks a node as unschedulable.
func (s *Service) CordonNode(ctx context.Context, name string) error {
	return s.setNodeUnschedulable(ctx, name, true)
}

// UncordonNode marks a node as schedulable.
func (s *Service) UncordonNode(ctx context.Context, name string) error {
	return s.setNodeUnschedulable(ctx, name, false)
}

func (s *Service) setNodeUnschedulable(ctx context.Context, name string, unschedulable bool) error {
	patch := map[string]interface{}{
		"spec": map[string]interface{}{
			"unschedulable": unschedulable,
		},
	}
	data, err := json.Marshal(patch)
	if err != nil {
		return fmt.Errorf("marshal patch: %w", err)
	}
	_, err = s.Clientset().CoreV1().Nodes().Patch(ctx, name, types.StrategicMergePatchType, data, metav1.PatchOptions{})
	if err != nil {
		action := "cordon"
		if !unschedulable {
			action = "uncordon"
		}
		return fmt.Errorf("%s node %s: %w", action, name, err)
	}
	return nil
}

// GetNodeYAML returns a node manifest as YAML.
func (s *Service) GetNodeYAML(ctx context.Context, name string, forceRefresh bool) (string, error) {
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "nodes"}
	return s.GetResourceYAML(ctx, gvr, "", name, forceRefresh)
}

// ApplyNodeYAML applies labels and annotations from a YAML string to a node.
// Protected keys with kubernetes.io/ and metadata.k8s.io/ prefixes are not modified.
func (s *Service) ApplyNodeYAML(ctx context.Context, name string, yamlStr string) error {
	node, err := s.Clientset().CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("get node %s: %w", name, err)
	}

	var parsed map[string]interface{}
	if err := yaml.Unmarshal([]byte(yamlStr), &parsed); err != nil {
		return fmt.Errorf("parse YAML: %w", err)
	}

	metadata, ok := parsed["metadata"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("invalid YAML: missing metadata")
	}

	if newLabels, ok := metadata["labels"].(map[string]interface{}); ok {
		if node.Labels == nil {
			node.Labels = make(map[string]string)
		}
		for k, v := range newLabels {
			if isProtectedKey(k) {
				continue
			}
			node.Labels[k] = fmt.Sprintf("%v", v)
		}
	}

	if newAnnotations, ok := metadata["annotations"].(map[string]interface{}); ok {
		if node.Annotations == nil {
			node.Annotations = make(map[string]string)
		}
		for k, v := range newAnnotations {
			if isProtectedKey(k) {
				continue
			}
			node.Annotations[k] = fmt.Sprintf("%v", v)
		}
	}

	_, err = s.Clientset().CoreV1().Nodes().Update(ctx, node, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("update node %s: %w", name, err)
	}

	s.cache.Delete(ctx, fmt.Sprintf("yaml|nodes||%s", name))
	return nil
}

// formatNodeSummary formats a node for list/detail views.
func formatNodeSummary(node *corev1.Node) map[string]interface{} {
	// Status
	status := "Unknown"
	for _, c := range node.Status.Conditions {
		if c.Type == corev1.NodeReady {
			if c.Status == corev1.ConditionTrue {
				status = "Ready"
			} else {
				status = "NotReady"
			}
			break
		}
	}
	if node.Spec.Unschedulable {
		status += ",SchedulingDisabled"
	}

	// Roles
	roles := make([]string, 0)
	for k := range node.Labels {
		if strings.HasPrefix(k, "node-role.kubernetes.io/") {
			role := strings.TrimPrefix(k, "node-role.kubernetes.io/")
			if role == "" {
				role = "worker"
			}
			roles = append(roles, role)
		}
	}
	if len(roles) == 0 {
		roles = append(roles, "<none>")
	}

	// Internal IP & External IP
	internalIP := ""
	externalIP := ""
	for _, addr := range node.Status.Addresses {
		if addr.Type == corev1.NodeInternalIP && internalIP == "" {
			internalIP = addr.Address
		}
		if addr.Type == corev1.NodeExternalIP && externalIP == "" {
			externalIP = addr.Address
		}
	}

	// Taints
	taints := make([]map[string]interface{}, 0, len(node.Spec.Taints))
	for _, t := range node.Spec.Taints {
		taints = append(taints, map[string]interface{}{
			"key":    t.Key,
			"value":  t.Value,
			"effect": string(t.Effect),
		})
	}

	// Capacity summary
	capacity := make(map[string]string)
	for k, v := range node.Status.Capacity {
		capacity[string(k)] = v.String()
	}

	allocatable := make(map[string]string)
	for k, v := range node.Status.Allocatable {
		allocatable[string(k)] = v.String()
	}

	// Conditions summary
	conditions := make([]map[string]interface{}, 0, len(node.Status.Conditions))
	for _, c := range node.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":   string(c.Type),
			"status": string(c.Status),
			"reason": c.Reason,
		})
	}

	return map[string]interface{}{
		"name":              node.Name,
		"status":            status,
		"unschedulable":     node.Spec.Unschedulable,
		"roles":             roles,
		"internal_ip":       internalIP,
		"external_ip":       externalIP,
		"version":           node.Status.NodeInfo.KubeletVersion,
		"os_image":          node.Status.NodeInfo.OSImage,
		"kernel_version":    node.Status.NodeInfo.KernelVersion,
		"container_runtime": node.Status.NodeInfo.ContainerRuntimeVersion,
		"kubelet_version":   node.Status.NodeInfo.KubeletVersion,
		"age":               age(&node.CreationTimestamp),
		"created_at":        toISO(&node.CreationTimestamp),
		"labels":            node.Labels,
		"taints":            taints,
		"conditions":        conditions,
		"capacity":          capacity,
		"allocatable":       allocatable,
	}
}
