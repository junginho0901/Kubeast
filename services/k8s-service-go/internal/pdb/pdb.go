// Package pdb is a PodDisruptionBudget as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package pdb

import (
	"time"

	policyv1 "k8s.io/api/policy/v1"
)

// Info is the budget's row: min available and max unavailable only where the object sets one, its status and selector.
func Info(p *policyv1.PodDisruptionBudget) map[string]interface{} {
	created := ""
	if !p.CreationTimestamp.IsZero() {
		created = p.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	result := map[string]interface{}{
		"name":                p.Name,
		"namespace":           p.Namespace,
		"current_healthy":     p.Status.CurrentHealthy,
		"desired_healthy":     p.Status.DesiredHealthy,
		"disruptions_allowed": p.Status.DisruptionsAllowed,
		"expected_pods":       p.Status.ExpectedPods,
		"labels":              p.Labels,
		"created_at":          created,
	}

	if p.Spec.MinAvailable != nil {
		result["min_available"] = p.Spec.MinAvailable.String()
	}
	if p.Spec.MaxUnavailable != nil {
		result["max_unavailable"] = p.Spec.MaxUnavailable.String()
	}

	selector := map[string]string{}
	if p.Spec.Selector != nil && p.Spec.Selector.MatchLabels != nil {
		selector = p.Spec.Selector.MatchLabels
	}
	result["selector"] = selector

	if p.Spec.Selector != nil && len(p.Spec.Selector.MatchExpressions) > 0 {
		exprs := make([]map[string]interface{}, 0, len(p.Spec.Selector.MatchExpressions))
		for _, e := range p.Spec.Selector.MatchExpressions {
			exprs = append(exprs, map[string]interface{}{
				"key":      e.Key,
				"operator": string(e.Operator),
				"values":   e.Values,
			})
		}
		result["match_expressions"] = exprs
	}

	if p.Spec.UnhealthyPodEvictionPolicy != nil {
		result["unhealthy_pod_eviction_policy"] = string(*p.Spec.UnhealthyPodEvictionPolicy)
	}

	return result
}
