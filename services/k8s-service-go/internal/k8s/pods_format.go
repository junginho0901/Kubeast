package k8s

import (
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// formatPodList formats a list of pods into map representations.
func formatPodList(pods []corev1.Pod) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(pods))
	for _, p := range pods {
		result = append(result, formatPodDetail(&p))
	}
	return result
}

// formatPodDetail formats a single pod into a map representation.
func formatPodDetail(p *corev1.Pod) map[string]interface{} {
	containers := make([]map[string]interface{}, 0, len(p.Spec.Containers))
	statusMap := make(map[string]corev1.ContainerStatus)
	for _, cs := range p.Status.ContainerStatuses {
		statusMap[cs.Name] = cs
	}

	totalReady := 0
	totalContainers := len(p.Spec.Containers)
	totalRestarts := int32(0)

	for _, c := range p.Spec.Containers {
		container := map[string]interface{}{
			"name":  c.Name,
			"image": c.Image,
		}

		ports := make([]map[string]interface{}, 0, len(c.Ports))
		for _, port := range c.Ports {
			ports = append(ports, map[string]interface{}{
				"container_port": port.ContainerPort,
				"protocol":       string(port.Protocol),
				"name":           port.Name,
			})
		}
		container["ports"] = ports

		resources := map[string]interface{}{}
		if c.Resources.Requests != nil {
			req := make(map[string]string)
			for k, v := range c.Resources.Requests {
				req[string(k)] = v.String()
			}
			resources["requests"] = req
		}
		if c.Resources.Limits != nil {
			lim := make(map[string]string)
			for k, v := range c.Resources.Limits {
				lim[string(k)] = v.String()
			}
			resources["limits"] = lim
		}
		container["resources"] = resources

		// Volume mounts
		volumeMounts := make([]map[string]interface{}, 0, len(c.VolumeMounts))
		for _, vm := range c.VolumeMounts {
			volumeMounts = append(volumeMounts, map[string]interface{}{
				"name":       vm.Name,
				"mount_path": vm.MountPath,
				"read_only":  vm.ReadOnly,
			})
		}
		container["volume_mounts"] = volumeMounts
		container["env_count"] = len(c.Env)

		if len(c.Command) > 0 {
			container["command"] = c.Command
		}
		if len(c.Args) > 0 {
			container["args"] = c.Args
		}

		if cs, ok := statusMap[c.Name]; ok {
			container["ready"] = cs.Ready
			container["restart_count"] = cs.RestartCount
			container["state"] = containerStateStr(cs.State)
			container["last_state"] = containerStateStr(cs.LastTerminationState)
			if cs.Ready {
				totalReady++
			}
			totalRestarts += cs.RestartCount
		}

		containers = append(containers, container)
	}

	initContainers := make([]map[string]interface{}, 0, len(p.Spec.InitContainers))
	for _, c := range p.Spec.InitContainers {
		ic := map[string]interface{}{
			"name":  c.Name,
			"image": c.Image,
		}
		for _, cs := range p.Status.InitContainerStatuses {
			if cs.Name == c.Name {
				ic["ready"] = cs.Ready
				ic["restart_count"] = cs.RestartCount
				ic["state"] = containerStateStr(cs.State)
				break
			}
		}
		initContainers = append(initContainers, ic)
	}

	status := string(p.Status.Phase)
	reason := p.Status.Reason
	message := p.Status.Message

	// Check for container-level issues
	for _, cs := range p.Status.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			status = cs.State.Waiting.Reason
			if reason == "" {
				reason = cs.State.Waiting.Reason
			}
			if message == "" {
				message = cs.State.Waiting.Message
			}
			break
		}
		if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" {
			if p.Status.Phase != corev1.PodRunning {
				status = cs.State.Terminated.Reason
			}
			break
		}
	}

	out := map[string]interface{}{
		"name":            p.Name,
		"namespace":       p.Namespace,
		"status":          status,
		"phase":           string(p.Status.Phase),
		"reason":          reason,
		"status_reason":   reason,
		"message":         message,
		"status_message":  message,
		"node_name":       p.Spec.NodeName,
		"pod_ip":          p.Status.PodIP,
		"containers":      containers,
		"init_containers": initContainers,
		"labels":          p.Labels,
		"restart_count":   totalRestarts,
		"ready":           fmt.Sprintf("%d/%d", totalReady, totalContainers),
		"created_at":      toISO(&p.CreationTimestamp),
	}
	// graceful shutdown 중인 pod 를 frontend 에서 'Terminating' 으로 표시할 수
	// 있도록 list 응답에도 노출. 이 필드가 없으면 phase 가 여전히 'Running' 인
	// pod 가 새 pod 와 동시에 두 개 'Running' 으로 보임.
	if p.DeletionTimestamp != nil {
		out["deletion_timestamp"] = toISO(p.DeletionTimestamp)
	}
	if len(p.OwnerReferences) > 0 {
		refs := make([]map[string]interface{}, 0, len(p.OwnerReferences))
		for _, r := range p.OwnerReferences {
			refs = append(refs, map[string]interface{}{
				"kind":       r.Kind,
				"name":       r.Name,
				"uid":        string(r.UID),
				"controller": r.Controller != nil && *r.Controller,
			})
		}
		out["owner_references"] = refs
	}
	if sa := p.Spec.ServiceAccountName; sa != "" {
		out["service_account_name"] = sa
	}
	return out
}

// podReadyString returns a "ready/total" string for a pod.
func podReadyString(statuses []corev1.ContainerStatus, total int) string {
	ready := 0
	for _, cs := range statuses {
		if cs.Ready {
			ready++
		}
	}
	return fmt.Sprintf("%d/%d", ready, total)
}

// podStatusString returns the effective status for a pod.
func podStatusString(pod *corev1.Pod) string {
	if pod.DeletionTimestamp != nil {
		return "Terminating"
	}
	status := string(pod.Status.Phase)
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			return cs.State.Waiting.Reason
		}
	}
	return strings.TrimSpace(status)
}

// listOwnedPods returns pods directly owned by the given controller
// (matched via metadata.ownerReferences kind/name). Used by DescribeDaemonSet
// / DescribeReplicaSet / DescribeStatefulSet to embed an owned_pods list in
// the detail response so the UI can show + link to children.
func (s *Service) listOwnedPods(ctx context.Context, namespace, ownerKind, ownerName string) ([]map[string]interface{}, error) {
	pods, err := s.Clientset().CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pods in %s: %w", namespace, err)
	}

	result := make([]map[string]interface{}, 0)
	for i := range pods.Items {
		pod := &pods.Items[i]
		owned := false
		for _, ref := range pod.OwnerReferences {
			if ref.Kind == ownerKind && ref.Name == ownerName {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}

		restartCount := int32(0)
		for _, cs := range pod.Status.ContainerStatuses {
			restartCount += cs.RestartCount
		}

		result = append(result, map[string]interface{}{
			"name":          pod.Name,
			"namespace":     pod.Namespace,
			"status":        podStatusString(pod),
			"ready":         podReadyString(pod.Status.ContainerStatuses, len(pod.Spec.Containers)),
			"restart_count": restartCount,
			"node_name":     pod.Spec.NodeName,
			"pod_ip":        pod.Status.PodIP,
			"created_at":    toISO(&pod.CreationTimestamp),
		})
	}
	return result, nil
}
