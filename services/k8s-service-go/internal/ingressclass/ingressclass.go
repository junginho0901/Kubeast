// Package ingressclass is an IngressClass as Kubeast lists it, one row for the list, the drawer and the live list
// updates alike.
package ingressclass

import (
	"time"

	networkingv1 "k8s.io/api/networking/v1"
)

// Info is the class's row: its controller, whether it is the default, its labels, annotations and finalizers, and its
// parameters when it has any.
func Info(ic *networkingv1.IngressClass) map[string]interface{} {
	created := ""
	if !ic.CreationTimestamp.IsZero() {
		created = ic.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	result := map[string]interface{}{
		"name":        ic.Name,
		"controller":  ic.Spec.Controller,
		"is_default":  ic.Annotations["ingressclass.kubernetes.io/is-default-class"] == "true",
		"labels":      ic.Labels,
		"annotations": ic.Annotations,
		"finalizers":  ic.Finalizers,
		"created_at":  created,
	}

	if ic.Spec.Parameters != nil {
		params := map[string]interface{}{
			"kind": ic.Spec.Parameters.Kind,
			"name": ic.Spec.Parameters.Name,
		}
		if ic.Spec.Parameters.APIGroup != nil {
			params["api_group"] = *ic.Spec.Parameters.APIGroup
		}
		if ic.Spec.Parameters.Namespace != nil {
			params["namespace"] = *ic.Spec.Parameters.Namespace
		}
		if ic.Spec.Parameters.Scope != nil {
			params["scope"] = *ic.Spec.Parameters.Scope
		}
		result["parameters"] = params
	}

	return result
}
