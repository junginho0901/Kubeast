package k8s

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Gateway → Policies: one list of every policy object attached to Gateway API
// resources, whichever implementation owns the kind.
//
// Kinds come from three places, in this order:
//  1. CRDs carrying the GEP-713 label gateway.networking.k8s.io/policy
//     (upstream experimental policies, NGINX Gateway Fabric, kgateway, …);
//  2. a built-in table for implementations that ship policy CRDs without the
//     label (Envoy Gateway 1.5, Istio 1.28 — checked against their CRD files);
//  3. GATEWAY_POLICY_KINDS ("group/plural,…", chart gatewayApi.policyKinds).
//
// A kind whose CRD is not installed is skipped; one the caller may not list is
// reported in `kinds[].error` and the rest of the page still renders.

// gatewayPolicyLabel marks a policy CRD (GEP-713 Policy Attachment).
const gatewayPolicyLabel = "gateway.networking.k8s.io/policy"

// policyKind is one kind the page scans.
type policyKind struct {
	Group    string
	Resource string // plural
	Source   string // "label" | "builtin" | "configured"
}

// builtinPolicyKinds: policy kinds whose CRDs do not carry the GEP-713 label.
var builtinPolicyKinds = []policyKind{
	// upstream kinds are labelled, but a caller who cannot list CRDs still gets them this way
	{Group: "gateway.networking.k8s.io", Resource: "backendtlspolicies", Source: "builtin"},
	{Group: "gateway.networking.x-k8s.io", Resource: "xbackendtrafficpolicies", Source: "builtin"},
	// Envoy Gateway
	{Group: "gateway.envoyproxy.io", Resource: "backendtrafficpolicies", Source: "builtin"},
	{Group: "gateway.envoyproxy.io", Resource: "clienttrafficpolicies", Source: "builtin"},
	{Group: "gateway.envoyproxy.io", Resource: "securitypolicies", Source: "builtin"},
	{Group: "gateway.envoyproxy.io", Resource: "envoypatchpolicies", Source: "builtin"},
	{Group: "gateway.envoyproxy.io", Resource: "envoyextensionpolicies", Source: "builtin"},
	// Istio
	{Group: "security.istio.io", Resource: "authorizationpolicies", Source: "builtin"},
	{Group: "security.istio.io", Resource: "requestauthentications", Source: "builtin"},
	{Group: "security.istio.io", Resource: "peerauthentications", Source: "builtin"},
	{Group: "telemetry.istio.io", Resource: "telemetries", Source: "builtin"},
	{Group: "extensions.istio.io", Resource: "wasmplugins", Source: "builtin"},
	{Group: "networking.istio.io", Resource: "envoyfilters", Source: "builtin"},
	{Group: "networking.istio.io", Resource: "destinationrules", Source: "builtin"},
}

// resolvedPolicyKind is a policy kind the cluster actually serves.
type resolvedPolicyKind struct {
	policyKind
	GVR        schema.GroupVersionResource
	Kind       string
	Namespaced bool
}

// GetGatewayPolicies lists the policies of every known kind. namespace ""
// means all namespaces; cluster-scoped kinds are listed either way.
func (s *Service) GetGatewayPolicies(ctx context.Context, namespace string, extra []string) (map[string]interface{}, error) {
	kinds := s.gatewayPolicyKinds(ctx, extra)

	type result struct {
		kind  resolvedPolicyKind
		items []map[string]interface{}
		err   error
	}
	results := make([]result, len(kinds))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for i, k := range kinds {
		wg.Add(1)
		go func(i int, k resolvedPolicyKind) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ns := namespace
			if !k.Namespaced {
				ns = ""
			}
			list, err := s.ListResources(ctx, k.GVR, ns, metav1.ListOptions{})
			if err != nil {
				results[i] = result{kind: k, err: err}
				return
			}
			rows := make([]map[string]interface{}, 0, len(list.Items))
			for _, item := range list.Items {
				rows = append(rows, policyRow(&item, k))
			}
			results[i] = result{kind: k, items: rows}
		}(i, k)
	}
	wg.Wait()

	items := make([]map[string]interface{}, 0)
	kindRows := make([]map[string]interface{}, 0, len(kinds))
	for _, r := range results {
		row := map[string]interface{}{
			"group":   r.kind.Group,
			"version": r.kind.GVR.Version,
			"plural":  r.kind.Resource,
			"kind":    r.kind.Kind,
			"scope":   scopeName(r.kind.Namespaced),
			"source":  r.kind.Source,
			"count":   len(r.items),
		}
		if r.err != nil {
			switch {
			case apierrors.IsNotFound(r.err):
				// the CRD disappeared between discovery and the list: not an error worth showing
				continue
			case apierrors.IsForbidden(r.err):
				row["error"] = "forbidden"
			default:
				row["error"] = r.err.Error()
			}
		}
		kindRows = append(kindRows, row)
		items = append(items, r.items...)
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i]["kind"] != items[j]["kind"] {
			return items[i]["kind"].(string) < items[j]["kind"].(string)
		}
		if items[i]["namespace"] != items[j]["namespace"] {
			return items[i]["namespace"].(string) < items[j]["namespace"].(string)
		}
		return items[i]["name"].(string) < items[j]["name"].(string)
	})
	return map[string]interface{}{
		"namespace": namespace,
		"kinds":     kindRows,
		"items":     items,
	}, nil
}

