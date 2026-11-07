package k8s

import (
	"errors"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	cronjobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/cronjob"
	dsrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/daemonset"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/eventtime"
	jobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/job"
	rsrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/replicaset"
)

// Formatting helpers — turn typed K8s objects into the
// map[string]interface{} shapes the frontend expects. Split out of
// workloads.go so the data conversion lives in one place.

func formatEventList(events []corev1.Event) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(events))
	for i := range events {
		result = append(result, formatDrawerEvent(&events[i]))
	}
	return result
}

// setEvents puts an object's events on its describe answer, newest first, or, when they could not be listed, the
// reason as events_error and no events: the drawer then says so instead of showing "None" for events it never read.
func setEvents(result map[string]interface{}, events *corev1.EventList, err error) {
	if err == nil && events == nil {
		err = errors.New("events not read")
	}
	if err != nil {
		reason := err.Error()
		if reason == "" {
			// an API error whose Status carries no message
			reason = "events could not be listed: " + string(apierrors.ReasonForError(err))
		}
		delete(result, "events")
		result["events_error"] = reason
		return
	}
	sortEventsByTime(events.Items)
	result["events"] = formatEventList(events.Items)
}

// formatDrawerEvent is an event as a drawer lists it: its times and count as kubectl prints them (eventtime.Seen),
// under the names the events API gives them.
func formatDrawerEvent(e *corev1.Event) map[string]interface{} {
	first, last, count := eventtime.Seen(e)
	return map[string]interface{}{
		"type":            e.Type,
		"reason":          e.Reason,
		"message":         e.Message,
		"count":           count,
		"first_timestamp": eventtime.ISO(first),
		"last_timestamp":  eventtime.ISO(last),
		"source":          e.Source.Component,
	}
}

func formatStatefulSetList(items []appsv1.StatefulSet) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, sts := range items {
		result = append(result, formatStatefulSetDetail(&sts))
	}
	return result
}

func formatStatefulSetDetail(sts *appsv1.StatefulSet) map[string]interface{} {
	replicas := int32(0)
	if sts.Spec.Replicas != nil {
		replicas = *sts.Spec.Replicas
	}

	images := make([]string, 0)
	for _, c := range sts.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	var selector interface{}
	if sts.Spec.Selector != nil && sts.Spec.Selector.MatchLabels != nil {
		selector = sts.Spec.Selector.MatchLabels
	} else {
		selector = map[string]string{}
	}

	stsStatus := replicaStatus(replicas, sts.Status.AvailableReplicas, sts.Status.ReadyReplicas)

	return map[string]interface{}{
		"name":               sts.Name,
		"namespace":          sts.Namespace,
		"replicas":           replicas,
		"ready_replicas":     sts.Status.ReadyReplicas,
		"current_replicas":   sts.Status.CurrentReplicas,
		"updated_replicas":   sts.Status.UpdatedReplicas,
		"available_replicas": sts.Status.AvailableReplicas,
		"image":              image,
		"images":             images,
		"selector":           selector,
		"service_name":       sts.Spec.ServiceName,
		"status":             stsStatus,
		"created_at":         toISO(&sts.CreationTimestamp),
	}
}

func formatDaemonSetList(items []appsv1.DaemonSet) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, dsrow.Info(&items[i]))
	}
	return result
}

func formatReplicaSetList(items []appsv1.ReplicaSet) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, rsrow.Info(&items[i]))
	}
	return result
}

func formatJobList(items []batchv1.Job) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, jobrow.Info(&items[i]))
	}
	return result
}

func formatCronJobList(items []batchv1.CronJob) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, cronjobrow.Info(&items[i]))
	}
	return result
}
