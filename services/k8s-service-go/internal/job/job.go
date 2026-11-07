// Package job is a Job as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package job

import (
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Status is a Job's summary status by its conditions: Complete, Failed or Running.
func Status(j *batchv1.Job) string {
	for _, c := range j.Status.Conditions {
		if c.Type == batchv1.JobComplete && c.Status == corev1.ConditionTrue {
			return "Complete"
		}
		if c.Type == batchv1.JobFailed && c.Status == corev1.ConditionTrue {
			return "Failed"
		}
	}
	return "Running"
}

// Info is the Job's row: its counts, status, containers, owners and run times.
func Info(j *batchv1.Job) map[string]interface{} {
	completions := int32(1)
	if j.Spec.Completions != nil {
		completions = *j.Spec.Completions
	}

	parallelism := int32(1)
	if j.Spec.Parallelism != nil {
		parallelism = *j.Spec.Parallelism
	}

	images := make([]string, 0, len(j.Spec.Template.Spec.Containers))
	containers := make([]string, 0, len(j.Spec.Template.Spec.Containers))
	for _, c := range j.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
		containers = append(containers, c.Name)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	ownerRefs := make([]map[string]interface{}, 0, len(j.OwnerReferences))
	for _, ref := range j.OwnerReferences {
		ownerRefs = append(ownerRefs, map[string]interface{}{
			"kind":       ref.Kind,
			"name":       ref.Name,
			"uid":        string(ref.UID),
			"controller": ref.Controller != nil && *ref.Controller,
		})
	}

	result := map[string]interface{}{
		"name":             j.Name,
		"namespace":        j.Namespace,
		"completions":      completions,
		"parallelism":      parallelism,
		"succeeded":        j.Status.Succeeded,
		"failed":           j.Status.Failed,
		"active":           j.Status.Active,
		"status":           Status(j),
		"image":            image,
		"images":           images,
		"containers":       containers,
		"owner_references": ownerRefs,
		"created_at":       iso(j.CreationTimestamp),
	}

	if j.Status.StartTime != nil {
		result["start_time"] = iso(*j.Status.StartTime)
	}
	if j.Status.CompletionTime != nil {
		result["completion_time"] = iso(*j.Status.CompletionTime)
	}
	if j.Status.StartTime != nil && j.Status.CompletionTime != nil {
		result["duration"] = j.Status.CompletionTime.Sub(j.Status.StartTime.Time).String()
	}

	return result
}

func iso(t metav1.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
