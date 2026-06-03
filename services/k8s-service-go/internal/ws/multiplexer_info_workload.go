package ws

import (
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// deploymentToInfo — list endpoint: formatDeploymentDetail (deployments.go).
func deploymentToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var replicas, readyReplicas, availableReplicas, updatedReplicas int64
	if spec != nil {
		replicas, _ = toInt64(spec["replicas"])
	}
	if status != nil {
		readyReplicas, _ = toInt64(status["readyReplicas"])
		availableReplicas, _ = toInt64(status["availableReplicas"])
		updatedReplicas, _ = toInt64(status["updatedReplicas"])
	}

	images := containerImages(spec)
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	// status — formatDeploymentDetail 과 동일 logic (Available/Failed/Progressing)
	depStatus := "Progressing"
	if status != nil {
		if conds, ok := status["conditions"].([]interface{}); ok {
			for _, c := range conds {
				cm, _ := c.(map[string]interface{})
				if cm == nil {
					continue
				}
				ctype, _ := cm["type"].(string)
				cstatus, _ := cm["status"].(string)
				if ctype == "Available" && cstatus == "True" {
					depStatus = "Available"
					break
				}
				if ctype == "Progressing" && cstatus == "False" {
					depStatus = "Failed"
					break
				}
			}
		}
	}

	selector := selectorMatchLabels(spec)

	return map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"replicas":           replicas,
		"ready_replicas":     readyReplicas,
		"available_replicas": availableReplicas,
		"updated_replicas":   updatedReplicas,
		"image":              image,
		"images":             images,
		"labels":             metadata["labels"],
		"selector":           selector,
		"status":             depStatus,
		"created_at":         metadata["creationTimestamp"],
	}
}

// statefulsetToInfo — list endpoint: formatStatefulSetDetail (workloads_formatters.go).
func statefulsetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var replicas, readyReplicas, currentReplicas, updatedReplicas, availableReplicas int64
	if spec != nil {
		replicas, _ = toInt64(spec["replicas"])
	}
	if status != nil {
		readyReplicas, _ = toInt64(status["readyReplicas"])
		currentReplicas, _ = toInt64(status["currentReplicas"])
		updatedReplicas, _ = toInt64(status["updatedReplicas"])
		availableReplicas, _ = toInt64(status["availableReplicas"])
	}

	images := containerImages(spec)
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	selector := selectorMatchLabels(spec)

	serviceName := ""
	if spec != nil {
		if sn, ok := spec["serviceName"].(string); ok {
			serviceName = sn
		}
	}

	// status — formatStatefulSetDetail 과 동일 logic
	stsStatus := "Healthy"
	if replicas == 0 {
		stsStatus = "Idle"
	} else if readyReplicas < replicas {
		stsStatus = "Degraded"
	} else if availableReplicas == 0 && replicas > 0 {
		stsStatus = "Unavailable"
	}

	return map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"replicas":           replicas,
		"ready_replicas":     readyReplicas,
		"current_replicas":   currentReplicas,
		"updated_replicas":   updatedReplicas,
		"available_replicas": availableReplicas,
		"image":              image,
		"images":             images,
		"selector":           selector,
		"service_name":       serviceName,
		"status":             stsStatus,
		"created_at":         metadata["creationTimestamp"],
	}
}

