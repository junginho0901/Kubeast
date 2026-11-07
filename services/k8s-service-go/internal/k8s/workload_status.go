package k8s

import (
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/deploystatus"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/replicastatus"
)

// The workload lists' summary statuses (frontend utils/workloadStatus), one set
// of rules for the lists, their drawers and the Resource Graph's boxes.

// replicaStatus is a StatefulSet's, DaemonSet's or ReplicaSet's: Idle with none
// wanted, Unavailable with none available, Degraded with fewer ready than wanted
// (replicastatus.Of, which the ReplicaSet row reads too).
func replicaStatus(want, available, ready int32) string {
	return replicastatus.Of(want, available, ready)
}

// deploymentStatus is a Deployment's by its conditions: Available, Failed (the
// rollout stopped, with the reason) or Progressing (deploystatus.Of, which the
// live list updates read too).
func deploymentStatus(d *appsv1.Deployment) (status, reason string) {
	return deploystatus.Of(d)
}

// jobStatus is a Job's by its conditions: Complete, Failed or Running.
func jobStatus(j *batchv1.Job) string {
	for _, c := range j.Status.Conditions {
		if c.Type == batchv1.JobComplete && c.Status == corev1.ConditionTrue {
			return "Complete"
		}
		if c.Type == batchv1.JobFailed && c.Status == corev1.ConditionTrue {
			return "Failed"
		}
	}
	return "Running"
}

// workloadHealth is how a list status is drawn: ok, warn or error; "" for a
// status that asks nothing (Idle).
func workloadHealth(status string) string {
	switch status {
	case "Healthy", "Available", "Complete", "Running":
		return "ok"
	case "Progressing", "Degraded":
		return "warn"
	case "Unavailable", "Failed":
		return "error"
	}
	return ""
}

// podHealthName names podHealth's level for the API.
func podHealthName(level uint8) string {
	switch level {
	case podHealthWarn:
		return "warn"
	case podHealthError:
		return "error"
	}
	return "ok"
}
