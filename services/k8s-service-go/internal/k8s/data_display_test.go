package k8s

import (
	"context"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func hpaResource() metav1.APIResource {
	return metav1.APIResource{Name: "horizontalpodautoscalers", Kind: "HorizontalPodAutoscaler", Namespaced: true, ShortNames: []string{"hpa"}}
}

func discoveryService(lists []metav1.APIResourceList) (*Service, context.Context) {
	s := &Service{
		apiResourcesCache: map[cluster.ID][]metav1.APIResourceList{"self": lists},
		apiResourcesAt:    map[cluster.ID]time.Time{"self": time.Now()},
	}
	return s, cluster.WithID(context.Background(), "self")
}

// Re-QA #31: discovery returns group versions in no fixed order, so the HPA
// YAML came back as autoscaling/v1 on some refreshes. Each group's preferred
// version now comes first and wins.
func TestPreferredFirstResolvesThePreferredVersion(t *testing.T) {
	groups := []*metav1.APIGroup{
		{Name: "", PreferredVersion: metav1.GroupVersionForDiscovery{GroupVersion: "v1", Version: "v1"}},
		{Name: "autoscaling", PreferredVersion: metav1.GroupVersionForDiscovery{GroupVersion: "autoscaling/v2", Version: "v2"}},
	}
	lists := []*metav1.APIResourceList{
		{GroupVersion: "autoscaling/v1", APIResources: []metav1.APIResource{hpaResource()}},
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true}}},
		nil,
		{GroupVersion: "autoscaling/v2", APIResources: []metav1.APIResource{hpaResource()}},
	}
	ordered := preferredFirst(groups, lists)
	var gvs []string
	for _, l := range ordered {
		gvs = append(gvs, l.GroupVersion)
	}
	if got := strings.Join(gvs, ","); got != "autoscaling/v2,v1,autoscaling/v1" {
		t.Fatalf("order = %s", got)
	}

	s, ctx := discoveryService(ordered)
	for _, name := range []string{"horizontalpodautoscalers", "hpa", "HorizontalPodAutoscaler"} {
		gvr, namespaced, err := s.ResolveResource(ctx, name)
		if err != nil || gvr.Version != "v2" || gvr.Group != "autoscaling" || !namespaced {
			t.Errorf("ResolveResource(%q) = %v %v %v, want autoscaling/v2", name, gvr, namespaced, err)
		}
	}
}

// Creating from YAML posts to the version the document names, not to whichever
// version the kind resolves to (a v1 HPA document to the v2 endpoint is refused).
func TestResolveKindUsesTheDocumentVersion(t *testing.T) {
	s, ctx := discoveryService([]metav1.APIResourceList{
		{GroupVersion: "autoscaling/v2", APIResources: []metav1.APIResource{hpaResource()}},
		{GroupVersion: "autoscaling/v1", APIResources: []metav1.APIResource{hpaResource()}},
		{GroupVersion: "v1", APIResources: []metav1.APIResource{
			{Name: "pods/status", Kind: "Pod", Namespaced: true},
			{Name: "pods", Kind: "Pod", Namespaced: true},
		}},
		{GroupVersion: "resource.k8s.io/v1", APIResources: []metav1.APIResource{{Name: "deviceclasses", Kind: "DeviceClass"}}},
	})
	for _, c := range []struct {
		apiVersion, kind, want string
		namespaced             bool
	}{
		{"autoscaling/v1", "HorizontalPodAutoscaler", "autoscaling/v1, Resource=horizontalpodautoscalers", true},
		{"autoscaling/v2", "HorizontalPodAutoscaler", "autoscaling/v2, Resource=horizontalpodautoscalers", true},
		{"v1", "Pod", "/v1, Resource=pods", true},
		{"resource.k8s.io/v1", "DeviceClass", "resource.k8s.io/v1, Resource=deviceclasses", false},
	} {
		gvr, namespaced, err := s.ResolveKind(ctx, c.apiVersion, c.kind)
		if err != nil || gvr.String() != c.want || namespaced != c.namespaced {
			t.Errorf("ResolveKind(%s, %s) = %v %v %v, want %s", c.apiVersion, c.kind, gvr, namespaced, err, c.want)
		}
	}
	if _, _, err := s.ResolveKind(ctx, "resource.k8s.io/v1beta1", "DeviceClass"); err == nil || !strings.Contains(err.Error(), "not served") {
		t.Errorf("unserved version: %v", err)
	}
}

// Re-QA #30: the list gives the current replica count (status.replicas), not
// only the desired one.
func TestFormatReplicaSetCurrentReplicas(t *testing.T) {
	three := int32(3)
	rs := &appsv1.ReplicaSet{
		ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "a"},
		Spec:       appsv1.ReplicaSetSpec{Replicas: &three},
		Status:     appsv1.ReplicaSetStatus{Replicas: 2, ReadyReplicas: 1},
	}
	got := formatReplicaSetDetail(rs)
	if got["current_replicas"] != int32(2) || got["replicas"] != int32(3) {
		t.Errorf("current/desired = %v/%v", got["current_replicas"], got["replicas"])
	}
}

// Re-QA #33: an HPA is active when its controller can compute a scale
// (ScalingActive=True), not when the target has pods.
func TestFormatHPAScalingActive(t *testing.T) {
	hpa := func(conds ...autoscalingv2.HorizontalPodAutoscalerCondition) *autoscalingv2.HorizontalPodAutoscaler {
		return &autoscalingv2.HorizontalPodAutoscaler{Status: autoscalingv2.HorizontalPodAutoscalerStatus{CurrentReplicas: 1, Conditions: conds}}
	}
	cond := func(t autoscalingv2.HorizontalPodAutoscalerConditionType, s corev1.ConditionStatus) autoscalingv2.HorizontalPodAutoscalerCondition {
		return autoscalingv2.HorizontalPodAutoscalerCondition{Type: t, Status: s}
	}
	for name, c := range map[string]struct {
		hpa  *autoscalingv2.HorizontalPodAutoscaler
		want bool
	}{
		"metrics fail": {hpa(cond(autoscalingv2.AbleToScale, corev1.ConditionTrue), cond(autoscalingv2.ScalingActive, corev1.ConditionFalse)), false},
		"active":       {hpa(cond(autoscalingv2.ScalingActive, corev1.ConditionTrue)), true},
		"not yet seen": {hpa(), false},
	} {
		if got := formatHPADetail(c.hpa)["scaling_active"]; got != c.want {
			t.Errorf("%s: scaling_active = %v, want %v", name, got, c.want)
		}
	}
}
