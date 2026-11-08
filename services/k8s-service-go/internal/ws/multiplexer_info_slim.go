package ws

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// The reflective converter walks all of an object and a row reads little of it: a ReplicaSet with its field managers and
// pod template took 54 µs on top of the 38 µs that reading its event takes, a Helm release's Secret 5 ms and 2.8 MB to
// decode a value no row holds. These leave out what the rows named below do not read, before converting, and the row
// still comes from the list's Info (TestSlimmedRowsAreTheRowsOfTheWholeObject).

// withoutFieldManagers is obj's fields with a metadata that has no field managers or annotations.
func withoutFieldManagers(obj *unstructured.Unstructured) map[string]interface{} {
	out := make(map[string]interface{}, len(obj.Object))
	for key, value := range obj.Object {
		out[key] = value
	}
	if metadata, ok := obj.Object["metadata"].(map[string]interface{}); ok {
		slim := make(map[string]interface{}, len(metadata))
		for key, value := range metadata {
			if key != "managedFields" && key != "annotations" {
				slim[key] = value
			}
		}
		out["metadata"] = slim
	}
	return out
}

// templateContainers reads each container's name and image, the converter's dearest walk and all the rows named below
// read of a pod template. ok is false for any other shape.
func templateContainers(spec map[string]interface{}) (containers []corev1.Container, ok bool) {
	template, ok := spec["template"].(map[string]interface{})
	if !ok {
		return nil, false
	}
	podSpec, ok := template["spec"].(map[string]interface{})
	if !ok {
		return nil, false
	}
	list, ok := podSpec["containers"].([]interface{})
	if !ok {
		return nil, false
	}
	containers = make([]corev1.Container, len(list))
	for i, c := range list {
		container, ok := c.(map[string]interface{})
		if !ok {
			return nil, false
		}
		if containers[i].Name, ok = stringField(container, "name"); !ok {
			return nil, false
		}
		if containers[i].Image, ok = stringField(container, "image"); !ok {
			return nil, false
		}
	}
	return containers, true
}

// stringField is a field that is a string or not there, as the converter takes it.
func stringField(m map[string]interface{}, key string) (string, bool) {
	value, there := m[key]
	if !there || value == nil {
		return "", true
	}
	s, ok := value.(string)
	return s, ok
}

// slimWorkload is for the rows of kinds that read only each container's name and image of their pod template, which it
// returns apart with the object to convert. A template of any other shape stays, for the converter to refuse it.
func slimWorkload(obj *unstructured.Unstructured) (map[string]interface{}, []corev1.Container) {
	out := withoutFieldManagers(obj)
	spec, ok := obj.Object["spec"].(map[string]interface{})
	if !ok {
		return out, nil
	}
	containers, ok := templateContainers(spec)
	if !ok {
		return out, nil
	}
	slimSpec := make(map[string]interface{}, len(spec))
	for key, value := range spec {
		if key != "template" {
			slimSpec[key] = value
		}
	}
	out["spec"] = slimSpec
	return out, containers
}

// slimKeysOnly is for the rows of kinds that read the names of their values and no value (a Secret, a ConfigMap): each
// value given is left empty. One that is no string stays, for the converter to refuse it.
func slimKeysOnly(obj *unstructured.Unstructured, fields ...string) map[string]interface{} {
	out := withoutFieldManagers(obj)
	for _, field := range fields {
		values, ok := obj.Object[field].(map[string]interface{})
		if !ok {
			continue
		}
		empty := make(map[string]interface{}, len(values))
		for key, value := range values {
			if _, isString := value.(string); isString {
				value = ""
			}
			empty[key] = value
		}
		out[field] = empty
	}
	return out
}

// slimEvent is what eventtime reads of an event.
func slimEvent(obj *unstructured.Unstructured) map[string]interface{} {
	out := make(map[string]interface{}, 6)
	for _, field := range []string{"firstTimestamp", "lastTimestamp", "eventTime", "count", "series"} {
		if value, ok := obj.Object[field]; ok {
			out[field] = value
		}
	}
	if metadata, ok := obj.Object["metadata"].(map[string]interface{}); ok {
		out["metadata"] = map[string]interface{}{"creationTimestamp": metadata["creationTimestamp"]}
	}
	return out
}
