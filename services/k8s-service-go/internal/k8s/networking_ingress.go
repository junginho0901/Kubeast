package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	ingressrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/ingress"
)

// ========== Ingresses ==========

// GetIngresses lists ingresses in a namespace.
func (s *Service) GetIngresses(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).NetworkingV1().Ingresses(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list ingresses: %w", err)
	}
	return formatIngressList(list.Items), nil
}

// GetAllIngresses lists ingresses across all namespaces.
func (s *Service) GetAllIngresses(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.clientsetCtx(ctx).NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all ingresses: %w", err)
		}
		return formatIngressList(list.Items), nil
	})
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
		ing, ingErr = s.clientsetCtx(ctx).NetworkingV1().Ingresses(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		icList, icErr = s.clientsetCtx(ctx).NetworkingV1().IngressClasses().List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Ingress", name),
		})
	}()
	wg.Wait()

	if ingErr != nil {
		return nil, fmt.Errorf("get ingress %s/%s: %w", namespace, name, ingErr)
	}

	result := ingressrow.Info(ing)

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

	setEvents(result, events, eventsErr)

	return result, nil
}

// DeleteIngress deletes an ingress.
func (s *Service) DeleteIngress(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).NetworkingV1().Ingresses(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ListIngressesByClass returns every Ingress of the cluster whose class is the given one (ingressClassName, else the
// kubernetes.io/ingress.class annotation), in the list's order. The drawer pages them and counts them all: it cut
// at 50 before, with the title saying 50.
func (s *Service) ListIngressesByClass(ctx context.Context, className string) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.clientsetCtx(ctx).NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all ingresses: %w", err)
		}
		out := make([]map[string]interface{}, 0)
		for i := range list.Items {
			ing := &list.Items[i]
			ic := ""
			if ing.Spec.IngressClassName != nil {
				ic = *ing.Spec.IngressClassName
			} else if ann, ok := ing.Annotations["kubernetes.io/ingress.class"]; ok {
				ic = ann
			}
			if ic != className {
				continue
			}
			out = append(out, map[string]interface{}{
				"name":       ing.Name,
				"namespace":  ing.Namespace,
				"created_at": toISO(&ing.CreationTimestamp),
			})
		}
		return out, nil
	})
}

// ========== IngressClasses ==========

// GetIngressClasses lists all ingress classes.
func (s *Service) GetIngressClasses(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).NetworkingV1().IngressClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list ingress classes: %w", err)
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, ic := range list.Items {
		result = append(result, formatIngressClassDetail(&ic))
	}
	return result, nil
}

// DescribeIngressClass returns the list's row of an IngressClass with its events, which kubectl describe lists
// (searchEvents: a cluster-scoped object's events in any namespace).
func (s *Service) DescribeIngressClass(ctx context.Context, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var ic *networkingv1.IngressClass
	var events *corev1.EventList
	var icErr, eventsErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		ic, icErr = s.clientsetCtx(ctx).NetworkingV1().IngressClasses().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=IngressClass", name),
		})
	}()
	wg.Wait()
	if icErr != nil {
		return nil, fmt.Errorf("get ingress class %s: %w", name, icErr)
	}
	result := formatIngressClassDetail(ic)
	result["uid"] = string(ic.UID)
	result["resource_version"] = ic.ResourceVersion
	result["labels"] = ic.Labels
	result["annotations"] = ic.Annotations
	setEvents(result, events, eventsErr)
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
	return s.clientsetCtx(ctx).NetworkingV1().IngressClasses().Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Formatting helpers ==========

func formatIngressList(items []networkingv1.Ingress) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, ingressrow.Info(&items[i]))
	}
	return result
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
