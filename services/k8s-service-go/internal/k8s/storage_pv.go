package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// --- PersistentVolumes ---

// GetPVs lists all PVs.
func (s *Service) GetPVs(ctx context.Context) ([]map[string]interface{}, error) {
	pvList, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pvs: %w", err)
	}
	return formatPVList(pvList.Items), nil
}

// GetPV returns a single PV.
func (s *Service) GetPV(ctx context.Context, name string) (map[string]interface{}, error) {
	pv, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get pv %s: %w", name, err)
	}
	return formatPVDetail(pv), nil
}

// DescribePV returns detailed info about a PV.
func (s *Service) DescribePV(ctx context.Context, name string) (map[string]interface{}, error) {
	pv, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get pv %s: %w", name, err)
	}

	// Fetch bound PVC, pods, and events in parallel
	var boundPVC *corev1.PersistentVolumeClaim
	var pods *corev1.PodList
	var events *corev1.EventList
	var pvcErr, podsErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		if pv.Spec.ClaimRef != nil && pv.Spec.ClaimRef.Name != "" {
			boundPVC, pvcErr = s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims(pv.Spec.ClaimRef.Namespace).Get(ctx, pv.Spec.ClaimRef.Name, metav1.GetOptions{})
		}
	}()
	go func() {
		defer wg.Done()
		if pv.Spec.ClaimRef != nil && pv.Spec.ClaimRef.Name != "" {
			pods, podsErr = s.clientsetCtx(ctx).CoreV1().Pods(pv.Spec.ClaimRef.Namespace).List(ctx, metav1.ListOptions{})
		}
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=PersistentVolume", name),
		})
	}()
	wg.Wait()

	result := formatPVDetail(pv)

	// Additional describe fields
	result["uid"] = string(pv.UID)
	result["resource_version"] = pv.ResourceVersion
	result["finalizers"] = pv.Finalizers
	result["labels"] = pv.Labels
	result["annotations"] = pv.Annotations

	// Node affinity
	if pv.Spec.NodeAffinity != nil {
		naBytes, err := json.Marshal(pv.Spec.NodeAffinity)
		if err == nil {
			result["node_affinity"] = string(naBytes)
		}
	}

	// Last phase transition time
	if pv.Status.LastPhaseTransitionTime != nil {
		result["last_phase_transition_time"] = toISO(pv.Status.LastPhaseTransitionTime)
	}

	// Bound PVC summary
	if pvcErr == nil && boundPVC != nil {
		pvcAccessModes := make([]string, 0, len(boundPVC.Spec.AccessModes))
		for _, am := range boundPVC.Spec.AccessModes {
			pvcAccessModes = append(pvcAccessModes, string(am))
		}
		pvcCapacity := ""
		if boundPVC.Status.Capacity != nil {
			if q, ok := boundPVC.Status.Capacity[corev1.ResourceStorage]; ok {
				pvcCapacity = q.String()
			}
		}
		pvcRequested := ""
		if boundPVC.Spec.Resources.Requests != nil {
			if q, ok := boundPVC.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
				pvcRequested = q.String()
			}
		}
		pvcVolumeMode := ""
		if boundPVC.Spec.VolumeMode != nil {
			pvcVolumeMode = string(*boundPVC.Spec.VolumeMode)
		}
		pvcStorageClass := ""
		if boundPVC.Spec.StorageClassName != nil {
			pvcStorageClass = *boundPVC.Spec.StorageClassName
		}
		result["bound_claim"] = map[string]interface{}{
			"namespace":     boundPVC.Namespace,
			"name":          boundPVC.Name,
			"status":        string(boundPVC.Status.Phase),
			"requested":     pvcRequested,
			"capacity":      pvcCapacity,
			"storage_class": pvcStorageClass,
			"volume_mode":   pvcVolumeMode,
			"access_modes":  pvcAccessModes,
		}
	}

	// Used by pods (pods using the PVC bound to this PV)
	if podsErr == nil && pods != nil && pv.Spec.ClaimRef != nil {
		usedByPods := findPodsUsingPVC(pods.Items, pv.Spec.ClaimRef.Name)
		result["used_by_pods"] = usedByPods
	}

	// Conditions
	conditions := make([]map[string]interface{}, 0)
	// PV doesn't have status.conditions in the same way, but we include them if present
	// (future-proofing for when the API adds them)
	result["conditions"] = conditions

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeletePV deletes a PV.
func (s *Service) DeletePV(ctx context.Context, name string) error {
	return s.clientsetCtx(ctx).CoreV1().PersistentVolumes().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatPVList(pvs []corev1.PersistentVolume) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(pvs))
	for _, pv := range pvs {
		result = append(result, formatPVDetail(&pv))
	}
	return result
}

func formatPVDetail(pv *corev1.PersistentVolume) map[string]interface{} {
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

	reclaimPolicy := ""
	if pv.Spec.PersistentVolumeReclaimPolicy != "" {
		reclaimPolicy = string(pv.Spec.PersistentVolumeReclaimPolicy)
	}

	storageClass := pv.Spec.StorageClassName

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

	// Determine volume source info
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

	return map[string]interface{}{
		"name":           pv.Name,
		"status":         string(pv.Status.Phase),
		"capacity":       capacity,
		"access_modes":   accessModes,
		"reclaim_policy": reclaimPolicy,
		"storage_class":  storageClass,
		"claim_ref":      claimRef,
		"volume_mode":    volumeMode,
		"source":         source,
		"driver":         driver,
		"volume_handle":  volumeHandle,
		"reason":         pv.Status.Reason,
		"message":        pv.Status.Message,
		"created_at":     toISO(&pv.CreationTimestamp),
	}
}
