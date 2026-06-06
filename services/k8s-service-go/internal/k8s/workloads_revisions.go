package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// Workload revision history & rollback. Split out of workloads.go
// because rollback is a distinct concern from list/describe and
// the controller-revision plumbing is itself ~370 lines.

// ========== Revision History & Rollback ==========

// GetRevisionHistory returns the revision history for a Deployment, DaemonSet, or StatefulSet.
func (s *Service) GetRevisionHistory(ctx context.Context, namespace, name, kind string) ([]map[string]interface{}, error) {
	switch kind {
	case "Deployment":
		return s.getDeploymentRevisionHistory(ctx, namespace, name)
	case "DaemonSet":
		return s.getControllerRevisionHistory(ctx, namespace, name, "DaemonSet")
	case "StatefulSet":
		return s.getControllerRevisionHistory(ctx, namespace, name, "StatefulSet")
	default:
		return nil, fmt.Errorf("unsupported workload kind for revision history: %s", kind)
	}
}

func (s *Service) getDeploymentRevisionHistory(ctx context.Context, namespace, name string) ([]map[string]interface{}, error) {
	deploy, err := s.clientsetCtx(ctx).AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get deployment %s/%s: %w", namespace, name, err)
	}

	rsList, err := s.clientsetCtx(ctx).AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list replicasets in %s: %w", namespace, err)
	}

	// Get current template hash from the deployment
	currentHash := deploy.Labels["pod-template-hash"]
	if currentHash == "" && deploy.Spec.Template.Labels != nil {
		currentHash = deploy.Spec.Template.Labels["pod-template-hash"]
	}

	revisions := make([]map[string]interface{}, 0)
	for _, rs := range rsList.Items {
		// Filter by ownerReference matching the Deployment
		owned := false
		for _, ref := range rs.OwnerReferences {
			if ref.Kind == "Deployment" && ref.Name == name {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}

		revStr, ok := rs.Annotations["deployment.kubernetes.io/revision"]
		if !ok {
			continue
		}
		rev, err := strconv.ParseInt(revStr, 10, 64)
		if err != nil {
			continue
		}

		images := make([]string, 0, len(rs.Spec.Template.Spec.Containers))
		for _, c := range rs.Spec.Template.Spec.Containers {
			images = append(images, c.Image)
		}

		// Determine if this RS is the current one by matching template hash
		rsHash := rs.Labels["pod-template-hash"]
		isCurrent := rsHash != "" && rsHash == currentHash

		revisions = append(revisions, map[string]interface{}{
			"revision":   rev,
			"images":     images,
			"created_at": toISO(&rs.CreationTimestamp),
			"is_current": isCurrent,
			"name":       rs.Name,
			"replicas":   rs.Status.Replicas,
		})
	}

	sort.Slice(revisions, func(i, j int) bool {
		return revisions[i]["revision"].(int64) < revisions[j]["revision"].(int64)
	})

	return revisions, nil
}

