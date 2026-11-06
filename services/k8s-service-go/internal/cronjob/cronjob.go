// Package cronjob is a CronJob as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package cronjob

import (
	"time"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Info is the CronJob's row. A run time and the time zone are in it only while the object has them.
func Info(cj *batchv1.CronJob) map[string]interface{} {
	suspend := false
	if cj.Spec.Suspend != nil {
		suspend = *cj.Spec.Suspend
	}

	images := make([]string, 0)
	containers := make([]string, 0)
	for _, c := range cj.Spec.JobTemplate.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
		containers = append(containers, c.Name)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	result := map[string]interface{}{
		"name":               cj.Name,
		"namespace":          cj.Namespace,
		"schedule":           cj.Spec.Schedule,
		"suspend":            suspend,
		"active":             len(cj.Status.Active),
		"image":              image,
		"images":             images,
		"containers":         containers,
		"concurrency_policy": string(cj.Spec.ConcurrencyPolicy),
		"created_at":         iso(&cj.CreationTimestamp),
	}

	// last_schedule_time / last_successful_time are the names the list and describe share (the
	// frontend reads them); last_schedule / last_successful stay for API callers.
	if cj.Status.LastScheduleTime != nil {
		result["last_schedule"] = iso(cj.Status.LastScheduleTime)
		result["last_schedule_time"] = iso(cj.Status.LastScheduleTime)
	}
	if cj.Status.LastSuccessfulTime != nil {
		result["last_successful"] = iso(cj.Status.LastSuccessfulTime)
		result["last_successful_time"] = iso(cj.Status.LastSuccessfulTime)
	}
	if cj.Spec.TimeZone != nil {
		result["time_zone"] = *cj.Spec.TimeZone
	}

	return result
}

func iso(t *metav1.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
