// Package gatewayrow is a Gateway API object as Kubeast lists it — GatewayClass, Gateway, HTTPRoute and GRPCRoute,
// ReferenceGrant, the policies — one row for the list API and the live list updates alike. The rows carry what the
// list pages show (the counts, the condition summary, accepted, programmed, resolved refs), which the pages used to
// work out only from a live update.
package gatewayrow

import (
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func object(u *unstructured.Unstructured, key string) map[string]interface{} {
	m, _ := u.Object[key].(map[string]interface{})
	return m
}

func list(m map[string]interface{}, key string) []interface{} {
	l, _ := m[key].([]interface{})
	if l == nil {
		return []interface{}{}
	}
	return l
}

func str(m map[string]interface{}, key string) string {
	s, _ := m[key].(string)
	return s
}

func maps(l []interface{}) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(l))
	for _, v := range l {
		if m, ok := v.(map[string]interface{}); ok {
			out = append(out, m)
		}
	}
	return out
}

func isTrue(c map[string]interface{}) bool  { return strings.EqualFold(str(c, "status"), "true") }
func isFalse(c map[string]interface{}) bool { return strings.EqualFold(str(c, "status"), "false") }

func has(conds []map[string]interface{}, kind string) bool {
	for _, c := range conds {
		if str(c, "type") == kind && isTrue(c) {
			return true
		}
	}
	return false
}

// summary names the conditions in one word: the first of first that holds, else the first condition that holds,
// else the first that does not as "<type>(False)", else "Unknown" — the list pages' status column.
func summary(conds []map[string]interface{}, first ...string) string {
	for _, kind := range first {
		if has(conds, kind) {
			return kind
		}
	}
	for _, c := range conds {
		if isTrue(c) && str(c, "type") != "" {
			return str(c, "type")
		}
	}
	for _, c := range conds {
		if isFalse(c) && str(c, "type") != "" {
			return str(c, "type") + "(False)"
		}
	}
	return "Unknown"
}

func meta(u *unstructured.Unstructured) map[string]interface{} {
	created := ""
	if ts := u.GetCreationTimestamp(); !ts.IsZero() {
		created = ts.UTC().Format(time.RFC3339)
	}
	labels := u.GetLabels()
	if labels == nil {
		labels = map[string]string{}
	}
	annotations := u.GetAnnotations()
	if annotations == nil {
		annotations = map[string]string{}
	}
	finalizers := u.GetFinalizers()
	if finalizers == nil {
		finalizers = []string{}
	}
	row := map[string]interface{}{
		"name":        u.GetName(),
		"labels":      labels,
		"annotations": annotations,
		"finalizers":  finalizers,
		"created_at":  created,
		"api_version": u.GetAPIVersion(),
	}
	if ns := u.GetNamespace(); ns != "" {
		row["namespace"] = ns
	}
	return row
}

// GatewayClass: the controller, the description (spec.description, as kubectl prints it), accepted and the
// condition summary, the parameters reference.
func GatewayClass(u *unstructured.Unstructured) map[string]interface{} {
	spec, status := object(u, "spec"), object(u, "status")
	conds := maps(list(status, "conditions"))
	row := meta(u)
	row["controller_name"] = str(spec, "controllerName")
	row["description"] = str(spec, "description")
	row["accepted"] = has(conds, "Accepted")
	row["status"] = summary(conds, "Accepted")
	var params interface{}
	if p, ok := spec["parametersRef"].(map[string]interface{}); ok {
		params = p
	}
	row["parameters_ref"] = params
	row["conditions"] = conds
	return row
}

