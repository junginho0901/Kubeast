// gpu_dra_classes_claims.go — DRA (Dynamic Resource Allocation) 의 DeviceClass /
// ResourceClaim / ResourceClaimTemplate 도메인 CRUD.
//
// gpu.go 에서 분리. 모든 메서드는 본체의 `isDRAUnavailable` 가드 + `draGVR` 헬퍼
// + `formatDRAList` 공유 포매터를 사용 (byte-equal 이동).

package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== DeviceClasses (cluster-scoped) ==========

func (s *Service) GetDeviceClasses(ctx context.Context) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "deviceclasses")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list deviceclasses: %w", err)
	}
	return formatDRAList(list), nil
}

func (s *Service) DescribeDeviceClass(ctx context.Context, name string) (map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return nil, fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "deviceclasses")
	obj, err := s.GetResource(ctx, gvr, "", name)
	if err != nil {
		return nil, fmt.Errorf("get deviceclass %s: %w", name, err)
	}

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	spec := mapMap(obj.Object, "spec")
	if spec != nil {
		if selectors := mapSlice(spec, "selectors"); len(selectors) > 0 {
			result["selectors"] = selectors
		}
		if config := mapMap(spec, "config"); config != nil {
			result["config"] = config
		}
		if suitableNodes := mapMap(spec, "suitableNodes"); suitableNodes != nil {
			result["suitable_nodes"] = suitableNodes
		}
	}

	return result, nil
}

func (s *Service) DeleteDeviceClass(ctx context.Context, name string) error {
	if s.isDRAUnavailable(ctx) {
		return fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "deviceclasses")
	return s.DeleteResource(ctx, gvr, "", name)
}

// ========== ResourceClaims (namespace-scoped) ==========

func (s *Service) GetResourceClaims(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "resourceclaims")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list resourceclaims: %w", err)
	}
	return formatDRAList(list), nil
}

func (s *Service) GetAllResourceClaims(ctx context.Context) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "resourceclaims")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all resourceclaims: %w", err)
	}
	return formatDRAList(list), nil
}

func (s *Service) DescribeResourceClaim(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return nil, fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceclaims")
	obj, err := s.GetResource(ctx, gvr, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get resourceclaim %s/%s: %w", namespace, name, err)
	}

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"namespace":   obj.GetNamespace(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	spec := mapMap(obj.Object, "spec")
	if spec != nil {
		if devices := mapMap(spec, "devices"); devices != nil {
			result["devices"] = devices
		}
	}

	status := mapMap(obj.Object, "status")
	if status != nil {
		if allocation := mapMap(status, "allocation"); allocation != nil {
			result["allocation"] = allocation
		}
		if reservedFor := mapSlice(status, "reservedFor"); len(reservedFor) > 0 {
			result["reserved_for"] = reservedFor
		}
		if deallocationRequested, ok := status["deallocationRequested"]; ok {
			result["deallocation_requested"] = deallocationRequested
		}
	}

	return result, nil
}

func (s *Service) DeleteResourceClaim(ctx context.Context, namespace, name string) error {
	if s.isDRAUnavailable(ctx) {
		return fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceclaims")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
