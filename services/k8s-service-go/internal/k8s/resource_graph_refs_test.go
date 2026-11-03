package k8s

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// A box the graph adds because something references it says what the graph knows of it: Active when the
// namespace's list has it, Missing when the list was read and does not (a warning when a pod needs it to start), and
// no status where it could not be read — a kind the identity may not list there, a namespace the graph did not read,
// a Role (the graph lists no roles). Before, every such box was Active.
func TestBuildResourceGraph_ReferencedObjectsSayWhatTheListsHave(t *testing.T) {
	yes := true
	meta := func(ns, name string) metav1.ObjectMeta { return metav1.ObjectMeta{Namespace: ns, Name: name} }
	p := corev1.Pod{ObjectMeta: meta("shop", "web"), Spec: corev1.PodSpec{
		Volumes: []corev1.Volume{
			{Name: "a", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "app-config"}}}},
			{Name: "b", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "gone"}}}},
			{Name: "c", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "maybe"}, Optional: &yes}}},
		},
		Containers: []corev1.Container{{Name: "app", EnvFrom: []corev1.EnvFromSource{
			{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "db"}}},
		}}},
	}}
	rb := rbacv1.RoleBinding{ObjectMeta: meta("shop", "web-read"), RoleRef: rbacv1.RoleRef{Kind: "Role", Name: "reader"},
		Subjects: []rbacv1.Subject{
			{Kind: "ServiceAccount", Name: "web"},
			{Kind: "ServiceAccount", Name: "ghost"},
			{Kind: "ServiceAccount", Name: "builder", Namespace: "ci"},
		}}
	res := &rgResources{
		pods:            []rgPod{toRGPod(&p)},
		configMaps:      []corev1.ConfigMap{{ObjectMeta: meta("shop", "app-config")}},
		serviceAccounts: []corev1.ServiceAccount{{ObjectMeta: meta("shop", "web")}},
		roleBindings:    []rbacv1.RoleBinding{rb},
		forbidden:       []string{"Secret"},
	}
	nodes, _ := buildResourceGraph(res, []string{"shop"}, ResourceGraphOptions{})
	got := map[string]string{}
	for _, id := range []string{
		"ConfigMap/shop/app-config", "ConfigMap/shop/gone", "ConfigMap/shop/maybe", "Secret/shop/db",
		"Role/shop/reader", "ServiceAccount/shop/web", "ServiceAccount/shop/ghost", "ServiceAccount/ci/builder",
	} {
		n, ok := nodes[id]
		if !ok {
			t.Fatalf("no node %s", id)
		}
		got[id] = n.Status + "|" + n.Health
	}
	want := map[string]string{
		"ConfigMap/shop/app-config": "Active|",
		"ConfigMap/shop/gone":       "Missing|warn", // the pod waits on it (CreateContainerConfigError)
		"ConfigMap/shop/maybe":      "Missing|",     // optional: the pod starts without it
		"Secret/shop/db":            "|",            // Secrets refused: not known
		"Role/shop/reader":          "|",            // roles are not listed
		"ServiceAccount/shop/web":   "Active|",
		"ServiceAccount/shop/ghost": "Missing|",
		"ServiceAccount/ci/builder": "|", // namespace ci not read
	}
	for id, w := range want {
		if got[id] != w {
			t.Errorf("%s: %q, want %q", id, got[id], w)
		}
	}
}
