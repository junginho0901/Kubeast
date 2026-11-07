// Package runtimeclass is a RuntimeClass as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package runtimeclass

import (
	"time"

	nodev1 "k8s.io/api/node/v1"
)

// Info is the RuntimeClass's row: its handler and, where it has them, its overhead and scheduling.
func Info(rc *nodev1.RuntimeClass) map[string]interface{} {
	created := ""
	if !rc.CreationTimestamp.IsZero() {
		created = rc.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	result := map[string]interface{}{
		"name":       rc.Name,
		"handler":    rc.Handler,
		"labels":     rc.Labels,
		"created_at": created,
	}

	if rc.Overhead != nil {
		overhead := map[string]string{}
		for k, v := range rc.Overhead.PodFixed {
			overhead[string(k)] = v.String()
		}
		result["overhead"] = overhead
	}

	if rc.Scheduling != nil {
		scheduling := map[string]interface{}{}
		if rc.Scheduling.NodeSelector != nil {
			scheduling["node_selector"] = rc.Scheduling.NodeSelector
		}
		if len(rc.Scheduling.Tolerations) > 0 {
			tolerations := make([]map[string]interface{}, 0, len(rc.Scheduling.Tolerations))
			for _, t := range rc.Scheduling.Tolerations {
				tol := map[string]interface{}{
					"key":      t.Key,
					"operator": string(t.Operator),
					"effect":   string(t.Effect),
				}
				if t.Value != "" {
					tol["value"] = t.Value
				}
				if t.TolerationSeconds != nil {
					tol["toleration_seconds"] = *t.TolerationSeconds
				}
				tolerations = append(tolerations, tol)
			}
			scheduling["tolerations"] = tolerations
		}
		result["scheduling"] = scheduling
	}

	return result
}
