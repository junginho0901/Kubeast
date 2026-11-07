package ws

import (
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	cronjobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/cronjob"
	dsrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/daemonset"
	deployrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/deployment"
	jobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/job"
	rsrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/replicaset"
)

// genericPodHolderToInfo is genericToInfo for a kind that holds a pod spec, for an object the conversion refuses: its
// row must not bring what the row of a converted object leaves out (withoutPodValues).
func genericPodHolderToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	out := genericToInfo(obj)
	if spec, _ := out["spec"].(map[string]interface{}); spec != nil {
		out["spec"] = withoutPodValues(spec)
	}
	return out
}

// deploymentToInfo is the list's row (deployrow.Info), so a live update says what the list says.
func deploymentToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var d appsv1.Deployment
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &d); err != nil {
		return genericPodHolderToInfo(obj)
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

// daemonsetToInfo is the list's row (dsrow.Info), so a live update says what the list says.
func daemonsetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var ds appsv1.DaemonSet
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &ds); err != nil {
		return genericPodHolderToInfo(obj)
	}
	return dsrow.Info(&ds)
}

// replicasetToInfo is the list's row (rsrow.Info), so a live update says what the list says. The drawer's owned
// ReplicaSets match on its owner_references.
func replicasetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var rs appsv1.ReplicaSet
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &rs); err != nil {
		return genericPodHolderToInfo(obj)
	}
	return rsrow.Info(&rs)
}

// jobToInfo is the list's row (jobrow.Info), so a live update says what the list says. The CronJob drawer's owned Jobs
// match on its owner_references.
func jobToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var j batchv1.Job
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &j); err != nil {
		return genericPodHolderToInfo(obj)
	}
	return jobrow.Info(&j)
}

// cronjobToInfo is the list's row (cronjobrow.Info), so a live update says what the list says.
func cronjobToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var cj batchv1.CronJob
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &cj); err != nil {
		return genericPodHolderToInfo(obj)
	}
	return cronjobrow.Info(&cj)
}
