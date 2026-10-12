package k8s

import (
	"context"

	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// A Service's addresses come from its EndpointSlices (label
// kubernetes.io/service-name). The Endpoints API is deprecated since 1.33 and
// every read of it counts in apiserver_requested_deprecated_apis.

// serviceEndpointSlices lists the slices of one Service.
func (s *Service) serviceEndpointSlices(ctx context.Context, namespace, service string) ([]discoveryv1.EndpointSlice, error) {
	list, err := s.clientsetCtx(ctx).DiscoveryV1().EndpointSlices(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: discoveryv1.LabelServiceName + "=" + service,
	})
	if err != nil {
		return nil, err
	}
	return list.Items, nil
}

// endpointReady follows the API: an unset ready condition reads as ready.
func endpointReady(e discoveryv1.Endpoint) bool {
	return e.Conditions.Ready == nil || *e.Conditions.Ready
}

// readyAddresses splits the slices' addresses by the ready condition.
func readyAddresses(slices []discoveryv1.EndpointSlice) (ready, notReady []string) {
	ready, notReady = []string{}, []string{}
	for i := range slices {
		for _, e := range slices[i].Endpoints {
			if endpointReady(e) {
				ready = append(ready, e.Addresses...)
			} else {
				notReady = append(notReady, e.Addresses...)
			}
		}
	}
	return ready, notReady
}

// sliceAddresses flattens the slices into one list of addresses, each with
// its slice's ports, its ready condition and the Pod it points at.
func sliceAddresses(slices []discoveryv1.EndpointSlice) []map[string]interface{} {
	out := make([]map[string]interface{}, 0)
	for i := range slices {
		ports := slicePorts(&slices[i])
		for _, e := range slices[i].Endpoints {
			for _, ip := range e.Addresses {
				entry := map[string]interface{}{"ip": ip, "ports": ports, "ready": endpointReady(e)}
				if e.TargetRef != nil {
					entry["target_ref"] = map[string]interface{}{
						"kind":      e.TargetRef.Kind,
						"name":      e.TargetRef.Name,
						"namespace": e.TargetRef.Namespace,
					}
				}
				out = append(out, entry)
			}
		}
	}
	return out
}

func slicePorts(es *discoveryv1.EndpointSlice) []map[string]interface{} {
	ports := make([]map[string]interface{}, 0, len(es.Ports))
	for _, p := range es.Ports {
		pm := map[string]interface{}{"name": "", "port": int32(0), "protocol": ""}
		if p.Name != nil {
			pm["name"] = *p.Name
		}
		if p.Port != nil {
			pm["port"] = *p.Port
		}
		if p.Protocol != nil {
			pm["protocol"] = string(*p.Protocol)
		}
		ports = append(ports, pm)
	}
	return ports
}
