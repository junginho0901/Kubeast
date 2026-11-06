// Package volumeattachment is a VolumeAttachment as Kubeast lists it, one row for the list, the drawer and the live
// list updates alike.
package volumeattachment

import (
	"time"

	storagev1 "k8s.io/api/storage/v1"
)

// Info is the attachment's row: what it attaches where, whether it is attached, and an error only while there is one.
func Info(va *storagev1.VolumeAttachment) map[string]interface{} {
	pvName := ""
	if va.Spec.Source.PersistentVolumeName != nil {
		pvName = *va.Spec.Source.PersistentVolumeName
	}
	created := ""
	if !va.CreationTimestamp.IsZero() {
		created = va.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	result := map[string]interface{}{
		"name":                   va.Name,
		"attacher":               va.Spec.Attacher,
		"node_name":              va.Spec.NodeName,
		"persistent_volume_name": pvName,
		"attached":               va.Status.Attached,
		"created_at":             created,
	}

	if va.Status.AttachError != nil {
		result["attach_error"] = map[string]interface{}{
			"message": va.Status.AttachError.Message,
			"time":    va.Status.AttachError.Time.UTC().Format("2006-01-02T15:04:05Z"),
		}
	}
	if va.Status.DetachError != nil {
		result["detach_error"] = map[string]interface{}{
			"message": va.Status.DetachError.Message,
			"time":    va.Status.DetachError.Time.UTC().Format("2006-01-02T15:04:05Z"),
		}
	}

	return result
}
