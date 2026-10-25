package netflows

import (
	"context"
	"strings"
)

// Lookup answers, as the reader, what a plugin's flows leave out. Microsoft Retina's Hubble control plane
// names a pod without its workload, and at a pod shows a Service's own address (seen before kube-proxy sent
// the packet to a pod, or before it put the pod's address back on the reply); Cilium's flows carry both, so
// nothing is looked up for them.
type Lookup interface {
	// Workloads names the workload of each pod of a namespace as the Hubble agent does, by the pod's name and
	// by its set as Calico names it (<generateName>*).
	Workloads(ctx context.Context, namespace string) (map[string]Workload, error)
	// ServiceIPs are the cluster IPs of a namespace's Services.
	ServiceIPs(ctx context.Context, namespace string) (map[string]bool, error)
	// PodSet is a pod's set as Calico names it: <generateName>*, or the pod's name when it has none.
	PodSet(ctx context.Context, namespace, pod string) (string, error)
}

// MaxLookupNamespaces caps the namespaces one read looks up; ends in others stay as the flows name them.
const MaxLookupNamespaces = 20

// fill names the workloads of pod ends that have none and marks the ends that are a Service's own address
// (the namespaces of the Services the flows name are looked up). A namespace the reader cannot read stays as
// the flows name it.
func fill(ctx context.Context, l Lookup, flows []Flow) {
	if l == nil {
		return
	}
	workloads := map[string]map[string]Workload{}
	serviceNamespaces := map[string]bool{}
	for i := range flows {
		for _, e := range []*End{&flows[i].Source, &flows[i].Destination} {
			if e.Pod == "" && e.Service != "" && e.IP != "" {
				ns, _, _ := strings.Cut(e.Service, "/")
				serviceNamespaces[ns] = true
			}
			if e.Namespace == "" || e.Pod == "" || e.Workload != nil {
				continue
			}
			m, ok := workloads[e.Namespace]
			if !ok && len(workloads) < MaxLookupNamespaces {
				m, _ = l.Workloads(ctx, e.Namespace)
				workloads[e.Namespace] = m
			}
			if w, ok := m[e.Pod]; ok {
				e.Workload = &w
			}
		}
	}
	serviceIPs := map[string]bool{}
	n := 0
	for ns := range serviceNamespaces {
		if n++; n > MaxLookupNamespaces {
			break
		}
		ips, _ := l.ServiceIPs(ctx, ns)
		for ip := range ips {
			serviceIPs[ip] = true
		}
	}
	if len(serviceIPs) == 0 {
		return
	}
	for i := range flows {
		for _, e := range []*End{&flows[i].Source, &flows[i].Destination} {
			if e.Pod == "" && serviceIPs[e.IP] {
				e.ServiceAddress = true
			}
		}
	}
}
