// gpu_resource_slice.go — DRA ResourceSlice (cluster-scoped) CRUD + 리스트 포매터.
//
// gpu.go 에서 분리. ResourceSlice 는 driver 가 광고하는 device pool 묶음.
// formatResourceSliceList 는 본 도메인 전용이라 함께 둠.

package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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
	return formatResourceSliceList(list), nil
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

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	if v := mapStr(obj.Object, "nodeName"); v != "" {
		result["node_name"] = v
	}
	if v := mapStr(obj.Object, "driverName"); v != "" {
		result["driver_name"] = v
	}

	pool := mapMap(obj.Object, "pool")
	if pool != nil {
		result["pool"] = pool
	}

	if devices := mapSlice(obj.Object, "devices"); len(devices) > 0 {
		result["devices"] = devices
	}

	return result, nil
}

func (s *Service) DeleteResourceSlice(ctx context.Context, name string) error {
	if s.isDRAUnavailable(ctx) {
		return fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceslices")
	return s.DeleteResource(ctx, gvr, "", name)
}
