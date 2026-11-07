package ws

import (
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	endpointsrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/endpoints"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/endpointslice"
)

// endpointsToInfo is the list's row (endpointsrow.Info), so a live update says what the list says. An object that does
// not convert keeps its subsets, which sit beside the metadata and not under spec or status, for the page to read.
func endpointsToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var ep corev1.Endpoints
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &ep); err != nil {
		out := genericToInfo(obj)
		if subsets, ok := obj.Object["subsets"]; ok {
			out["subsets"] = subsets
		}
		return out
	}
	return endpointsrow.Info(&ep)
}

// endpointSliceToInfo is the list's row (endpointslice.Info), so a live update carries the endpoints, labels and
// annotations the list and its drawer show.
func endpointSliceToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var es discoveryv1.EndpointSlice
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &es); err != nil {
		return genericToInfo(obj)
	}
	return endpointslice.Info(&es)
}
