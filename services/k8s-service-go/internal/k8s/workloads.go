package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// ========== StatefulSets ==========

// GetStatefulSets lists statefulsets in a namespace.
func (s *Service) GetStatefulSets(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientset.AppsV1().StatefulSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list statefulsets: %w", err)
	}
	return formatStatefulSetList(list.Items), nil
}

// GetAllStatefulSets lists statefulsets across all namespaces.
func (s *Service) GetAllStatefulSets(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.AppsV1().StatefulSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all statefulsets: %w", err)
	}
	return formatStatefulSetList(list.Items), nil
}

// DescribeStatefulSet returns detailed info about a statefulset.
func (s *Service) DescribeStatefulSet(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var sts *appsv1.StatefulSet
	var events *corev1.EventList
	var stsErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		sts, stsErr = s.clientset.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=StatefulSet", name),
		})
	}()
	wg.Wait()

	if stsErr != nil {
		return nil, fmt.Errorf("get statefulset %s/%s: %w", namespace, name, stsErr)
	}

	result := formatStatefulSetDetail(sts)

	// Additional metadata
	result["uid"] = string(sts.UID)
	result["resource_version"] = sts.ResourceVersion
	result["generation"] = sts.Generation
	result["labels"] = sts.Labels
	result["annotations"] = sts.Annotations
	if sts.Status.ObservedGeneration > 0 {
		result["observed_generation"] = sts.Status.ObservedGeneration
	}

	// StatefulSet-specific settings
	result["service_name"] = sts.Spec.ServiceName
	result["pod_management_policy"] = string(sts.Spec.PodManagementPolicy)
	if sts.Spec.MinReadySeconds > 0 {
		result["min_ready_seconds"] = sts.Spec.MinReadySeconds
	}
	if sts.Spec.RevisionHistoryLimit != nil {
		result["revision_history_limit"] = *sts.Spec.RevisionHistoryLimit
	}
	if sts.Status.CurrentRevision != "" {
		result["current_revision"] = sts.Status.CurrentRevision
	}
	if sts.Status.UpdateRevision != "" {
		result["update_revision"] = sts.Status.UpdateRevision
	}
	if sts.Status.CollisionCount != nil {
		result["collision_count"] = *sts.Status.CollisionCount
	}

	// Replicas status
	replicas := int32(0)
	if sts.Spec.Replicas != nil {
		replicas = *sts.Spec.Replicas
	}
	result["replicas_status"] = map[string]interface{}{
		"desired":   replicas,
		"current":   sts.Status.CurrentReplicas,
		"ready":     sts.Status.ReadyReplicas,
		"updated":   sts.Status.UpdatedReplicas,
		"available": sts.Status.AvailableReplicas,
	}

	// Selector as map
	if sts.Spec.Selector != nil && sts.Spec.Selector.MatchLabels != nil {
		result["selector"] = sts.Spec.Selector.MatchLabels
	}

	// Update strategy
	updateStrategy := map[string]interface{}{
		"type": string(sts.Spec.UpdateStrategy.Type),
	}
	if sts.Spec.UpdateStrategy.RollingUpdate != nil && sts.Spec.UpdateStrategy.RollingUpdate.Partition != nil {
		updateStrategy["rolling_update"] = map[string]interface{}{
			"partition": *sts.Spec.UpdateStrategy.RollingUpdate.Partition,
		}
	}
	result["update_strategy"] = updateStrategy

	// Pod template
	result["pod_template"] = formatPodTemplate(sts.Spec.Template)

	// Volume claim templates
	vcts := make([]map[string]interface{}, 0, len(sts.Spec.VolumeClaimTemplates))
	for _, vct := range sts.Spec.VolumeClaimTemplates {
		v := map[string]interface{}{
			"name": vct.Name,
		}
		if vct.Spec.StorageClassName != nil {
			v["storage_class_name"] = *vct.Spec.StorageClassName
		}
		v["access_modes"] = func() []string {
			modes := make([]string, 0, len(vct.Spec.AccessModes))
			for _, m := range vct.Spec.AccessModes {
				modes = append(modes, string(m))
			}
			return modes
		}()
		if vct.Spec.Resources.Requests != nil {
			req := make(map[string]string)
			for k, val := range vct.Spec.Resources.Requests {
				req[string(k)] = val.String()
			}
			v["requests"] = req
		}
		vcts = append(vcts, v)
	}
	result["volume_claim_templates"] = vcts

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(sts.Status.Conditions))
	for _, c := range sts.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                   string(c.Type),
			"status":                 string(c.Status),
			"reason":                 c.Reason,
			"message":                c.Message,
			"last_transition_time":   toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	return result, nil
}

