package storageclass

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// As storageutil.IsDefaultAnnotation: the annotation or its beta form, set to "true".
func TestIsDefault(t *testing.T) {
	for _, c := range []struct {
		annotations map[string]string
		want        bool
	}{
		{nil, false},
		{map[string]string{"storageclass.kubernetes.io/is-default-class": "true"}, true},
		{map[string]string{"storageclass.beta.kubernetes.io/is-default-class": "true"}, true},
		{map[string]string{"storageclass.kubernetes.io/is-default-class": "false"}, false},
		{map[string]string{"storageclass.kubernetes.io/is-default-class": "True"}, false},
		{map[string]string{"storageclass.kubernetes.io/is-default-class": "false", "storageclass.beta.kubernetes.io/is-default-class": "true"}, true},
	} {
		sc := &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "sc", Annotations: c.annotations}}
		if got := IsDefault(sc.ObjectMeta); got != c.want {
			t.Errorf("%v: IsDefault = %v, want %v", c.annotations, got, c.want)
		}
		if got := Info(sc)["is_default"]; got != c.want {
			t.Errorf("%v: row is_default = %v, want %v", c.annotations, got, c.want)
		}
	}
}

func TestInfo(t *testing.T) {
	retain := corev1.PersistentVolumeReclaimRetain
	immediate := storagev1.VolumeBindingImmediate
	expand := true
	sc := &storagev1.StorageClass{
		ObjectMeta:           metav1.ObjectMeta{Name: "fast", CreationTimestamp: metav1.Date(2026, 11, 1, 3, 4, 5, 0, metav1.Now().Location())},
		Provisioner:          "example.com/disk",
		ReclaimPolicy:        &retain,
		VolumeBindingMode:    &immediate,
		AllowVolumeExpansion: &expand,
		Parameters:           map[string]string{"type": "ssd"},
	}
	row := Info(sc)
	for k, want := range map[string]interface{}{
		"name": "fast", "provisioner": "example.com/disk", "reclaim_policy": "Retain", "volume_binding_mode": "Immediate",
		"allow_volume_expansion": true, "is_default": false, "created_at": sc.CreationTimestamp.UTC().Format("2006-01-02T15:04:05Z"),
	} {
		if row[k] != want {
			t.Errorf("%s = %v, want %v", k, row[k], want)
		}
	}
	if opts, ok := row["mount_options"].([]string); !ok || len(opts) != 0 {
		t.Errorf("mount_options = %#v, want an empty list", row["mount_options"])
	}
}
