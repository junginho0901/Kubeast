package podrow

import (
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// FromObject reads a pod out of a watch event's object for Info: the fields Info reads and no others, so an environment
// value is not even copied. A namespace's pods come one event each, and the reflective converter costs ten times what
// the row does (BenchmarkPodFrame). A field of an unexpected type reads as empty. TestFromObjectReadsWhatInfoReads holds
// this to the converter over random pods, so a field Info starts to read has to be added here.
func FromObject(o map[string]interface{}) *corev1.Pod {
	meta, spec, status := mapOf(o["metadata"]), mapOf(o["spec"]), mapOf(o["status"])
	p := &corev1.Pod{}

	p.Name, p.Namespace = str(meta["name"]), str(meta["namespace"])
	p.CreationTimestamp = timeOf(meta["creationTimestamp"])
	if t := timeOf(meta["deletionTimestamp"]); !t.IsZero() {
		p.DeletionTimestamp = &t
	}
	if labels := mapOf(meta["labels"]); labels != nil {
		p.Labels = make(map[string]string, len(labels))
		for k, v := range labels {
			p.Labels[k] = str(v)
		}
	}
	for _, r := range mapsOf(meta["ownerReferences"]) {
		p.OwnerReferences = append(p.OwnerReferences, metav1.OwnerReference{
			Kind: str(r["kind"]), Name: str(r["name"]), UID: types.UID(str(r["uid"])), Controller: boolPtr(r["controller"]),
		})
	}

	p.Spec.NodeName = str(spec["nodeName"])
	p.Spec.ServiceAccountName = str(spec["serviceAccountName"])
	p.Spec.PriorityClassName = str(spec["priorityClassName"])
	p.Spec.RuntimeClassName = strPtr(spec["runtimeClassName"])
	p.Spec.Containers = containersOf(spec["containers"])
	p.Spec.InitContainers = containersOf(spec["initContainers"])
	for _, v := range mapsOf(spec["volumes"]) {
		p.Spec.Volumes = append(p.Spec.Volumes, volumeOf(v))
	}
	for _, s := range mapsOf(spec["imagePullSecrets"]) {
		p.Spec.ImagePullSecrets = append(p.Spec.ImagePullSecrets, corev1.LocalObjectReference{Name: str(s["name"])})
	}
	for _, c := range mapsOf(spec["resourceClaims"]) {
		p.Spec.ResourceClaims = append(p.Spec.ResourceClaims, corev1.PodResourceClaim{
			Name: str(c["name"]), ResourceClaimName: strPtr(c["resourceClaimName"]), ResourceClaimTemplateName: strPtr(c["resourceClaimTemplateName"]),
		})
	}

	p.Status.Phase = corev1.PodPhase(str(status["phase"]))
	p.Status.Reason = str(status["reason"])
	p.Status.Message = str(status["message"])
	p.Status.PodIP = str(status["podIP"])
	for _, c := range mapsOf(status["conditions"]) {
		p.Status.Conditions = append(p.Status.Conditions, corev1.PodCondition{
			Type: corev1.PodConditionType(str(c["type"])), Status: corev1.ConditionStatus(str(c["status"])), Reason: str(c["reason"]),
		})
	}
	p.Status.ContainerStatuses = containerStatusesOf(status["containerStatuses"])
	p.Status.InitContainerStatuses = containerStatusesOf(status["initContainerStatuses"])
	return p
}

func containersOf(v interface{}) []corev1.Container {
	list := mapsOf(v)
	if len(list) == 0 {
		return nil
	}
	out := make([]corev1.Container, 0, len(list))
	for _, m := range list {
		c := corev1.Container{Name: str(m["name"]), Image: str(m["image"])}
		for _, port := range mapsOf(m["ports"]) {
			c.Ports = append(c.Ports, corev1.ContainerPort{
				Name: str(port["name"]), ContainerPort: int32Of(port["containerPort"]), Protocol: corev1.Protocol(str(port["protocol"])),
			})
		}
		resources := mapOf(m["resources"])
		c.Resources.Requests = resourcesOf(resources["requests"])
		c.Resources.Limits = resourcesOf(resources["limits"])
		for _, mount := range mapsOf(m["volumeMounts"]) {
			readOnly, _ := mount["readOnly"].(bool)
			c.VolumeMounts = append(c.VolumeMounts, corev1.VolumeMount{Name: str(mount["name"]), MountPath: str(mount["mountPath"]), ReadOnly: readOnly})
		}
		for _, e := range mapsOf(m["env"]) {
			c.Env = append(c.Env, envVarOf(e))
		}
		for _, e := range mapsOf(m["envFrom"]) {
			c.EnvFrom = append(c.EnvFrom, envFromOf(e))
		}
		c.SecurityContext = securityContextOf(m["securityContext"])
		c.Command, c.Args = stringsOf(m["command"]), stringsOf(m["args"])
		if policy := str(m["restartPolicy"]); policy != "" {
			restart := corev1.ContainerRestartPolicy(policy)
			c.RestartPolicy = &restart
		}
		out = append(out, c)
	}
	return out
}

// envVarOf keeps the names an entry refers to; its value stays out.
func envVarOf(e map[string]interface{}) corev1.EnvVar {
	env := corev1.EnvVar{Name: str(e["name"])}
	from := mapOf(e["valueFrom"])
	if from == nil {
		return env
	}
	env.ValueFrom = &corev1.EnvVarSource{}
	if ref := mapOf(from["configMapKeyRef"]); ref != nil {
		env.ValueFrom.ConfigMapKeyRef = &corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: str(ref["name"])}}
	}
	if ref := mapOf(from["secretKeyRef"]); ref != nil {
		env.ValueFrom.SecretKeyRef = &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: str(ref["name"])}}
	}
	return env
}