// DeleteStatefulSet deletes a statefulset.
func (s *Service) DeleteStatefulSet(ctx context.Context, namespace, name string) error {
	return s.clientset.AppsV1().StatefulSets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== DaemonSets ==========

// GetDaemonSets lists daemonsets in a namespace.
func (s *Service) GetDaemonSets(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientset.AppsV1().DaemonSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list daemonsets: %w", err)
	}
	return formatDaemonSetList(list.Items), nil
}

// GetAllDaemonSets lists daemonsets across all namespaces.
func (s *Service) GetAllDaemonSets(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.AppsV1().DaemonSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all daemonsets: %w", err)
	}
	return formatDaemonSetList(list.Items), nil
}

// DescribeDaemonSet returns detailed info about a daemonset.
func (s *Service) DescribeDaemonSet(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var ds *appsv1.DaemonSet
	var events *corev1.EventList
	var dsErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		ds, dsErr = s.clientset.AppsV1().DaemonSets(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=DaemonSet", name),
		})
	}()
	wg.Wait()

	if dsErr != nil {
		return nil, fmt.Errorf("get daemonset %s/%s: %w", namespace, name, dsErr)
	}

	result := formatDaemonSetDetail(ds)

	// Additional metadata
	result["uid"] = string(ds.UID)
	result["resource_version"] = ds.ResourceVersion
	result["generation"] = ds.Generation
	result["labels"] = ds.Labels
	result["annotations"] = ds.Annotations
	if ds.Status.ObservedGeneration > 0 {
		result["observed_generation"] = ds.Status.ObservedGeneration
	}

	// DaemonSet-specific settings
	if ds.Spec.MinReadySeconds > 0 {
		result["min_ready_seconds"] = ds.Spec.MinReadySeconds
	}
	if ds.Spec.RevisionHistoryLimit != nil {
		result["revision_history_limit"] = *ds.Spec.RevisionHistoryLimit
	}
	if ds.Status.CollisionCount != nil {
		result["collision_count"] = *ds.Status.CollisionCount
	}
	result["daemonset_status"] = map[string]interface{}{
		"desired":      ds.Status.DesiredNumberScheduled,
		"current":      ds.Status.CurrentNumberScheduled,
		"ready":        ds.Status.NumberReady,
		"updated":      ds.Status.UpdatedNumberScheduled,
		"available":    ds.Status.NumberAvailable,
		"misscheduled": ds.Status.NumberMisscheduled,
		"unavailable":  ds.Status.NumberUnavailable,
	}

	// Selector as map
	if ds.Spec.Selector != nil && ds.Spec.Selector.MatchLabels != nil {
		result["selector"] = ds.Spec.Selector.MatchLabels
	}

	// Update strategy
	updateStrategy := map[string]interface{}{
		"type": string(ds.Spec.UpdateStrategy.Type),
	}
	if ds.Spec.UpdateStrategy.RollingUpdate != nil && ds.Spec.UpdateStrategy.RollingUpdate.MaxUnavailable != nil {
		updateStrategy["rolling_update"] = map[string]interface{}{
			"max_unavailable": ds.Spec.UpdateStrategy.RollingUpdate.MaxUnavailable.String(),
		}
	}
	result["update_strategy"] = updateStrategy

	// Pod template
	result["pod_template"] = formatPodTemplate(ds.Spec.Template)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(ds.Status.Conditions))
	for _, c := range ds.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                   string(c.Type),
			"status":                 string(c.Status),
			"reason":                 c.Reason,
			"message":                c.Message,
			"last_transition_time":   toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	return result, nil
}

// DeleteDaemonSet deletes a daemonset.
func (s *Service) DeleteDaemonSet(ctx context.Context, namespace, name string) error {
	return s.clientset.AppsV1().DaemonSets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== ReplicaSets ==========

// GetReplicaSets lists replicasets in a namespace.
func (s *Service) GetReplicaSets(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientset.AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list replicasets: %w", err)
	}
	return formatReplicaSetList(list.Items), nil
}

