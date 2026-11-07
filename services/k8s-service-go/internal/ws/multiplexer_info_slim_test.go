package ws

import (
	"encoding/base64"
	"encoding/json"
	"math/rand"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"

	configmaprow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/configmap"
	deployrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/deployment"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/eventtime"
	jobrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/job"
	rsrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/replicaset"
	secretrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/secret"
	servicerow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/service"
)

// randomFill gives an object values of its fields' types, with the words the rows' statuses read.
func randomFill(r *rand.Rand, v reflect.Value, depth int) {
	switch v.Kind() {
	case reflect.Ptr:
		if r.Intn(2) == 0 && depth > 0 {
			v.Set(reflect.New(v.Type().Elem()))
			randomFill(r, v.Elem(), depth-1)
		}
	case reflect.Struct:
		at := time.Unix(1_700_000_000+r.Int63n(1_000_000), 0).UTC()
		switch v.Interface().(type) {
		case metav1.Time:
			if r.Intn(4) > 0 {
				v.Set(reflect.ValueOf(metav1.NewTime(at)))
			}
			return
		case metav1.MicroTime:
			if r.Intn(4) > 0 {
				v.Set(reflect.ValueOf(metav1.NewMicroTime(at)))
			}
			return
		case resource.Quantity:
			v.Set(reflect.ValueOf(resource.MustParse([]string{"100m", "1", "1Gi"}[r.Intn(3)])))
			return
		case intstr.IntOrString:
			v.Set(reflect.ValueOf(intstr.FromInt32(r.Int31n(100))))
			return
		}
		for i := range v.NumField() {
			if field := v.Type().Field(i); field.IsExported() && field.Name != "ManagedFields" {
				randomFill(r, v.Field(i), depth-1)
			}
		}
	case reflect.Slice:
		if depth <= 0 || v.Type().Elem().Kind() == reflect.Uint8 {
			return
		}
		n := r.Intn(3)
		v.Set(reflect.MakeSlice(v.Type(), n, n))
		for i := range n {
			randomFill(r, v.Index(i), depth-1)
		}
	case reflect.Map:
		if depth <= 0 {
			return
		}
		n := r.Intn(3)
		v.Set(reflect.MakeMap(v.Type()))
		for range n {
			key, value := reflect.New(v.Type().Key()).Elem(), reflect.New(v.Type().Elem()).Elem()
			randomFill(r, key, depth-1)
			randomFill(r, value, depth-1)
			v.SetMapIndex(key, value)
		}
	case reflect.String:
		v.SetString([]string{"", "a", "b", "True", "False", "Available", "Progressing", "Complete", "Failed", "Suspended", "ClusterIP", "NodePort", "LoadBalancer", "ExternalName", "Deployment", "Warning"}[r.Intn(16)])
	case reflect.Bool:
		v.SetBool(r.Intn(2) == 0)
	case reflect.Int32, reflect.Int64, reflect.Int:
		v.SetInt(r.Int63n(5))
	}
}

