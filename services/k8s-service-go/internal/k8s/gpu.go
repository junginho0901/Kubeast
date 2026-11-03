// gpu.go — DRA (Dynamic Resource Allocation) 인프라 + 공유 리스트 포매터.
//
// DRA 도메인별 CRUD 는 gpu_dra_classes_claims.go (DeviceClass / ResourceClaim /
// Template) 와 gpu_resource_slice.go (ResourceSlice) 로 분리됨. GPU 대시보드
// 통합 응답은 gpu_dashboard.go. 본 파일은 resource.k8s.io 서빙 버전 해석
// (apiversion.go discovery) + GVR 헬퍼 + 행(internal/drarow)·claim 목록 헬퍼만 보유.

package k8s

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const draAPIGroup = "resource.k8s.io"

// resolveDRAAPIVersion is the version the cluster serves resource.k8s.io
// under — v1 (1.34+), v1beta2/v1beta1 (1.32–1.33), v1alpha3 (1.31) — found
// through API discovery (apiversion.go), or "unavailable" when the group is
// not served.
func (s *Service) resolveDRAAPIVersion(ctx context.Context) string {
	if gvr, ok := s.resolveGVR(ctx, draAPIGroup, "deviceclasses"); ok {
		return gvr.Version
	}
	return "unavailable"
}

// draGVR returns the GVR for DRA resources. If DRA is unavailable, version will be "unavailable".
func (s *Service) draGVR(ctx context.Context, resource string) schema.GroupVersionResource {
	if gvr, ok := s.resolveGVR(ctx, draAPIGroup, resource); ok {
		return gvr
	}
	return schema.GroupVersionResource{Group: draAPIGroup, Version: "unavailable", Resource: resource}
}

// isDRAUnavailable returns true if DRA API was probed and not found.
func (s *Service) isDRAUnavailable(ctx context.Context) bool {
	return s.resolveDRAAPIVersion(ctx) == "unavailable"
}

// draRows turns a DRA list into its rows (internal/drarow), the same the live updates send.
func draRows(list *unstructured.UnstructuredList, row func(*unstructured.Unstructured) map[string]interface{}) []map[string]interface{} {
	out := []map[string]interface{}{}
	if list == nil {
		return out
	}
	for i := range list.Items {
		out = append(out, row(&list.Items[i]))
	}
	return out
}

// draClaims are the ResourceClaims the caller may read in every namespace — each namespace of a grant limited to
// them in turn, as the all-namespaces list reads them — for the drawers' references to claims.
func (s *Service) draClaims(ctx context.Context) ([]unstructured.Unstructured, error) {
	gvr := s.draGVR(ctx, "resourceclaims")
	list := func(ns string) ([]unstructured.Unstructured, error) {
		l, err := s.ListResources(ctx, gvr, ns, metav1.ListOptions{})
		if err != nil {
			return nil, err
		}
		return l.Items, nil
	}
	if scope := scopeFromCtx(ctx); len(scope) > 0 {
		return fanOutNamespaces(scope, list)
	}
	return list("")
}
