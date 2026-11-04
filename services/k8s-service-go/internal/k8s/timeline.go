package k8s

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/eventtime"
)

// TimelineResult holds merged events and rollout history for a timeline view.
type TimelineResult struct {
	Events         []map[string]interface{} `json:"events"`
	RolloutHistory []map[string]interface{} `json:"rollout_history"`
	Summary        map[string]interface{}   `json:"summary"`
}

// GetNamespaceTimeline returns events and rollout history for a namespace within the given time window; eventType
// (Normal, Warning, or empty for both) chooses the events listed, the counts are of every event.
func (s *Service) GetNamespaceTimeline(ctx context.Context, namespace string, hours int, limit int, eventType string) (*TimelineResult, error) {
	cutoff := time.Now().Add(-time.Duration(hours) * time.Hour)

	var wg sync.WaitGroup
	var events []map[string]interface{}
	var counts eventCounts
	var rollouts []map[string]interface{}
	var eventsErr, rolloutsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		events, counts, eventsErr = s.getTimelineEvents(ctx, namespace, "", "", cutoff, limit, eventType)
	}()
	go func() {
		defer wg.Done()
		rollouts, rolloutsErr = s.getNamespaceRolloutHistory(ctx, namespace, cutoff)
	}()
	wg.Wait()

	if eventsErr != nil {
		return nil, eventsErr
	}
	return buildTimelineResult(events, counts, rollouts, rolloutsErr, cutoff, eventType), nil
}

// GetResourceTimeline returns events and rollout history for a specific resource.
func (s *Service) GetResourceTimeline(ctx context.Context, namespace, kind, name string, hours int, limit int, eventType string) (*TimelineResult, error) {
	cutoff := time.Now().Add(-time.Duration(hours) * time.Hour)

	var wg sync.WaitGroup
	var events []map[string]interface{}
	var counts eventCounts
	var rollouts []map[string]interface{}
	var eventsErr, rolloutsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		events, counts, eventsErr = s.getTimelineEvents(ctx, namespace, kind, name, cutoff, limit, eventType)
	}()
	go func() {
		defer wg.Done()
		switch kind {
		case "Deployment", "StatefulSet", "DaemonSet":
			rollouts, rolloutsErr = s.getResourceRolloutHistory(ctx, namespace, kind, name, cutoff)
		default:
			rollouts = []map[string]interface{}{}
		}
	}()
	wg.Wait()

	if eventsErr != nil {
		return nil, eventsErr
	}
	return buildTimelineResult(events, counts, rollouts, rolloutsErr, cutoff, eventType), nil
}

// getResourceRolloutHistory returns rollout history for a specific workload resource.
func (s *Service) getResourceRolloutHistory(ctx context.Context, namespace, kind, name string, cutoff time.Time) ([]map[string]interface{}, error) {
	if kind == "Deployment" {
		return s.getDeploymentRolloutTimeline(ctx, namespace, name, cutoff)
	}
	// StatefulSet/DaemonSet use ControllerRevisions
	return s.getControllerRevisionTimeline(ctx, namespace, kind, name, cutoff)
}

// buildTimelineResult constructs the final timeline response with summary: the counts are of every event in the
// window, the list holds the newest limit of the type asked (events_shown of events_matching). Rollouts that could
// not be read are none, with the reason (rollouts_error) rather than a silent zero.
func buildTimelineResult(events []map[string]interface{}, counts eventCounts, rollouts []map[string]interface{}, rolloutsErr error, cutoff time.Time, eventType string) *TimelineResult {
	matching := counts.Total
	switch eventType {
	case corev1.EventTypeWarning:
		matching = counts.Warning
	case corev1.EventTypeNormal:
		matching = counts.Total - counts.Warning
	}
	summary := map[string]interface{}{
		"total_events":    counts.Total,
		"events_shown":    len(events),
		"events_matching": matching,
		"normal_count":    counts.Total - counts.Warning,
		"warning_count":   counts.Warning,
		"time_range": map[string]interface{}{
			"start": cutoff.UTC().Format(time.RFC3339),
			"end":   time.Now().UTC().Format(time.RFC3339),
		},
	}
	if rolloutsErr != nil {
		rollouts = []map[string]interface{}{}
		summary["rollouts_error"] = rolloutsErr.Error()
	}
	return &TimelineResult{Events: events, RolloutHistory: rollouts, Summary: summary}
}

// eventTimestamp is when an event was last seen, as kubectl prints it (eventtime.Last).
func eventTimestamp(e corev1.Event) time.Time {
	return eventtime.Last(&e)
}

// extractContainerImages returns image names from containers.
func extractContainerImages(containers []corev1.Container) []string {
	images := make([]string, 0, len(containers))
	for _, c := range containers {
		images = append(images, c.Image)
	}
	return images
}

