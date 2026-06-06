// gpu.go — DRA (Dynamic Resource Allocation) 인프라 + 공유 리스트 포매터.
//
// DRA 도메인별 CRUD 는 gpu_dra_classes_claims.go (DeviceClass / ResourceClaim /
// Template) 와 gpu_resource_slice.go (ResourceSlice) 로 분리됨. GPU 대시보드
// 통합 응답은 gpu_dashboard.go. 본 파일은 K8s 버전별 (v1beta1 / v1alpha3) API
// 자동 탐지 + GVR 헬퍼 + DRA 도메인이 공유하는 list 포매터만 보유.

package k8s

import (
	"context"
	"log/slog"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// resolveDRAAPIVersion auto-detects whether the cluster uses v1beta1 or v1alpha3 for resource.k8s.io.
// The result is cached for the lifetime of the process.
func (s *Service) resolveDRAAPIVersion(ctx context.Context) string {
	s.draAPIVersionMu.RLock()
	cached := s.draAPIVersionCache
	s.draAPIVersionMu.RUnlock()
	if cached != "" {
		return cached
	}

	s.draAPIVersionMu.Lock()
	defer s.draAPIVersionMu.Unlock()

	// Double-check after acquiring write lock
	if s.draAPIVersionCache != "" {
		return s.draAPIVersionCache
	}

	// Use a short timeout so version probing doesn't block requests
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Try v1beta1 first (Kubernetes 1.32+)
	gvr := schema.GroupVersionResource{
		Group:    "resource.k8s.io",
		Version:  "v1beta1",
		Resource: "deviceclasses",
	}
	_, err := s.dynamicCtx(ctx).Resource(gvr).List(probeCtx, metav1.ListOptions{Limit: 1})
	if err == nil {
		s.draAPIVersionCache = "v1beta1"
		slog.Info("DRA API version detected", "version", "v1beta1")
		return "v1beta1"
	}

	// Fall back to v1alpha3 (Kubernetes 1.31)
	probeCtx2, cancel2 := context.WithTimeout(ctx, 5*time.Second)
	defer cancel2()
	gvr.Version = "v1alpha3"
	_, err = s.dynamicCtx(ctx).Resource(gvr).List(probeCtx2, metav1.ListOptions{Limit: 1})
	if err == nil {
		s.draAPIVersionCache = "v1alpha3"
		slog.Info("DRA API version detected", "version", "v1alpha3")
		return "v1alpha3"
	}

	// Mark as unavailable so we don't probe again
	s.draAPIVersionCache = "unavailable"
	slog.Warn("DRA API not detected (cluster may be < v1.31)")
	return "unavailable"
}

// draGVR returns the GVR for DRA resources. If DRA is unavailable, version will be "unavailable".
func (s *Service) draGVR(ctx context.Context, resource string) schema.GroupVersionResource {
	return schema.GroupVersionResource{
		Group:    "resource.k8s.io",
		Version:  s.resolveDRAAPIVersion(ctx),
		Resource: resource,
	}
}

// isDRAUnavailable returns true if DRA API was probed and not found.
func (s *Service) isDRAUnavailable(ctx context.Context) bool {
	return s.resolveDRAAPIVersion(ctx) == "unavailable"
}

// ========== DRA list formatters ==========

// formatDRAList flattens DeviceClass / ResourceClaim / ResourceClaimTemplate
// unstructured lists into the common list-card shape (name, labels, request
// count, allocation status, conditions).
func formatDRAList(list *unstructured.UnstructuredList) []map[string]interface{} {
	if list == nil {
		return []map[string]interface{}{}
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, item := range list.Items {
		entry := map[string]interface{}{
			"name":       item.GetName(),
			"namespace":  item.GetNamespace(),
			"labels":     item.GetLabels(),
			"created_at": toISO(&metav1.Time{Time: item.GetCreationTimestamp().Time}),
		}

		spec := mapMap(item.Object, "spec")
		if spec != nil {
			if devices := mapMap(spec, "devices"); devices != nil {
				if requests := mapSlice(devices, "requests"); len(requests) > 0 {
					entry["request_count"] = len(requests)
				}
			}
			if selectors := mapSlice(spec, "selectors"); len(selectors) > 0 {
				entry["selector_count"] = len(selectors)
			}
			if claimSpec := mapMap(spec, "spec"); claimSpec != nil {
				if devices := mapMap(claimSpec, "devices"); devices != nil {
					if requests := mapSlice(devices, "requests"); len(requests) > 0 {
						entry["request_count"] = len(requests)
					}
				}
			}
		}

		status := mapMap(item.Object, "status")
		if status != nil {
			if allocation := mapMap(status, "allocation"); allocation != nil {
				entry["allocation_status"] = "Allocated"
			} else {
				if reservedFor := mapSlice(status, "reservedFor"); len(reservedFor) > 0 {
					entry["allocation_status"] = "Reserved"
				}
			}
			if conditions := mapSlice(status, "conditions"); len(conditions) > 0 {
				condList := make([]map[string]interface{}, 0, len(conditions))
				for _, c := range conditions {
					if cm, ok := c.(map[string]interface{}); ok {
						condList = append(condList, map[string]interface{}{
							"type":   mapStr(cm, "type"),
							"status": mapStr(cm, "status"),
							"reason": mapStr(cm, "reason"),
						})
					}
				}
				entry["conditions"] = condList
			}
		}

		result = append(result, entry)
	}
	return result
}
