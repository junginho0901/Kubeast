// Package service is a Service as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package service

import (
	"slices"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Info is the Service's row: its type, addresses, ports and selector, with EXTERNAL-IP as kubectl prints it.
func Info(svc *corev1.Service) map[string]interface{} {
	ports := make([]map[string]interface{}, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		port := map[string]interface{}{
			"name":        p.Name,
			"port":        p.Port,
			"target_port": p.TargetPort.String(),
			"protocol":    string(p.Protocol),
		}
		if p.NodePort > 0 {
			port["node_port"] = p.NodePort
		}
		if p.AppProtocol != nil {
			port["app_protocol"] = *p.AppProtocol
		}
		ports = append(ports, port)
	}

	lbIngress := make([]map[string]interface{}, 0, len(svc.Status.LoadBalancer.Ingress))
	for _, ing := range svc.Status.LoadBalancer.Ingress {
		entry := map[string]interface{}{}
		if ing.IP != "" {
			entry["ip"] = ing.IP
		}
		if ing.Hostname != "" {
			entry["hostname"] = ing.Hostname
		}
		lbIngress = append(lbIngress, entry)
	}

	created := ""
	if !svc.CreationTimestamp.IsZero() {
		created = svc.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return map[string]interface{}{
		"name":                  svc.Name,
		"namespace":             svc.Namespace,
		"type":                  string(svc.Spec.Type),
		"cluster_ip":            svc.Spec.ClusterIP,
		"external_ip":           externalIP(svc),
		"external_ips":          append(make([]string, 0, len(svc.Spec.ExternalIPs)), svc.Spec.ExternalIPs...),
		"load_balancer_ingress": lbIngress,
		"ports":                 ports,
		"selector":              svc.Spec.Selector,
		"created_at":            created,
	}
}

// externalIP is kubectl's EXTERNAL-IP (v1.37 getServiceExternalIP), not always an address: the row keeps the lists beside it.
func externalIP(svc *corev1.Service) string {
	switch svc.Spec.Type {
	case corev1.ServiceTypeClusterIP, corev1.ServiceTypeNodePort:
		if len(svc.Spec.ExternalIPs) > 0 {
			return strings.Join(svc.Spec.ExternalIPs, ",")
		}
		return "<none>"
	case corev1.ServiceTypeLoadBalancer:
		cells := append(loadBalancerAddresses(svc.Status.LoadBalancer), svc.Spec.ExternalIPs...)
		if len(cells) > 0 {
			return strings.Join(cells, ",")
		}
		return "<pending>"
	case corev1.ServiceTypeExternalName:
		return svc.Spec.ExternalName
	}
	return "<unknown>"
}

// loadBalancerAddresses are unclipped: the API server builds kubectl's Table with Wide set.
func loadBalancerAddresses(s corev1.LoadBalancerStatus) []string {
	addresses := make([]string, 0, len(s.Ingress))
	for _, ing := range s.Ingress {
		if ing.IP != "" {
			addresses = append(addresses, ing.IP)
		} else if ing.Hostname != "" {
			addresses = append(addresses, ing.Hostname)
		}
	}
	slices.Sort(addresses)
	return slices.Compact(addresses)
}
