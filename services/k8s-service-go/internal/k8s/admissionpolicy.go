package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Admission policies (admissionregistration.k8s.io/v1): ValidatingAdmissionPolicy
// and MutatingAdmissionPolicy with their bindings, read-only. The list carries
// the kubectl columns plus the bindings; describe hands the spec, status and
// bindings over as the API writes them (camelCase), the drawer lays them out.

// GetValidatingAdmissionPolicies lists the policies with their bindings.
func (s *Service) GetValidatingAdmissionPolicies(ctx context.Context) ([]map[string]interface{}, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, errNotLoaded
	}
	list, err := cs.AdmissionregistrationV1().ValidatingAdmissionPolicies().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list validatingadmissionpolicies: %w", err)
	}
	bindings, err := cs.AdmissionregistrationV1().ValidatingAdmissionPolicyBindings().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list validatingadmissionpolicybindings: %w", err)
	}
	byPolicy := map[string][]string{}
	for _, b := range bindings.Items {
		byPolicy[b.Spec.PolicyName] = append(byPolicy[b.Spec.PolicyName], b.Name)
	}
	out := make([]map[string]interface{}, 0, len(list.Items))
	for i := range list.Items {
		p := &list.Items[i]
		row := admissionPolicyRow(&p.ObjectMeta, p.Spec.FailurePolicy, p.Spec.ParamKind, byPolicy[p.Name])
		row["validations_count"] = len(p.Spec.Validations)
		out = append(out, row)
	}
	return out, nil
}

// DescribeValidatingAdmissionPolicy returns one policy with its bindings.
func (s *Service) DescribeValidatingAdmissionPolicy(ctx context.Context, name string) (map[string]interface{}, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, errNotLoaded
	}
	p, err := cs.AdmissionregistrationV1().ValidatingAdmissionPolicies().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get validatingadmissionpolicy %s: %w", name, err)
	}
	bindings, err := cs.AdmissionregistrationV1().ValidatingAdmissionPolicyBindings().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list validatingadmissionpolicybindings: %w", err)
	}
	bound := []map[string]interface{}{}
	for i := range bindings.Items {
		b := &bindings.Items[i]
		if b.Spec.PolicyName != name {
			continue
		}
		bound = append(bound, map[string]interface{}{"name": b.Name, "created_at": toISO(&b.CreationTimestamp), "spec": asJSON(b.Spec)})
	}
	out := admissionPolicyDescribe(&p.ObjectMeta, p.Spec.FailurePolicy, p.Spec.ParamKind, bound)
	out["kind"] = "ValidatingAdmissionPolicy"
	out["validations_count"] = len(p.Spec.Validations)
	out["spec"] = asJSON(p.Spec)
	out["status"] = asJSON(p.Status)
	return out, nil
}

// GetMutatingAdmissionPolicies lists the policies with their bindings.
func (s *Service) GetMutatingAdmissionPolicies(ctx context.Context) ([]map[string]interface{}, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, errNotLoaded
	}
	list, err := cs.AdmissionregistrationV1().MutatingAdmissionPolicies().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list mutatingadmissionpolicies: %w", err)
	}
	bindings, err := cs.AdmissionregistrationV1().MutatingAdmissionPolicyBindings().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list mutatingadmissionpolicybindings: %w", err)
	}
	byPolicy := map[string][]string{}
	for _, b := range bindings.Items {
		byPolicy[b.Spec.PolicyName] = append(byPolicy[b.Spec.PolicyName], b.Name)
	}
	out := make([]map[string]interface{}, 0, len(list.Items))
	for i := range list.Items {
		p := &list.Items[i]
		row := admissionPolicyRow(&p.ObjectMeta, p.Spec.FailurePolicy, p.Spec.ParamKind, byPolicy[p.Name])
		row["mutations_count"] = len(p.Spec.Mutations)
		row["reinvocation_policy"] = string(p.Spec.ReinvocationPolicy)
		out = append(out, row)
	}
	return out, nil
}

// DescribeMutatingAdmissionPolicy returns one policy with its bindings.
func (s *Service) DescribeMutatingAdmissionPolicy(ctx context.Context, name string) (map[string]interface{}, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, errNotLoaded
	}
	p, err := cs.AdmissionregistrationV1().MutatingAdmissionPolicies().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get mutatingadmissionpolicy %s: %w", name, err)
	}
	bindings, err := cs.AdmissionregistrationV1().MutatingAdmissionPolicyBindings().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list mutatingadmissionpolicybindings: %w", err)
	}
	bound := []map[string]interface{}{}
	for i := range bindings.Items {
		b := &bindings.Items[i]
		if b.Spec.PolicyName != name {
			continue
		}
		bound = append(bound, map[string]interface{}{"name": b.Name, "created_at": toISO(&b.CreationTimestamp), "spec": asJSON(b.Spec)})
	}
	out := admissionPolicyDescribe(&p.ObjectMeta, p.Spec.FailurePolicy, p.Spec.ParamKind, bound)
	out["kind"] = "MutatingAdmissionPolicy"
	out["mutations_count"] = len(p.Spec.Mutations)
	out["reinvocation_policy"] = string(p.Spec.ReinvocationPolicy)
	out["spec"] = asJSON(p.Spec)
	return out, nil
}

func admissionPolicyRow(meta *metav1.ObjectMeta, failure *admissionregistrationv1.FailurePolicyType, param *admissionregistrationv1.ParamKind, bindings []string) map[string]interface{} {
	if bindings == nil {
		bindings = []string{}
	}
	sort.Strings(bindings)
	return map[string]interface{}{
		"name":           meta.Name,
		"failure_policy": failurePolicyString(failure),
		"param_kind":     paramKindString(param),
		"bindings_count": len(bindings),
		"bindings":       bindings,
		"labels":         meta.Labels,
		"created_at":     toISO(&meta.CreationTimestamp),
	}
}

func admissionPolicyDescribe(meta *metav1.ObjectMeta, failure *admissionregistrationv1.FailurePolicyType, param *admissionregistrationv1.ParamKind, bindings []map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name":             meta.Name,
		"uid":              string(meta.UID),
		"resource_version": meta.ResourceVersion,
		"generation":       meta.Generation,
		"created_at":       toISO(&meta.CreationTimestamp),
		"labels":           meta.Labels,
		"annotations":      meta.Annotations,
		"failure_policy":   failurePolicyString(failure),
		"param_kind":       paramKindString(param),
		"bindings_count":   len(bindings),
		"bindings":         bindings,
	}
}

func failurePolicyString(p *admissionregistrationv1.FailurePolicyType) string {
	if p == nil {
		return string(admissionregistrationv1.Fail)
	}
	return string(*p)
}

func paramKindString(p *admissionregistrationv1.ParamKind) string {
	if p == nil {
		return ""
	}
	return p.APIVersion + "/" + p.Kind
}

// asJSON hands a typed API struct over with its wire field names.
func asJSON(v interface{}) interface{} {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var out interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}
