package ws

import (
	discoveryv1 "k8s.io/api/discovery/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/endpointslice"
)

// Endpoints keep their payload at the top level (`subsets`), not under
// spec/status — so the generic summary dropped it and every watch event reset
// the ready counts to 0 in the list. Pass it through; the frontend normaliser
// computes the counts from it.

func endpointsToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	out := genericToInfo(obj)
	if subsets, ok := obj.Object["subsets"]; ok {
		out["subsets"] = subsets
	}
	return out
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
