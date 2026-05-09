package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// --- StorageClasses ---

// GetStorageClasses lists all storage classes.
func (s *Service) GetStorageClasses(ctx context.Context) ([]map[string]interface{}, error) {
	scList, err := s.Clientset().StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
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
		sc, scErr = s.Clientset().StorageV1().StorageClasses().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		pvList, pvErr = s.Clientset().CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		pvcList, pvcErr = s.Clientset().CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events("").List(ctx, metav1.ListOptions{
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
				"pv_count":        pvCount,
				"pv_bound_count":  pvBoundCount,
				"pvc_count":       pvcCount,
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
	return s.Clientset().StorageV1().StorageClasses().Delete(ctx, name, metav1.DeleteOptions{})
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
