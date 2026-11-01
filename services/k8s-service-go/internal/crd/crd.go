// Package crd is a CustomResourceDefinition as Kubeast lists it, one row for the list and the live list updates alike.
package crd

import (
	"sort"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Info is the definition's row. version is the storage version, which the instance pages ask the API for;
// served_versions are the versions the API serves, sorted, as kubectl's VERSIONS column (apiextensions-apiserver
// v0.37 tableconvertor) lists them.
func Info(u *unstructured.Unstructured) map[string]interface{} {
	spec, _ := u.Object["spec"].(map[string]interface{})
	group, _ := spec["group"].(string)
	scope, _ := spec["scope"].(string)
	names, _ := spec["names"].(map[string]interface{})
	kind, _ := names["kind"].(string)

	version := ""
	served := []string{}
	versions, _ := spec["versions"].([]interface{})
	for _, v := range versions {
		vm, _ := v.(map[string]interface{})
		name, _ := vm["name"].(string)
		if storage, _ := vm["storage"].(bool); storage && version == "" {
			version = name
		}
		if ok, _ := vm["served"].(bool); ok {
			served = append(served, name)
		}
	}
	if version == "" && len(versions) > 0 {
		vm, _ := versions[0].(map[string]interface{})
		version, _ = vm["name"].(string)
	}
	sort.Strings(served)

	createdAt := ""
	if ts := u.GetCreationTimestamp(); !ts.IsZero() {
		createdAt = ts.UTC().Format("2006-01-02T15:04:05Z")
	}
	return map[string]interface{}{
		"name":            u.GetName(),
		"group":           group,
		"version":         version,
		"served_versions": served,
		"scope":           scope,
		"kind":            kind,
		"created_at":      createdAt,
		"labels":          u.GetLabels(),
		"annotations":     u.GetAnnotations(),
	}
}
