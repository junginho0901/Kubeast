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

// --- PersistentVolumeClaims ---

// GetPVCs lists PVCs in a namespace.
func (s *Service) GetPVCs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	pvcList, err := s.clientset.CoreV1().PersistentVolumeClaims(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pvcs: %w", err)
	}
	return formatPVCList(pvcList.Items), nil
}

// GetAllPVCs lists PVCs across all namespaces.
func (s *Service) GetAllPVCs(ctx context.Context) ([]map[string]interface{}, error) {
	pvcList, err := s.clientset.CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all pvcs: %w", err)
	}
	return formatPVCList(pvcList.Items), nil
}

// DescribePVC returns detailed info about a PVC.
func (s *Service) DescribePVC(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	pvc, err := s.clientset.CoreV1().PersistentVolumeClaims(namespace).Get(ctx, name, metav1.GetOptions{})
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
			boundPV, pvErr = s.clientset.CoreV1().PersistentVolumes().Get(ctx, pvc.Spec.VolumeName, metav1.GetOptions{})
		}
	}()
	go func() {
		defer wg.Done()
		pods, podsErr = s.clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
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
			"status":              string(c.Status),
			"reason":              c.Reason,
			"message":             c.Message,
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
	return s.clientset.CoreV1().PersistentVolumeClaims(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// --- PersistentVolumes ---

// GetPVs lists all PVs.
func (s *Service) GetPVs(ctx context.Context) ([]map[string]interface{}, error) {
	pvList, err := s.clientset.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pvs: %w", err)
	}
	return formatPVList(pvList.Items), nil
}

// GetPV returns a single PV.
func (s *Service) GetPV(ctx context.Context, name string) (map[string]interface{}, error) {
	pv, err := s.clientset.CoreV1().PersistentVolumes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get pv %s: %w", name, err)
	}
	return formatPVDetail(pv), nil
}

// DescribePV returns detailed info about a PV.
func (s *Service) DescribePV(ctx context.Context, name string) (map[string]interface{}, error) {
	pv, err := s.clientset.CoreV1().PersistentVolumes().Get(ctx, name, metav1.GetOptions{})
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
			boundPVC, pvcErr = s.clientset.CoreV1().PersistentVolumeClaims(pv.Spec.ClaimRef.Namespace).Get(ctx, pv.Spec.ClaimRef.Name, metav1.GetOptions{})
		}
	}()
	go func() {
		defer wg.Done()
		if pv.Spec.ClaimRef != nil && pv.Spec.ClaimRef.Name != "" {
			pods, podsErr = s.clientset.CoreV1().Pods(pv.Spec.ClaimRef.Namespace).List(ctx, metav1.ListOptions{})
		}
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{
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
	return s.clientset.CoreV1().PersistentVolumes().Delete(ctx, name, metav1.DeleteOptions{})
}

// --- StorageClasses ---

// GetStorageClasses lists all storage classes.
func (s *Service) GetStorageClasses(ctx context.Context) ([]map[string]interface{}, error) {
	scList, err := s.clientset.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list storage classes: %w", err)
	}
	return formatStorageClassList(scList.Items), nil
}

