// Package storageclass is a StorageClass as Kubeast lists it, one row for the list, the drawer and the live list
// updates alike.
package storageclass

import (
	"time"

	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// IsDefault is storageutil.IsDefaultAnnotation (Kubernetes v1.37): the class carries the default annotation or its
// beta form set to "true", which the DefaultStorageClass admission and kubectl both read.
func IsDefault(m metav1.ObjectMeta) bool {
	return m.Annotations["storageclass.kubernetes.io/is-default-class"] == "true" ||
		m.Annotations["storageclass.beta.kubernetes.io/is-default-class"] == "true"
}

// Info is the class's row. is_default is the annotation, as kubectl describe prints it; which annotated class is the
// one the cluster uses is a question of the whole list, answered where the list is.
func Info(sc *storagev1.StorageClass) map[string]interface{} {
	reclaimPolicy := ""
	if sc.ReclaimPolicy != nil {
		reclaimPolicy = string(*sc.ReclaimPolicy)
	}
	volumeBindingMode := ""
	if sc.VolumeBindingMode != nil {
		volumeBindingMode = string(*sc.VolumeBindingMode)
	}
	allowExpansion := false
	if sc.AllowVolumeExpansion != nil {
		allowExpansion = *sc.AllowVolumeExpansion
	}
	mountOptions := sc.MountOptions
	if mountOptions == nil {
		mountOptions = []string{}
	}
	created := ""
	if !sc.CreationTimestamp.IsZero() {
		created = sc.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":                   sc.Name,
		"provisioner":            sc.Provisioner,
		"reclaim_policy":         reclaimPolicy,
		"volume_binding_mode":    volumeBindingMode,
		"allow_volume_expansion": allowExpansion,
		"is_default":             IsDefault(sc.ObjectMeta),
		"parameters":             sc.Parameters,
		"mount_options":          mountOptions,
		"labels":                 sc.Labels,
		"annotations":            sc.Annotations,
		"created_at":             created,
	}
}