func envFromOf(e map[string]interface{}) corev1.EnvFromSource {
	out := corev1.EnvFromSource{Prefix: str(e["prefix"])}
	if ref := mapOf(e["configMapRef"]); ref != nil {
		out.ConfigMapRef = &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: str(ref["name"])}, Optional: boolPtr(ref["optional"])}
	}
	if ref := mapOf(e["secretRef"]); ref != nil {
		out.SecretRef = &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: str(ref["name"])}, Optional: boolPtr(ref["optional"])}
	}
	return out
}

func securityContextOf(v interface{}) *corev1.SecurityContext {
	m := mapOf(v)
	if m == nil {
		return nil
	}
	sc := &corev1.SecurityContext{
		RunAsUser: int64Ptr(m["runAsUser"]), RunAsGroup: int64Ptr(m["runAsGroup"]), RunAsNonRoot: boolPtr(m["runAsNonRoot"]),
		ReadOnlyRootFilesystem: boolPtr(m["readOnlyRootFilesystem"]), AllowPrivilegeEscalation: boolPtr(m["allowPrivilegeEscalation"]), Privileged: boolPtr(m["privileged"]),
	}
	if caps := mapOf(m["capabilities"]); caps != nil {
		sc.Capabilities = &corev1.Capabilities{}
		for _, a := range listOf(caps["add"]) {
			sc.Capabilities.Add = append(sc.Capabilities.Add, corev1.Capability(str(a)))
		}
		for _, d := range listOf(caps["drop"]) {
			sc.Capabilities.Drop = append(sc.Capabilities.Drop, corev1.Capability(str(d)))
		}
	}
	return sc
}

func volumeOf(m map[string]interface{}) corev1.Volume {
	v := corev1.Volume{Name: str(m["name"])}
	if cm := mapOf(m["configMap"]); cm != nil {
		v.ConfigMap = &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: str(cm["name"])}}
	}
	if secret := mapOf(m["secret"]); secret != nil {
		v.Secret = &corev1.SecretVolumeSource{SecretName: str(secret["secretName"])}
	}
	if projected := mapOf(m["projected"]); projected != nil {
		v.Projected = &corev1.ProjectedVolumeSource{}
		for _, s := range mapsOf(projected["sources"]) {
			var source corev1.VolumeProjection
			if cm := mapOf(s["configMap"]); cm != nil {
				source.ConfigMap = &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: str(cm["name"])}}
			}
			if secret := mapOf(s["secret"]); secret != nil {
				source.Secret = &corev1.SecretProjection{LocalObjectReference: corev1.LocalObjectReference{Name: str(secret["name"])}}
			}
			v.Projected.Sources = append(v.Projected.Sources, source)
		}
	}
	return v
}

