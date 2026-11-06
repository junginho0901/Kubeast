// Package endpoints is an Endpoints object as Kubeast lists it, one row for the list, the drawer and the live list
// updates alike.
package endpoints

import (
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// addressPreview caps the address lists a row carries; the counts and targets hold every address.
const addressPreview = 50

// Info is the row: the ready and not-ready counts, addresses and targets across every subset, and the ports once each.
func Info(ep *corev1.Endpoints) map[string]interface{} {
	readyCount := 0
	notReadyCount := 0
	readyAddresses := make([]string, 0)
	notReadyAddresses := make([]string, 0)
	readyTargets := make([]map[string]interface{}, 0)
	notReadyTargets := make([]map[string]interface{}, 0)
	portSet := make(map[string]bool)
	ports := make([]map[string]interface{}, 0)

	for _, subset := range ep.Subsets {
		readyCount += len(subset.Addresses)
		notReadyCount += len(subset.NotReadyAddresses)

		for _, addr := range subset.Addresses {
			if len(readyAddresses) < addressPreview {
				readyAddresses = append(readyAddresses, addr.IP)
			}
			readyTargets = append(readyTargets, target(addr))
		}

		for _, addr := range subset.NotReadyAddresses {
			if len(notReadyAddresses) < addressPreview {
				notReadyAddresses = append(notReadyAddresses, addr.IP)
			}
			notReadyTargets = append(notReadyTargets, target(addr))
		}

		for _, p := range subset.Ports {
			key := fmt.Sprintf("%s/%d/%s", p.Name, p.Port, string(p.Protocol))
			if !portSet[key] {
				portSet[key] = true
				ports = append(ports, map[string]interface{}{
					"name":     p.Name,
					"port":     p.Port,
					"protocol": string(p.Protocol),
				})
			}
		}
	}

	created := ""
	if !ep.CreationTimestamp.IsZero() {
		created = ep.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return map[string]interface{}{
		"name":                ep.Name,
		"namespace":           ep.Namespace,
		"ready_count":         readyCount,
		"not_ready_count":     notReadyCount,
		"ready_addresses":     readyAddresses,
		"not_ready_addresses": notReadyAddresses,
		"ready_targets":       readyTargets,
		"not_ready_targets":   notReadyTargets,
		"ports":               ports,
		"created_at":          created,
	}
}

func target(addr corev1.EndpointAddress) map[string]interface{} {
	t := map[string]interface{}{"ip": addr.IP}
	if addr.NodeName != nil {
		t["node_name"] = *addr.NodeName
	}
	if addr.TargetRef != nil {
		t["target_ref"] = map[string]interface{}{
			"kind": addr.TargetRef.Kind,
			"name": addr.TargetRef.Name,
		}
	}
	return t
}
