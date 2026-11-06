package k8s

import (
	"errors"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	cronjobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/cronjob"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/eventtime"
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
	for _, ds := range items {
		result = append(result, formatDaemonSetDetail(&ds))
	}
	return result
}

func formatDaemonSetDetail(ds *appsv1.DaemonSet) map[string]interface{} {
	images := make([]string, 0)
	for _, c := range ds.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	var selector interface{}
	if ds.Spec.Selector != nil && ds.Spec.Selector.MatchLabels != nil {
		selector = ds.Spec.Selector.MatchLabels
	} else {
		selector = map[string]string{}
	}

	dsStatus := replicaStatus(ds.Status.DesiredNumberScheduled, ds.Status.NumberAvailable, ds.Status.NumberReady)

	return map[string]interface{}{
		"name":          ds.Name,
		"namespace":     ds.Namespace,
		"desired":       ds.Status.DesiredNumberScheduled,
		"current":       ds.Status.CurrentNumberScheduled,
		"ready":         ds.Status.NumberReady,
		"updated":       ds.Status.UpdatedNumberScheduled,
		"available":     ds.Status.NumberAvailable,
		"misscheduled":  ds.Status.NumberMisscheduled,
		"unavailable":   ds.Status.NumberUnavailable,
		"node_selector": ds.Spec.Template.Spec.NodeSelector,
		"image":         image,
		"images":        images,
		"selector":      selector,
		"status":        dsStatus,
		"created_at":    toISO(&ds.CreationTimestamp),
	}
}

func formatReplicaSetList(items []appsv1.ReplicaSet) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, rs := range items {
		result = append(result, formatReplicaSetDetail(&rs))
	}
	return result
}

func formatReplicaSetDetail(rs *appsv1.ReplicaSet) map[string]interface{} {
	replicas := int32(0)
	if rs.Spec.Replicas != nil {
		replicas = *rs.Spec.Replicas
	}

	images := make([]string, 0)
	containers := make([]string, 0)
	for _, c := range rs.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
		containers = append(containers, c.Name)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	var selector interface{}
	if rs.Spec.Selector != nil && rs.Spec.Selector.MatchLabels != nil {
		selector = rs.Spec.Selector.MatchLabels
	} else {
		selector = map[string]string{}
	}

	owner := ""
	for _, or := range rs.OwnerReferences {
		if or.Kind == "Deployment" {
			owner = or.Name
			break
		}
	}

	rsStatus := replicaStatus(replicas, rs.Status.AvailableReplicas, rs.Status.ReadyReplicas)

	ownerRefs := make([]map[string]interface{}, 0, len(rs.OwnerReferences))
	for _, or := range rs.OwnerReferences {
		ownerRefs = append(ownerRefs, map[string]interface{}{
			"kind":       or.Kind,
			"name":       or.Name,
			"uid":        string(or.UID),
			"controller": or.Controller != nil && *or.Controller,
		})
	}

	return map[string]interface{}{
		"name":               rs.Name,
		"namespace":          rs.Namespace,
		"replicas":           replicas,
		"current_replicas":   rs.Status.Replicas,
		"ready_replicas":     rs.Status.ReadyReplicas,
		"available_replicas": rs.Status.AvailableReplicas,
		"image":              image,
		"images":             images,
		"containers":         containers,
		"selector":           selector,
		"owner_deployment":   owner,
		"owner_references":   ownerRefs,
		"status":             rsStatus,
		"created_at":         toISO(&rs.CreationTimestamp),
	}
}

func formatJobList(items []batchv1.Job) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, job := range items {
		result = append(result, formatJobDetail(&job))
	}
	return result
}

func formatJobDetail(job *batchv1.Job) map[string]interface{} {
	completions := int32(1)
	if job.Spec.Completions != nil {
		completions = *job.Spec.Completions
	}

	parallelism := int32(1)
	if job.Spec.Parallelism != nil {
		parallelism = *job.Spec.Parallelism
	}

	images := make([]string, 0)
	containers := make([]string, 0)
	for _, c := range job.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
		containers = append(containers, c.Name)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	status := jobStatus(job)

	ownerRefs := make([]map[string]interface{}, 0, len(job.OwnerReferences))
	for _, ref := range job.OwnerReferences {
		ownerRefs = append(ownerRefs, map[string]interface{}{
			"kind":       ref.Kind,
			"name":       ref.Name,
			"uid":        string(ref.UID),
			"controller": ref.Controller != nil && *ref.Controller,
		})
	}

	result := map[string]interface{}{
		"name":             job.Name,
		"namespace":        job.Namespace,
		"completions":      completions,
		"parallelism":      parallelism,
		"succeeded":        job.Status.Succeeded,
		"failed":           job.Status.Failed,
		"active":           job.Status.Active,
		"status":           status,
		"image":            image,
		"images":           images,
		"containers":       containers,
		"owner_references": ownerRefs,
		"created_at":       toISO(&job.CreationTimestamp),
	}

	if job.Status.StartTime != nil {
		result["start_time"] = toISO(job.Status.StartTime)
	}
	if job.Status.CompletionTime != nil {
		result["completion_time"] = toISO(job.Status.CompletionTime)
	}
	if job.Status.StartTime != nil && job.Status.CompletionTime != nil {
		result["duration"] = job.Status.CompletionTime.Time.Sub(job.Status.StartTime.Time).String()
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
