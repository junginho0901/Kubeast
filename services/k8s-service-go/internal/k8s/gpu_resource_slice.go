// gpu_resource_slice.go — DRA ResourceSlice (cluster-scoped) CRUD.
//
// gpu.go 에서 분리. ResourceSlice 는 driver 가 광고하는 device pool 묶음. 행은
// internal/drarow (v1 spec.driver·spec.nodeName·spec.pool·spec.devices).

package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/drarow"
)

// ========== ResourceSlices (cluster-scoped) ==========

func (s *Service) GetResourceSlices(ctx context.Context) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "resourceslices")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list resourceslices: %w", err)
	}
	return draRows(list, drarow.Slice), nil
}

func (s *Service) DescribeResourceSlice(ctx context.Context, name string) (map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return nil, fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceslices")
	obj, err := s.GetResource(ctx, gvr, "", name)
	if err != nil {
		return nil, fmt.Errorf("get resourceslice %s: %w", name, err)
	}

	result := drarow.Slice(obj)
	result["annotations"] = obj.GetAnnotations()

	spec := mapMap(obj.Object, "spec")
	if pool := mapMap(spec, "pool"); pool != nil {
		result["pool"] = pool
	}
	if sel := mapMap(spec, "nodeSelector"); sel != nil {
		result["node_selector"] = sel
	}
	result["devices"] = mapSlice(spec, "devices")

	// the claims holding this slice's devices, read here so the drawer does not list every claim itself
	if claims, err := s.draClaims(ctx); err != nil {
		result["allocations_error"] = err.Error()
	} else {
		result["allocations"] = drarow.SliceAllocations(obj, claims)
	}
	s.setObjectEvents(ctx, result, "", "ResourceSlice", name, about(obj.GetUID()))

	return result, nil
}

func (s *Service) DeleteResourceSlice(ctx context.Context, name string) error {
	if s.isDRAUnavailable(ctx) {
		return fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceslices")
	return s.DeleteResource(ctx, gvr, "", name)
}