// DescribeStorageClass returns detailed info about a storage class.
func (s *Service) DescribeStorageClass(ctx context.Context, name string) (map[string]interface{}, error) {
	// Fetch SC, PVs, PVCs, and events in parallel
	var sc *storagev1.StorageClass
	var pvList *corev1.PersistentVolumeList
	var pvcList *corev1.PersistentVolumeClaimList
	var events *corev1.EventList
	var scErr, pvErr, pvcErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(4)
	go func() {
		defer wg.Done()
		sc, scErr = s.clientset.StorageV1().StorageClasses().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		pvList, pvErr = s.clientset.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		pvcList, pvcErr = s.clientset.CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=StorageClass", name),
		})
	}()
	wg.Wait()

	if scErr != nil {
		return nil, fmt.Errorf("get storage class %s: %w", name, scErr)
	}

	result := formatStorageClassDetail(sc)

	// Additional describe fields
	result["uid"] = string(sc.UID)
	result["resource_version"] = sc.ResourceVersion
	result["finalizers"] = sc.Finalizers
	result["labels"] = sc.Labels
	result["annotations"] = sc.Annotations
	result["parameters"] = sc.Parameters
	result["mount_options"] = sc.MountOptions

	if sc.AllowedTopologies != nil {
		topos := make([]map[string]interface{}, 0, len(sc.AllowedTopologies))
		for _, t := range sc.AllowedTopologies {
			exprs := make([]map[string]interface{}, 0, len(t.MatchLabelExpressions))
			for _, e := range t.MatchLabelExpressions {
				exprs = append(exprs, map[string]interface{}{
					"key":    e.Key,
					"values": e.Values,
				})
			}
			topos = append(topos, map[string]interface{}{
				"match_label_expressions": exprs,
			})
		}
		result["allowed_topologies"] = topos
	}

	// Usage stats and related resources
	if pvErr == nil && pvList != nil {
		pvCount := 0
		pvBoundCount := 0
		relatedPVs := make([]map[string]interface{}, 0)
		for _, pv := range pvList.Items {
			if pv.Spec.StorageClassName == name {
				pvCount++
				if pv.Status.Phase == corev1.VolumeBound {
					pvBoundCount++
				}
				pvCapacity := ""
				if pv.Spec.Capacity != nil {
					if q, ok := pv.Spec.Capacity[corev1.ResourceStorage]; ok {
						pvCapacity = q.String()
					}
				}
				pvEntry := map[string]interface{}{
					"name":       pv.Name,
					"status":     string(pv.Status.Phase),
					"capacity":   pvCapacity,
					"created_at": toISO(&pv.CreationTimestamp),
				}
				if pv.Spec.ClaimRef != nil {
					pvEntry["claim_ref"] = map[string]interface{}{
						"namespace": pv.Spec.ClaimRef.Namespace,
						"name":      pv.Spec.ClaimRef.Name,
					}
				}
				relatedPVs = append(relatedPVs, pvEntry)
			}
		}
		result["related_pvs"] = relatedPVs

		if pvcErr == nil && pvcList != nil {
			pvcCount := 0
			pvcBoundCount := 0
			relatedPVCs := make([]map[string]interface{}, 0)
			for _, pvc := range pvcList.Items {
				scName := ""
				if pvc.Spec.StorageClassName != nil {
					scName = *pvc.Spec.StorageClassName
				}
				if scName == name {
					pvcCount++
					if pvc.Status.Phase == corev1.ClaimBound {
						pvcBoundCount++
					}
					pvcCapacity := ""
					if pvc.Status.Capacity != nil {
						if q, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok {
							pvcCapacity = q.String()
						}
					}
					pvcRequested := ""
					if pvc.Spec.Resources.Requests != nil {
						if q, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
							pvcRequested = q.String()
						}
					}
					relatedPVCs = append(relatedPVCs, map[string]interface{}{
						"name":        pvc.Name,
						"namespace":   pvc.Namespace,
						"status":      string(pvc.Status.Phase),
						"requested":   pvcRequested,
						"capacity":    pvcCapacity,
						"volume_name": pvc.Spec.VolumeName,
						"created_at":  toISO(&pvc.CreationTimestamp),
					})
				}
			}
			result["related_pvcs"] = relatedPVCs
			result["usage"] = map[string]interface{}{
				"pv_count":       pvCount,
				"pv_bound_count": pvBoundCount,
				"pvc_count":      pvcCount,
				"pvc_bound_count": pvcBoundCount,
			}
		}
	}

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteStorageClass deletes a storage class.
func (s *Service) DeleteStorageClass(ctx context.Context, name string) error {
	return s.clientset.StorageV1().StorageClasses().Delete(ctx, name, metav1.DeleteOptions{})
}

// --- VolumeAttachments ---

// GetVolumeAttachments lists all volume attachments.
func (s *Service) GetVolumeAttachments(ctx context.Context) ([]map[string]interface{}, error) {
	vaList, err := s.clientset.StorageV1().VolumeAttachments().List(ctx, metav1.ListOptions{})
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
	va, err := s.clientset.StorageV1().VolumeAttachments().Get(ctx, name, metav1.GetOptions{})
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
			pv, pvErr = s.clientset.CoreV1().PersistentVolumes().Get(ctx, pvName, metav1.GetOptions{})
		}
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{
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
	return s.clientset.StorageV1().VolumeAttachments().Delete(ctx, name, metav1.DeleteOptions{})
}

// --- Formatting helpers ---

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
		"created_at":     toISO(&pv.CreationTimestamp),
	}
}

func formatStorageClassList(scs []storagev1.StorageClass) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(scs))
	for _, sc := range scs {
		result = append(result, formatStorageClassDetail(&sc))
	}
	return result
}

func formatStorageClassDetail(sc *storagev1.StorageClass) map[string]interface{} {
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

	isDefault := false
	if v, ok := sc.Annotations["storageclass.kubernetes.io/is-default-class"]; ok && v == "true" {
		isDefault = true
	}

	return map[string]interface{}{
		"name":                   sc.Name,
		"provisioner":            sc.Provisioner,
		"reclaim_policy":         reclaimPolicy,
		"volume_binding_mode":    volumeBindingMode,
		"allow_volume_expansion": allowExpansion,
		"is_default":             isDefault,
		"parameters":             sc.Parameters,
		"mount_options":          sc.MountOptions,
		"labels":                 sc.Labels,
		"annotations":            sc.Annotations,
		"created_at":             toISO(&sc.CreationTimestamp),
	}
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
