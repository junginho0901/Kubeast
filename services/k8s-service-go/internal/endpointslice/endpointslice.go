// Package endpointslice is an EndpointSlice as Kubeast shows it, one row for the list, the drawer and the live list
// updates alike.
package endpointslice

import (
	"fmt"
	"time"

	discoveryv1 "k8s.io/api/discovery/v1"
)

// Ready follows the API: an unset ready condition reads as ready.
func Ready(e discoveryv1.Endpoint) bool {
	return e.Conditions.Ready == nil || *e.Conditions.Ready
}

// Info is the slice's row: its counts, ports, endpoints, labels and annotations.
func Info(es *discoveryv1.EndpointSlice) map[string]interface{} {
	ready, notReady := 0, 0
	for _, ep := range es.Endpoints {
		if Ready(ep) {
			ready++
		} else {
			notReady++
		}
	}
	created := ""
	if !es.CreationTimestamp.IsZero() {
		created = es.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":                es.Name,
		"namespace":           es.Namespace,
		"service_name":        es.Labels[discoveryv1.LabelServiceName],
		"managed_by":          es.Labels[discoveryv1.LabelManagedBy],
		"address_type":        string(es.AddressType),
		"endpoints_total":     len(es.Endpoints),
		"endpoints_ready":     ready,
		"endpoints_not_ready": notReady,
		"endpoints":           endpoints(es),
		"ports":               ports(es),
		"labels":              es.Labels,
		"annotations":         es.Annotations,
		"created_at":          created,
	}
}

// ports without repeats, with the app protocol where one is set
func ports(es *discoveryv1.EndpointSlice) []map[string]interface{} {
	seen := make(map[string]bool)
	out := make([]map[string]interface{}, 0, len(es.Ports))
	for _, p := range es.Ports {
		name, port, protocol := "", int32(0), ""
		if p.Name != nil {
			name = *p.Name
		}
		if p.Port != nil {
			port = *p.Port
		}
		if p.Protocol != nil {
			protocol = string(*p.Protocol)
		}
		key := fmt.Sprintf("%s/%d/%s", name, port, protocol)
		if seen[key] {
			continue
		}
		seen[key] = true
		pm := map[string]interface{}{"name": name, "port": port, "protocol": protocol}
		if p.AppProtocol != nil {
			pm["app_protocol"] = *p.AppProtocol
		}
		out = append(out, pm)
	}
	return out
}

func endpoints(es *discoveryv1.EndpointSlice) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(es.Endpoints))
	for _, ep := range es.Endpoints {
		conditions := map[string]interface{}{}
		if ep.Conditions.Ready != nil {
			conditions["ready"] = *ep.Conditions.Ready
		}
		if ep.Conditions.Serving != nil {
			conditions["serving"] = *ep.Conditions.Serving
		}
		if ep.Conditions.Terminating != nil {
			conditions["terminating"] = *ep.Conditions.Terminating
		}
		e := map[string]interface{}{"addresses": ep.Addresses, "conditions": conditions}
		if ep.Hostname != nil {
			e["hostname"] = *ep.Hostname
		}
		if ep.TargetRef != nil {
			e["target_ref"] = map[string]interface{}{
				"kind":      ep.TargetRef.Kind,
				"name":      ep.TargetRef.Name,
				"namespace": ep.TargetRef.Namespace,
			}
		}
		if ep.NodeName != nil {
			e["node_name"] = *ep.NodeName
		}
		if ep.Zone != nil {
			e["zone"] = *ep.Zone
		}
		// topology aware routing: the zones (PreferClose, PreferSameZone) or the node (PreferSameNode, stable in
		// 1.35) the endpoint is meant for
		if ep.Hints != nil {
			hints := map[string]interface{}{}
			if len(ep.Hints.ForZones) > 0 {
				zones := make([]string, 0, len(ep.Hints.ForZones))
				for _, z := range ep.Hints.ForZones {
					zones = append(zones, z.Name)
				}
				hints["for_zones"] = zones
			}
			if len(ep.Hints.ForNodes) > 0 {
				nodes := make([]string, 0, len(ep.Hints.ForNodes))
				for _, n := range ep.Hints.ForNodes {
					nodes = append(nodes, n.Name)
				}
				hints["for_nodes"] = nodes
			}
			if len(hints) > 0 {
				e["hints"] = hints
			}
		}
		out = append(out, e)
	}
	return out
}