// Gateway: the class, the listeners and the routes attached to them, the addresses, programmed, accepted and the
// condition summary.
func Gateway(u *unstructured.Unstructured) map[string]interface{} {
	spec, status := object(u, "spec"), object(u, "status")
	conds := maps(list(status, "conditions"))
	listeners := maps(list(spec, "listeners"))
	statusListeners := maps(list(status, "listeners"))
	addresses := maps(list(status, "addresses"))
	attached := int64(0)
	for _, l := range statusListeners {
		switch v := l["attachedRoutes"].(type) {
		case int64:
			attached += v
		case float64:
			attached += int64(v)
		}
	}
	row := meta(u)
	row["gateway_class_name"] = str(spec, "gatewayClassName")
	row["listeners_count"] = len(listeners)
	row["attached_routes"] = attached
	row["addresses_count"] = len(addresses)
	row["status"] = summary(conds, "Programmed", "Accepted")
	row["programmed"] = has(conds, "Programmed")
	row["accepted"] = has(conds, "Accepted")
	row["listeners"] = listeners
	row["status_listeners"] = statusListeners
	row["addresses"] = addresses
	row["conditions"] = conds
	return row
}

// Route is an HTTPRoute or a GRPCRoute: hostnames, parent references, rules and their backends, and the conditions
// of every parent the route reports on, pooled — accepted and resolved refs hold when one parent says so.
func Route(u *unstructured.Unstructured) map[string]interface{} {
	spec, status := object(u, "spec"), object(u, "status")
	rules := maps(list(spec, "rules"))
	parentRefs := maps(list(spec, "parentRefs"))
	parents := maps(list(status, "parents"))
	backends := 0
	for _, r := range rules {
		backends += len(list(r, "backendRefs"))
	}
	conds := []map[string]interface{}{}
	for _, p := range parents {
		conds = append(conds, maps(list(p, "conditions"))...)
	}
	hostnames := []string{}
	for _, h := range list(spec, "hostnames") {
		if s, ok := h.(string); ok {
			hostnames = append(hostnames, s)
		}
	}
	row := meta(u)
	row["hostnames"] = hostnames
	row["parent_refs"] = parentRefs
	row["rules"] = rules
	row["parents"] = parents
	row["rule_count"] = len(rules)
	row["parent_refs_count"] = len(parentRefs)
	row["backend_refs_count"] = backends
	row["status"] = summary(conds, "Accepted", "ResolvedRefs")
	row["accepted"] = has(conds, "Accepted")
	row["resolved_refs"] = has(conds, "ResolvedRefs")
	row["conditions"] = conds
	return row
}

// ReferenceGrant: who may refer (from: group, kind, namespace) to what (to: group, kind, name).
func ReferenceGrant(u *unstructured.Unstructured) map[string]interface{} {
	spec := object(u, "spec")
	from := []map[string]interface{}{}
	for _, f := range maps(list(spec, "from")) {
		from = append(from, map[string]interface{}{"group": str(f, "group"), "kind": str(f, "kind"), "namespace": str(f, "namespace")})
	}
	to := []map[string]interface{}{}
	for _, t := range maps(list(spec, "to")) {
		to = append(to, map[string]interface{}{"group": str(t, "group"), "kind": str(t, "kind"), "name": str(t, "name")})
	}
	row := meta(u)
	row["from"] = from
	row["to"] = to
	return row
}

// Policy is a policy attached to Gateway API objects (BackendTLSPolicy and the like): its targets (spec.targetRefs,
// else spec.targetRef) and the conditions of the first ancestor that reports any.
func Policy(u *unstructured.Unstructured) map[string]interface{} {
	spec, status := object(u, "spec"), object(u, "status")
	targets := list(spec, "targetRefs")
	if len(targets) == 0 {
		if t, ok := spec["targetRef"].(map[string]interface{}); ok {
			targets = []interface{}{t}
		}
	}
	refs := []map[string]interface{}{}
	for _, t := range maps(targets) {
		ref := map[string]interface{}{"name": str(t, "name")}
		for _, k := range []string{"group", "kind", "namespace", "sectionName"} {
			if v := str(t, k); v != "" {
				ref[k] = v
			}
		}
		refs = append(refs, ref)
	}
	conds := []map[string]interface{}{}
	for _, a := range maps(list(status, "ancestors")) {
		if c := maps(list(a, "conditions")); len(c) > 0 {
			conds = c
			break
		}
	}
	row := meta(u)
	row["target_refs"] = refs
	row["conditions"] = conds
	return row
}
