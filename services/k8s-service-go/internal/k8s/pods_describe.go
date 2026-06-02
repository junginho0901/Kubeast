package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// DescribePod returns detailed info about a pod.
func (s *Service) DescribePod(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	// Fetch pod and events in parallel
	var pod *corev1.Pod
	var events *corev1.EventList
	var podErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		pod, podErr = s.Clientset().CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Pod", name),
		})
	}()
	wg.Wait()

	if podErr != nil {
		return nil, fmt.Errorf("get pod %s/%s: %w", namespace, name, podErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatPodDetail(pod)

	// Additional describe-only fields (matching Python output)
	result["uid"] = string(pod.UID)
	result["resource_version"] = pod.ResourceVersion

	// QoS class
	result["qos_class"] = string(pod.Status.QOSClass)

	// Multiple pod IPs
	podIPs := make([]string, 0, len(pod.Status.PodIPs))
	for _, ip := range pod.Status.PodIPs {
		podIPs = append(podIPs, ip.IP)
	}
	result["pod_ips"] = podIPs

	// Host IP
	result["host_ip"] = pod.Status.HostIP
	hostIPs := make([]string, 0)
	for _, hip := range pod.Status.HostIPs {
		hostIPs = append(hostIPs, hip.IP)
	}
	result["host_ips"] = hostIPs

	// Nominated node and preemption
	result["nominated_node_name"] = pod.Status.NominatedNodeName
	if pod.Spec.PreemptionPolicy != nil {
		result["preemption_policy"] = string(*pod.Spec.PreemptionPolicy)
	}
	if pod.Spec.RuntimeClassName != nil {
		result["runtime_class_name"] = *pod.Spec.RuntimeClassName
	}

	// Priority
	if pod.Spec.Priority != nil {
		result["priority"] = *pod.Spec.Priority
	}
	result["priority_class_name"] = pod.Spec.PriorityClassName

	// Service account
	result["service_account"] = pod.Spec.ServiceAccountName
	result["restart_policy"] = string(pod.Spec.RestartPolicy)
	result["host_network"] = pod.Spec.HostNetwork
	result["host_pid"] = pod.Spec.HostPID
	result["host_ipc"] = pod.Spec.HostIPC

	// imagePullSecrets — registry 인증용 Secret. 사용자가 Pod 모달에서 어느 Secret
	// 으로 이미지 pull 하는지 즉시 보고 ResourceLink 로 Secret detail 점프하기 위함.
	pullSecrets := make([]string, 0, len(pod.Spec.ImagePullSecrets))
	for _, s := range pod.Spec.ImagePullSecrets {
		pullSecrets = append(pullSecrets, s.Name)
	}
	result["image_pull_secrets"] = pullSecrets

	// Start time and deletion timestamp
	if pod.Status.StartTime != nil {
		result["start_time"] = toISO(pod.Status.StartTime)
	}
	if pod.DeletionTimestamp != nil {
		result["deletion_timestamp"] = toISO(pod.DeletionTimestamp)
	}

	// Owner references
	owners := make([]map[string]interface{}, 0, len(pod.OwnerReferences))
	for _, or := range pod.OwnerReferences {
		owners = append(owners, map[string]interface{}{
			"kind": or.Kind,
			"name": or.Name,
			"uid":  string(or.UID),
		})
	}
	result["owner_references"] = owners
	result["finalizers"] = pod.Finalizers
	result["annotations"] = pod.Annotations

	// Events
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

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(pod.Status.Conditions))
	for _, c := range pod.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                 string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	// Volumes
	volumes := make([]map[string]interface{}, 0, len(pod.Spec.Volumes))
	for _, v := range pod.Spec.Volumes {
		vol := map[string]interface{}{
			"name": v.Name,
		}
		if v.ConfigMap != nil {
			vol["type"] = "ConfigMap"
			vol["config_map"] = v.ConfigMap.Name
		} else if v.Secret != nil {
			vol["type"] = "Secret"
			vol["secret"] = v.Secret.SecretName
		} else if v.PersistentVolumeClaim != nil {
			vol["type"] = "PersistentVolumeClaim"
			vol["pvc"] = v.PersistentVolumeClaim.ClaimName
		} else if v.EmptyDir != nil {
			vol["type"] = "EmptyDir"
		} else if v.HostPath != nil {
			vol["type"] = "HostPath"
			vol["path"] = v.HostPath.Path
		} else if v.Projected != nil {
			vol["type"] = "Projected"
		} else if v.DownwardAPI != nil {
			vol["type"] = "DownwardAPI"
		} else {
			vol["type"] = "Other"
		}
		volumes = append(volumes, vol)
	}
	result["volumes"] = volumes

	// Tolerations
	tolerations := make([]map[string]interface{}, 0, len(pod.Spec.Tolerations))
	for _, t := range pod.Spec.Tolerations {
		tolerations = append(tolerations, map[string]interface{}{
			"key":                t.Key,
			"operator":           string(t.Operator),
			"value":              t.Value,
			"effect":             string(t.Effect),
			"toleration_seconds": t.TolerationSeconds,
		})
	}
	result["tolerations"] = tolerations

	// Node selector
	nodeSelector := make(map[string]string)
	for k, v := range pod.Spec.NodeSelector {
		nodeSelector[k] = v
	}
	result["node_selector"] = nodeSelector

	return result, nil
}