// getTimelineEvents fetches K8s events with optional resource filter and time cutoff: read a page at a time, the newest
// limit kept, every event in the window counted.
func (s *Service) getTimelineEvents(ctx context.Context, namespace, kind, name string, cutoff time.Time, limit int, eventType string) ([]map[string]interface{}, eventCounts, error) {
	opts := metav1.ListOptions{}
	if name != "" && kind != "" {
		opts.FieldSelector = fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=%s", name, kind)
	} else if name != "" {
		opts.FieldSelector = fmt.Sprintf("involvedObject.name=%s", name)
	}

	filtered, counts, err := s.newestEventsSince(ctx, namespace, opts, cutoff, limit, eventType)
	if err != nil {
		return nil, eventCounts{}, fmt.Errorf("list timeline events: %w", err)
	}

	result := make([]map[string]interface{}, 0, len(filtered))
	for i := range filtered {
		result = append(result, timelineEventRow(&filtered[i]))
	}
	return result, counts, nil
}

// timelineEventRow is an event as the Timeline lists it; the object it names carries its apiVersion, so the page
// opens a custom resource of the right group (two groups may serve one Kind).
func timelineEventRow(e *corev1.Event) map[string]interface{} {
	first, last, count := eventtime.Seen(e)
	object := func() map[string]interface{} {
		return map[string]interface{}{
			"kind":        e.InvolvedObject.Kind,
			"name":        e.InvolvedObject.Name,
			"namespace":   e.InvolvedObject.Namespace,
			"api_version": e.InvolvedObject.APIVersion,
		}
	}
	return map[string]interface{}{
		"timestamp":       eventTimestamp(*e).UTC().Format(time.RFC3339),
		"type":            e.Type,
		"reason":          e.Reason,
		"message":         e.Message,
		"source":          e.Source.Component,
		"resource":        object(),
		"involved_object": object(),
		"count":           count,
		"first_seen":      eventtime.ISO(first),
		"last_seen":       eventtime.ISO(last),
	}
}

// getNamespaceRolloutHistory collects the rollouts of a namespace (all when empty): each Deployment's ReplicaSets
// and each StatefulSet's and DaemonSet's ControllerRevisions created in the window.
func (s *Service) getNamespaceRolloutHistory(ctx context.Context, namespace string, cutoff time.Time) ([]map[string]interface{}, error) {
	var wg sync.WaitGroup
	var deploys *appsv1.DeploymentList
	var rsList *appsv1.ReplicaSetList
	var crList *appsv1.ControllerRevisionList
	var deploysErr, rsErr, crErr error

	wg.Add(3)
	go func() {
		defer wg.Done()
		deploys, deploysErr = s.clientsetCtx(ctx).AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		rsList, rsErr = s.clientsetCtx(ctx).AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		crList, crErr = s.clientsetCtx(ctx).AppsV1().ControllerRevisions(namespace).List(ctx, metav1.ListOptions{})
	}()
	wg.Wait()

	if deploysErr != nil {
		return nil, fmt.Errorf("list deployments for timeline: %w", deploysErr)
	}
	if rsErr != nil {
		return nil, fmt.Errorf("list replicasets for timeline: %w", rsErr)
	}
	if crErr != nil {
		return nil, fmt.Errorf("list controller revisions for timeline: %w", crErr)
	}

	result := append(rolloutHistoryFromLists(deploys, rsList, cutoff), controllerRevisionRollouts(crList, cutoff)...)
	sortRolloutsNewestFirst(result)
	return result, nil
}

// controllerRevisionRollouts is each StatefulSet's and DaemonSet's ControllerRevision created after cutoff, by its
// controlling owner.
func controllerRevisionRollouts(crList *appsv1.ControllerRevisionList, cutoff time.Time) []map[string]interface{} {
	result := make([]map[string]interface{}, 0)
	for i := range crList.Items {
		cr := &crList.Items[i]
		if cr.CreationTimestamp.Time.Before(cutoff) {
			continue
		}
		owner := metav1.GetControllerOf(cr)
		if owner == nil || (owner.Kind != "StatefulSet" && owner.Kind != "DaemonSet") {
			continue
		}
		result = append(result, map[string]interface{}{
			"kind":         owner.Kind,
			"name":         owner.Name,
			"namespace":    cr.Namespace,
			"revision":     cr.Revision,
			"change_cause": nil,
			"created_at":   toISO(&cr.CreationTimestamp),
			"images":       extractImagesFromControllerRevision(cr),
			"replicas":     0,
		})
	}
	return result
}

// sortRolloutsNewestFirst orders rollout entries by created_at, the newest first.
func sortRolloutsNewestFirst(result []map[string]interface{}) {
	sort.SliceStable(result, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, result[i]["created_at"].(string))
		tj, _ := time.Parse(time.RFC3339, result[j]["created_at"].(string))
		return ti.After(tj)
	})
}

