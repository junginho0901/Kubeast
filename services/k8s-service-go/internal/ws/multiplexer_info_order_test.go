package ws

import (
	"fmt"
	"slices"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// The live updates hold the same lists as the list APIs, in the same order (internal/k8s/list_order_test.go).

func keysObject(fields ...string) *unstructured.Unstructured {
	obj := map[string]interface{}{"metadata": map[string]interface{}{"name": "x", "namespace": "n"}}
	for _, field := range fields {
		m := map[string]interface{}{}
		for i := 0; i < 12; i++ {
			// valid as a ConfigMap's text and as base64, what a Secret's and a binaryData value are
			m[fmt.Sprintf("key-%02d", i)] = "dg=="
		}
		obj[field] = m
	}
	return &unstructured.Unstructured{Object: obj}
}

func TestLiveKeys_Sorted(t *testing.T) {
	cases := []struct {
		name string
		info map[string]interface{}
		keys []string
	}{
		{"ConfigMap", configmapToInfo(keysObject("data", "binaryData")), []string{"data_keys", "binary_keys"}},
		{"Secret", secretToInfo(keysObject("data")), []string{"data_keys"}},
	}
	for _, c := range cases {
		for _, k := range c.keys {
			list, _ := c.info[k].([]string)
			if len(list) != 12 || !slices.IsSorted(list) {
				t.Errorf("%s %s = %v, want the 12 keys sorted", c.name, k, list)
			}
		}
	}
}

func TestLivePodRefs_Sorted(t *testing.T) {
	var envFrom []interface{}
	for i := 12; i > 0; i-- {
		envFrom = append(envFrom,
			map[string]interface{}{"configMapRef": map[string]interface{}{"name": fmt.Sprintf("cm-%02d", i)}},
			map[string]interface{}{"secretRef": map[string]interface{}{"name": fmt.Sprintf("secret-%02d", i)}},
		)
	}
	info := podToInfo(&unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "p", "namespace": "n"},
		"spec":     map[string]interface{}{"containers": []interface{}{map[string]interface{}{"name": "c", "envFrom": envFrom}}},
	}})
	for _, field := range []string{"config_map_refs", "secret_refs"} {
		list, _ := info[field].([]string)
		if len(list) != 12 || !slices.IsSorted(list) {
			t.Errorf("%s = %v, want the 12 names sorted", field, list)
		}
	}
}
