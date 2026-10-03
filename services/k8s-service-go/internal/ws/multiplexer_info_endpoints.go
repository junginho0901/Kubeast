package ws

import "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

// Endpoints and EndpointSlice keep their payload at the top level (`subsets`,
// `endpoints`, `ports`, `addressType`) — not under spec/status — so the generic
// summary dropped it and every watch event reset the ready counts to 0 in the
// list. Pass those fields through; the frontend normalisers already compute the
// counts from them.

func endpointsToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	out := genericToInfo(obj)
	if subsets, ok := obj.Object["subsets"]; ok {
		out["subsets"] = subsets
	}
	return out
}

func endpointSliceToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	out := genericToInfo(obj)
	for _, key := range []string{"addressType", "endpoints", "ports"} {
		if v, ok := obj.Object[key]; ok {
			out[key] = v
		}
	}
	return out
}