// GetAllReplicaSets lists replicasets across all namespaces.
func (s *Service) GetAllReplicaSets(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.AppsV1().ReplicaSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all replicasets: %w", err)
	}
	return formatReplicaSetList(list.Items), nil
}

// DescribeReplicaSet returns detailed info about a replicaset.
func (s *Service) DescribeReplicaSet(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var rs *appsv1.ReplicaSet
	var events *corev1.EventList
	var rsErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		rs, rsErr = s.clientset.AppsV1().ReplicaSets(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=ReplicaSet", name),
		})
	}()
	wg.Wait()

	if rsErr != nil {
		return nil, fmt.Errorf("get replicaset %s/%s: %w", namespace, name, rsErr)
	}

	result := formatReplicaSetDetail(rs)

	// Additional metadata
	result["uid"] = string(rs.UID)
	result["resource_version"] = rs.ResourceVersion
	result["generation"] = rs.Generation
	result["labels"] = rs.Labels
	result["annotations"] = rs.Annotations

	// ReplicaSet-specific settings
	if rs.Spec.MinReadySeconds > 0 {
		result["min_ready_seconds"] = rs.Spec.MinReadySeconds
	}
	result["fully_labeled_replicas"] = rs.Status.FullyLabeledReplicas

	// Owner
	for _, or := range rs.OwnerReferences {
		if or.Kind == "Deployment" {
			result["owner"] = or.Name
			break
		}
	}

	// Revision from annotations
	if rev, ok := rs.Annotations["deployment.kubernetes.io/revision"]; ok {
		result["revision"] = rev
	}

	// Selector as map
	if rs.Spec.Selector != nil && rs.Spec.Selector.MatchLabels != nil {
		result["selector"] = rs.Spec.Selector.MatchLabels
	}

	// Pod template
	result["pod_template"] = formatPodTemplate(rs.Spec.Template)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(rs.Status.Conditions))
	for _, c := range rs.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                   string(c.Type),
			"status":                 string(c.Status),
			"reason":                 c.Reason,
			"message":                c.Message,
			"last_transition_time":   toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	// Owner references
	owners := make([]map[string]interface{}, 0, len(rs.OwnerReferences))
	for _, or := range rs.OwnerReferences {
		owners = append(owners, map[string]interface{}{
			"kind": or.Kind,
			"name": or.Name,
			"uid":  string(or.UID),
		})
	}
	result["owner_references"] = owners

	return result, nil
}

// DeleteReplicaSet deletes a replicaset.
func (s *Service) DeleteReplicaSet(ctx context.Context, namespace, name string) error {
	return s.clientset.AppsV1().ReplicaSets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Jobs ==========

// GetJobs lists jobs in a namespace.
func (s *Service) GetJobs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientset.BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	return formatJobList(list.Items), nil
}

// GetAllJobs lists jobs across all namespaces.
func (s *Service) GetAllJobs(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.BatchV1().Jobs("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all jobs: %w", err)
	}
	return formatJobList(list.Items), nil
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
		job, jobErr = s.clientset.BatchV1().Jobs(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Job", name),
		})
	}()
	wg.Wait()

	if jobErr != nil {
		return nil, fmt.Errorf("get job %s/%s: %w", namespace, name, jobErr)
	}

	result := formatJobDetail(job)

	// Additional metadata
	result["uid"] = string(job.UID)
	result["labels"] = job.Labels
	result["annotations"] = job.Annotations

	// Job-specific fields the frontend expects
	if job.Spec.Completions != nil {
		result["completions"] = *job.Spec.Completions
	}
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
	if job.Status.StartTime != nil {
		result["start_time"] = toISO(job.Status.StartTime)
	}
	if job.Status.CompletionTime != nil {
		result["completion_time"] = toISO(job.Status.CompletionTime)
		if job.Status.StartTime != nil {
			result["duration_seconds"] = int64(job.Status.CompletionTime.Sub(job.Status.StartTime.Time).Seconds())
		}
	}

	// Determine job status
	jobStatus := "Active"
	for _, c := range job.Status.Conditions {
		if c.Type == "Complete" && c.Status == "True" {
			jobStatus = "Complete"
			break
		}
		if c.Type == "Failed" && c.Status == "True" {
			jobStatus = "Failed"
			break
		}
	}
	result["status"] = jobStatus

	// Pod template
	result["pod_template"] = formatPodTemplate(job.Spec.Template)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(job.Status.Conditions))
	for _, c := range job.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                   string(c.Type),
			"status":                 string(c.Status),
			"reason":                 c.Reason,
			"message":                c.Message,
			"last_transition_time":   toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	return result, nil
}

