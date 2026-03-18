package k8s

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"gopkg.in/yaml.v3"
)

// toISO converts a metav1.Time to ISO 8601 string.
func toISO(t *metav1.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// age returns a human-readable age string.
func age(t *metav1.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	d := time.Since(t.Time)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// jsonToYAML converts JSON bytes to YAML string.
func jsonToYAML(data []byte) string {
	var obj interface{}
	if err := json.Unmarshal(data, &obj); err != nil {
		return string(data)
	}
	out, err := yaml.Marshal(obj)
	if err != nil {
		return string(data)
	}
	return string(out)
}

// unstructuredToYAML converts unstructured object to YAML string.
func unstructuredToYAML(obj *unstructured.Unstructured) (string, error) {
	obj.SetManagedFields(nil)
	data, err := json.Marshal(obj.Object)
	if err != nil {
		return "", err
	}
	return jsonToYAML(data), nil
}

// mapStr safely gets a string from a map.
func mapStr(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

// mapMap safely gets a sub-map.
func mapMap(m map[string]interface{}, key string) map[string]interface{} {
	if v, ok := m[key]; ok {
		if mm, ok := v.(map[string]interface{}); ok {
			return mm
		}
	}
	return nil
}

// mapSlice safely gets a slice.
func mapSlice(m map[string]interface{}, key string) []interface{} {
	if v, ok := m[key]; ok {
		if s, ok := v.([]interface{}); ok {
			return s
		}
	}
	return nil
}

// mapStrMap converts map[string]interface{} to map[string]string.
func mapStrMap(m map[string]interface{}) map[string]string {
	if m == nil {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = fmt.Sprintf("%v", v)
	}
	return out
}

// containerStateStr returns a human-readable state from a container status.
func containerStateStr(state corev1.ContainerState) map[string]interface{} {
	result := map[string]interface{}{}
	if state.Running != nil {
		result["running"] = map[string]interface{}{
			"started_at": toISO(&state.Running.StartedAt),
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
			"started_at":  toISO(&state.Terminated.StartedAt),
			"finished_at": toISO(&state.Terminated.FinishedAt),
		}
	}
	return result
}

// sortEventsByTime sorts events newest first.
func sortEventsByTime(events []corev1.Event) {
	sort.Slice(events, func(i, j int) bool {
		ti := events[i].LastTimestamp.Time
		tj := events[j].LastTimestamp.Time
		if ti.IsZero() {
			ti = events[i].CreationTimestamp.Time
		}
		if tj.IsZero() {
			tj = events[j].CreationTimestamp.Time
		}
		return ti.After(tj)
	})
}

// formatPodTemplate formats a PodTemplateSpec into the structure the frontend expects.
func formatPodTemplate(template corev1.PodTemplateSpec) map[string]interface{} {
	result := map[string]interface{}{
		"labels":               template.Labels,
		"service_account_name": template.Spec.ServiceAccountName,
		"node_selector":        template.Spec.NodeSelector,
		"priority_class_name":  template.Spec.PriorityClassName,
	}

	containers := make([]map[string]interface{}, 0, len(template.Spec.Containers))
	for _, c := range template.Spec.Containers {
		container := map[string]interface{}{
			"name":  c.Name,
			"image": c.Image,
		}
		if len(c.Command) > 0 {
			container["command"] = c.Command
		}
		if len(c.Args) > 0 {
			container["args"] = c.Args
		}

		ports := make([]map[string]interface{}, 0, len(c.Ports))
		for _, p := range c.Ports {
			ports = append(ports, map[string]interface{}{
				"container_port": p.ContainerPort,
				"protocol":       string(p.Protocol),
				"name":           p.Name,
			})
		}
		container["ports"] = ports

		if c.Resources.Requests != nil {
			req := make(map[string]string)
			for k, v := range c.Resources.Requests {
				req[string(k)] = v.String()
			}
			container["requests"] = req
		}
		if c.Resources.Limits != nil {
			lim := make(map[string]string)
			for k, v := range c.Resources.Limits {
				lim[string(k)] = v.String()
			}
			container["limits"] = lim
		}

		container["env_count"] = len(c.Env)

		volumeMounts := make([]map[string]interface{}, 0, len(c.VolumeMounts))
		for _, vm := range c.VolumeMounts {
			volumeMounts = append(volumeMounts, map[string]interface{}{
				"name":       vm.Name,
				"mount_path": vm.MountPath,
				"read_only":  vm.ReadOnly,
			})
		}
		container["volume_mounts"] = volumeMounts

		containers = append(containers, container)
	}
	result["containers"] = containers

	tolerations := make([]map[string]interface{}, 0, len(template.Spec.Tolerations))
	for _, tol := range template.Spec.Tolerations {
		t := map[string]interface{}{
			"key":      tol.Key,
			"operator": string(tol.Operator),
			"effect":   string(tol.Effect),
		}
		if tol.Value != "" {
			t["value"] = tol.Value
		}
		if tol.TolerationSeconds != nil {
			t["toleration_seconds"] = *tol.TolerationSeconds
		}
		tolerations = append(tolerations, t)
	}
	result["tolerations"] = tolerations

	return result
}

// labelsToString converts map to comma-separated k=v string.
func labelsToString(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	parts := make([]string, 0, len(labels))
	for k, v := range labels {
		parts = append(parts, k+"="+v)
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}
