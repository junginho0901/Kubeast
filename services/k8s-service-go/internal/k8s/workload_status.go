package k8s

import (
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/deploystatus"
	jobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/job"
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

// jobStatus is a Job's STATUS as kubectl prints it (jobrow.Status, which the Job row reads too).
func jobStatus(j *batchv1.Job) string {
	return jobrow.Status(j)
}

// workloadHealth is how a list status is drawn: ok, warn or error; "" for a
// status that asks nothing (Idle).
func workloadHealth(status string) string {
	switch status {
	case "Healthy", "Available", "Complete", "Running", "SuccessCriteriaMet":
		return "ok"
	case "Progressing", "Degraded", "Suspended", "Terminating":
		return "warn"
	case "Unavailable", "Failed", "FailureTarget":
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
