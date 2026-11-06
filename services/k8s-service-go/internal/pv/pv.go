// Package pv is a PersistentVolume as Kubeast lists it, one row for the list, the drawer and the live list updates
// alike.
package pv

import (
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Info is the volume's row: its phase and why, capacity, modes, class, claim and source.
func Info(pv *corev1.PersistentVolume) map[string]interface{} {
	capacity := ""
	if pv.Spec.Capacity != nil {
		if q, ok := pv.Spec.Capacity[corev1.ResourceStorage]; ok {
			capacity = q.String()
		}
	}

	accessModes := make([]string, 0, len(pv.Spec.AccessModes))
	for _, am := range pv.Spec.AccessModes {
		accessModes = append(accessModes, string(am))
	}

	var claimRef interface{}
	if pv.Spec.ClaimRef != nil {
		claimRef = map[string]interface{}{
			"namespace": pv.Spec.ClaimRef.Namespace,
			"name":      pv.Spec.ClaimRef.Name,
		}
	}

	volumeMode := ""
	if pv.Spec.VolumeMode != nil {
		volumeMode = string(*pv.Spec.VolumeMode)
	}

	source := ""
	driver := ""
	volumeHandle := ""
	if pv.Spec.CSI != nil {
		source = "CSI"
		driver = pv.Spec.CSI.Driver
		volumeHandle = pv.Spec.CSI.VolumeHandle
	} else if pv.Spec.NFS != nil {
		source = "NFS"
		driver = fmt.Sprintf("%s:%s", pv.Spec.NFS.Server, pv.Spec.NFS.Path)
	} else if pv.Spec.Local != nil {
		source = "Local"
		driver = pv.Spec.Local.Path
	} else if pv.Spec.HostPath != nil {
		source = "HostPath"
		driver = pv.Spec.HostPath.Path
	}

	created := ""
	if !pv.CreationTimestamp.IsZero() {
		created = pv.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return map[string]interface{}{
		"name":           pv.Name,
		"status":         string(pv.Status.Phase),
		"capacity":       capacity,
		"access_modes":   accessModes,
		"reclaim_policy": string(pv.Spec.PersistentVolumeReclaimPolicy),
		"storage_class":  pv.Spec.StorageClassName,
		"claim_ref":      claimRef,
		"volume_mode":    volumeMode,
		"source":         source,
		"driver":         driver,
		"volume_handle":  volumeHandle,
		"reason":         pv.Status.Reason,
		"message":        pv.Status.Message,
		"created_at":     created,
	}
}
