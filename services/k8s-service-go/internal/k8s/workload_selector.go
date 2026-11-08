package k8s

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// selectorExpressions are a workload selector's matchExpressions as a drawer reads them beside its matchLabels
// (`selector_expressions`), nil when it has none: the drawer's pod table asks for the pods of the whole selector.
func selectorExpressions(sel *metav1.LabelSelector) []map[string]interface{} {
	if sel == nil || len(sel.MatchExpressions) == 0 {
		return nil
	}
	out := make([]map[string]interface{}, 0, len(sel.MatchExpressions))
	for _, e := range sel.MatchExpressions {
		out = append(out, map[string]interface{}{"key": e.Key, "operator": string(e.Operator), "values": e.Values})
	}
	return out
}

// setSelectorExpressions puts a workload selector's matchExpressions in its describe answer when it has any.
func setSelectorExpressions(result map[string]interface{}, sel *metav1.LabelSelector) {
	if exprs := selectorExpressions(sel); exprs != nil {
		result["selector_expressions"] = exprs
	}
}
