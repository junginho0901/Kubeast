// Package configmap is a ConfigMap as Kubeast lists it, one row for the list, the drawer and the live list updates
// alike.
package configmap

import (
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Info is the ConfigMap's row: the names of its keys and how many, never a value. Only the drawer's describe answer
// holds those.
func Info(cm *corev1.ConfigMap) map[string]interface{} {
	created := ""
	if !cm.CreationTimestamp.IsZero() {
		created = cm.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":        cm.Name,
		"namespace":   cm.Namespace,
		"data_count":  len(cm.Data),
		"data_keys":   keys(cm.Data),
		"binary_keys": keys(cm.BinaryData),
		"labels":      cm.Labels,
		"created_at":  created,
	}
}

// keys lists a map's keys in one order, [] for none.
func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
