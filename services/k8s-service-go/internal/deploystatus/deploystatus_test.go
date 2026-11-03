package deploystatus

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
)

// A Deployment's status reads its conditions by type, as kubectl rollout status does: a rollout past its progress
// deadline is Failed while the old pods keep Available=True — the controller writes Available before Progressing.
func TestOf_AsRolloutStatusReadsIt(t *testing.T) {
	cond := func(typ appsv1.DeploymentConditionType, s corev1.ConditionStatus, reason string) appsv1.DeploymentCondition {
		return appsv1.DeploymentCondition{Type: typ, Status: s, Reason: reason}
	}
	avail := func(s corev1.ConditionStatus) appsv1.DeploymentCondition {
		return cond(appsv1.DeploymentAvailable, s, "MinimumReplicasAvailable")
	}
	prog := func(s corev1.ConditionStatus, reason string) appsv1.DeploymentCondition {
		return cond(appsv1.DeploymentProgressing, s, reason)
	}
	for _, c := range []struct {
		name           string
		conds          []appsv1.DeploymentCondition
		status, reason string
	}{
		{"stuck rollout, old pods available", []appsv1.DeploymentCondition{avail("True"), prog("False", "ProgressDeadlineExceeded")}, "Failed", "ProgressDeadlineExceeded"},
		{"the same, other order", []appsv1.DeploymentCondition{prog("False", "ProgressDeadlineExceeded"), avail("True")}, "Failed", "ProgressDeadlineExceeded"},
		{"stuck rollout, none available", []appsv1.DeploymentCondition{avail("False"), prog("False", "ProgressDeadlineExceeded")}, "Failed", "ProgressDeadlineExceeded"},
		{"rolled out", []appsv1.DeploymentCondition{avail("True"), prog("True", "NewReplicaSetAvailable")}, "Available", ""},
		{"rolling, old pods available", []appsv1.DeploymentCondition{avail("True"), prog("True", "ReplicaSetUpdated")}, "Available", ""},
		{"starting", []appsv1.DeploymentCondition{avail("False"), prog("True", "ReplicaSetUpdated")}, "Progressing", ""},
		{"no conditions yet", nil, "Progressing", ""},
	} {
		status, reason := Of(&appsv1.Deployment{Status: appsv1.DeploymentStatus{Conditions: c.conds}})
		if status != c.status || reason != c.reason {
			t.Errorf("%s: %q %q, want %q %q", c.name, status, reason, c.status, c.reason)
		}
	}
}
