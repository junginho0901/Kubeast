package k8s

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetPods lists pods in a namespace with optional label selector.
func (s *Service) GetPods(ctx context.Context, namespace string, labelSelector string) ([]map[string]interface{}, error) {
	opts := metav1.ListOptions{}
	if labelSelector != "" {
		opts.LabelSelector = labelSelector
	}
	podList, err := s.Clientset().CoreV1().Pods(namespace).List(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}
	return formatPodList(podList.Items), nil
}

// GetAllPods lists pods across all namespaces.
func (s *Service) GetAllPods(ctx context.Context) ([]map[string]interface{}, error) {
	podList, err := s.Clientset().CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all pods: %w", err)
	}
	return formatPodList(podList.Items), nil
}

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
			"status":              string(c.Status),
			"reason":              c.Reason,
			"message":             c.Message,
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

// GetPodLogs returns logs for a pod container.
func (s *Service) GetPodLogs(ctx context.Context, namespace, name, container string, tailLines int64) (string, error) {
	opts := &corev1.PodLogOptions{}
	if container != "" {
		opts.Container = container
	}
	if tailLines > 0 {
		opts.TailLines = &tailLines
	}

	req := s.Clientset().CoreV1().Pods(namespace).GetLogs(name, opts)
	stream, err := req.Stream(ctx)
	if err != nil {
		return "", fmt.Errorf("get pod logs %s/%s: %w", namespace, name, err)
	}
	defer stream.Close()

	data, err := io.ReadAll(stream)
	if err != nil {
		return "", fmt.Errorf("read pod logs: %w", err)
	}
	return string(data), nil
}

// StreamPodLogs returns a streaming io.ReadCloser for follow-mode pod logs.
func (s *Service) StreamPodLogs(ctx context.Context, namespace, name, container string, tailLines int64) (io.ReadCloser, error) {
	opts := &corev1.PodLogOptions{
		Follow:     true,
		Timestamps: true,
	}
	if container != "" {
		opts.Container = container
	}
	if tailLines > 0 {
		opts.TailLines = &tailLines
	}

	req := s.Clientset().CoreV1().Pods(namespace).GetLogs(name, opts)
	stream, err := req.Stream(ctx)
	if err != nil {
		return nil, fmt.Errorf("stream pod logs %s/%s: %w", namespace, name, err)
	}
	return stream, nil
}

// DeletePod deletes a pod with optional force deletion.
func (s *Service) DeletePod(ctx context.Context, namespace, name string, force bool) error {
	opts := metav1.DeleteOptions{}
	if force {
		grace := int64(0)
		opts.GracePeriodSeconds = &grace
	}
	return s.Clientset().CoreV1().Pods(namespace).Delete(ctx, name, opts)
}

// GetPodRBAC returns RBAC info for a pod's service account.
func (s *Service) GetPodRBAC(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	pod, err := s.Clientset().CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get pod %s/%s: %w", namespace, name, err)
	}

	saName := pod.Spec.ServiceAccountName
	if saName == "" {
		saName = "default"
	}

	sa, err := s.Clientset().CoreV1().ServiceAccounts(namespace).Get(ctx, saName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get service account %s: %w", saName, err)
	}

	// Find role bindings
	roleBindings, err := s.Clientset().RbacV1().RoleBindings(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list role bindings: %w", err)
	}

	clusterRoleBindings, err := s.Clientset().RbacV1().ClusterRoleBindings().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list cluster role bindings: %w", err)
	}

	bindings := make([]map[string]interface{}, 0)
	for _, rb := range roleBindings.Items {
		for _, subject := range rb.Subjects {
			if subject.Kind == "ServiceAccount" && subject.Name == saName && subject.Namespace == namespace {
				bindings = append(bindings, map[string]interface{}{
					"binding_type": "RoleBinding",
					"binding_name": rb.Name,
					"role_kind":    rb.RoleRef.Kind,
					"role_name":    rb.RoleRef.Name,
				})
			}
		}
	}

	for _, crb := range clusterRoleBindings.Items {
		for _, subject := range crb.Subjects {
			if subject.Kind == "ServiceAccount" && subject.Name == saName && (subject.Namespace == namespace || subject.Namespace == "") {
				bindings = append(bindings, map[string]interface{}{
					"binding_type": "ClusterRoleBinding",
					"binding_name": crb.Name,
					"role_kind":    crb.RoleRef.Kind,
					"role_name":    crb.RoleRef.Name,
				})
			}
		}
	}

	secrets := make([]string, 0, len(sa.Secrets))
	for _, s := range sa.Secrets {
		secrets = append(secrets, s.Name)
	}

	return map[string]interface{}{
		"pod_name":             name,
		"namespace":            namespace,
		"service_account_name": saName,
		"service_account_labels": sa.Labels,
		"secrets":              secrets,
		"bindings":             bindings,
	}, nil
}

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

	return map[string]interface{}{
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
