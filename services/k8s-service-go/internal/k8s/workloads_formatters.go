package k8s

import (
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
)

// Formatting helpers — turn typed K8s objects into the
// map[string]interface{} shapes the frontend expects. Split out of
// workloads.go so the data conversion lives in one place.

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
		"ready_replicas":     rs.Status.ReadyReplicas,
		"available_replicas": rs.Status.AvailableReplicas,
		"image":              image,
		"images":             images,
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
