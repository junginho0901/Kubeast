package k8s

import (
	"fmt"
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
)

// Lists built from a Go map come in another order per computation: on screen and in the answers these keep one order.

func TestPodRefs_Sorted(t *testing.T) {
	var c corev1.Container
	for i := 12; i > 0; i-- {
		c.EnvFrom = append(c.EnvFrom,
			corev1.EnvFromSource{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: fmt.Sprintf("cm-%02d", i)}}},
			corev1.EnvFromSource{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: fmt.Sprintf("secret-%02d", i)}}},
		)
	}
	out := formatPodDetail(&corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{c}}})
	for _, field := range []string{"config_map_refs", "secret_refs"} {
		list, _ := out[field].([]string)
		if len(list) != 12 || !slices.IsSorted(list) {
			t.Errorf("%s = %v, want the 12 names sorted", field, list)
		}
	}
}

func TestSortedKeys(t *testing.T) {
	m := map[string]string{}
	for i := 0; i < 12; i++ {
		m[fmt.Sprintf("key-%02d", i)] = "v"
	}
	got := sortedKeys(m)
	if len(got) != 12 || !slices.IsSorted(got) {
		t.Errorf("sortedKeys = %v, want the 12 keys sorted", got)
	}
	// an object with none answers [], not null
	if empty := sortedKeys(map[string][]byte{}); empty == nil || len(empty) != 0 {
		t.Errorf("sortedKeys of nothing = %#v, want an empty list", empty)
	}
}

func TestResourceGraphNodes_Sorted(t *testing.T) {
	nodes := map[string]rgNode{}
	for i := 0; i < 12; i++ {
		id := fmt.Sprintf("Pod/ns/p-%02d", i)
		nodes[id] = rgNode{ID: id, Kind: "Pod", Name: id, Namespace: "ns"}
	}
	list, _ := buildResourceGraphResponse(nodes, nil)["nodes"].([]map[string]interface{})
	ids := make([]string, 0, len(list))
	for _, n := range list {
		ids = append(ids, n["id"].(string))
	}
	if len(ids) != 12 || !slices.IsSorted(ids) {
		t.Errorf("node ids = %v, want the 12 sorted", ids)
	}
}

func TestSortInstances_OneOrderWithinASecond(t *testing.T) {
	newer := map[string]interface{}{"created_at": "2026-11-06T02:00:00Z", "crd_name": "z.example.com", "namespace": "z", "name": "z"}
	var items []map[string]interface{}
	for i := 11; i >= 0; i-- {
		items = append(items, map[string]interface{}{"created_at": "2026-11-06T01:00:00Z", "crd_name": "a.example.com", "namespace": "n", "name": fmt.Sprintf("o-%02d", i)})
	}
	items = append(items, newer)
	sortInstances(items)
	if items[0]["name"] != "z" {
		t.Errorf("first = %v, want the newest object", items[0]["name"])
	}
	for i := 1; i < len(items); i++ {
		if want := fmt.Sprintf("o-%02d", i-1); items[i]["name"] != want {
			t.Errorf("items[%d] = %v, want %s", i, items[i]["name"], want)
		}
	}
}
