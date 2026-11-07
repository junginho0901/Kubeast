package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	pvcrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/pvc"
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
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		pvcList, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all pvcs: %w", err)
		}
		return formatPVCList(pvcList.Items), nil
	})
}

// DescribePVC returns detailed info about a PVC.
func (s *Service) DescribePVC(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	pvc, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get pvc %s/%s: %w", namespace, name, err)
	}

	// Fetch bound PV, pods, and events in parallel
	var boundPV *corev1.PersistentVolume
	var pods []corev1.Pod
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
		// a page at a time, keeping the pods kubectl describe's getPodsForPVC keeps (the whole namespace in one list
		// took k8s-service past 512 Mi)
		users := newPVCUsers(name, pvc)
		podsErr = eachPod(ctx, s.clientsetCtx(ctx).CoreV1(), namespace, metav1.ListOptions{}, func(p *corev1.Pod) {
			if users.keeps(p) {
				pods = append(pods, *p.DeepCopy())
			}
		})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.objectEvents(ctx, namespace, "PersistentVolumeClaim", name)
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
	if podsErr == nil {
		result["used_by_pods"] = findPodsUsingPVC(pods, newPVCUsers(name, pvc))
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
	setEvents(result, events, eventsErr)

	attachPVCUsage([]map[string]interface{}{result}, s.pvcUsage(ctx))
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

// formatPVCDetail is the claim's row (pvcrow.Info), the same for the list, describe and the live updates.
func formatPVCDetail(c *corev1.PersistentVolumeClaim) map[string]interface{} {
	return pvcrow.Info(c)
}

// pvcUsers are the pods kubectl describe pvc lists as "Used By" (v1.37 getPodsForPVC): the pods with a
// persistentVolumeClaim volume of the claim, and a pod the claim names as its owner — a generic ephemeral volume's
// claim, which its pod mounts through spec.volumes[].ephemeral, not by the claim's name.
type pvcUsers struct {
	claim  string
	owners map[types.UID]bool
}

// newPVCUsers reads the owners from the claim; without the claim (it could not be read) only the mounts count.
func newPVCUsers(claim string, pvc *corev1.PersistentVolumeClaim) pvcUsers {
	u := pvcUsers{claim: claim, owners: map[types.UID]bool{}}
	if pvc != nil {
		for _, ref := range pvc.OwnerReferences {
			if ref.Kind == "Pod" {
				u.owners[ref.UID] = true
			}
		}
	}
	return u
}

// mounts are the pod's volumes of the claim: persistentVolumeClaim volumes by name, and the ephemeral volume whose
// claim it is (named <pod>-<volume>, as k8s.io/component-helpers ephemeral.VolumeClaimName names it).
func (u pvcUsers) mounts(p *corev1.Pod) []string {
	names := make([]string, 0)
	for _, vol := range p.Spec.Volumes {
		if vol.PersistentVolumeClaim != nil && vol.PersistentVolumeClaim.ClaimName == u.claim {
			names = append(names, vol.Name)
		}
	}
	if u.owners[p.UID] {
		for _, vol := range p.Spec.Volumes {
			if vol.Ephemeral != nil && p.Name+"-"+vol.Name == u.claim {
				names = append(names, vol.Name)
			}
		}
	}
	return names
}

func (u pvcUsers) byName(p *corev1.Pod) bool {
	for _, vol := range p.Spec.Volumes {
		if vol.PersistentVolumeClaim != nil && vol.PersistentVolumeClaim.ClaimName == u.claim {
			return true
		}
	}
	return false
}

func (u pvcUsers) keeps(p *corev1.Pod) bool { return u.byName(p) || u.owners[p.UID] }

// findPodsUsingPVC lists the claim's users in kubectl's order — the pods that mount it by name in the list's order,
// then the owner pods not among them — with their STATUS, READY and RESTARTS as kubectl get pods prints them. A pod
// is one row whatever the number of its volumes of the claim (kubectl repeats it per volume).
func findPodsUsingPVC(pods []corev1.Pod, users pvcUsers) []map[string]interface{} {
	ordered := make([]*corev1.Pod, 0, len(pods))
	for i := range pods {
		if users.byName(&pods[i]) {
			ordered = append(ordered, &pods[i])
		}
	}
	for i := range pods {
		if users.owners[pods[i].UID] && !users.byName(&pods[i]) {
			ordered = append(ordered, &pods[i])
		}
	}
	result := make([]map[string]interface{}, 0, len(ordered))
	for _, pod := range ordered {
		status, ready, total, restarts := podListView(pod)
		result = append(result, map[string]interface{}{
			"name":          pod.Name,
			"namespace":     pod.Namespace,
			"status":        status,
			"phase":         string(pod.Status.Phase),
			"node_name":     pod.Spec.NodeName,
			"ready":         fmt.Sprintf("%d/%d", ready, total),
			"restart_count": restarts,
			"volume_names":  users.mounts(pod),
			"created_at":    toISO(&pod.CreationTimestamp),
		})
	}
	return result
}