// daemonsetToInfo — list endpoint: formatDaemonSetDetail (workloads_formatters.go).
func daemonsetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var desired, current, ready, available, misscheduled, updated, unavailable int64
	if status != nil {
		desired, _ = toInt64(status["desiredNumberScheduled"])
		current, _ = toInt64(status["currentNumberScheduled"])
		ready, _ = toInt64(status["numberReady"])
		available, _ = toInt64(status["numberAvailable"])
		misscheduled, _ = toInt64(status["numberMisscheduled"])
		updated, _ = toInt64(status["updatedNumberScheduled"])
		unavailable, _ = toInt64(status["numberUnavailable"])
	}

	images := containerImages(spec)
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	selector := selectorMatchLabels(spec)

	// node_selector 는 spec.template.spec.nodeSelector
	var nodeSelector interface{}
	if spec != nil {
		if tmpl, ok := spec["template"].(map[string]interface{}); ok {
			if podSpec, ok := tmpl["spec"].(map[string]interface{}); ok {
				nodeSelector = podSpec["nodeSelector"]
			}
		}
	}

	dsStatus := "Healthy"
	if desired == 0 {
		dsStatus = "Idle"
	} else if ready < desired {
		dsStatus = "Degraded"
	} else if available == 0 && desired > 0 {
		dsStatus = "Unavailable"
	}

	return map[string]interface{}{
		"name":          metadata["name"],
		"namespace":     metadata["namespace"],
		"desired":       desired,
		"current":       current,
		"ready":         ready,
		"updated":       updated,
		"available":     available,
		"misscheduled":  misscheduled,
		"unavailable":   unavailable,
		"node_selector": nodeSelector,
		"image":         image,
		"images":        images,
		"selector":      selector,
		"status":        dsStatus,
		"created_at":    metadata["creationTimestamp"],
	}
}

// replicasetToInfo — list endpoint: formatReplicaSetDetail (workloads_formatters.go).
func replicasetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var replicas, readyReplicas, availableReplicas int64
	if spec != nil {
		replicas, _ = toInt64(spec["replicas"])
	}
	if status != nil {
		readyReplicas, _ = toInt64(status["readyReplicas"])
		availableReplicas, _ = toInt64(status["availableReplicas"])
	}

	images := containerImages(spec)
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	selector := selectorMatchLabels(spec)

	// owner_deployment — ownerReferences 에서 Kind=="Deployment" 의 Name. owner_references 전체도
	// 함께 노출 (5.2 Deployment Owned RS / WorkloadOwnedResources 의 ownerRef filter 가
	// watch event 에서 정확히 매칭하도록).
	owner := ""
	var ownerRefs []map[string]interface{}
	if ors, ok := metadata["ownerReferences"].([]interface{}); ok && len(ors) > 0 {
		ownerRefs = make([]map[string]interface{}, 0, len(ors))
		for _, o := range ors {
			om, _ := o.(map[string]interface{})
			if om == nil {
				continue
			}
			ctrl, _ := om["controller"].(bool)
			ownerRefs = append(ownerRefs, map[string]interface{}{
				"kind":       om["kind"],
				"name":       om["name"],
				"uid":        om["uid"],
				"controller": ctrl,
			})
			if k, _ := om["kind"].(string); k == "Deployment" && owner == "" {
				if n, _ := om["name"].(string); n != "" {
					owner = n
				}
			}
		}
	}

	rsStatus := "Healthy"
	if replicas == 0 {
		rsStatus = "Idle"
	} else if readyReplicas < replicas {
		rsStatus = "Degraded"
	} else if availableReplicas == 0 && replicas > 0 {
		rsStatus = "Unavailable"
	}

	out := map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"replicas":           replicas,
		"ready_replicas":     readyReplicas,
		"available_replicas": availableReplicas,
		"image":              image,
		"images":             images,
		"selector":           selector,
		"owner_deployment":   owner,
		"status":             rsStatus,
		"created_at":         metadata["creationTimestamp"],
	}
	if len(ownerRefs) > 0 {
		out["owner_references"] = ownerRefs
	}
	return out
}

