package k8s

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/eventtime"
)

// timelinePageSize: ControllerRevisions carry whole pod templates and a ReplicaSet its own, so one list of a busy
// cluster holds far more than the few rows a window keeps.
const timelinePageSize = 500

// eachRolloutPage lists a kind timelinePageSize at a time, giving each page to keep, as a big read past the first.
func eachRolloutPage[L metav1.ListInterface](ctx context.Context, list func(metav1.ListOptions) (L, error), keep func(L)) error {
	return eachPage(ctx, metav1.ListOptions{Limit: timelinePageSize}, list, keep)
}

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

	filtered, counts, from, err := s.newestEventsRead(ctx, namespace, opts, cutoff, limit, eventType)
	if err != nil {
		return nil, eventCounts{}, fmt.Errorf("list timeline events: %w", err)
	}
	if from != nil {
		// the read's own rows, for the answer to write; cut to their length so an append copies
		n := len(filtered)
		return from.timelineRows()[:n:n], counts, nil
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

// getNamespaceRolloutHistory collects the rollouts of a namespace (all when empty, each of a limited grant's namespaces
// in turn): each Deployment's ReplicaSets and each StatefulSet's and DaemonSet's ControllerRevisions created in the window,
// each kind from one read for everyone whose identity may list it there (rolloutWindow), else as the caller.
func (s *Service) getNamespaceRolloutHistory(ctx context.Context, namespace string, cutoff time.Time) ([]map[string]interface{}, error) {
	if scope := scopeFromCtx(ctx); namespace == "" && len(scope) > 0 {
		result, err := fanOutNamespaces(scope, func(ns string) ([]map[string]interface{}, error) {
			return s.rolloutHistoryIn(ctx, ns, cutoff)
		})
		if err != nil {
			return nil, err
		}
		sortRolloutsNewestFirst(result)
		return result, nil
	}
	return s.rolloutHistoryIn(ctx, namespace, cutoff)
}

func (s *Service) rolloutHistoryIn(ctx context.Context, namespace string, cutoff time.Time) ([]map[string]interface{}, error) {
	var wg sync.WaitGroup
	var deployments map[string]bool
	var sets []rolloutRS
	var revisions []rolloutCR
	var deploysErr, rsErr, crErr error

	wg.Add(3)
	go func() {
		defer wg.Done()
		deployments, deploysErr = s.rolloutDeployments(ctx, namespace)
	}()
	go func() {
		defer wg.Done()
		sets, rsErr = s.rolloutReplicaSets(ctx, namespace, cutoff)
	}()
	go func() {
		defer wg.Done()
		revisions, crErr = s.rolloutRevisions(ctx, namespace, cutoff)
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

	result := append(deploymentRolloutRows(deployments, sets), revisionRolloutRows(revisions)...)
	sortRolloutsNewestFirst(result)
	return result, nil
}

// sortRolloutsNewestFirst orders rollout entries by created_at, the newest first.
func sortRolloutsNewestFirst(result []map[string]interface{}) {
	sort.SliceStable(result, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, result[i]["created_at"].(string))
		tj, _ := time.Parse(time.RFC3339, result[j]["created_at"].(string))
		return ti.After(tj)
	})
}

// sortRolloutRowsByTime orders one kind's rows by created_at, the newest first, as they were before the kinds join.
func sortRolloutRowsByTime(result []map[string]interface{}) {
	sort.Slice(result, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, result[i]["created_at"].(string))
		tj, _ := time.Parse(time.RFC3339, result[j]["created_at"].(string))
		return ti.After(tj)
	})
}

// getDeploymentRolloutTimeline is the rollouts of the Deployment name: its ReplicaSets created in the window.
func (s *Service) getDeploymentRolloutTimeline(ctx context.Context, namespace, name string, cutoff time.Time) ([]map[string]interface{}, error) {
	sets, err := s.rolloutReplicaSets(ctx, namespace, cutoff)
	if err != nil {
		return nil, fmt.Errorf("list replicasets for timeline: %w", err)
	}
	result := make([]map[string]interface{}, 0)
	for i := range sets {
		if slices.Contains(sets[i].deployments, name) {
			result = append(result, sets[i].row(name, namespace))
		}
	}
	sortRolloutRowsByTime(result)
	return result, nil
}

// getControllerRevisionTimeline is the rollouts of the StatefulSet or DaemonSet name: its ControllerRevisions created
// in the window.
func (s *Service) getControllerRevisionTimeline(ctx context.Context, namespace, kind, name string, cutoff time.Time) ([]map[string]interface{}, error) {
	revisions, err := s.rolloutRevisions(ctx, namespace, cutoff)
	if err != nil {
		return nil, fmt.Errorf("list controller revisions for timeline: %w", err)
	}
	result := make([]map[string]interface{}, 0)
	for i := range revisions {
		if slices.Contains(revisions[i].owners, ownerKey{kind, name}) {
			result = append(result, revisions[i].row(kind, name, namespace))
		}
	}
	sortRolloutRowsByTime(result)
	return result, nil
}

// nilIfEmpty returns nil if string is empty, otherwise the string.
func nilIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
