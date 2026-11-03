// Package deploystatus reads a Deployment's summary status from its conditions, for the lists, the live list updates,
// the issues, the Resource Graph and the topology alike.
package deploystatus

import (
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
)

// Of is Available, Failed (the rollout stopped, with the condition's reason) or Progressing. The conditions are read
// by type, not in the order they come: a rollout past its progress deadline (Progressing=False,
// ProgressDeadlineExceeded) is Failed while the old pods keep Available=True, as kubectl rollout status
// (release-1.37) and Argo CD's Deployment health read it.
func Of(d *appsv1.Deployment) (status, reason string) {
	var available, progressing *appsv1.DeploymentCondition
	for i := range d.Status.Conditions {
		switch c := &d.Status.Conditions[i]; c.Type {
		case appsv1.DeploymentAvailable:
			available = c
		case appsv1.DeploymentProgressing:
			progressing = c
		}
	}
	if progressing != nil && progressing.Status == corev1.ConditionFalse {
		return "Failed", progressing.Reason
	}
	if available != nil && available.Status == corev1.ConditionTrue {
		return "Available", ""
	}
	return "Progressing", ""
}
