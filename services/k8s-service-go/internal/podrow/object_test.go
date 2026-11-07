package podrow

import (
	"encoding/json"
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
)

var (
	timeType     = reflect.TypeFor[metav1.Time]()
	quantityType = reflect.TypeFor[resource.Quantity]()
	intOrStrType = reflect.TypeFor[intstr.IntOrString]()
)

// A field the row of some pod would read is filled here whatever its name, so one Info starts to read fails below until
// FromObject reads it. Only what cannot go through JSON or does not bear on a row is left empty.
func fill(r *rand.Rand, v reflect.Value, depth int) {
	switch v.Kind() {
	case reflect.Ptr:
		if r.Intn(2) == 0 && depth > 0 {
			v.Set(reflect.New(v.Type().Elem()))
			fill(r, v.Elem(), depth-1)
		}
	case reflect.Struct:
		switch v.Type() {
		case timeType:
			if r.Intn(4) > 0 {
				v.Set(reflect.ValueOf(metav1.NewTime(time.Unix(1_700_000_000+r.Int63n(1_000_000), 0).UTC())))
			}
			return
		case quantityType:
			v.Set(reflect.ValueOf(resource.MustParse([]string{"100m", "1", "1024Mi", "1Gi", "2.5"}[r.Intn(5)])))
			return
		case intOrStrType:
			v.Set(reflect.ValueOf(intstr.FromInt32(r.Int31n(100))))
			return
		}
		for i := range v.NumField() {
			if field := v.Type().Field(i); field.IsExported() && field.Name != "ManagedFields" {
				fill(r, v.Field(i), depth-1)
			}
		}
	case reflect.Slice:
		if depth <= 0 || v.Type().Elem().Kind() == reflect.Uint8 {
			return
		}
		n := r.Intn(3)
		v.Set(reflect.MakeSlice(v.Type(), n, n))
		for i := range n {
			fill(r, v.Index(i), depth-1)
		}
	case reflect.Map:
		if depth <= 0 {
			return
		}
		n := r.Intn(3)
		v.Set(reflect.MakeMap(v.Type()))
		for range n {
			key, value := reflect.New(v.Type().Key()).Elem(), reflect.New(v.Type().Elem()).Elem()
			fill(r, key, depth-1)
			fill(r, value, depth-1)
			v.SetMapIndex(key, value)
		}
	case reflect.String:
		v.SetString([]string{"", "a", "b", "Running", "Pending", "True", "False", "Ready", "Initialized", "NodeLost", "Completed", "PodScheduled", "SchedulingGated", "Always", "Succeeded", "Failed"}[r.Intn(16)])
	case reflect.Bool:
		v.SetBool(r.Intn(2) == 0)
	case reflect.Int32, reflect.Int64, reflect.Int:
		v.SetInt(r.Int63n(5))
	}
}

func rowJSON(t *testing.T, p *corev1.Pod) string {
	t.Helper()
	raw, err := json.Marshal(Info(p))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// A live update reads a pod field by field; the list's row comes from the typed pod. Both make the one row.
func TestFromObjectReadsWhatInfoReads(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	seen := map[string]bool{}
	for i := range 1500 {
		var pod corev1.Pod
		fill(r, reflect.ValueOf(&pod).Elem(), 9)
		// the object's creation time and deletion time reach the row like any other field; a name keeps the row readable
		pod.Name, pod.Namespace = "p", "n"
		object, err := runtime.DefaultUnstructuredConverter.ToUnstructured(&pod)
		if err != nil {
			t.Fatalf("pod %d: %v", i, err)
		}
		var converted corev1.Pod
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object, &converted); err != nil {
			t.Fatalf("pod %d: %v", i, err)
		}
		want, got := rowJSON(t, &converted), rowJSON(t, FromObject(object))
		if got != want {
			t.Fatalf("pod %d:\n got %s\nwant %s", i, got, want)
		}
		var row map[string]interface{}
		if err := json.Unmarshal([]byte(want), &row); err != nil {
			t.Fatal(err)
		}
		for key := range row {
			seen[key] = true
		}
		// so the rows above are not empty: each keeps at least the status of a phase or container named
		if status, _ := row["status"].(string); status != "" {
			seen["status:"+status] = true
		}
	}
	for _, key := range []string{
		"config_map_refs", "secret_refs", "owner_references", "deletion_timestamp", "service_account_name", "priority_class_name",
		"runtime_class_name", "resource_claims", "resource_claim_templates", "status:Terminating", "status:Unknown",
	} {
		if !seen[key] {
			t.Errorf("no random pod's row had %q: the comparison did not reach it", key)
		}
	}
}

func TestFromObjectOfUnexpectedTypesReadsTheRest(t *testing.T) {
	object := map[string]interface{}{
		"metadata": map[string]interface{}{"name": "odd", "namespace": "demo", "labels": "not a map", "creationTimestamp": "not a time", "ownerReferences": "not a list"},
		"spec": map[string]interface{}{
			"nodeName":   int64(7),
			"containers": []interface{}{"not an object", map[string]interface{}{"name": "app", "image": "example.test/app:1", "ports": "not a list", "resources": map[string]interface{}{"limits": map[string]interface{}{"memory": "not a quantity"}}}},
		},
		"status": "not an object",
	}
	row := Info(FromObject(object))
	if row["name"] != "odd" || row["namespace"] != "demo" || row["status"] != "Unknown" || row["ready"] != "0/1" {
		t.Errorf("row: %v", row)
	}
	containers := row["containers"].([]map[string]interface{})
	if len(containers) != 1 || containers[0]["name"] != "app" {
		t.Errorf("containers: %v", containers)
	}
	for _, missing := range []map[string]interface{}{nil, {}, {"metadata": "not an object"}} {
		if row := Info(FromObject(missing)); row["status"] != "Unknown" {
			t.Errorf("%v: %v", missing, row)
		}
	}
}

func TestFromObjectLeavesAnEnvironmentValueOut(t *testing.T) {
	const value = "fake-env-value-for-tests"
	object := map[string]interface{}{
		"metadata": map[string]interface{}{"name": "p", "namespace": "demo"},
		"spec": map[string]interface{}{"containers": []interface{}{map[string]interface{}{
			"name": "app",
			"env":  []interface{}{map[string]interface{}{"name": "MODE", "value": value}},
		}}},
	}
	pod := FromObject(object)
	if got := pod.Spec.Containers[0].Env[0].Value; got != "" {
		t.Errorf("the pod holds the value %q", got)
	}
	if raw := rowJSON(t, pod); strings.Contains(raw, value) {
		t.Errorf("the row holds the value: %s", raw)
	}
	if row := Info(pod); row["containers"].([]map[string]interface{})[0]["env_count"] != 1 {
		t.Errorf("the row lost the count: %v", row)
	}
}