// rolloutHistoryFromLists pairs each ReplicaSet created after cutoff with its
// owning Deployment. Deployments are keyed by namespace/name: with
// metav1.NamespaceAll both lists span the cluster, and a ReplicaSet may only
// be owned by a Deployment in its own namespace.
func rolloutHistoryFromLists(deploys *appsv1.DeploymentList, rsList *appsv1.ReplicaSetList, cutoff time.Time) []map[string]interface{} {
	deployKeys := make(map[string]bool, len(deploys.Items))
	for _, d := range deploys.Items {
		deployKeys[d.Namespace+"/"+d.Name] = true
	}

	result := make([]map[string]interface{}, 0)
	for _, rs := range rsList.Items {
		if rs.CreationTimestamp.Time.Before(cutoff) {
			continue
		}

		// Find owning deployment
		ownerName := ""
		for _, ref := range rs.OwnerReferences {
			if ref.Kind == "Deployment" && deployKeys[rs.Namespace+"/"+ref.Name] {
				ownerName = ref.Name
				break
			}
		}
		if ownerName == "" {
			continue
		}

		revStr, ok := rs.Annotations["deployment.kubernetes.io/revision"]
		if !ok {
			continue
		}
		rev, err := strconv.ParseInt(revStr, 10, 64)
		if err != nil {
			continue
		}

		images := extractContainerImages(rs.Spec.Template.Spec.Containers)
		changeCause := rs.Annotations["kubernetes.io/change-cause"]

		replicas := int32(0)
		if rs.Spec.Replicas != nil {
			replicas = *rs.Spec.Replicas
		}

		result = append(result, map[string]interface{}{
			"kind":         "Deployment",
			"name":         ownerName,
			"namespace":    rs.Namespace,
			"revision":     rev,
			"change_cause": nilIfEmpty(changeCause),
			"created_at":   toISO(&rs.CreationTimestamp),
			"images":       images,
			"replicas":     replicas,
		})
	}

	sort.Slice(result, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, result[i]["created_at"].(string))
		tj, _ := time.Parse(time.RFC3339, result[j]["created_at"].(string))
		return ti.After(tj)
	})

	return result
}

func (s *Service) getDeploymentRolloutTimeline(ctx context.Context, namespace, name string, cutoff time.Time) ([]map[string]interface{}, error) {
	rsList, err := s.clientsetCtx(ctx).AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list replicasets for timeline: %w", err)
	}

	result := make([]map[string]interface{}, 0)
	for _, rs := range rsList.Items {
		if rs.CreationTimestamp.Time.Before(cutoff) {
			continue
		}

		owned := false
		for _, ref := range rs.OwnerReferences {
			if ref.Kind == "Deployment" && ref.Name == name {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}

		revStr, ok := rs.Annotations["deployment.kubernetes.io/revision"]
		if !ok {
			continue
		}
		rev, err := strconv.ParseInt(revStr, 10, 64)
		if err != nil {
			continue
		}

		images := extractContainerImages(rs.Spec.Template.Spec.Containers)
		changeCause := rs.Annotations["kubernetes.io/change-cause"]

		replicas := int32(0)
		if rs.Spec.Replicas != nil {
			replicas = *rs.Spec.Replicas
		}

		result = append(result, map[string]interface{}{
			"kind":         "Deployment",
			"name":         name,
			"namespace":    namespace,
			"revision":     rev,
			"change_cause": nilIfEmpty(changeCause),
			"created_at":   toISO(&rs.CreationTimestamp),
			"images":       images,
			"replicas":     replicas,
		})
	}

	sort.Slice(result, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, result[i]["created_at"].(string))
		tj, _ := time.Parse(time.RFC3339, result[j]["created_at"].(string))
		return ti.After(tj)
	})

	return result, nil
}

func (s *Service) getControllerRevisionTimeline(ctx context.Context, namespace, kind, name string, cutoff time.Time) ([]map[string]interface{}, error) {
	crList, err := s.clientsetCtx(ctx).AppsV1().ControllerRevisions(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list controller revisions for timeline: %w", err)
	}

	result := make([]map[string]interface{}, 0)
	for _, cr := range crList.Items {
		if cr.CreationTimestamp.Time.Before(cutoff) {
			continue
		}

		owned := false
		for _, ref := range cr.OwnerReferences {
			if ref.Kind == kind && ref.Name == name {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}

		images := extractImagesFromControllerRevision(&cr)

		result = append(result, map[string]interface{}{
			"kind":         kind,
			"name":         name,
			"namespace":    namespace,
			"revision":     cr.Revision,
			"change_cause": nil,
			"created_at":   toISO(&cr.CreationTimestamp),
			"images":       images,
			"replicas":     0,
		})
	}

	sort.Slice(result, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, result[i]["created_at"].(string))
		tj, _ := time.Parse(time.RFC3339, result[j]["created_at"].(string))
		return ti.After(tj)
	})

	return result, nil
}

// nilIfEmpty returns nil if string is empty, otherwise the string.
func nilIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