// jobToInfo — list endpoint: formatJobDetail (workloads_formatters.go).
func jobToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	completions := int64(1)
	parallelism := int64(1)
	if spec != nil {
		if c, ok := toInt64(spec["completions"]); ok {
			completions = c
		}
		if p, ok := toInt64(spec["parallelism"]); ok {
			parallelism = p
		}
	}

	var succeeded, failed, active int64
	var startTime, completionTime interface{}
	if status != nil {
		succeeded, _ = toInt64(status["succeeded"])
		failed, _ = toInt64(status["failed"])
		active, _ = toInt64(status["active"])
		startTime = status["startTime"]
		completionTime = status["completionTime"]
	}

	// status — formatJobDetail 과 동일 logic
	jobStatus := "Running"
	if status != nil {
		if conds, ok := status["conditions"].([]interface{}); ok {
			for _, c := range conds {
				cm, _ := c.(map[string]interface{})
				if cm == nil {
					continue
				}
				ctype, _ := cm["type"].(string)
				cstatus, _ := cm["status"].(string)
				if ctype == "Complete" && cstatus == "True" {
					jobStatus = "Complete"
					break
				}
				if ctype == "Failed" && cstatus == "True" {
					jobStatus = "Failed"
					break
				}
			}
		}
	}

	images := containerImagesFromTemplate(spec)
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	// owner_references — CronJob owned Jobs 매칭에 필수 (5.6 #12).
	var ownerRefs []map[string]interface{}
	if ors, ok := metadata["ownerReferences"].([]interface{}); ok && len(ors) > 0 {
		ownerRefs = make([]map[string]interface{}, 0, len(ors))
		for _, r := range ors {
			rm, _ := r.(map[string]interface{})
			if rm == nil {
				continue
			}
			ctrl, _ := rm["controller"].(bool)
			ownerRefs = append(ownerRefs, map[string]interface{}{
				"kind":       rm["kind"],
				"name":       rm["name"],
				"uid":        rm["uid"],
				"controller": ctrl,
			})
		}
	}

	out := map[string]interface{}{
		"name":        metadata["name"],
		"namespace":   metadata["namespace"],
		"completions": completions,
		"parallelism": parallelism,
		"succeeded":   succeeded,
		"failed":      failed,
		"active":      active,
		"status":      jobStatus,
		"image":       image,
		"images":      images,
		"created_at":  metadata["creationTimestamp"],
	}
	if len(ownerRefs) > 0 {
		out["owner_references"] = ownerRefs
	}

	if st, ok := startTime.(string); ok && st != "" {
		out["start_time"] = st
	}
	if ct, ok := completionTime.(string); ok && ct != "" {
		out["completion_time"] = ct
	}
	if st, ok := startTime.(string); ok && st != "" {
		if ct, ok := completionTime.(string); ok && ct != "" {
			stTime, err1 := time.Parse(time.RFC3339, st)
			ctTime, err2 := time.Parse(time.RFC3339, ct)
			if err1 == nil && err2 == nil {
				// formatJobDetail 은 duration 을 time.Duration.String() 로 직렬화
				out["duration"] = ctTime.Sub(stTime).String()
			}
		}
	}

	return out
}

// cronjobToInfo — list endpoint: formatCronJobDetail (workloads_formatters.go).
func cronjobToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	schedule := ""
	suspend := false
	concurrencyPolicy := ""
	if spec != nil {
		if s, ok := spec["schedule"].(string); ok {
			schedule = s
		}
		if s, ok := spec["suspend"].(bool); ok {
			suspend = s
		}
		if cp, ok := spec["concurrencyPolicy"].(string); ok {
			concurrencyPolicy = cp
		}
	}

	activeCount := 0
	var lastScheduleTime, lastSuccessfulTime interface{}
	if status != nil {
		if activeList, ok := status["active"].([]interface{}); ok {
			activeCount = len(activeList)
		}
		lastScheduleTime = status["lastScheduleTime"]
		lastSuccessfulTime = status["lastSuccessfulTime"]
	}

	// images — spec.jobTemplate.spec.template.spec.containers
	images := []string{}
	if spec != nil {
		if jt, ok := spec["jobTemplate"].(map[string]interface{}); ok {
			if jtSpec, ok := jt["spec"].(map[string]interface{}); ok {
				images = containerImagesFromTemplate(jtSpec)
			}
		}
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	out := map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"schedule":           schedule,
		"suspend":            suspend,
		"active":             activeCount,
		"image":              image,
		"images":             images,
		"concurrency_policy": concurrencyPolicy,
		"created_at":         metadata["creationTimestamp"],
	}
	if ls, ok := lastScheduleTime.(string); ok && ls != "" {
		out["last_schedule"] = ls
	}
	if lsu, ok := lastSuccessfulTime.(string); ok && lsu != "" {
		out["last_successful"] = lsu
	}

	return out
}
