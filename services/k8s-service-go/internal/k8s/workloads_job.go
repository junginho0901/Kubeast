package k8s

import (
	"context"
	"fmt"
	"sync"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	jobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/job"
)

// ========== Jobs ==========

// GetJobs lists jobs in a namespace.
func (s *Service) GetJobs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	return formatJobList(list.Items), nil
}

// GetAllJobs lists jobs across all namespaces.
func (s *Service) GetAllJobs(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.clientsetCtx(ctx).BatchV1().Jobs(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all jobs: %w", err)
		}
		return formatJobList(list.Items), nil
	})
}

// DescribeJob returns detailed info about a job.
func (s *Service) DescribeJob(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var job *batchv1.Job
	var events *corev1.EventList
	var jobErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		job, jobErr = s.clientsetCtx(ctx).BatchV1().Jobs(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.objectEvents(ctx, namespace, "Job", name)
	}()
	wg.Wait()

	if jobErr != nil {
		return nil, fmt.Errorf("get job %s/%s: %w", namespace, name, jobErr)
	}

	result := jobrow.Info(job)

	// Additional metadata
	result["uid"] = string(job.UID)
	result["labels"] = job.Labels
	result["annotations"] = job.Annotations

	// Job-specific fields the frontend expects. The spec's completions, unset for a work queue as kubectl describe says:
	// the row fills in 1 for the list.
	result["completions"] = job.Spec.Completions
	if job.Spec.Parallelism != nil {
		result["parallelism"] = *job.Spec.Parallelism
	}
	result["active"] = job.Status.Active
	result["succeeded"] = job.Status.Succeeded
	result["failed"] = job.Status.Failed
	if job.Spec.BackoffLimit != nil {
		result["backoff_limit"] = *job.Spec.BackoffLimit
	}
	if job.Spec.ActiveDeadlineSeconds != nil {
		result["active_deadline_seconds"] = *job.Spec.ActiveDeadlineSeconds
	}
	if job.Spec.TTLSecondsAfterFinished != nil {
		result["ttl_seconds_after_finished"] = *job.Spec.TTLSecondsAfterFinished
	}
	if job.Spec.CompletionMode != nil {
		result["completion_mode"] = string(*job.Spec.CompletionMode)
	}
	if job.Spec.Suspend != nil {
		result["suspend"] = *job.Spec.Suspend
	}
	if job.Spec.ManualSelector != nil {
		result["manual_selector"] = *job.Spec.ManualSelector
	}
	// The selector the Job's pods are listed by, as the other workloads' answers give it.
	selector := map[string]string{}
	if job.Spec.Selector != nil && job.Spec.Selector.MatchLabels != nil {
		selector = job.Spec.Selector.MatchLabels
	}
	result["selector"] = selector
	setSelectorExpressions(result, job.Spec.Selector)
	if job.Status.StartTime != nil {
		result["start_time"] = toISO(job.Status.StartTime)
	}
	if job.Status.CompletionTime != nil {
		result["completion_time"] = toISO(job.Status.CompletionTime)
		if job.Status.StartTime != nil {
			result["duration_seconds"] = int64(job.Status.CompletionTime.Sub(job.Status.StartTime.Time).Seconds())
		}
	}

	// Pod template
	result["pod_template"] = formatPodTemplate(job.Spec.Template)

	// Events
	setEvents(result, events, eventsErr)

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(job.Status.Conditions))
	for _, c := range job.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                 string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	return result, nil
}

// DeleteJob deletes a job.
func (s *Service) DeleteJob(ctx context.Context, namespace, name string) error {
	propagation := metav1.DeletePropagationBackground
	return s.clientsetCtx(ctx).BatchV1().Jobs(namespace).Delete(ctx, name, metav1.DeleteOptions{
		PropagationPolicy: &propagation,
	})
}
