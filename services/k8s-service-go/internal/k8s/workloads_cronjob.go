package k8s

import (
	"context"
	"fmt"
	"sync"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// ========== CronJobs ==========

// GetCronJobs lists cronjobs in a namespace.
func (s *Service) GetCronJobs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).BatchV1().CronJobs(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list cronjobs: %w", err)
	}
	return formatCronJobList(list.Items), nil
}

// GetAllCronJobs lists cronjobs across all namespaces.
func (s *Service) GetAllCronJobs(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).BatchV1().CronJobs("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all cronjobs: %w", err)
	}
	return formatCronJobList(list.Items), nil
}

// DescribeCronJob returns detailed info about a cronjob.
func (s *Service) DescribeCronJob(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var cj *batchv1.CronJob
	var events *corev1.EventList
	var cjErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		cj, cjErr = s.clientsetCtx(ctx).BatchV1().CronJobs(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=CronJob", name),
		})
	}()
	wg.Wait()

	if cjErr != nil {
		return nil, fmt.Errorf("get cronjob %s/%s: %w", namespace, name, cjErr)
	}

	result := formatCronJobDetail(cj)

	// Additional metadata
	result["uid"] = string(cj.UID)
	result["labels"] = cj.Labels
	result["annotations"] = cj.Annotations

	// CronJob-specific fields
	result["schedule"] = cj.Spec.Schedule
	result["suspend"] = cj.Spec.Suspend != nil && *cj.Spec.Suspend
	result["concurrency_policy"] = string(cj.Spec.ConcurrencyPolicy)
	if cj.Spec.StartingDeadlineSeconds != nil {
		result["starting_deadline_seconds"] = *cj.Spec.StartingDeadlineSeconds
	}
	if cj.Spec.SuccessfulJobsHistoryLimit != nil {
		result["successful_jobs_history_limit"] = *cj.Spec.SuccessfulJobsHistoryLimit
	}
	if cj.Spec.FailedJobsHistoryLimit != nil {
		result["failed_jobs_history_limit"] = *cj.Spec.FailedJobsHistoryLimit
	}
	if cj.Spec.TimeZone != nil {
		result["time_zone"] = *cj.Spec.TimeZone
	}
	result["active"] = len(cj.Status.Active)
	if cj.Status.LastScheduleTime != nil {
		result["last_schedule_time"] = toISO(cj.Status.LastScheduleTime)
	}
	if cj.Status.LastSuccessfulTime != nil {
		result["last_successful_time"] = toISO(cj.Status.LastSuccessfulTime)
	}

	// Pod template (from jobTemplate)
	result["pod_template"] = formatPodTemplate(cj.Spec.JobTemplate.Spec.Template)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	// Active jobs
	activeJobs := make([]map[string]interface{}, 0, len(cj.Status.Active))
	for _, ref := range cj.Status.Active {
		activeJobs = append(activeJobs, map[string]interface{}{
			"name":      ref.Name,
			"namespace": ref.Namespace,
		})
	}
	result["active_jobs"] = activeJobs

	// Owned jobs
	ownedJobs, ownedErr := s.GetCronJobOwnedJobs(ctx, namespace, name)
	if ownedErr == nil {
		result["owned_jobs"] = ownedJobs
	}

	return result, nil
}

// SuspendCronJob patches the suspend field of a cronjob.
func (s *Service) SuspendCronJob(ctx context.Context, namespace, name string, suspend bool) error {
	patch := fmt.Sprintf(`{"spec":{"suspend":%t}}`, suspend)
	_, err := s.clientsetCtx(ctx).BatchV1().CronJobs(namespace).Patch(ctx, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("patch cronjob %s/%s suspend: %w", namespace, name, err)
	}
	return nil
}

// TriggerCronJob creates a Job from a CronJob's jobTemplate.
func (s *Service) TriggerCronJob(ctx context.Context, namespace, name string) (string, error) {
	cj, err := s.clientsetCtx(ctx).BatchV1().CronJobs(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("get cronjob %s/%s: %w", namespace, name, err)
	}

	jobName := fmt.Sprintf("%s-manual-%d", name, time.Now().Unix())
	isController := true
	blockOwnerDeletion := true

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: namespace,
			Annotations: map[string]string{
				"cronjob.kubernetes.io/instantiate": "manual",
			},
			OwnerReferences: []metav1.OwnerReference{
				{
					APIVersion:         "batch/v1",
					Kind:               "CronJob",
					Name:               cj.Name,
					UID:                cj.UID,
					Controller:         &isController,
					BlockOwnerDeletion: &blockOwnerDeletion,
				},
			},
		},
		Spec: cj.Spec.JobTemplate.Spec,
	}

	created, err := s.clientsetCtx(ctx).BatchV1().Jobs(namespace).Create(ctx, job, metav1.CreateOptions{})
	if err != nil {
		return "", fmt.Errorf("create job from cronjob %s/%s: %w", namespace, name, err)
	}
	return created.Name, nil
}

// GetCronJobOwnedJobs lists Jobs owned by a CronJob via ownerReference.
func (s *Service) GetCronJobOwnedJobs(ctx context.Context, namespace, name string) ([]map[string]interface{}, error) {
	jobList, err := s.clientsetCtx(ctx).BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list jobs in %s: %w", namespace, err)
	}

	result := make([]map[string]interface{}, 0)
	for _, job := range jobList.Items {
		owned := false
		for _, ref := range job.OwnerReferences {
			if ref.Kind == "CronJob" && ref.Name == name {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}

		// Determine status
		status := "Active"
		if job.Status.CompletionTime != nil {
			status = "Complete"
		} else {
			for _, cond := range job.Status.Conditions {
				if cond.Type == batchv1.JobFailed && cond.Status == corev1.ConditionTrue {
					status = "Failed"
					break
				}
			}
		}

		entry := map[string]interface{}{
			"name":      job.Name,
			"namespace": job.Namespace,
			"status":    status,
		}

		if job.Status.StartTime != nil {
			entry["start_time"] = toISO(job.Status.StartTime)
		}
		if job.Status.CompletionTime != nil {
			entry["completion_time"] = toISO(job.Status.CompletionTime)
		}

		// Duration in seconds
		if job.Status.StartTime != nil {
			endTime := time.Now()
			if job.Status.CompletionTime != nil {
				endTime = job.Status.CompletionTime.Time
			}
			entry["duration"] = int64(endTime.Sub(job.Status.StartTime.Time).Seconds())
		}

		result = append(result, entry)
	}

	return result, nil
}

// DeleteCronJob deletes a cronjob.
func (s *Service) DeleteCronJob(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).BatchV1().CronJobs(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}
