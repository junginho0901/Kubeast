// Package secret is a Secret as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package secret

import (
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Info is the Secret's row: its type and the names of its keys. It never holds a value, nor the annotations, where
// kubectl apply repeats the values; reading those is the drawer's describe answer and its permission.
func Info(s *corev1.Secret) map[string]interface{} {
	keys := make([]string, 0, len(s.Data))
	for k := range s.Data {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	created := ""
	if !s.CreationTimestamp.IsZero() {
		created = s.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return map[string]interface{}{
		"name":       s.Name,
		"namespace":  s.Namespace,
		"type":       string(s.Type),
		"data_count": len(s.Data),
		"data_keys":  keys,
		"labels":     s.Labels,
		"created_at": created,
	}
}