// gatewayPolicyKinds resolves the kinds to scan: labelled CRDs, then the
// built-in table, then the configured extras — first occurrence of a
// group/plural wins. Kinds the cluster does not serve are dropped.
func (s *Service) gatewayPolicyKinds(ctx context.Context, extra []string) []resolvedPolicyKind {
	seen := map[string]bool{}
	out := make([]resolvedPolicyKind, 0)
	add := func(k resolvedPolicyKind) {
		key := k.Group + "/" + k.Resource
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, k)
	}

	for _, k := range s.labelledPolicyCRDs(ctx) {
		add(k)
	}
	candidates := append([]policyKind{}, builtinPolicyKinds...)
	for _, e := range extra {
		g, p, ok := strings.Cut(strings.TrimSpace(e), "/")
		if !ok || g == "" || p == "" {
			slog.Warn("GATEWAY_POLICY_KINDS entry ignored (want group/plural)", "entry", e)
			continue
		}
		candidates = append(candidates, policyKind{Group: g, Resource: p, Source: "configured"})
	}
	for _, c := range candidates {
		if seen[c.Group+"/"+c.Resource] {
			continue
		}
		res, ok := s.resolveResource(ctx, c.Group, c.Resource)
		if !ok {
			continue
		}
		add(resolvedPolicyKind{policyKind: c, GVR: res.GVR, Kind: res.Kind, Namespaced: res.Namespaced})
	}
	return out
}

// labelledPolicyCRDs lists the CRDs carrying the GEP-713 policy label. A
// caller who may not list CRDs gets none (the built-in table still applies).
func (s *Service) labelledPolicyCRDs(ctx context.Context) []resolvedPolicyKind {
	dyn := s.dynamicCtx(ctx)
	if dyn == nil {
		return nil
	}
	list, err := dyn.Resource(crdGVR).List(ctx, metav1.ListOptions{LabelSelector: gatewayPolicyLabel})
	if err != nil {
		if !apierrors.IsForbidden(err) {
			slog.Warn("gateway policies: list labelled CRDs", "cluster", ctxClusterID(ctx), "err", err)
		}
		return nil
	}
	out := make([]resolvedPolicyKind, 0, len(list.Items))
	for i := range list.Items {
		spec := mapMap(list.Items[i].Object, "spec")
		names := mapMap(spec, "names")
		if spec == nil || names == nil {
			continue
		}
		version := crdStorageVersion(spec)
		if version == "" {
			continue
		}
		group, plural := mapStr(spec, "group"), mapStr(names, "plural")
		out = append(out, resolvedPolicyKind{
			policyKind: policyKind{Group: group, Resource: plural, Source: "label"},
			GVR:        schema.GroupVersionResource{Group: group, Version: version, Resource: plural},
			Kind:       mapStr(names, "kind"),
			Namespaced: mapStr(spec, "scope") != "Cluster",
		})
	}
	return out
}

