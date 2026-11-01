package pvc

import (
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// As kubectl's printPersistentVolumeClaim: capacity and access modes are the volume's once the claim is bound, empty
// before; what the claim asks for is kept apart.
func TestInfo(t *testing.T) {
	sc := "standard"
	claim := func(volume string, granted ...corev1.PersistentVolumeAccessMode) *corev1.PersistentVolumeClaim {
		c := &corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{Name: "data", Namespace: "qa", CreationTimestamp: metav1.Date(2026, 11, 1, 3, 4, 5, 0, metav1.Now().Location())},
			Spec: corev1.PersistentVolumeClaimSpec{
				AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce, corev1.ReadOnlyMany},
				Resources:        corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("1Gi")}},
				StorageClassName: &sc,
				VolumeName:       volume,
			},
		}
		if volume != "" {
			c.Status = corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound, AccessModes: granted, Capacity: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("2Gi")}}
		} else {
			c.Status = corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimPending}
		}
		return c
	}

	bound := Info(claim("pv-1", corev1.ReadWriteOnce))
	want := map[string]interface{}{
		"name": "data", "namespace": "qa", "status": "Bound", "volume_name": "pv-1", "capacity": "2Gi", "requested": "1Gi",
		"access_modes": []string{"ReadWriteOnce"}, "requested_access_modes": []string{"ReadWriteOnce", "ReadOnlyMany"},
		"storage_class": "standard", "created_at": claim("").CreationTimestamp.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
	if !reflect.DeepEqual(bound, want) {
		t.Fatalf("bound claim:\n got %#v\nwant %#v", bound, want)
	}

	pending := Info(claim(""))
	if pending["capacity"] != "" || len(pending["access_modes"].([]string)) != 0 {
		t.Fatalf("a claim not bound has no capacity or access modes yet: %#v", pending)
	}
	if !reflect.DeepEqual(pending["requested_access_modes"], []string{"ReadWriteOnce", "ReadOnlyMany"}) || pending["requested"] != "1Gi" {
		t.Fatalf("what the claim asks for: %#v", pending)
	}
}
