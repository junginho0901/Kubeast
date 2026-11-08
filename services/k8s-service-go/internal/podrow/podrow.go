// Package podrow is a pod as Kubeast lists it, one row for the pod list API, the drawers and the live list updates
// alike, with its Status, READY and RESTARTS as kubectl prints them.
package podrow

import (
	"fmt"
	"slices"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Info is the pod's row. It names what the containers refer to and holds no environment value: env_count and env_from
// are all it says of a container's environment.
func Info(p *corev1.Pod) map[string]interface{} {
	containers := make([]map[string]interface{}, 0, len(p.Spec.Containers))
	statusMap := make(map[string]*corev1.ContainerStatus, len(p.Status.ContainerStatuses))
	for i := range p.Status.ContainerStatuses {
		statusMap[p.Status.ContainerStatuses[i].Name] = &p.Status.ContainerStatuses[i]
	}

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

		// Which ConfigMap or Secret a container takes its whole environment from: the Pod drawer shows it.
		envFrom := make([]map[string]interface{}, 0, len(c.EnvFrom))
		for _, ef := range c.EnvFrom {
			entry := map[string]interface{}{}
			if ef.Prefix != "" {
				entry["prefix"] = ef.Prefix
			}
			if ef.ConfigMapRef != nil {
				entry["config_map"] = ef.ConfigMapRef.Name
				if ef.ConfigMapRef.Optional != nil {
					entry["optional"] = *ef.ConfigMapRef.Optional
				}
			} else if ef.SecretRef != nil {
				entry["secret"] = ef.SecretRef.Name
				if ef.SecretRef.Optional != nil {
					entry["optional"] = *ef.SecretRef.Optional
				}
			}
			envFrom = append(envFrom, entry)
		}
		container["env_from"] = envFrom

		if sc := containerSecurityContext(c.SecurityContext); len(sc) > 0 {
			container["security_context"] = sc
		}

		if len(c.Command) > 0 {
			container["command"] = c.Command
		}
		if len(c.Args) > 0 {
			container["args"] = c.Args
		}

		if cs, ok := statusMap[c.Name]; ok {
			container["ready"] = cs.Ready
			container["restart_count"] = cs.RestartCount
			container["state"] = containerState(cs.State)
			container["last_state"] = containerState(cs.LastTerminationState)
		}

		containers = append(containers, container)
	}

	initContainers := make([]map[string]interface{}, 0, len(p.Spec.InitContainers))
	for _, c := range p.Spec.InitContainers {
		ic := map[string]interface{}{
			"name":  c.Name,
			"image": c.Image,
		}
		sidecar := restartableInit(&c)
		if sidecar {
			ic["restart_policy"] = string(*c.RestartPolicy)
		}
		for _, cs := range p.Status.InitContainerStatuses {
			if cs.Name == c.Name {
				ic["ready"] = cs.Ready
				ic["restart_count"] = cs.RestartCount
				ic["state"] = containerState(cs.State)
				if sidecar && cs.Started != nil {
					ic["started"] = *cs.Started
				}
				break
			}
		}
		initContainers = append(initContainers, ic)
	}

	status, totalReady, totalContainers, totalRestarts := ListView(p)
	reason := p.Status.Reason
	message := p.Status.Message

	for _, cs := range p.Status.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			if reason == "" {
				reason = cs.State.Waiting.Reason
			}
			if message == "" {
				message = cs.State.Waiting.Message
			}
			break
		}
		if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" {
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
		"created_at":      iso(p.CreationTimestamp),
	}
	// A pod in graceful shutdown keeps the phase Running: Cluster View tells it from the new pod that replaces it by this.
	if p.DeletionTimestamp != nil {
		out["deletion_timestamp"] = iso(*p.DeletionTimestamp)
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
	if pc := p.Spec.PriorityClassName; pc != "" {
		out["priority_class_name"] = pc
	}
	if p.Spec.RuntimeClassName != nil && *p.Spec.RuntimeClassName != "" {
		out["runtime_class_name"] = *p.Spec.RuntimeClassName
	}

	// A claim named directly and one made from a template are told apart (Kubernetes 1.31+ names them on the entry).
	if len(p.Spec.ResourceClaims) > 0 {
		claimNames := make([]string, 0)
		templateNames := make([]string, 0)
		for _, rc := range p.Spec.ResourceClaims {
			if rc.ResourceClaimName != nil && *rc.ResourceClaimName != "" {
				claimNames = append(claimNames, *rc.ResourceClaimName)
			}
			if rc.ResourceClaimTemplateName != nil && *rc.ResourceClaimTemplateName != "" {
				templateNames = append(templateNames, *rc.ResourceClaimTemplateName)
			}
		}
		if len(claimNames) > 0 {
			out["resource_claims"] = claimNames
		}
		if len(templateNames) > 0 {
			out["resource_claim_templates"] = templateNames
		}
	}

	cms, secrets := ReferenceNames(&p.Spec)
	if len(cms) > 0 {
		out["config_map_refs"] = cms
	}
	if len(secrets) > 0 {
		out["secret_refs"] = secrets
	}
	return out
}

