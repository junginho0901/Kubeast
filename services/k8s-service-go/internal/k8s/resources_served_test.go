package k8s

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// Re-QA #37: a Gateway API or VPA list on a cluster without the CRD is "not
// installed", told apart from "none" and "no permission" by discovery.
func TestResourceServed(t *testing.T) {
	s := &Service{
		apiResourcesCache: map[cluster.ID][]metav1.APIResourceList{
			"self": {
				{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods"}}},
				{GroupVersion: "gateway.networking.k8s.io/v1", APIResources: []metav1.APIResource{{Name: "gateways"}, {Name: "httproutes"}}},
				{GroupVersion: "gateway.networking.k8s.io/v1beta1", APIResources: []metav1.APIResource{{Name: "referencegrants"}}},
			},
		},
		apiResourcesAt: map[cluster.ID]time.Time{"self": time.Now()},
	}
	ctx := cluster.WithID(context.Background(), "self")
	for _, c := range []struct {
		group, resource string
		want            bool
	}{
		{"gateway.networking.k8s.io", "httproutes", true},
		{"gateway.networking.k8s.io", "referencegrants", true}, // any version
		{"gateway.networking.k8s.io", "grpcroutes", false},
		{"autoscaling.k8s.io", "verticalpodautoscalers", false},
		{"", "pods", true},
		{"apps", "pods", false}, // the group must match too
	} {
		if got := s.ResourceServed(ctx, c.group, c.resource); got != c.want {
			t.Errorf("ResourceServed(%q, %q) = %v, want %v", c.group, c.resource, got, c.want)
		}
	}
}