// DeleteJob deletes a job.
func (s *Service) DeleteJob(ctx context.Context, namespace, name string) error {
	propagation := metav1.DeletePropagationBackground
	return s.clientset.BatchV1().Jobs(namespace).Delete(ctx, name, metav1.DeleteOptions{
		PropagationPolicy: &propagation,
	})
}

// ========== CronJobs ==========

// GetCronJobs lists cronjobs in a namespace.
func (s *Service) GetCronJobs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientset.BatchV1().CronJobs(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list cronjobs: %w", err)
	}
	return formatCronJobList(list.Items), nil
}

// GetAllCronJobs lists cronjobs across all namespaces.
func (s *Service) GetAllCronJobs(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.BatchV1().CronJobs("").List(ctx, metav1.ListOptions{})
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
		cj, cjErr = s.clientset.BatchV1().CronJobs(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
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
	_, err := s.clientset.BatchV1().CronJobs(namespace).Patch(ctx, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("patch cronjob %s/%s suspend: %w", namespace, name, err)
	}
	return nil
}

// TriggerCronJob creates a Job from a CronJob's jobTemplate.
func (s *Service) TriggerCronJob(ctx context.Context, namespace, name string) (string, error) {
	cj, err := s.clientset.BatchV1().CronJobs(namespace).Get(ctx, name, metav1.GetOptions{})
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

	created, err := s.clientset.BatchV1().Jobs(namespace).Create(ctx, job, metav1.CreateOptions{})
	if err != nil {
		return "", fmt.Errorf("create job from cronjob %s/%s: %w", namespace, name, err)
	}
	return created.Name, nil
}

// GetCronJobOwnedJobs lists Jobs owned by a CronJob via ownerReference.
func (s *Service) GetCronJobOwnedJobs(ctx context.Context, namespace, name string) ([]map[string]interface{}, error) {
	jobList, err := s.clientset.BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{})
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
	return s.clientset.BatchV1().CronJobs(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Revision History & Rollback ==========

// GetRevisionHistory returns the revision history for a Deployment, DaemonSet, or StatefulSet.
func (s *Service) GetRevisionHistory(ctx context.Context, namespace, name, kind string) ([]map[string]interface{}, error) {
	switch kind {
	case "Deployment":
		return s.getDeploymentRevisionHistory(ctx, namespace, name)
	case "DaemonSet":
		return s.getControllerRevisionHistory(ctx, namespace, name, "DaemonSet")
	case "StatefulSet":
		return s.getControllerRevisionHistory(ctx, namespace, name, "StatefulSet")
	default:
		return nil, fmt.Errorf("unsupported workload kind for revision history: %s", kind)
	}
}

func (s *Service) getDeploymentRevisionHistory(ctx context.Context, namespace, name string) ([]map[string]interface{}, error) {
	deploy, err := s.clientset.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get deployment %s/%s: %w", namespace, name, err)
	}

	rsList, err := s.clientset.AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list replicasets in %s: %w", namespace, err)
	}

	// Get current template hash from the deployment
	currentHash := deploy.Labels["pod-template-hash"]
	if currentHash == "" && deploy.Spec.Template.Labels != nil {
		currentHash = deploy.Spec.Template.Labels["pod-template-hash"]
	}

	revisions := make([]map[string]interface{}, 0)
	for _, rs := range rsList.Items {
		// Filter by ownerReference matching the Deployment
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

		images := make([]string, 0, len(rs.Spec.Template.Spec.Containers))
		for _, c := range rs.Spec.Template.Spec.Containers {
			images = append(images, c.Image)
		}

		// Determine if this RS is the current one by matching template hash
		rsHash := rs.Labels["pod-template-hash"]
		isCurrent := rsHash != "" && rsHash == currentHash

		revisions = append(revisions, map[string]interface{}{
			"revision":   rev,
			"images":     images,
			"created_at": toISO(&rs.CreationTimestamp),
			"is_current": isCurrent,
			"name":       rs.Name,
			"replicas":   rs.Status.Replicas,
		})
	}

	sort.Slice(revisions, func(i, j int) bool {
		return revisions[i]["revision"].(int64) < revisions[j]["revision"].(int64)
	})

	return revisions, nil
}

