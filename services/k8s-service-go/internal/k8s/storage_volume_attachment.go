package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// --- VolumeAttachments ---

// GetVolumeAttachments lists all volume attachments.
func (s *Service) GetVolumeAttachments(ctx context.Context) ([]map[string]interface{}, error) {
	vaList, err := s.Clientset().StorageV1().VolumeAttachments().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list volume attachments: %w", err)
	}

	result := make([]map[string]interface{}, 0, len(vaList.Items))
	for _, va := range vaList.Items {
		result = append(result, formatVolumeAttachment(&va))
	}
	return result, nil
}

// DescribeVolumeAttachment returns detailed info about a volume attachment.
func (s *Service) DescribeVolumeAttachment(ctx context.Context, name string) (map[string]interface{}, error) {
	va, err := s.Clientset().StorageV1().VolumeAttachments().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get volume attachment %s: %w", name, err)
	}

	pvName := ""
	if va.Spec.Source.PersistentVolumeName != nil {
		pvName = *va.Spec.Source.PersistentVolumeName
	}

	// Fetch PV and events in parallel
	var pv *corev1.PersistentVolume
	var events *corev1.EventList
	var pvErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if pvName != "" {
			pv, pvErr = s.Clientset().CoreV1().PersistentVolumes().Get(ctx, pvName, metav1.GetOptions{})
		}
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=VolumeAttachment", name),
		})
	}()
	wg.Wait()

	result := formatVolumeAttachment(va)

	// Additional describe fields
	result["uid"] = string(va.UID)
	result["resource_version"] = va.ResourceVersion
	result["finalizers"] = va.Finalizers
	result["labels"] = va.Labels
	result["annotations"] = va.Annotations

	// Attachment metadata
	if va.Status.AttachmentMetadata != nil {
		result["attachment_metadata"] = va.Status.AttachmentMetadata
	}

	// Inline volume spec
	if va.Spec.Source.InlineVolumeSpec != nil {
		specBytes, err := json.Marshal(va.Spec.Source.InlineVolumeSpec)
		if err == nil {
			result["source_inline_volume_spec"] = string(specBytes)
		}
	}

	// PV summary
	if pvErr == nil && pv != nil {
		pvAccessModes := make([]string, 0, len(pv.Spec.AccessModes))
		for _, am := range pv.Spec.AccessModes {
			pvAccessModes = append(pvAccessModes, string(am))
		}
		pvCapacity := ""
		if pv.Spec.Capacity != nil {
			if q, ok := pv.Spec.Capacity[corev1.ResourceStorage]; ok {
				pvCapacity = q.String()
			}
		}
		pvVolumeMode := ""
		if pv.Spec.VolumeMode != nil {
			pvVolumeMode = string(*pv.Spec.VolumeMode)
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
		result["pv_summary"] = map[string]interface{}{
			"name":           pv.Name,
			"status":         string(pv.Status.Phase),
			"capacity":       pvCapacity,
			"access_modes":   pvAccessModes,
			"storage_class":  pv.Spec.StorageClassName,
			"reclaim_policy": string(pv.Spec.PersistentVolumeReclaimPolicy),
			"volume_mode":    pvVolumeMode,
			"source":         source,
			"driver":         driver,
			"volume_handle":  volumeHandle,
		}
	}

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteVolumeAttachment deletes a volume attachment.
func (s *Service) DeleteVolumeAttachment(ctx context.Context, name string) error {
	return s.Clientset().StorageV1().VolumeAttachments().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatVolumeAttachment(va *storagev1.VolumeAttachment) map[string]interface{} {
	pvName := ""
	if va.Spec.Source.PersistentVolumeName != nil {
		pvName = *va.Spec.Source.PersistentVolumeName
	}

	result := map[string]interface{}{
		"name":                   va.Name,
		"attacher":               va.Spec.Attacher,
		"node_name":              va.Spec.NodeName,
		"persistent_volume_name": pvName,
		"attached":               va.Status.Attached,
		"created_at":             toISO(&va.CreationTimestamp),
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
