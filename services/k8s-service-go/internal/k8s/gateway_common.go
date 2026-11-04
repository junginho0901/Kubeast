package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const gatewayAPIGroup = "gateway.networking.k8s.io"

// addObjectMetaFields adds the ObjectMeta values the detail drawers' Lifecycle
// section reads (the same keys the typed describe responses carry).
func addObjectMetaFields(result map[string]interface{}, obj *unstructured.Unstructured) {
	result["uid"] = string(obj.GetUID())
	result["resource_version"] = obj.GetResourceVersion()
	result["generation"] = obj.GetGeneration()
	if f := obj.GetFinalizers(); len(f) > 0 {
		result["finalizers"] = f
	}
}

// gatewayGVR is the GVR the cluster serves for one Gateway API resource. Each
// kind is resolved on its own because the group mixes versions (gateways v1,
// referencegrants v1beta1, backendtlspolicies v1alpha3). When the cluster has
// no Gateway API, the v1 GVR is returned so the list fails with "not found",
// which the handlers turn into an empty page.
func (s *Service) gatewayGVR(ctx context.Context, resource string) schema.GroupVersionResource {
	if gvr, ok := s.resolveGVR(ctx, gatewayAPIGroup, resource); ok {
		return gvr
	}
	return schema.GroupVersionResource{Group: gatewayAPIGroup, Version: "v1", Resource: resource}
}

// gatewayRows is a Gateway API list as the list pages show it: each item the row gatewayrow builds, the row the
// live updates carry too.
func gatewayRows(list *unstructured.UnstructuredList, row func(*unstructured.Unstructured) map[string]interface{}) []map[string]interface{} {
	if list == nil {
		return []map[string]interface{}{}
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for i := range list.Items {
		result = append(result, row(&list.Items[i]))
	}
	return result
}

// describeGatewayObject is a Gateway API object as its drawer shows it: the row the list shows (gatewayrow), the
// metadata the Lifecycle section reads and the events about it, found as kubectl describe finds them (involvedObject
// name and kind, in every namespace for a cluster-scoped kind). The object comes back for what only a drawer shows.
func (s *Service) describeGatewayObject(ctx context.Context, resource, kind, namespace, name string, row func(*unstructured.Unstructured) map[string]interface{}) (map[string]interface{}, *unstructured.Unstructured, error) {
	gvr := s.gatewayGVR(ctx, resource)
	var obj *unstructured.Unstructured
	var events *corev1.EventList
	var objErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		obj, objErr = s.GetResource(ctx, gvr, namespace, name)
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=%s", name, kind),
		})
	}()
	wg.Wait()

	if objErr != nil {
		return nil, nil, objErr
	}
	result := row(obj)
	addObjectMetaFields(result, obj)
	setEvents(result, events, eventsErr)
	return result, obj, nil
}