// crdStorageVersion is the CRD's storage version (the one every object is
// readable under), falling back to the first served version.
func crdStorageVersion(spec map[string]interface{}) string {
	first := ""
	for _, v := range mapSlice(spec, "versions") {
		vm, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		served, _ := vm["served"].(bool)
		if !served {
			continue
		}
		if storage, _ := vm["storage"].(bool); storage {
			return mapStr(vm, "name")
		}
		if first == "" {
			first = mapStr(vm, "name")
		}
	}
	return first
}

func scopeName(namespaced bool) string {
	if namespaced {
		return "Namespaced"
	}
	return "Cluster"
}

// policyRow flattens one policy object for the table: identity, what it
// attaches to, and whether the implementation accepted it.
func policyRow(item *unstructured.Unstructured, k resolvedPolicyKind) map[string]interface{} {
	row := map[string]interface{}{
		"name":       item.GetName(),
		"namespace":  item.GetNamespace(),
		"kind":       k.Kind,
		"group":      k.Group,
		"version":    k.GVR.Version,
		"plural":     k.Resource,
		"scope":      scopeName(k.Namespaced),
		"source":     k.Source,
		"labels":     item.GetLabels(),
		"created_at": toISO(&metav1.Time{Time: item.GetCreationTimestamp().Time}),
		"targets":    policyTargets(mapMap(item.Object, "spec")),
	}
	if accepted, known := policyAccepted(mapMap(item.Object, "status")); known {
		row["accepted"] = accepted
	}
	return row
}

// policyTargets reads what a policy attaches to. GEP-713 kinds use
// targetRefs/targetRef; Istio kinds select workloads by labels
// (selector.matchLabels, workloadSelector.labels) or name a host
// (DestinationRule). Each target is {kind, name[, namespace, group, section]}.
func policyTargets(spec map[string]interface{}) []map[string]interface{} {
	out := make([]map[string]interface{}, 0)
	if spec == nil {
		return out
	}
	refs := mapSlice(spec, "targetRefs")
	if len(refs) == 0 {
		if tr := mapMap(spec, "targetRef"); tr != nil {
			refs = []interface{}{tr}
		}
	}
	for _, r := range refs {
		tm, ok := r.(map[string]interface{})
		if !ok {
			continue
		}
		t := map[string]interface{}{"kind": mapStr(tm, "kind"), "name": mapStr(tm, "name")}
		if v := mapStr(tm, "group"); v != "" {
			t["group"] = v
		}
		if v := mapStr(tm, "namespace"); v != "" {
			t["namespace"] = v
		}
		if v := mapStr(tm, "sectionName"); v != "" {
			t["section"] = v
		}
		out = append(out, t)
	}
	if len(out) > 0 {
		return out
	}
	for _, path := range [][]string{{"selector", "matchLabels"}, {"workloadSelector", "labels"}, {"workloadSelector", "matchLabels"}} {
		if labels := mapMap(mapMap(spec, path[0]), path[1]); len(labels) > 0 {
			out = append(out, map[string]interface{}{"kind": "selector", "name": joinLabels(labels)})
			return out
		}
	}
	if host := mapStr(spec, "host"); host != "" {
		out = append(out, map[string]interface{}{"kind": "host", "name": host})
	}
	return out
}

func joinLabels(labels map[string]interface{}) string {
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", k, labels[k]))
	}
	return strings.Join(parts, ",")
}

// policyAccepted reads the Accepted condition — directly on status
// (implementation-specific kinds) or per ancestor (GEP-713 PolicyStatus).
// known=false when the object reports no such condition.
func policyAccepted(status map[string]interface{}) (accepted bool, known bool) {
	if status == nil {
		return false, false
	}
	trues, falses := 0, 0
	count := func(conds []interface{}) {
		for _, c := range conds {
			cm, ok := c.(map[string]interface{})
			if !ok || mapStr(cm, "type") != "Accepted" {
				continue
			}
			if mapStr(cm, "status") == "True" {
				trues++
			} else {
				falses++
			}
		}
	}
	count(mapSlice(status, "conditions"))
	for _, a := range mapSlice(status, "ancestors") {
		if am, ok := a.(map[string]interface{}); ok {
			count(mapSlice(am, "conditions"))
		}
	}
	if trues+falses == 0 {
		return false, false
	}
	return falses == 0, true
}
