// Package ingress is an Ingress as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package ingress

import (
	"sort"
	"time"

	networkingv1 "k8s.io/api/networking/v1"
)

// Info is the Ingress's row: its class and where the class came from, hosts, addresses, TLS, default backend, rules
// and backends.
func Info(ing *networkingv1.Ingress) map[string]interface{} {
	hosts := make([]string, 0)
	backendSet := make(map[string]bool)
	backends := make([]string, 0)

	rules := make([]map[string]interface{}, 0, len(ing.Spec.Rules))
	for _, rule := range ing.Spec.Rules {
		if rule.Host != "" {
			hosts = append(hosts, rule.Host)
		}
		r := map[string]interface{}{
			"host": rule.Host,
		}
		if rule.HTTP != nil {
			paths := make([]map[string]interface{}, 0, len(rule.HTTP.Paths))
			for _, p := range rule.HTTP.Paths {
				path := map[string]interface{}{
					"path": p.Path,
				}
				if p.PathType != nil {
					path["path_type"] = string(*p.PathType)
				}
				if p.Backend.Service != nil {
					svcName := p.Backend.Service.Name
					backend := map[string]interface{}{
						"service_name": svcName,
					}
					if p.Backend.Service.Port.Number > 0 {
						backend["service_port"] = p.Backend.Service.Port.Number
					}
					if p.Backend.Service.Port.Name != "" {
						backend["service_port_name"] = p.Backend.Service.Port.Name
					}
					path["backend"] = backend
					if !backendSet[svcName] {
						backendSet[svcName] = true
						backends = append(backends, svcName)
					}
				}
				paths = append(paths, path)
			}
			r["paths"] = paths
		}
		rules = append(rules, r)
	}
	sort.Strings(backends)

	addresses := make([]map[string]interface{}, 0)
	for _, lb := range ing.Status.LoadBalancer.Ingress {
		addr := map[string]interface{}{}
		if lb.IP != "" {
			addr["ip"] = lb.IP
		}
		if lb.Hostname != "" {
			addr["hostname"] = lb.Hostname
		}
		if len(lb.Ports) > 0 {
			ports := make([]map[string]interface{}, 0, len(lb.Ports))
			for _, p := range lb.Ports {
				port := map[string]interface{}{
					"port":     int(p.Port),
					"protocol": string(p.Protocol),
				}
				if p.Error != nil {
					port["error"] = *p.Error
				}
				ports = append(ports, port)
			}
			addr["ports"] = ports
		}
		addresses = append(addresses, addr)
	}

	ingressClass := ""
	classSource := ""
	if ing.Spec.IngressClassName != nil {
		ingressClass = *ing.Spec.IngressClassName
		classSource = "spec"
	} else if v, ok := ing.Annotations["kubernetes.io/ingress.class"]; ok {
		ingressClass = v
		classSource = "annotation"
	}

	tls := make([]map[string]interface{}, 0, len(ing.Spec.TLS))
	for _, t := range ing.Spec.TLS {
		tls = append(tls, map[string]interface{}{
			"secret_name": t.SecretName,
			"hosts":       t.Hosts,
		})
	}

	var defaultBackend interface{}
	if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
		db := map[string]interface{}{
			"type":         "service",
			"service_name": ing.Spec.DefaultBackend.Service.Name,
		}
		if ing.Spec.DefaultBackend.Service.Port.Number > 0 {
			db["service_port"] = ing.Spec.DefaultBackend.Service.Port.Number
		}
		defaultBackend = db
	}

	created := ""
	if !ing.CreationTimestamp.IsZero() {
		created = ing.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":            ing.Name,
		"namespace":       ing.Namespace,
		"class":           ingressClass,
		"class_source":    classSource,
		"hosts":           hosts,
		"addresses":       addresses,
		"tls":             tls,
		"default_backend": defaultBackend,
		"rules":           rules,
		"backends":        backends,
		"labels":          ing.Labels,
		"annotations":     ing.Annotations,
		"created_at":      created,
	}
}