func (s *Service) getControllerRevisionHistory(ctx context.Context, namespace, name, kind string) ([]map[string]interface{}, error) {
	crList, err := s.clientset.AppsV1().ControllerRevisions(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list controller revisions in %s: %w", namespace, err)
	}

	// Find the highest revision to determine current
	var maxRevision int64
	revisions := make([]map[string]interface{}, 0)

	for _, cr := range crList.Items {
		// Filter by ownerReference
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

		if cr.Revision > maxRevision {
			maxRevision = cr.Revision
		}

		// Extract images from the revision data
		images := extractImagesFromControllerRevision(&cr)

		revisions = append(revisions, map[string]interface{}{
			"revision":   cr.Revision,
			"images":     images,
			"created_at": toISO(&cr.CreationTimestamp),
			"is_current": false, // will be set below
			"name":       cr.Name,
		})
	}

	// Mark current revision
	for i := range revisions {
		if revisions[i]["revision"].(int64) == maxRevision {
			revisions[i]["is_current"] = true
		}
	}

	sort.Slice(revisions, func(i, j int) bool {
		return revisions[i]["revision"].(int64) < revisions[j]["revision"].(int64)
	})

	return revisions, nil
}

// extractImagesFromControllerRevision tries to extract container images from ControllerRevision data.
func extractImagesFromControllerRevision(cr *appsv1.ControllerRevision) []string {
	images := make([]string, 0)
	if cr.Data.Raw == nil {
		return images
	}

	// The Data.Raw typically contains either:
	// - A full DaemonSet/StatefulSet spec
	// - A strategic merge patch with spec.template
	var raw map[string]interface{}
	if err := json.Unmarshal(cr.Data.Raw, &raw); err != nil {
		return images
	}

	// Try spec.template.spec.containers path
	spec, ok := raw["spec"].(map[string]interface{})
	if !ok {
		return images
	}
	template, ok := spec["template"].(map[string]interface{})
	if !ok {
		return images
	}
	templateSpec, ok := template["spec"].(map[string]interface{})
	if !ok {
		return images
	}
	containers, ok := templateSpec["containers"].([]interface{})
	if !ok {
		return images
	}
	for _, c := range containers {
		container, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		if image, ok := container["image"].(string); ok {
			images = append(images, image)
		}
	}
	return images
}

// RollbackWorkload rolls back a Deployment, DaemonSet, or StatefulSet to a specific revision.
func (s *Service) RollbackWorkload(ctx context.Context, namespace, name, kind string, toRevision int64) error {
	switch kind {
	case "Deployment":
		return s.rollbackDeployment(ctx, namespace, name, toRevision)
	case "DaemonSet":
		return s.rollbackDaemonSet(ctx, namespace, name, toRevision)
	case "StatefulSet":
		return s.rollbackStatefulSet(ctx, namespace, name, toRevision)
	default:
		return fmt.Errorf("unsupported workload kind for rollback: %s", kind)
	}
}

func (s *Service) rollbackDeployment(ctx context.Context, namespace, name string, toRevision int64) error {
	rsList, err := s.clientset.AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list replicasets in %s: %w", namespace, err)
	}

	// Find the RS with the target revision
	var targetRS *appsv1.ReplicaSet
	for i, rs := range rsList.Items {
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
		if rev == toRevision {
			targetRS = &rsList.Items[i]
			break
		}
	}

	if targetRS == nil {
		return fmt.Errorf("revision %d not found for deployment %s/%s", toRevision, namespace, name)
	}

	// Build patch from the target RS's pod template
	// Remove the pod-template-hash label from the template to avoid conflicts
	templateLabels := make(map[string]string)
	for k, v := range targetRS.Spec.Template.Labels {
		if k != "pod-template-hash" {
			templateLabels[k] = v
		}
	}

	patchTemplate := targetRS.Spec.Template.DeepCopy()
	patchTemplate.Labels = templateLabels

	patch := map[string]interface{}{
		"spec": map[string]interface{}{
			"template": patchTemplate,
		},
	}
	patchBytes, err := json.Marshal(patch)
	if err != nil {
		return fmt.Errorf("marshal rollback patch: %w", err)
	}

	_, err = s.clientset.AppsV1().Deployments(namespace).Patch(ctx, name, types.StrategicMergePatchType, patchBytes, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("rollback deployment %s/%s to revision %d: %w", namespace, name, toRevision, err)
	}
	return nil
}

