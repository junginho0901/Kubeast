package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetBackendTLSPolicies lists BackendTLSPolicies in a namespace.
func (s *Service) GetBackendTLSPolicies(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	gvr := s.gatewayPolicyGVR(ctx, "backendtlspolicies")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list backendtlspolicies: %w", err)
	}
	return formatPolicyList(list), nil
}

// GetAllBackendTLSPolicies lists BackendTLSPolicies across all namespaces.
func (s *Service) GetAllBackendTLSPolicies(ctx context.Context) ([]map[string]interface{}, error) {
	gvr := s.gatewayPolicyGVR(ctx, "backendtlspolicies")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all backendtlspolicies: %w", err)
	}
	return formatPolicyList(list), nil
}

// DescribeBackendTLSPolicy returns detailed info about a BackendTLSPolicy.
func (s *Service) DescribeBackendTLSPolicy(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	gvr := s.gatewayPolicyGVR(ctx, "backendtlspolicies")
	obj, err := s.GetResource(ctx, gvr, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get backendtlspolicy %s/%s: %w", namespace, name, err)
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
		// targetRefs
		targetRefs := mapSlice(spec, "targetRefs")
		if len(targetRefs) == 0 {
			// Some versions use singular targetRef
			if tr := mapMap(spec, "targetRef"); tr != nil {
				targetRefs = []interface{}{tr}
			}
		}
		refs := make([]map[string]interface{}, 0, len(targetRefs))
		for _, tr := range targetRefs {
			if tm, ok := tr.(map[string]interface{}); ok {
				ref := map[string]interface{}{
					"name": mapStr(tm, "name"),
				}
				if v := mapStr(tm, "group"); v != "" {
					ref["group"] = v
				}
				if v := mapStr(tm, "kind"); v != "" {
					ref["kind"] = v
				}
				if v := mapStr(tm, "namespace"); v != "" {
					ref["namespace"] = v
				}
				if v := mapStr(tm, "sectionName"); v != "" {
					ref["section_name"] = v
				}
				refs = append(refs, ref)
			}
		}
		result["target_refs"] = refs

		// validation (TLS validation config)
		if validation := mapMap(spec, "validation"); validation != nil {
			valResult := map[string]interface{}{}
			if hostname := mapStr(validation, "hostname"); hostname != "" {
				valResult["hostname"] = hostname
			}
			if wke := mapStr(validation, "wellKnownCACertificates"); wke != "" {
				valResult["well_known_ca_certificates"] = wke
			}
			caCertRefs := mapSlice(validation, "caCertificateRefs")
			certRefs := make([]map[string]interface{}, 0, len(caCertRefs))
			for _, cr := range caCertRefs {
				if cm, ok := cr.(map[string]interface{}); ok {
					certRef := map[string]interface{}{
						"name": mapStr(cm, "name"),
					}
					if v := mapStr(cm, "group"); v != "" {
						certRef["group"] = v
					}
					if v := mapStr(cm, "kind"); v != "" {
						certRef["kind"] = v
					}
					if v := mapStr(cm, "namespace"); v != "" {
						certRef["namespace"] = v
					}
					certRefs = append(certRefs, certRef)
				}
			}
			if len(certRefs) > 0 {
				valResult["ca_certificate_refs"] = certRefs
			}
			result["validation"] = valResult
		}
	}

	// status conditions
	status := mapMap(obj.Object, "status")
	if status != nil {
		ancestors := mapSlice(status, "ancestors")
		ancestorStatuses := make([]map[string]interface{}, 0, len(ancestors))
		for _, a := range ancestors {
			if am, ok := a.(map[string]interface{}); ok {
				as := map[string]interface{}{}
				if ancestorRef := mapMap(am, "ancestorRef"); ancestorRef != nil {
					as["ancestor_ref"] = ancestorRef
				}
				conditions := mapSlice(am, "conditions")
				condList := make([]map[string]interface{}, 0, len(conditions))
				for _, c := range conditions {
					if cm, ok := c.(map[string]interface{}); ok {
						condList = append(condList, map[string]interface{}{
							"type":    mapStr(cm, "type"),
							"status":  mapStr(cm, "status"),
							"reason":  mapStr(cm, "reason"),
							"message": mapStr(cm, "message"),
						})
					}
				}
				as["conditions"] = condList
				ancestorStatuses = append(ancestorStatuses, as)
			}
		}
		result["ancestor_statuses"] = ancestorStatuses
	}

	return result, nil
}

// DeleteBackendTLSPolicy deletes a BackendTLSPolicy.
func (s *Service) DeleteBackendTLSPolicy(ctx context.Context, namespace, name string) error {
	gvr := s.gatewayPolicyGVR(ctx, "backendtlspolicies")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
