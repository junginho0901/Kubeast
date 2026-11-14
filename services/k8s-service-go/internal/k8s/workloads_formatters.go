package k8s

import (
	"context"
	"errors"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"

	cronjobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/cronjob"
	dsrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/daemonset"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/eventtime"
	jobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/job"
	rsrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/replicaset"
	"github.com/junginho0901/kubeast/services/pkg/response"
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

// withObservedGeneration says which generation a condition was written for, where its writer says: a status that lags
// its spec reads true for an older one.
func withObservedGeneration(condition map[string]interface{}, generation int64) map[string]interface{} {
	if generation != 0 {
		condition["observed_generation"] = generation
	}
	return condition
}

// eventUIDs are the UIDs an object's events name it by in involvedObject.uid.
type eventUIDs []types.UID

// about is the UIDs an object's events name it by: its own; a Node also its name, which the kubelet writes, and a mirror
// pod the UID of its static pod (kubectl describe's searchEvents and its Node and Pod describers).
func about(uids ...types.UID) eventUIDs { return uids }

// keep is the events of items that name one of the UIDs, as kubectl describe's field selector involvedObject.uid keeps
// them: an event of an earlier object of the same name, or one that names no UID, is not about this one. With no UID
// known the list stays as read, as kubectl leaves the selector out.
func (uids eventUIDs) keep(items []corev1.Event) []corev1.Event {
	want := make(map[types.UID]bool, len(uids))
	for _, uid := range uids {
		if uid != "" {
			want[uid] = true
		}
	}
	if len(want) == 0 {
		return items
	}
	kept := make([]corev1.Event, 0, len(items))
	for i := range items {
		if want[items[i].InvolvedObject.UID] {
			kept = append(kept, items[i])
		}
	}
	return kept
}

// setEvents puts the events about an object (those naming uids) on its describe answer, newest first, or, when they
// could not be listed, the reason as events_error and no events: the drawer then says so instead of showing "None" for
// events it never read.
func setEvents(result map[string]interface{}, events *corev1.EventList, err error, uids eventUIDs) {
	if err == nil && events == nil {
		err = errors.New("events not read")
	}
	if err != nil {
		reason := response.Public(err)
		if reason == "" {
			// an API error whose Status carries no message
			reason = "events could not be listed: " + string(apierrors.ReasonForError(err))
		}
		delete(result, "events")
		result["events_error"] = reason
		return
	}
	items := uids.keep(events.Items)
	sortEventsByTime(items)
	result["events"] = formatEventList(items)
}

// setObjectEvents reads the events about an object (objectEvents) onto its describe answer.
func (s *Service) setObjectEvents(ctx context.Context, result map[string]interface{}, namespace, kind, name string, uids eventUIDs) {
	events, err := s.objectEvents(ctx, namespace, kind, name)
	setEvents(result, events, err, uids)
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
