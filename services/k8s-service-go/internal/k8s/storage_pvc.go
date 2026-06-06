package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// --- PersistentVolumeClaims ---

// GetPVCs lists PVCs in a namespace.
func (s *Service) GetPVCs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	pvcList, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pvcs: %w", err)
	}
	return formatPVCList(pvcList.Items), nil
}

// GetAllPVCs lists PVCs across all namespaces.
func (s *Service) GetAllPVCs(ctx context.Context) ([]map[string]interface{}, error) {
	pvcList, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all pvcs: %w", err)
	}
	return formatPVCList(pvcList.Items), nil
}

// DescribePVC returns detailed info about a PVC.
func (s *Service) DescribePVC(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	pvc, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get pvc %s/%s: %w", namespace, name, err)
	}

	// Fetch bound PV, pods, and events in parallel
	var boundPV *corev1.PersistentVolume
	var pods *corev1.PodList
	var events *corev1.EventList
	var pvErr, podsErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		if pvc.Spec.VolumeName != "" {
			boundPV, pvErr = s.clientsetCtx(ctx).CoreV1().PersistentVolumes().Get(ctx, pvc.Spec.VolumeName, metav1.GetOptions{})
		}
	}()
	go func() {
		defer wg.Done()
		pods, podsErr = s.clientsetCtx(ctx).CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=PersistentVolumeClaim", name),
		})
	}()
	wg.Wait()

	result := formatPVCDetail(pvc)

	// Additional describe fields
	result["uid"] = string(pvc.UID)
	result["resource_version"] = pvc.ResourceVersion
	result["finalizers"] = pvc.Finalizers
	result["labels"] = pvc.Labels
	result["annotations"] = pvc.Annotations

	// Volume mode
	if pvc.Spec.VolumeMode != nil {
		result["volume_mode"] = string(*pvc.Spec.VolumeMode)
	} else {
		result["volume_mode"] = "Filesystem"
	}

	// Selected node annotation
	if node, ok := pvc.Annotations["volume.kubernetes.io/selected-node"]; ok {
		result["selected_node"] = node
	}

	// Data source
	if pvc.Spec.DataSource != nil {
		ds := map[string]interface{}{
			"kind": pvc.Spec.DataSource.Kind,
			"name": pvc.Spec.DataSource.Name,
		}
		if pvc.Spec.DataSource.APIGroup != nil {
			ds["api_group"] = *pvc.Spec.DataSource.APIGroup
		}
		result["data_source"] = ds
	}

	// Data source ref
	if pvc.Spec.DataSourceRef != nil {
		dsRef := map[string]interface{}{
			"kind": pvc.Spec.DataSourceRef.Kind,
			"name": pvc.Spec.DataSourceRef.Name,
		}
		if pvc.Spec.DataSourceRef.APIGroup != nil {
			dsRef["api_group"] = *pvc.Spec.DataSourceRef.APIGroup
		}
		if pvc.Spec.DataSourceRef.Namespace != nil {
			dsRef["namespace"] = *pvc.Spec.DataSourceRef.Namespace
		}
		result["data_source_ref"] = dsRef
	}

	// Bound PV summary
	if pvErr == nil && boundPV != nil {
		pvAccessModes := make([]string, 0, len(boundPV.Spec.AccessModes))
		for _, am := range boundPV.Spec.AccessModes {
			pvAccessModes = append(pvAccessModes, string(am))
		}
		pvCapacity := ""
		if boundPV.Spec.Capacity != nil {
			if q, ok := boundPV.Spec.Capacity[corev1.ResourceStorage]; ok {
				pvCapacity = q.String()
			}
		}
		pvVolumeMode := ""
		if boundPV.Spec.VolumeMode != nil {
			pvVolumeMode = string(*boundPV.Spec.VolumeMode)
		}
		result["bound_pv"] = map[string]interface{}{
			"name":           boundPV.Name,
			"status":         string(boundPV.Status.Phase),
			"capacity":       pvCapacity,
			"access_modes":   pvAccessModes,
			"storage_class":  boundPV.Spec.StorageClassName,
			"reclaim_policy": string(boundPV.Spec.PersistentVolumeReclaimPolicy),
			"volume_mode":    pvVolumeMode,
		}
	}

	// Used by pods
	if podsErr == nil && pods != nil {
		usedByPods := findPodsUsingPVC(pods.Items, name)
		result["used_by_pods"] = usedByPods
	}

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(pvc.Status.Conditions))
	resizeConditions := make([]map[string]interface{}, 0)
	filesystemResizePending := false
	for _, c := range pvc.Status.Conditions {
		cond := map[string]interface{}{
			"type":                 string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		}
		conditions = append(conditions, cond)
		if c.Type == corev1.PersistentVolumeClaimResizing || c.Type == corev1.PersistentVolumeClaimFileSystemResizePending {
			resizeConditions = append(resizeConditions, cond)
			if c.Type == corev1.PersistentVolumeClaimFileSystemResizePending && c.Status == corev1.ConditionTrue {
				filesystemResizePending = true
			}
		}
	}
	result["conditions"] = conditions
	result["resize_conditions"] = resizeConditions
	result["filesystem_resize_pending"] = filesystemResizePending

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeletePVC deletes a PVC.
func (s *Service) DeletePVC(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatPVCList(pvcs []corev1.PersistentVolumeClaim) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(pvcs))
	for _, pvc := range pvcs {
		result = append(result, formatPVCDetail(&pvc))
	}
	return result
}