func containerSecurityContext(c *corev1.SecurityContext) map[string]interface{} {
	sc := map[string]interface{}{}
	if c == nil {
		return sc
	}
	if c.RunAsUser != nil {
		sc["run_as_user"] = *c.RunAsUser
	}
	if c.RunAsGroup != nil {
		sc["run_as_group"] = *c.RunAsGroup
	}
	if c.RunAsNonRoot != nil {
		sc["run_as_non_root"] = *c.RunAsNonRoot
	}
	if c.ReadOnlyRootFilesystem != nil {
		sc["read_only_root_filesystem"] = *c.ReadOnlyRootFilesystem
	}
	if c.AllowPrivilegeEscalation != nil {
		sc["allow_privilege_escalation"] = *c.AllowPrivilegeEscalation
	}
	if c.Privileged != nil {
		sc["privileged"] = *c.Privileged
	}
	if c.Capabilities != nil {
		caps := map[string]interface{}{}
		if len(c.Capabilities.Add) > 0 {
			adds := make([]string, 0, len(c.Capabilities.Add))
			for _, a := range c.Capabilities.Add {
				adds = append(adds, string(a))
			}
			caps["add"] = adds
		}
		if len(c.Capabilities.Drop) > 0 {
			drops := make([]string, 0, len(c.Capabilities.Drop))
			for _, d := range c.Capabilities.Drop {
				drops = append(drops, string(d))
			}
			caps["drop"] = drops
		}
		if len(caps) > 0 {
			sc["capabilities"] = caps
		}
	}
	return sc
}

// ReferenceNames are the ConfigMaps and Secrets a pod names, each once and sorted: the Used By Pods sections of their
// drawers filter on them, in the row and in the pod rows the server pages (pod_index.go).
func ReferenceNames(spec *corev1.PodSpec) (configMaps, secrets []string) {
	add := func(list *[]string, name string) {
		if name != "" {
			*list = append(*list, name)
		}
	}
	for _, v := range spec.Volumes {
		if v.ConfigMap != nil {
			add(&configMaps, v.ConfigMap.Name)
		}
		if v.Secret != nil {
			add(&secrets, v.Secret.SecretName)
		}
		if v.Projected != nil {
			for _, src := range v.Projected.Sources {
				if src.ConfigMap != nil {
					add(&configMaps, src.ConfigMap.Name)
				}
				if src.Secret != nil {
					add(&secrets, src.Secret.Name)
				}
			}
		}
	}
	for _, c := range slices.Concat(spec.Containers, spec.InitContainers) {
		for _, e := range c.EnvFrom {
			if e.ConfigMapRef != nil {
				add(&configMaps, e.ConfigMapRef.Name)
			}
			if e.SecretRef != nil {
				add(&secrets, e.SecretRef.Name)
			}
		}
		for _, env := range c.Env {
			if env.ValueFrom == nil {
				continue
			}
			if env.ValueFrom.ConfigMapKeyRef != nil {
				add(&configMaps, env.ValueFrom.ConfigMapKeyRef.Name)
			}
			if env.ValueFrom.SecretKeyRef != nil {
				add(&secrets, env.ValueFrom.SecretKeyRef.Name)
			}
		}
	}
	for _, ips := range spec.ImagePullSecrets {
		add(&secrets, ips.Name)
	}
	slices.Sort(configMaps)
	slices.Sort(secrets)
	return slices.Compact(configMaps), slices.Compact(secrets)
}

func containerState(state corev1.ContainerState) map[string]interface{} {
	result := map[string]interface{}{}
	if state.Running != nil {
		result["running"] = map[string]interface{}{
			"started_at": iso(state.Running.StartedAt),
		}
	}
	if state.Waiting != nil {
		result["waiting"] = map[string]interface{}{
			"reason":  state.Waiting.Reason,
			"message": state.Waiting.Message,
		}
	}
	if state.Terminated != nil {
		result["terminated"] = map[string]interface{}{
			"exit_code":   state.Terminated.ExitCode,
			"reason":      state.Terminated.Reason,
			"message":     state.Terminated.Message,
			"started_at":  iso(state.Terminated.StartedAt),
			"finished_at": iso(state.Terminated.FinishedAt),
		}
	}
	return result
}

func iso(t metav1.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
