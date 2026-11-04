// Package drarow is a Dynamic Resource Allocation object as Kubeast lists it — DeviceClass, ResourceClaim,
// ResourceClaimTemplate, ResourceSlice — one row for the list API, describe and the live list updates alike, read
// from the resource.k8s.io/v1 shape (spec.driver, spec.nodeName, spec.pool, requests[].exactly or firstAvailable).
// The columns kubectl prints are its values (Kubernetes v1.37 pkg/printers/internalversion/printers.go): a claim's
// State is resourceClaimState, a slice's Node, Driver and Pool are printResourceSlice's.
package drarow

import (
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func object(m map[string]interface{}, key string) map[string]interface{} {
	o, _ := m[key].(map[string]interface{})
	return o
}

func list(m map[string]interface{}, key string) []interface{} {
	l, _ := m[key].([]interface{})
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

func meta(u *unstructured.Unstructured) map[string]interface{} {
	created := ""
	if ts := u.GetCreationTimestamp(); !ts.IsZero() {
		created = ts.UTC().Format(time.RFC3339)
	}
	labels := u.GetLabels()
	if labels == nil {
		labels = map[string]string{}
	}
	row := map[string]interface{}{"name": u.GetName(), "labels": labels, "created_at": created}
	if ns := u.GetNamespace(); ns != "" {
		row["namespace"] = ns
	}
	return row
}

// requests are a claim spec's device requests (devices.requests).
func requests(claimSpec map[string]interface{}) []map[string]interface{} {
	return maps(list(object(claimSpec, "devices"), "requests"))
}

// ClaimState is kubectl's STATE of a ResourceClaim (resourceClaimState): "deleted" while it is being deleted, then
// "pending" without an allocation (left out while deleted), or "allocated" and "reserved" while a consumer holds it,
// joined by commas.
func ClaimState(u *unstructured.Unstructured) string {
	var states []string
	deleted := u.GetDeletionTimestamp() != nil
	if deleted {
		states = append(states, "deleted")
	}
	status := object(u.Object, "status")
	if object(status, "allocation") == nil {
		if !deleted {
			states = append(states, "pending")
		}
	} else {
		states = append(states, "allocated")
		if len(list(status, "reservedFor")) > 0 {
			states = append(states, "reserved")
		}
	}
	return strings.Join(states, ",")
}

// DeviceClass: the selectors it has (v1 DeviceClass has no status).
func DeviceClass(u *unstructured.Unstructured) map[string]interface{} {
	row := meta(u)
	row["selector_count"] = len(list(object(u.Object, "spec"), "selectors"))
	return row
}

// Claim: how many requests it makes and kubectl's State.
func Claim(u *unstructured.Unstructured) map[string]interface{} {
	row := meta(u)
	row["request_count"] = len(requests(object(u.Object, "spec")))
	row["state"] = ClaimState(u)
	return row
}

// ClaimTemplate: how many requests the claims made from it make.
func ClaimTemplate(u *unstructured.Unstructured) map[string]interface{} {
	row := meta(u)
	row["request_count"] = len(requests(object(object(u.Object, "spec"), "spec")))
	return row
}

// Slice: kubectl's Node (spec.nodeName, empty for a slice of all nodes or a node selector), Driver and Pool, and the
// devices it publishes.
func Slice(u *unstructured.Unstructured) map[string]interface{} {
	spec := object(u.Object, "spec")
	row := meta(u)
	row["node_name"] = str(spec, "nodeName")
	row["driver_name"] = str(spec, "driver")
	row["pool_name"] = str(object(spec, "pool"), "name")
	row["device_count"] = len(list(spec, "devices"))
	allNodes, _ := spec["allNodes"].(bool)
	row["all_nodes"] = allNodes
	return row
}

// ClassRequests are the names of a claim's requests that ask for the device class: a request whose exactly names it
// (v1beta1, 1.32–1.33: the request itself), or one with a firstAvailable subrequest that does.
func ClassRequests(u *unstructured.Unstructured, class string) []string {
	var names []string
	for _, r := range requests(object(u.Object, "spec")) {
		uses := str(object(r, "exactly"), "deviceClassName") == class || str(r, "deviceClassName") == class
		for _, sub := range maps(list(r, "firstAvailable")) {
			uses = uses || str(sub, "deviceClassName") == class
		}
		if uses {
			names = append(names, str(r, "name"))
		}
	}
	return names
}

// UsedBy are the claims whose requests ask for the device class, each with its State and those requests.
func UsedBy(class string, claims []unstructured.Unstructured) []map[string]interface{} {
	out := []map[string]interface{}{}
	for i := range claims {
		if names := ClassRequests(&claims[i], class); len(names) > 0 {
			out = append(out, map[string]interface{}{
				"namespace": claims[i].GetNamespace(), "name": claims[i].GetName(), "state": ClaimState(&claims[i]), "requests": names,
			})
		}
	}
	return out
}

// SliceAllocations are the slice's devices that claims hold: each status.allocation.devices.results entry whose driver,
// pool and device are the slice's (a pool can span slices; a device name is unique in its pool).
func SliceAllocations(slice *unstructured.Unstructured, claims []unstructured.Unstructured) []map[string]interface{} {
	spec := object(slice.Object, "spec")
	driver, pool := str(spec, "driver"), str(object(spec, "pool"), "name")
	devices := map[string]bool{}
	for _, d := range maps(list(spec, "devices")) {
		devices[str(d, "name")] = true
	}
	out := []map[string]interface{}{}
	for i := range claims {
		alloc := object(object(claims[i].Object, "status"), "allocation")
		for _, r := range maps(list(object(alloc, "devices"), "results")) {
			if str(r, "driver") != driver || str(r, "pool") != pool || !devices[str(r, "device")] {
				continue
			}
			out = append(out, map[string]interface{}{
				"claim_namespace": claims[i].GetNamespace(), "claim_name": claims[i].GetName(),
				"request": str(r, "request"), "device": str(r, "device"), "driver": driver, "pool": pool,
			})
		}
	}
	return out
}

// ReservedPods are the pods holding allocated devices: the status.reservedFor entries of resource pods (core group)
// of each claim with an allocation, in the claim's namespace, once each and sorted.
func ReservedPods(claims []unstructured.Unstructured) []map[string]interface{} {
	seen := map[[2]string]bool{}
	var keys [][2]string
	for i := range claims {
		status := object(claims[i].Object, "status")
		if object(status, "allocation") == nil {
			continue
		}
		for _, c := range maps(list(status, "reservedFor")) {
			k := [2]string{claims[i].GetNamespace(), str(c, "name")}
			if str(c, "resource") != "pods" || str(c, "apiGroup") != "" || k[1] == "" || seen[k] {
				continue
			}
			seen[k] = true
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(a, b int) bool {
		if keys[a][0] != keys[b][0] {
			return keys[a][0] < keys[b][0]
		}
		return keys[a][1] < keys[b][1]
	})
	out := make([]map[string]interface{}, 0, len(keys))
	for _, k := range keys {
		out = append(out, map[string]interface{}{"namespace": k[0], "name": k[1]})
	}
	return out
}

// PodUsesClaim reports whether the pod refers to the claim: by name in spec.resourceClaims, or as the claim made for it
// from a template, which its status.resourceClaimStatuses records.
func PodUsesClaim(p *corev1.Pod, claim string) bool {
	for _, c := range p.Spec.ResourceClaims {
		if c.ResourceClaimName != nil && *c.ResourceClaimName == claim {
			return true
		}
	}
	for _, s := range p.Status.ResourceClaimStatuses {
		if s.ResourceClaimName != nil && *s.ResourceClaimName == claim {
			return true
		}
	}
	return false
}

// PodTemplateClaims are the claims made for the pod from the template: for each of its spec.resourceClaims naming the
// template, the claim its status.resourceClaimStatuses entry of the same name records (none until it is made).
func PodTemplateClaims(p *corev1.Pod, template string) []string {
	var out []string
	for _, c := range p.Spec.ResourceClaims {
		if c.ResourceClaimTemplateName == nil || *c.ResourceClaimTemplateName != template {
			continue
		}
		for _, s := range p.Status.ResourceClaimStatuses {
			if s.Name == c.Name && s.ResourceClaimName != nil && *s.ResourceClaimName != "" {
				out = append(out, *s.ResourceClaimName)
			}
		}
	}
	return out
}