func (s *Service) getControllerRevisionHistory(ctx context.Context, namespace, name, kind string) ([]map[string]interface{}, error) {
	crList, err := s.clientsetCtx(ctx).AppsV1().ControllerRevisions(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list controller revisions in %s: %w", namespace, err)
	}

	// Find the highest revision to determine current
	var maxRevision int64
	revisions := make([]map[string]interface{}, 0)

	for _, cr := range crList.Items {
		// Filter by ownerReference
		owned := false
		for _, ref := range cr.OwnerReferences {
			if ref.Kind == kind && ref.Name == name {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}

		if cr.Revision > maxRevision {
			maxRevision = cr.Revision
		}

		// Extract images from the revision data
		images := extractImagesFromControllerRevision(&cr)

		revisions = append(revisions, map[string]interface{}{
			"revision":   cr.Revision,
			"images":     images,
			"created_at": toISO(&cr.CreationTimestamp),
			"is_current": false, // will be set below
			"name":       cr.Name,
		})
	}

	// Mark current revision
	for i := range revisions {
		if revisions[i]["revision"].(int64) == maxRevision {
			revisions[i]["is_current"] = true
		}
	}

	sort.Slice(revisions, func(i, j int) bool {
		return revisions[i]["revision"].(int64) < revisions[j]["revision"].(int64)
	})

	return revisions, nil
}

// extractImagesFromControllerRevision tries to extract container images from ControllerRevision data.
func extractImagesFromControllerRevision(cr *appsv1.ControllerRevision) []string {
	images := make([]string, 0)
	if cr.Data.Raw == nil {
		return images
	}

	// The Data.Raw typically contains either:
	// - A full DaemonSet/StatefulSet spec
	// - A strategic merge patch with spec.template
	var raw map[string]interface{}
	if err := json.Unmarshal(cr.Data.Raw, &raw); err != nil {
		return images
	}

	// Try spec.template.spec.containers path
	spec, ok := raw["spec"].(map[string]interface{})
	if !ok {
		return images
	}
	template, ok := spec["template"].(map[string]interface{})
	if !ok {
		return images
	}
	templateSpec, ok := template["spec"].(map[string]interface{})
	if !ok {
		return images
	}
	containers, ok := templateSpec["containers"].([]interface{})
	if !ok {
		return images
	}
	for _, c := range containers {
		container, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		if image, ok := container["image"].(string); ok {
			images = append(images, image)
		}
	}
	return images
}

// RollbackWorkload rolls back a Deployment, DaemonSet, or StatefulSet to a specific revision.
func (s *Service) RollbackWorkload(ctx context.Context, namespace, name, kind string, toRevision int64) error {
	switch kind {
	case "Deployment":
		return s.rollbackDeployment(ctx, namespace, name, toRevision)
	case "DaemonSet":
		return s.rollbackDaemonSet(ctx, namespace, name, toRevision)
	case "StatefulSet":
		return s.rollbackStatefulSet(ctx, namespace, name, toRevision)
	default:
		return fmt.Errorf("unsupported workload kind for rollback: %s", kind)
	}
}

func (s *Service) rollbackDeployment(ctx context.Context, namespace, name string, toRevision int64) error {
	rsList, err := s.clientsetCtx(ctx).AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list replicasets in %s: %w", namespace, err)
	}

	// Find the RS with the target revision
	var targetRS *appsv1.ReplicaSet
	for i, rs := range rsList.Items {
		owned := false
		for _, ref := range rs.OwnerReferences {
			if ref.Kind == "Deployment" && ref.Name == name {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}
		revStr, ok := rs.Annotations["deployment.kubernetes.io/revision"]
		if !ok {
			continue
		}
		rev, err := strconv.ParseInt(revStr, 10, 64)
		if err != nil {
			continue
		}
		if rev == toRevision {
			targetRS = &rsList.Items[i]
			break
		}
	}

	if targetRS == nil {
		return fmt.Errorf("revision %d not found for deployment %s/%s", toRevision, namespace, name)
	}

	// Build patch from the target RS's pod template
	// Remove the pod-template-hash label from the template to avoid conflicts
	templateLabels := make(map[string]string)
	for k, v := range targetRS.Spec.Template.Labels {
		if k != "pod-template-hash" {
			templateLabels[k] = v
		}
	}

	patchTemplate := targetRS.Spec.Template.DeepCopy()
	patchTemplate.Labels = templateLabels

	patch := map[string]interface{}{
		"spec": map[string]interface{}{
			"template": patchTemplate,
		},
	}
	patchBytes, err := json.Marshal(patch)
	if err != nil {
		return fmt.Errorf("marshal rollback patch: %w", err)
	}

	_, err = s.clientsetCtx(ctx).AppsV1().Deployments(namespace).Patch(ctx, name, types.StrategicMergePatchType, patchBytes, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("rollback deployment %s/%s to revision %d: %w", namespace, name, toRevision, err)
	}
	return nil
}

func (s *Service) rollbackDaemonSet(ctx context.Context, namespace, name string, toRevision int64) error {
	crList, err := s.clientsetCtx(ctx).AppsV1().ControllerRevisions(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list controller revisions in %s: %w", namespace, err)
	}

	var targetCR *appsv1.ControllerRevision
	for i, cr := range crList.Items {
		owned := false
		for _, ref := range cr.OwnerReferences {
			if ref.Kind == "DaemonSet" && ref.Name == name {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}
		if cr.Revision == toRevision {
			targetCR = &crList.Items[i]
			break
		}
	}

	if targetCR == nil {
		return fmt.Errorf("revision %d not found for daemonset %s/%s", toRevision, namespace, name)
	}

	// Extract the spec.template from the ControllerRevision data
	patchBytes, err := buildControllerRevisionPatch(targetCR)
	if err != nil {
		return fmt.Errorf("build rollback patch for daemonset %s/%s: %w", namespace, name, err)
	}

	_, err = s.clientsetCtx(ctx).AppsV1().DaemonSets(namespace).Patch(ctx, name, types.StrategicMergePatchType, patchBytes, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("rollback daemonset %s/%s to revision %d: %w", namespace, name, toRevision, err)
	}
	return nil
}

func (s *Service) rollbackStatefulSet(ctx context.Context, namespace, name string, toRevision int64) error {
	crList, err := s.clientsetCtx(ctx).AppsV1().ControllerRevisions(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list controller revisions in %s: %w", namespace, err)
	}

	var targetCR *appsv1.ControllerRevision
	for i, cr := range crList.Items {
		owned := false
		for _, ref := range cr.OwnerReferences {
			if ref.Kind == "StatefulSet" && ref.Name == name {
				owned = true
				break
			}
		}
		if !owned {
			continue
		}
		if cr.Revision == toRevision {
			targetCR = &crList.Items[i]
			break
		}
	}

	if targetCR == nil {
		return fmt.Errorf("revision %d not found for statefulset %s/%s", toRevision, namespace, name)
	}

	// Extract the spec.template from the ControllerRevision data
	patchBytes, err := buildControllerRevisionPatch(targetCR)
	if err != nil {
		return fmt.Errorf("build rollback patch for statefulset %s/%s: %w", namespace, name, err)
	}

	_, err = s.clientsetCtx(ctx).AppsV1().StatefulSets(namespace).Patch(ctx, name, types.StrategicMergePatchType, patchBytes, metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("rollback statefulset %s/%s to revision %d: %w", namespace, name, toRevision, err)
	}
	return nil
}

// buildControllerRevisionPatch extracts spec.template from a ControllerRevision
// and builds a strategic merge patch with it.
func buildControllerRevisionPatch(cr *appsv1.ControllerRevision) ([]byte, error) {
	if cr.Data.Raw == nil {
		return nil, fmt.Errorf("controller revision %s has no data", cr.Name)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(cr.Data.Raw, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal controller revision data: %w", err)
	}

	spec, ok := raw["spec"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("controller revision %s has no spec field", cr.Name)
	}

	template, ok := spec["template"]
	if !ok {
		return nil, fmt.Errorf("controller revision %s has no spec.template field", cr.Name)
	}

	patch := map[string]interface{}{
		"spec": map[string]interface{}{
			"template": template,
		},
	}

	return json.Marshal(patch)
}

