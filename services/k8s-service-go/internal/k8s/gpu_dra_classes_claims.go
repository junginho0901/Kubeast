// gpu_dra_classes_claims.go — DRA (Dynamic Resource Allocation) 의 DeviceClass /
// ResourceClaim / ResourceClaimTemplate 도메인 CRUD.
//
// gpu.go 에서 분리. 모든 메서드는 본체의 `isDRAUnavailable` 가드 + `draGVR` 헬퍼를
// 쓰고, 행은 internal/drarow 가 목록·describe·실시간 갱신에 같은 모양으로 만든다.

package k8s

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/drarow"
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
	return draRows(list, drarow.DeviceClass), nil
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
		if config := mapSlice(spec, "config"); len(config) > 0 {
			result["config"] = config
		}
		if v := mapStr(spec, "extendedResourceName"); v != "" {
			result["extended_resource_name"] = v
		}
	}

	// the claims whose requests ask for this class, read here so the drawer does not list every claim itself
	if claims, err := s.draClaims(ctx); err != nil {
		result["used_by_error"] = err.Error()
	} else {
		result["used_by"] = drarow.UsedBy(name, claims)
	}
	s.setObjectEvents(ctx, result, "", "DeviceClass", name, about(obj.GetUID()))

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
	return draRows(list, drarow.Claim), nil
}

func (s *Service) GetAllResourceClaims(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		if s.isDRAUnavailable(ctx) {
			return []map[string]interface{}{}, nil
		}
		gvr := s.draGVR(ctx, "resourceclaims")
		list, err := s.ListResources(ctx, gvr, ns, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all resourceclaims: %w", err)
		}
		return draRows(list, drarow.Claim), nil
	})
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
		"state":       drarow.ClaimState(obj),
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
	}

	// the namespace's pods that refer to the claim, by name or as the claim made for them from a template
	using := []map[string]interface{}{}
	err = eachPod(ctx, s.clientsetCtx(ctx).CoreV1(), namespace, metav1.ListOptions{}, func(p *corev1.Pod) {
		if drarow.PodUsesClaim(p, name) {
			st, _, _, _ := podListView(p)
			using = append(using, map[string]interface{}{"name": p.Name, "namespace": p.Namespace, "status": st, "node_name": p.Spec.NodeName})
		}
	})
	if err != nil {
		result["using_pods_error"] = err.Error()
	} else {
		result["using_pods"] = using
	}
	s.setObjectEvents(ctx, result, namespace, "ResourceClaim", name, about(obj.GetUID()))

	return result, nil
}

func (s *Service) DeleteResourceClaim(ctx context.Context, namespace, name string) error {
	if s.isDRAUnavailable(ctx) {
		return fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceclaims")
	return s.DeleteResource(ctx, gvr, namespace, name)
}

// ========== ResourceClaimTemplates (namespace-scoped) ==========

func (s *Service) GetResourceClaimTemplates(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return []map[string]interface{}{}, nil
	}
	gvr := s.draGVR(ctx, "resourceclaimtemplates")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list resourceclaimtemplates: %w", err)
	}
	return draRows(list, drarow.ClaimTemplate), nil
}

func (s *Service) GetAllResourceClaimTemplates(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		if s.isDRAUnavailable(ctx) {
			return []map[string]interface{}{}, nil
		}
		gvr := s.draGVR(ctx, "resourceclaimtemplates")
		list, err := s.ListResources(ctx, gvr, ns, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all resourceclaimtemplates: %w", err)
		}
		return draRows(list, drarow.ClaimTemplate), nil
	})
}

func (s *Service) DescribeResourceClaimTemplate(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	if s.isDRAUnavailable(ctx) {
		return nil, fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceclaimtemplates")
	obj, err := s.GetResource(ctx, gvr, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get resourceclaimtemplate %s/%s: %w", namespace, name, err)
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
		if claimSpec := mapMap(spec, "spec"); claimSpec != nil {
			result["claim_spec"] = claimSpec
		}
	}

	// the claims made from the template: the namespace's pods name them in status.resourceClaimStatuses (a claim made
	// from a template is owned by its pod and does not name the template)
	related := []map[string]interface{}{}
	err = eachPod(ctx, s.clientsetCtx(ctx).CoreV1(), namespace, metav1.ListOptions{}, func(p *corev1.Pod) {
		for _, claim := range drarow.PodTemplateClaims(p, name) {
			related = append(related, map[string]interface{}{"name": claim, "namespace": p.Namespace, "pod": p.Name})
		}
	})
	if err != nil {
		result["related_claims_error"] = err.Error()
	} else {
		result["related_claims"] = related
	}
	s.setObjectEvents(ctx, result, namespace, "ResourceClaimTemplate", name, about(obj.GetUID()))

	return result, nil
}

func (s *Service) DeleteResourceClaimTemplate(ctx context.Context, namespace, name string) error {
	if s.isDRAUnavailable(ctx) {
		return fmt.Errorf("DRA API not available")
	}
	gvr := s.draGVR(ctx, "resourceclaimtemplates")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