func formatPVCDetail(pvc *corev1.PersistentVolumeClaim) map[string]interface{} {
	capacity := ""
	if pvc.Status.Capacity != nil {
		if q, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok {
			capacity = q.String()
		}
	}

	request := ""
	if pvc.Spec.Resources.Requests != nil {
		if q, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
			request = q.String()
		}
	}

	accessModes := make([]string, 0, len(pvc.Spec.AccessModes))
	for _, am := range pvc.Spec.AccessModes {
		accessModes = append(accessModes, string(am))
	}

	storageClass := ""
	if pvc.Spec.StorageClassName != nil {
		storageClass = *pvc.Spec.StorageClassName
	}

	return map[string]interface{}{
		"name":          pvc.Name,
		"namespace":     pvc.Namespace,
		"status":        string(pvc.Status.Phase),
		"volume_name":   pvc.Spec.VolumeName,
		"capacity":      capacity,
		"requested":     request,
		"access_modes":  accessModes,
		"storage_class": storageClass,
		"created_at":    toISO(&pvc.CreationTimestamp),
	}
}

// findPodsUsingPVC finds pods that reference a given PVC name.
func findPodsUsingPVC(pods []corev1.Pod, pvcName string) []map[string]interface{} {
	result := make([]map[string]interface{}, 0)
	for _, pod := range pods {
		volumeNames := make([]string, 0)
		for _, vol := range pod.Spec.Volumes {
			if vol.PersistentVolumeClaim != nil && vol.PersistentVolumeClaim.ClaimName == pvcName {
				volumeNames = append(volumeNames, vol.Name)
			}
		}
		if len(volumeNames) == 0 {
			continue
		}

		ready := 0
		total := len(pod.Spec.Containers)
		restarts := int32(0)
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.Ready {
				ready++
			}
			restarts += cs.RestartCount
		}

		result = append(result, map[string]interface{}{
			"name":          pod.Name,
			"namespace":     pod.Namespace,
			"phase":         string(pod.Status.Phase),
			"node_name":     pod.Spec.NodeName,
			"ready":         fmt.Sprintf("%d/%d", ready, total),
			"restart_count": restarts,
			"volume_names":  volumeNames,
			"created_at":    toISO(&pod.CreationTimestamp),
		})
	}
	return result
}
