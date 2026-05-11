package k8s

import (
	"context"
	"fmt"
	"sort"
	"sync"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== Ingresses ==========

// GetIngresses lists ingresses in a namespace.
func (s *Service) GetIngresses(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().NetworkingV1().Ingresses(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list ingresses: %w", err)
	}
	return formatIngressList(list.Items), nil
}

// GetAllIngresses lists ingresses across all namespaces.
func (s *Service) GetAllIngresses(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().NetworkingV1().Ingresses("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all ingresses: %w", err)
	}
	return formatIngressList(list.Items), nil
}

// DescribeIngress returns detailed info about an ingress.
func (s *Service) DescribeIngress(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var ing *networkingv1.Ingress
	var icList *networkingv1.IngressClassList
	var events *corev1.EventList
	var ingErr, icErr, eventsErr error

	wg.Add(3)
	go func() {
		defer wg.Done()
		ing, ingErr = s.Clientset().NetworkingV1().Ingresses(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		icList, icErr = s.Clientset().NetworkingV1().IngressClasses().List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Ingress", name),
		})
	}()
	wg.Wait()

	if ingErr != nil {
		return nil, fmt.Errorf("get ingress %s/%s: %w", namespace, name, ingErr)
	}

	// formatIngressDetail now includes rules, tls, default_backend, labels, annotations
	result := formatIngressDetail(ing)

	// Try to enrich with IngressClass controller info
	if ing.Spec.IngressClassName != nil && icErr == nil {
		for i := range icList.Items {
			if icList.Items[i].Name == *ing.Spec.IngressClassName {
				ic := &icList.Items[i]
				result["class_controller"] = ic.Spec.Controller
				isDefault := false
				if v, ok := ic.Annotations["ingressclass.kubernetes.io/is-default-class"]; ok && v == "true" {
					isDefault = true
				}
				result["class_is_default"] = isDefault
				break
			}
		}
	}

	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteIngress deletes an ingress.
func (s *Service) DeleteIngress(ctx context.Context, namespace, name string) error {
	return s.Clientset().NetworkingV1().Ingresses(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== IngressClasses ==========

// GetIngressClasses lists all ingress classes.
func (s *Service) GetIngressClasses(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().NetworkingV1().IngressClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list ingress classes: %w", err)
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, ic := range list.Items {
		result = append(result, formatIngressClassDetail(&ic))
	}
	return result, nil
}

// DescribeIngressClass returns detailed info about an ingress class.
func (s *Service) DescribeIngressClass(ctx context.Context, name string) (map[string]interface{}, error) {
	ic, err := s.Clientset().NetworkingV1().IngressClasses().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get ingress class %s: %w", name, err)
	}
	result := formatIngressClassDetail(ic)
	result["labels"] = ic.Labels
	result["annotations"] = ic.Annotations
	if ic.Spec.Parameters != nil {
		params := map[string]interface{}{
			"kind": ic.Spec.Parameters.Kind,
			"name": ic.Spec.Parameters.Name,
		}
		if ic.Spec.Parameters.APIGroup != nil {
			params["api_group"] = *ic.Spec.Parameters.APIGroup
		}
		if ic.Spec.Parameters.Namespace != nil {
			params["namespace"] = *ic.Spec.Parameters.Namespace
		}
		if ic.Spec.Parameters.Scope != nil {
			params["scope"] = *ic.Spec.Parameters.Scope
		}
		result["parameters"] = params
	}
	return result, nil
}

// DeleteIngressClass deletes an ingress class.
func (s *Service) DeleteIngressClass(ctx context.Context, name string) error {
	return s.Clientset().NetworkingV1().IngressClasses().Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Formatting helpers ==========

func formatIngressList(items []networkingv1.Ingress) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, ing := range items {
		result = append(result, formatIngressDetail(&ing))
	}
	return result
}

func formatIngressDetail(ing *networkingv1.Ingress) map[string]interface{} {
	hosts := make([]string, 0)
	backendSet := make(map[string]bool)
	backends := make([]string, 0)

	// Build rules with full detail
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

	// TLS info
	tls := make([]map[string]interface{}, 0, len(ing.Spec.TLS))
	for _, t := range ing.Spec.TLS {
		tls = append(tls, map[string]interface{}{
			"secret_name": t.SecretName,
			"hosts":       t.Hosts,
		})
	}

	// Default backend
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
		"created_at":      toISO(&ing.CreationTimestamp),
	}
}

func formatIngressClassDetail(ic *networkingv1.IngressClass) map[string]interface{} {
	isDefault := false
	if v, ok := ic.Annotations["ingressclass.kubernetes.io/is-default-class"]; ok && v == "true" {
		isDefault = true
	}

	result := map[string]interface{}{
		"name":        ic.Name,
		"controller":  ic.Spec.Controller,
		"is_default":  isDefault,
		"labels":      ic.Labels,
		"annotations": ic.Annotations,
		"finalizers":  ic.Finalizers,
		"created_at":  toISO(&ic.CreationTimestamp),
	}

	if ic.Spec.Parameters != nil {
		params := map[string]interface{}{
			"kind": ic.Spec.Parameters.Kind,
			"name": ic.Spec.Parameters.Name,
		}
		if ic.Spec.Parameters.APIGroup != nil {
			params["api_group"] = *ic.Spec.Parameters.APIGroup
		}
		if ic.Spec.Parameters.Namespace != nil {
			params["namespace"] = *ic.Spec.Parameters.Namespace
		}
		if ic.Spec.Parameters.Scope != nil {
			params["scope"] = *ic.Spec.Parameters.Scope
		}
		result["parameters"] = params
	}

	return result
}
