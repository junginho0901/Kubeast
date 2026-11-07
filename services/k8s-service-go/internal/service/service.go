// Package service is a Service as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package service

import (
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Info is the Service's row: its type, addresses, ports and selector.
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

	externalIPs := make([]string, 0)
	externalIPs = append(externalIPs, svc.Spec.ExternalIPs...)
	if svc.Spec.Type == corev1.ServiceTypeLoadBalancer {
		for _, ing := range svc.Status.LoadBalancer.Ingress {
			if ing.IP != "" {
				externalIPs = append(externalIPs, ing.IP)
			}
			if ing.Hostname != "" {
				externalIPs = append(externalIPs, ing.Hostname)
			}
		}
	}

	externalIP := "<none>"
	if len(externalIPs) > 0 {
		externalIP = strings.Join(externalIPs, ",")
	}

	created := ""
	if !svc.CreationTimestamp.IsZero() {
		created = svc.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return map[string]interface{}{
		"name":        svc.Name,
		"namespace":   svc.Namespace,
		"type":        string(svc.Spec.Type),
		"cluster_ip":  svc.Spec.ClusterIP,
		"external_ip": externalIP,
		"ports":       ports,
		"selector":    svc.Spec.Selector,
		"created_at":  created,
	}
}
