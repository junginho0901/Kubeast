package ws

import (
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	cronjobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/cronjob"
	deployrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/deployment"
	rsrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/replicaset"
)

// deploymentToInfo is the list's row (deployrow.Info), so a live update says what the list says.
func deploymentToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var d appsv1.Deployment
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &d); err != nil {
		return genericToInfo(obj)
	}
	return deployrow.Info(&d)
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
	} else if availableReplicas == 0 && replicas > 0 {
		stsStatus = "Unavailable"
	} else if readyReplicas < replicas {
		stsStatus = "Degraded"
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
	} else if available == 0 && desired > 0 {
		dsStatus = "Unavailable"
	} else if ready < desired {
		dsStatus = "Degraded"
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

// replicasetToInfo is the list's row (rsrow.Info), so a live update says what the list says. The drawer's owned
// ReplicaSets match on its owner_references.
func replicasetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var rs appsv1.ReplicaSet
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &rs); err != nil {
		return genericToInfo(obj)
	}
	return rsrow.Info(&rs)
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
		"containers":  containerNamesFromTemplate(spec),
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

// cronjobToInfo is the list's row (cronjobrow.Info), so a live update says what the list says.
func cronjobToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var cj batchv1.CronJob
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &cj); err != nil {
		return genericToInfo(obj)
	}
	return cronjobrow.Info(&cj)
}
