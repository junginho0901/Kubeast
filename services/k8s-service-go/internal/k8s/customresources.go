package k8s

import (
	"sort"

	"k8s.io/apimachinery/pkg/runtime/schema"
)

// CRD discovery and Custom Resource instance operations are split between
// sibling files in this package:
//   - customresources_crd.go     : GetCRDs / DescribeCRD / DeleteCRD
//   - customresources_instance.go: list / describe / delete CR instances
//
// This file keeps the shared GVR and a tiny helper they both rely on.

// ========== Custom Resource Definitions ==========

var crdGVR = schema.GroupVersionResource{
	Group:    "apiextensions.k8s.io",
	Version:  "v1",
	Resource: "customresourcedefinitions",
}

// subresourcesToList is the subresources by name, as kubectl describe prints a CRD's (scale, status) — a map's order
// changes from one read to the next.
func subresourcesToList(m map[string]bool) []string {
	result := make([]string, 0, len(m))
	for k := range m {
		result = append(result, k)
	}
	sort.Strings(result)
	return result
}