func (s *Service) rollbackDaemonSet(ctx context.Context, namespace, name string, toRevision int64) error {
	crList, err := s.clientset.AppsV1().ControllerRevisions(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list controller revisions in %s: %w", namespace, err)
	}

	var targetCR *appsv1.ControllerRevision
	for i, cr := range crList.Items {
		owned := false
		for _, ref := range cr.OwnerReferences {
			if ref.Kind == "DaemonSet" && ref.Name == name {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}
		if cr.Revision == toRevision {
			targetCR = &crList.Items[i]
			break
		}
	}

	if targetCR == nil {
		return fmt.Errorf("revision %d not found for daemonset %s/%s", toRevision, namespace, name)
	}

	// Extract the spec.template from the ControllerRevision data
	patchBytes, err := buildControllerRevisionPatch(targetCR)
	if err != nil {
		return fmt.Errorf("build rollback patch for daemonset %s/%s: %w", namespace, name, err)
	}

	_, err = s.clientset.AppsV1().DaemonSets(namespace).Patch(ctx, name, types.StrategicMergePatchType, patchBytes, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("rollback daemonset %s/%s to revision %d: %w", namespace, name, toRevision, err)
	}
	return nil
}

func (s *Service) rollbackStatefulSet(ctx context.Context, namespace, name string, toRevision int64) error {
	crList, err := s.clientset.AppsV1().ControllerRevisions(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list controller revisions in %s: %w", namespace, err)
	}

	var targetCR *appsv1.ControllerRevision
	for i, cr := range crList.Items {
		owned := false
		for _, ref := range cr.OwnerReferences {
			if ref.Kind == "StatefulSet" && ref.Name == name {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}
		if cr.Revision == toRevision {
			targetCR = &crList.Items[i]
			break
		}
	}

	if targetCR == nil {
		return fmt.Errorf("revision %d not found for statefulset %s/%s", toRevision, namespace, name)
	}

	// Extract the spec.template from the ControllerRevision data
	patchBytes, err := buildControllerRevisionPatch(targetCR)
	if err != nil {
		return fmt.Errorf("build rollback patch for statefulset %s/%s: %w", namespace, name, err)
	}

	_, err = s.clientset.AppsV1().StatefulSets(namespace).Patch(ctx, name, types.StrategicMergePatchType, patchBytes, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("rollback statefulset %s/%s to revision %d: %w", namespace, name, toRevision, err)
	}
	return nil
}

// buildControllerRevisionPatch extracts spec.template from a ControllerRevision
// and builds a strategic merge patch with it.
func buildControllerRevisionPatch(cr *appsv1.ControllerRevision) ([]byte, error) {
	if cr.Data.Raw == nil {
		return nil, fmt.Errorf("controller revision %s has no data", cr.Name)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(cr.Data.Raw, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal controller revision data: %w", err)
	}

	spec, ok := raw["spec"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("controller revision %s has no spec field", cr.Name)
	}

	template, ok := spec["template"]
	if !ok {
		return nil, fmt.Errorf("controller revision %s has no spec.template field", cr.Name)
	}

	patch := map[string]interface{}{
		"spec": map[string]interface{}{
			"template": template,
		},
	}

	return json.Marshal(patch)
}

// ========== Formatting helpers ==========

func formatEventList(events []corev1.Event) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(events))
	for _, e := range events {
		result = append(result, map[string]interface{}{
			"type":       e.Type,
			"reason":     e.Reason,
			"message":    e.Message,
			"count":      e.Count,
			"first_time": toISO(&e.FirstTimestamp),
			"last_time":  toISO(&e.LastTimestamp),
			"source":     e.Source.Component,
		})
	}
	return result
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

	// Compute status
	stsStatus := "Healthy"
	if replicas == 0 {
		stsStatus = "Idle"
	} else if sts.Status.ReadyReplicas < replicas {
		stsStatus = "Degraded"
	} else if sts.Status.AvailableReplicas == 0 && replicas > 0 {
		stsStatus = "Unavailable"
	}

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

	// Compute status
	dsStatus := "Healthy"
	if ds.Status.DesiredNumberScheduled == 0 {
		dsStatus = "Idle"
	} else if ds.Status.NumberReady < ds.Status.DesiredNumberScheduled {
		dsStatus = "Degraded"
	} else if ds.Status.NumberAvailable == 0 && ds.Status.DesiredNumberScheduled > 0 {
		dsStatus = "Unavailable"
	}

	return map[string]interface{}{
		"name":           ds.Name,
		"namespace":      ds.Namespace,
		"desired":        ds.Status.DesiredNumberScheduled,
		"current":        ds.Status.CurrentNumberScheduled,
		"ready":          ds.Status.NumberReady,
		"updated":        ds.Status.UpdatedNumberScheduled,
		"available":      ds.Status.NumberAvailable,
		"misscheduled":   ds.Status.NumberMisscheduled,
		"unavailable":    ds.Status.NumberUnavailable,
		"node_selector":  ds.Spec.Template.Spec.NodeSelector,
		"image":          image,
		"images":         images,
		"selector":       selector,
		"status":         dsStatus,
		"created_at":     toISO(&ds.CreationTimestamp),
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
	for _, c := range rs.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
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

	// Compute status
	rsStatus := "Healthy"
	if replicas == 0 {
		rsStatus = "Idle"
	} else if rs.Status.ReadyReplicas < replicas {
		rsStatus = "Degraded"
	} else if rs.Status.AvailableReplicas == 0 && replicas > 0 {
		rsStatus = "Unavailable"
	}

	return map[string]interface{}{
		"name":               rs.Name,
		"namespace":          rs.Namespace,
		"replicas":           replicas,
		"ready_replicas":     rs.Status.ReadyReplicas,
		"available_replicas": rs.Status.AvailableReplicas,
		"image":              image,
		"images":             images,
		"selector":           selector,
		"owner_deployment":   owner,
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
	for _, c := range job.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	status := "Running"
	for _, c := range job.Status.Conditions {
		if c.Type == batchv1.JobComplete && c.Status == corev1.ConditionTrue {
			status = "Complete"
			break
		}
		if c.Type == batchv1.JobFailed && c.Status == corev1.ConditionTrue {
			status = "Failed"
			break
		}
	}

	result := map[string]interface{}{
		"name":        job.Name,
		"namespace":   job.Namespace,
		"completions": completions,
		"parallelism": parallelism,
		"succeeded":   job.Status.Succeeded,
		"failed":      job.Status.Failed,
		"active":      job.Status.Active,
		"status":      status,
		"image":       image,
		"images":      images,
		"created_at":  toISO(&job.CreationTimestamp),
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
	for _, cj := range items {
		result = append(result, formatCronJobDetail(&cj))
	}
	return result
}

func formatCronJobDetail(cj *batchv1.CronJob) map[string]interface{} {
	suspend := false
	if cj.Spec.Suspend != nil {
		suspend = *cj.Spec.Suspend
	}

	images := make([]string, 0)
	for _, c := range cj.Spec.JobTemplate.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	result := map[string]interface{}{
		"name":        cj.Name,
		"namespace":   cj.Namespace,
		"schedule":    cj.Spec.Schedule,
		"suspend":     suspend,
		"active":      len(cj.Status.Active),
		"image":       image,
		"images":      images,
		"created_at":  toISO(&cj.CreationTimestamp),
	}

	if cj.Status.LastScheduleTime != nil {
		result["last_schedule"] = toISO(cj.Status.LastScheduleTime)
	}
	if cj.Status.LastSuccessfulTime != nil {
		result["last_successful"] = toISO(cj.Status.LastSuccessfulTime)
	}

	concurrencyPolicy := ""
	if cj.Spec.ConcurrencyPolicy != "" {
		concurrencyPolicy = string(cj.Spec.ConcurrencyPolicy)
	}
	result["concurrency_policy"] = concurrencyPolicy

	return result
}
