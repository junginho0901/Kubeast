package k8s

import (
	"encoding/json"
	"fmt"
	"reflect"

	"gopkg.in/yaml.v3"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/strategicpatch"
	"k8s.io/client-go/kubernetes/scheme"
)

// openedObject is the text a YAML window's edit began from, nil when there is none or it reads as no object.
func openedObject(opened string) map[string]interface{} {
	var out map[string]interface{}
	if err := yaml.Unmarshal([]byte(opened), &out); err != nil || len(out) == 0 {
		return nil
	}
	return out
}

// patchTypeOf is the patch a whole document goes as: a kind client-go knows takes a strategic merge patch, and the API
// server answers 415 to one for a custom resource (apiextensions customresource_handler.go), which takes a JSON merge patch.
func patchTypeOf(gvk schema.GroupVersionKind) types.PatchType {
	if _, err := scheme.Scheme.New(gvk); err != nil {
		return types.MergePatchType
	}
	return types.StrategicMergePatchType
}

// Fields the API server keeps by itself: a line of them taken out of a window asks for nothing.
var serverKeptMetadata = []string{"uid", "resourceVersion", "generation", "creationTimestamp", "managedFields", "selfLink", "deletionTimestamp", "deletionGracePeriodSeconds"}

// editedPatch is what a save of a YAML window sends, worked out as kubectl edit does: the difference between the text the
// edit began from and the text saved. A merge patch leaves what it does not name, so a line taken out goes as its deletion,
// and a key someone added since is not named. A strategic patch follows each list's merge key; a JSON merge patch replaces
// a list that changed whole and leaves one that did not. The version the text was read at goes along, so a save over an
// object changed since is refused as before.
func editedPatch(gvk schema.GroupVersionKind, before, edited map[string]interface{}) (types.PatchType, []byte, error) {
	keepIdentity(before, edited)
	patchType, patch, err := differenceOf(gvk, before, edited)
	if err != nil {
		return "", nil, fmt.Errorf("marshal patch: %w", err)
	}
	metadata, _ := patch["metadata"].(map[string]interface{})
	for _, key := range serverKeptMetadata {
		if value, named := metadata[key]; named && value == nil {
			delete(metadata, key)
		}
	}
	if editedMetadata, ok := edited["metadata"].(map[string]interface{}); ok && editedMetadata["resourceVersion"] != nil {
		if metadata == nil {
			metadata = map[string]interface{}{}
			patch["metadata"] = metadata
		}
		metadata["resourceVersion"] = editedMetadata["resourceVersion"]
	}
	if metadata != nil && len(metadata) == 0 {
		delete(patch, "metadata")
	}
	raw, err := json.Marshal(patch)
	return patchType, raw, err
}

// keepIdentity puts back what the object is, whose lines taken out of a window ask for nothing a patch could do.
func keepIdentity(before, edited map[string]interface{}) {
	for _, key := range []string{"apiVersion", "kind"} {
		if _, named := edited[key]; !named && before[key] != nil {
			edited[key] = before[key]
		}
	}
	beforeMetadata, _ := before["metadata"].(map[string]interface{})
	if _, named := edited["metadata"]; !named && beforeMetadata != nil {
		edited["metadata"] = map[string]interface{}{}
	}
	metadata, ok := edited["metadata"].(map[string]interface{})
	if !ok {
		return
	}
	for _, key := range []string{"name", "namespace"} {
		if _, named := metadata[key]; !named && beforeMetadata[key] != nil {
			metadata[key] = beforeMetadata[key]
		}
	}
}

func differenceOf(gvk schema.GroupVersionKind, before, edited map[string]interface{}) (types.PatchType, map[string]interface{}, error) {
	original, err := json.Marshal(before)
	if err != nil {
		return "", nil, err
	}
	modified, err := json.Marshal(edited)
	if err != nil {
		return "", nil, err
	}
	var from, to map[string]interface{}
	if err := json.Unmarshal(original, &from); err != nil {
		return "", nil, err
	}
	if err := json.Unmarshal(modified, &to); err != nil {
		return "", nil, err
	}
	if typed, err := scheme.Scheme.New(gvk); err == nil {
		// Where this is no answer the JSON merge patch below is: a field this client's types do not have is an error here,
		// and a merge key two items share (a Service's port for TCP and UDP) gives a patch that takes both out.
		if raw, err := strategicpatch.CreateTwoWayMergePatch(original, modified, typed); err == nil {
			merged, err := strategicpatch.StrategicMergePatch(original, raw, typed)
			var result, patch map[string]interface{}
			if err == nil && json.Unmarshal(merged, &result) == nil && json.Unmarshal(raw, &patch) == nil && reflect.DeepEqual(result, withoutNulls(to)) {
				return types.StrategicMergePatchType, patch, nil
			}
		}
	}
	return types.MergePatchType, mergePatchOf(from, to), nil
}

// withoutNulls is an object as it reads once a patch has taken out the keys written with no value.
func withoutNulls(value map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(value))
	for key, item := range value {
		if item == nil {
			continue
		}
		out[key] = withoutNullsIn(item)
	}
	return out
}

func withoutNullsIn(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}:
		return withoutNulls(typed)
	case []interface{}:
		out := make([]interface{}, len(typed))
		for i, item := range typed {
			out[i] = withoutNullsIn(item)
		}
		return out
	}
	return value
}

// mergePatchOf is the RFC 7386 patch from one object to another.
func mergePatchOf(from, to map[string]interface{}) map[string]interface{} {
	patch := map[string]interface{}{}
	for key := range from {
		if _, kept := to[key]; !kept {
			patch[key] = nil
		}
	}
	for key, value := range to {
		old, had := from[key]
		if had && reflect.DeepEqual(old, value) {
			continue
		}
		oldMap, oldIsMap := old.(map[string]interface{})
		newMap, newIsMap := value.(map[string]interface{})
		if had && oldIsMap && newIsMap {
			patch[key] = mergePatchOf(oldMap, newMap)
			continue
		}
		patch[key] = value
	}
	return patch
}