func containerStatusesOf(v interface{}) []corev1.ContainerStatus {
	list := mapsOf(v)
	if len(list) == 0 {
		return nil
	}
	out := make([]corev1.ContainerStatus, 0, len(list))
	for _, m := range list {
		ready, _ := m["ready"].(bool)
		out = append(out, corev1.ContainerStatus{
			Name: str(m["name"]), Ready: ready, Started: boolPtr(m["started"]), RestartCount: int32Of(m["restartCount"]),
			State: containerStateOf(m["state"]), LastTerminationState: containerStateOf(m["lastState"]),
		})
	}
	return out
}

func containerStateOf(v interface{}) corev1.ContainerState {
	m := mapOf(v)
	var s corev1.ContainerState
	if r := mapOf(m["running"]); r != nil {
		s.Running = &corev1.ContainerStateRunning{StartedAt: timeOf(r["startedAt"])}
	}
	if w := mapOf(m["waiting"]); w != nil {
		s.Waiting = &corev1.ContainerStateWaiting{Reason: str(w["reason"]), Message: str(w["message"])}
	}
	if t := mapOf(m["terminated"]); t != nil {
		s.Terminated = &corev1.ContainerStateTerminated{
			ExitCode: int32Of(t["exitCode"]), Signal: int32Of(t["signal"]), Reason: str(t["reason"]), Message: str(t["message"]),
			StartedAt: timeOf(t["startedAt"]), FinishedAt: timeOf(t["finishedAt"]),
		}
	}
	return s
}

func resourcesOf(v interface{}) corev1.ResourceList {
	m := mapOf(v)
	if m == nil {
		return nil
	}
	out := make(corev1.ResourceList, len(m))
	for name, value := range m {
		text, ok := value.(string)
		if !ok {
			// a quantity written as a bare number, which the API accepts
			text = fmt.Sprint(value)
		}
		if q, err := resource.ParseQuantity(text); err == nil {
			out[corev1.ResourceName(name)] = q
		}
	}
	return out
}

func mapOf(v interface{}) map[string]interface{} {
	m, _ := v.(map[string]interface{})
	return m
}

func listOf(v interface{}) []interface{} {
	list, _ := v.([]interface{})
	return list
}

func mapsOf(v interface{}) []map[string]interface{} {
	list := listOf(v)
	if len(list) == 0 {
		return nil
	}
	out := make([]map[string]interface{}, 0, len(list))
	for _, entry := range list {
		if m := mapOf(entry); m != nil {
			out = append(out, m)
		}
	}
	return out
}

func stringsOf(v interface{}) []string {
	list := listOf(v)
	if len(list) == 0 {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, entry := range list {
		out = append(out, str(entry))
	}
	return out
}

func str(v interface{}) string {
	s, _ := v.(string)
	return s
}

func strPtr(v interface{}) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func boolPtr(v interface{}) *bool {
	if b, ok := v.(bool); ok {
		return &b
	}
	return nil
}

func int64Of(v interface{}) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case float64:
		return int64(n), true
	}
	return 0, false
}

func int64Ptr(v interface{}) *int64 {
	if n, ok := int64Of(v); ok {
		return &n
	}
	return nil
}

func int32Of(v interface{}) int32 {
	n, _ := int64Of(v)
	return int32(n)
}

func timeOf(v interface{}) metav1.Time {
	s, ok := v.(string)
	if !ok {
		return metav1.Time{}
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return metav1.Time{}
	}
	return metav1.NewTime(t)
}
