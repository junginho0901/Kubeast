package main

import (
	"bytes"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"

	"github.com/junginho0901/kubeast/services/pkg/gitops"
)

// manifestObjects reads a manifest as kubectl -f reads it, with the same decoders:
// document by document and into the items of a list, a typed list's items taking
// its kind. kubectl stops at a document that does not parse and reports one it
// cannot decode, so neither reaches the cluster.
func manifestObjects(manifest string) []gitops.Object {
	decoder := utilyaml.NewYAMLOrJSONDecoder(strings.NewReader(manifest), 4096)
	var out []gitops.Object
	for {
		var doc runtime.RawExtension
		if err := decoder.Decode(&doc); err != nil {
			return out
		}
		raw := bytes.TrimSpace(doc.Raw)
		if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
			continue
		}
		obj, _, err := unstructured.UnstructuredJSONScheme.Decode(raw, nil, nil)
		if err != nil {
			continue
		}
		out = appendManifestObject(out, obj)
	}
}

func appendManifestObject(out []gitops.Object, obj runtime.Object) []gitops.Object {
	switch o := obj.(type) {
	case *unstructured.UnstructuredList:
		for i := range o.Items {
			out = appendManifestObject(out, &o.Items[i])
		}
	case *unstructured.Unstructured:
		if o.IsList() {
			if list, err := o.ToList(); err == nil {
				return appendManifestObject(out, list)
			}
		}
		out = append(out, gitops.Object{Group: o.GroupVersionKind().Group, Kind: o.GetKind(), Namespace: o.GetNamespace(), Name: o.GetName()})
	}
	return out
}