func rowText(t *testing.T, row map[string]interface{}) string {
	t.Helper()
	b, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// A row made from the part of an object it reads is the row of the whole object, over random objects of each kind.
func TestSlimmedRowsAreTheRowsOfTheWholeObject(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	cases := []struct {
		resource string
		object   func() any
		whole    func(any) map[string]interface{}
	}{
		{"replicasets", func() any { return &appsv1.ReplicaSet{} }, func(o any) map[string]interface{} { return rsrow.Info(o.(*appsv1.ReplicaSet)) }},
		{"deployments", func() any { return &appsv1.Deployment{} }, func(o any) map[string]interface{} { return deployrow.Info(o.(*appsv1.Deployment)) }},
		{"jobs", func() any { return &batchv1.Job{} }, func(o any) map[string]interface{} { return jobrow.Info(o.(*batchv1.Job)) }},
		{"services", func() any { return &corev1.Service{} }, func(o any) map[string]interface{} { return servicerow.Info(o.(*corev1.Service)) }},
		{"secrets", func() any { return &corev1.Secret{} }, func(o any) map[string]interface{} { return secretrow.Info(o.(*corev1.Secret)) }},
		{"configmaps", func() any { return &corev1.ConfigMap{} }, func(o any) map[string]interface{} { return configmaprow.Info(o.(*corev1.ConfigMap)) }},
	}
	for _, c := range cases {
		keys := map[string]bool{}
		for i := range 400 {
			typed := c.object()
			randomFill(r, reflect.ValueOf(typed).Elem(), 9)
			if s, ok := typed.(*corev1.Secret); ok {
				s.Data = map[string][]byte{"a": []byte("fake-a"), "b": nil}
			}
			if cm, ok := typed.(*corev1.ConfigMap); ok {
				cm.BinaryData = map[string][]byte{"c": []byte("fake-c")}
			}
			object, err := k8sruntime.DefaultUnstructuredConverter.ToUnstructured(typed)
			if err != nil {
				t.Fatalf("%s %d: %v", c.resource, i, err)
			}
			if object["metadata"] == nil {
				object["metadata"] = map[string]interface{}{}
			}
			converted := c.object()
			if err := k8sruntime.DefaultUnstructuredConverter.FromUnstructured(object, converted); err != nil {
				t.Fatalf("%s %d: %v", c.resource, i, err)
			}
			want := c.whole(converted)
			got := objectToInfo(c.resource, &unstructured.Unstructured{Object: object})
			if rowText(t, got) != rowText(t, want) {
				t.Fatalf("%s %d:\n got %s\nwant %s", c.resource, i, rowText(t, got), rowText(t, want))
			}
			for key, value := range want {
				if value != nil && !reflect.ValueOf(value).IsZero() {
					keys[key] = true
				}
			}
		}
		// so the rows compared are not empty
		if len(keys) < 4 {
			t.Errorf("%s: the random objects filled only %v", c.resource, keys)
		}
	}
}

// An event's times and count are what kubectl prints of the whole event, over random events.
func TestAnEventsSlimmedTimesAreThoseOfTheWholeEvent(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	series := 0
	for i := range 1000 {
		var ev corev1.Event
		randomFill(r, reflect.ValueOf(&ev).Elem(), 6)
		object, err := k8sruntime.DefaultUnstructuredConverter.ToUnstructured(&ev)
		if err != nil {
			t.Fatal(err)
		}
		if ev.Series != nil {
			series++
		}
		var whole corev1.Event
		if err := k8sruntime.DefaultUnstructuredConverter.FromUnstructured(object, &whole); err != nil {
			t.Fatal(err)
		}
		first, _, count := eventtime.Seen(&whole)
		row := eventToInfo(&unstructured.Unstructured{Object: object})
		if row["count"] != count || row["first_timestamp"] != eventtime.ISO(first) || row["last_timestamp"] != eventtime.ISO(eventtime.Last(&whole)) {
			t.Fatalf("event %d: %v, want %d %s %s", i, row, count, eventtime.ISO(first), eventtime.ISO(eventtime.Last(&whole)))
		}
	}
	if series == 0 {
		t.Error("no random event had a series")
	}
}

// A live row of a Helm release's Secret, a value of most of a megabyte in a frame every few minutes per release, costs
// what a small Secret's does: no row holds the value, so it is not decoded.
func TestASecretsRowDoesNotCostItsValue(t *testing.T) {
	value := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("fake-value-", 70_000)))
	big := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "sh.helm.release.v1.app.v1", "namespace": "demo"},
		"type":     "helm.sh/release.v1",
		"data":     map[string]interface{}{"release": value},
	}}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	const rows = 20
	for range rows {
		objectToInfo("secrets", big)
	}
	runtime.ReadMemStats(&after)
	perRow := (after.TotalAlloc - before.TotalAlloc) / rows
	t.Logf("a row of a Secret with a value of %d bytes allocates %d bytes", len(value), perRow)
	if perRow > 64<<10 {
		t.Errorf("a row allocates %d bytes", perRow)
	}
	row := objectToInfo("secrets", big)
	if row["data_count"] != 1 || rowText(t, row) == "" || strings.Contains(rowText(t, row), "fake-value") {
		t.Errorf("row = %v", row)
	}
}

// The original object stays as it came: other watches of one event may read it after a row is made.
func TestMakingARowLeavesTheObjectAsItCame(t *testing.T) {
	object := func() *unstructured.Unstructured {
		var obj unstructured.Unstructured
		if err := obj.UnmarshalJSON([]byte(`{"apiVersion":"v1","kind":"Secret","metadata":{"name":"s","namespace":"n","annotations":{"a":"b"},"managedFields":[{"manager":"m"}]},"data":{"k":"ZmFrZQ=="},
			"spec":{"template":{"metadata":{"labels":{"a":"b"}},"spec":{"containers":[{"name":"c","image":"i","env":[{"name":"E","value":"fake"}]}]}}}}`)); err != nil {
			t.Fatal(err)
		}
		return &obj
	}
	for _, resource := range []string{"secrets", "configmaps", "replicasets", "deployments", "jobs", "services", "events"} {
		obj := object()
		objectToInfo(resource, obj)
		if !reflect.DeepEqual(obj.Object, object().Object) {
			t.Errorf("%s: the object changed", resource)
		}
	}
}
