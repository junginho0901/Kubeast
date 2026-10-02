package k8s

import (
	"encoding/json"
	"errors"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func podTemplate(env []corev1.EnvVar, hash string) corev1.PodTemplateSpec {
	labels := map[string]string{"app": "web"}
	if hash != "" {
		labels[appsv1.DefaultDeploymentUniqueLabelKey] = hash
	}
	return corev1.PodTemplateSpec{
		ObjectMeta: metav1.ObjectMeta{Labels: labels},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{
			Name: "web", Image: "nginx:alpine", Env: env,
		}}},
	}
}

// Revision 2 added an env var; rolling back to revision 1 must drop it. A
// strategic merge of the old template (the previous implementation) keeps
// env entries that only the newer template has, which is why the patch is a
// whole-template replace.
func TestDeploymentRollbackPatch_ReplacesWholeTemplate(t *testing.T) {
	deploy := &appsv1.Deployment{Spec: appsv1.DeploymentSpec{
		Template: podTemplate([]corev1.EnvVar{{Name: "QA_REV", Value: "2"}}, ""),
	}}
	rs := &appsv1.ReplicaSet{Spec: appsv1.ReplicaSetSpec{Template: podTemplate(nil, "abc123")}}

	patch, err := deploymentRollbackPatch(deploy, rs)
	if err != nil {
		t.Fatalf("patch: %v", err)
	}
	var ops []struct {
		Op    string                 `json:"op"`
		Path  string                 `json:"path"`
		Value corev1.PodTemplateSpec `json:"value"`
	}
	if err := json.Unmarshal(patch, &ops); err != nil {
		t.Fatalf("patch is not a JSON patch: %v\n%s", err, patch)
	}
	if len(ops) != 1 || ops[0].Op != "replace" || ops[0].Path != "/spec/template" {
		t.Fatalf("want one replace of /spec/template, got %s", patch)
	}
	if got := ops[0].Value.Spec.Containers[0].Env; len(got) != 0 {
		t.Errorf("env after rollback = %v, want none", got)
	}
	if _, has := ops[0].Value.Labels[appsv1.DefaultDeploymentUniqueLabelKey]; has {
		t.Errorf("pod-template-hash must not be copied into the Deployment template: %v", ops[0].Value.Labels)
	}
	if ops[0].Value.Labels["app"] != "web" {
		t.Errorf("other template labels must survive: %v", ops[0].Value.Labels)
	}
}

func TestDeploymentRollbackPatch_AlreadyAtRevision(t *testing.T) {
	deploy := &appsv1.Deployment{Spec: appsv1.DeploymentSpec{Template: podTemplate(nil, "")}}
	rs := &appsv1.ReplicaSet{Spec: appsv1.ReplicaSetSpec{Template: podTemplate(nil, "abc123")}}
	if _, err := deploymentRollbackPatch(deploy, rs); !errors.Is(err, ErrAlreadyAtRevision) {
		t.Fatalf("same template (hash label aside) must report ErrAlreadyAtRevision, got %v", err)
	}
}
