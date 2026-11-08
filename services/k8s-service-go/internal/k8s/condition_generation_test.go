package k8s

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// What each drawer's condition table reads: the generation a condition was written for, under the answers' snake case,
// where the object has it, and no key where it does not.
func TestAConditionsGenerationReachesTheDrawer(t *testing.T) {
	typed := func(kind, version string) metav1.TypeMeta { return metav1.TypeMeta{Kind: kind, APIVersion: version} }
	api := &clusterDrawersAPI{objects: map[string]interface{}{
		"/apis/policy/v1/namespaces/shop/poddisruptionbudgets/web": policyv1.PodDisruptionBudget{
			TypeMeta:   typed("PodDisruptionBudget", "policy/v1"),
			ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"},
			Status: policyv1.PodDisruptionBudgetStatus{Conditions: []metav1.Condition{
				{Type: "DisruptionAllowed", Status: metav1.ConditionTrue, ObservedGeneration: 4},
				{Type: "Other", Status: metav1.ConditionTrue},
			}},
		},
		"/api/v1/namespaces/shop/services/web": corev1.Service{
			TypeMeta:   typed("Service", "v1"),
			ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"},
			Status: corev1.ServiceStatus{Conditions: []metav1.Condition{
				{Type: "LoadBalancerReady", Status: metav1.ConditionTrue, ObservedGeneration: 9},
			}},
		},
		"/api/v1/namespaces/shop/pods/web-0": corev1.Pod{
			TypeMeta:   typed("Pod", "v1"),
			ObjectMeta: metav1.ObjectMeta{Name: "web-0", Namespace: "shop"},
			Status: corev1.PodStatus{Conditions: []corev1.PodCondition{
				{Type: corev1.PodReady, Status: corev1.ConditionTrue, ObservedGeneration: 2},
				{Type: corev1.PodScheduled, Status: corev1.ConditionTrue},
			}},
		},
	}}
	s := newClusterDrawersService(t, api)
	ctx := context.Background()

	generations := func(t *testing.T, out map[string]interface{}, err error) []interface{} {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		conditions, _ := out["conditions"].([]map[string]interface{})
		got := make([]interface{}, 0, len(conditions))
		for _, c := range conditions {
			got = append(got, c["observed_generation"])
		}
		return got
	}
	check := func(t *testing.T, got, want []interface{}) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("condition %d: observed_generation = %#v, want %#v", i, got[i], want[i])
			}
		}
	}

	t.Run("PodDisruptionBudget", func(t *testing.T) {
		out, err := s.DescribePDB(ctx, "shop", "web")
		check(t, generations(t, out, err), []interface{}{int64(4), nil})
	})
	t.Run("Service", func(t *testing.T) {
		out, err := s.DescribeService(ctx, "shop", "web")
		check(t, generations(t, out, err), []interface{}{int64(9)})
	})
	t.Run("Pod", func(t *testing.T) {
		out, err := s.DescribePod(ctx, "shop", "web-0")
		check(t, generations(t, out, err), []interface{}{int64(2), nil})
	})
}
