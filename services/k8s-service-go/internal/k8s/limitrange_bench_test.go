package k8s

import (
	"context"
	"strconv"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// One read of a LimitRange window's violating pods, a page at a time over the API server's JSON. The window reads them
// when the LimitRange changes, at most once a second. The stand-in's own encoding counts in the time.
func BenchmarkLimitRangeViolations(b *testing.B) {
	caps := corev1.LimitRange{
		TypeMeta:   metav1.TypeMeta{Kind: "LimitRange", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "caps", Namespace: "bulk"},
		Spec: corev1.LimitRangeSpec{Limits: []corev1.LimitRangeItem{{
			Type: corev1.LimitTypeContainer,
			Max:  corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("50m")},
		}}},
	}
	for _, pods := range []int{100, 1000, 5000} {
		b.Run(strconv.Itoa(pods), func(b *testing.B) {
			api := &listAPI{objects: map[string]any{"/api/v1/namespaces/bulk/limitranges/caps": caps}}
			for i := range pods {
				api.pods = append(api.pods, bulkPod(i, "web", corev1.PodRunning, "100m", "64Mi"))
			}
			s := api.serve(b)
			ctx := context.Background()
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				rows, err := s.ListPodsViolatingLimitRange(ctx, "bulk", "caps")
				if err != nil {
					b.Fatal(err)
				}
				if len(rows) != pods {
					b.Fatalf("%d rows, want %d", len(rows), pods)
				}
			}
		})
	}
}
