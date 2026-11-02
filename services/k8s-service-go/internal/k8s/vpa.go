package k8s

import (
	"context"
	"fmt"
	"strings"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	vparow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/vpa"
)

// isVPANotInstalled checks if the error indicates VPA CRD is not installed.
func isVPANotInstalled(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "the server could not find the requested resource") ||
		strings.Contains(msg, "no matches for kind") ||
		strings.Contains(msg, "could not find the requested resource")
}

var vpaGVR = schema.GroupVersionResource{
	Group:    "autoscaling.k8s.io",
	Version:  "v1",
	Resource: "verticalpodautoscalers",
}

// GetVPAs lists VPAs in a namespace using dynamic client.
func (s *Service) GetVPAs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.dynamicCtx(ctx).Resource(vpaGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		if isVPANotInstalled(err) {
			return []map[string]interface{}{}, nil
		}
		return nil, fmt.Errorf("list vpas: %w", err)
	}
	return formatVPAList(list.Items), nil
}

// GetAllVPAs lists VPAs across all namespaces.
func (s *Service) GetAllVPAs(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.dynamicCtx(ctx).Resource(vpaGVR).Namespace(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			if isVPANotInstalled(err) {
				return []map[string]interface{}{}, nil
			}
			return nil, fmt.Errorf("list all vpas: %w", err)
		}
		return formatVPAList(list.Items), nil
	})
}

// DescribeVPA returns detailed info about a VPA.
func (s *Service) DescribeVPA(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var vpa *unstructured.Unstructured
	var events *corev1.EventList
	var vpaErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		vpa, vpaErr = s.dynamicCtx(ctx).Resource(vpaGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=VerticalPodAutoscaler", name),
		})
	}()
	wg.Wait()

	if vpaErr != nil {
		return nil, fmt.Errorf("get vpa %s/%s: %w", namespace, name, vpaErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := vparow.Info(vpa)

	// Additional metadata
	result["uid"] = string(vpa.GetUID())
	result["resource_version"] = vpa.GetResourceVersion()
	result["generation"] = vpa.GetGeneration()
	result["annotations"] = vpa.GetAnnotations()

	// Events
	result["events"] = formatEventList(events.Items)

	return result, nil
}

// DeleteVPA deletes a VPA.
func (s *Service) DeleteVPA(ctx context.Context, namespace, name string) error {
	return s.dynamicCtx(ctx).Resource(vpaGVR).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatVPAList(items []unstructured.Unstructured) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, vparow.Info(&items[i]))
	}
	return result
}
