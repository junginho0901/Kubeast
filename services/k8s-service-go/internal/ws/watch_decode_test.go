package ws

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
)

// The server's provider gives the REST config, so its watches go through the shape decoder.
var _ RESTConfigProvider = (*k8s.Service)(nil)

// wholeDecoder is the decoder client-go's dynamic client reads a watch event's object with.
func wholeDecoder(t *testing.T) k8sruntime.Serializer {
	t.Helper()
	for _, info := range dynamic.ConfigFor(&rest.Config{}).NegotiatedSerializer.SupportedMediaTypes() {
		if info.MediaType == k8sruntime.ContentTypeJSON {
			return info.Serializer
		}
	}
	t.Fatal("no JSON serializer")
	return nil
}

func decodeWith(t *testing.T, d k8sruntime.Decoder, data []byte) *unstructured.Unstructured {
	t.Helper()
	obj, err := k8sruntime.Decode(d, data)
	if err != nil {
		t.Fatal(err)
	}
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		t.Fatalf("decoded %T", obj)
	}
	return u
}

// A row made from the part of an event's object the shape decoder reads is the row of the whole object, over random
// pods, nodes and deployments with field managers, annotations and environment values the rows do not read.
func TestRowsOfTheDecodedPartAreTheRowsOfTheWholeObject(t *testing.T) {
	r := rand.New(rand.NewSource(3))
	whole := wholeDecoder(t)
	shaped := rowSerializer{Serializer: whole, shapeOf: rowShapes}
	managed := []metav1.ManagedFieldsEntry{{Manager: "kubectl", Operation: metav1.ManagedFieldsOperationUpdate, FieldsType: "FieldsV1", FieldsV1: &metav1.FieldsV1{Raw: []byte(`{"f:metadata":{"f:labels":{}}}`)}}}
	cases := []struct {
		resource, apiVersion, kind string
		object                     func() k8sruntime.Object
	}{
		{"pods", "v1", "Pod", func() k8sruntime.Object {
			p := &corev1.Pod{}
			randomFill(r, reflect.ValueOf(p).Elem(), 10)
			for i := range p.Spec.Containers {
				p.Spec.Containers[i].Env = append(p.Spec.Containers[i].Env, corev1.EnvVar{Name: "TOKEN", Value: "fake-value"})
			}
			return p
		}},
		{"nodes", "v1", "Node", func() k8sruntime.Object {
			n := &corev1.Node{}
			randomFill(r, reflect.ValueOf(n).Elem(), 8)
			if r.Intn(2) == 0 {
				n.Labels = map[string]string{"node-role.kubernetes.io/control-plane": "", "node-role.kubernetes.io/" + []string{"", "agent"}[r.Intn(2)]: "", "type": "kwok"}
			}
			n.Status.Images = []corev1.ContainerImage{{Names: []string{"registry.example/fake@sha256:00"}, SizeBytes: 1 << 20}}
			return n
		}},
		{"deployments", "apps/v1", "Deployment", func() k8sruntime.Object {
			d := &appsv1.Deployment{}
			randomFill(r, reflect.ValueOf(d).Elem(), 10)
			return d
		}},
	}
	for _, c := range cases {
		keys := map[string]bool{}
		for i := range 400 {
			obj := c.object()
			meta := obj.(metav1.Object)
			meta.SetManagedFields(managed)
			meta.SetAnnotations(map[string]string{"kubectl.kubernetes.io/last-applied-configuration": `{"fake":"value"}`})
			meta.SetResourceVersion(fmt.Sprint(1000 + i))
			obj.GetObjectKind().SetGroupVersionKind(schema.FromAPIVersionAndKind(c.apiVersion, c.kind))
			data, err := json.Marshal(obj)
			if err != nil {
				t.Fatal(err)
			}
			full := decodeWith(t, whole, data)
			part := decodeWith(t, shaped, data)
			if part.GetResourceVersion() != full.GetResourceVersion() || part.GetKind() != c.kind {
				t.Fatalf("%s %d: resourceVersion %q kind %q, want %q %q", c.resource, i, part.GetResourceVersion(), part.GetKind(), full.GetResourceVersion(), c.kind)
			}
			if part.GetManagedFields() != nil || part.GetAnnotations() != nil || strings.Contains(rowText(t, part.Object), "fake-value") {
				t.Fatalf("%s %d: the decoded part holds what no row reads: %s", c.resource, i, rowText(t, part.Object))
			}
			want := objectToInfo(c.resource, full)
			got := objectToInfo(c.resource, part)
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
		if len(keys) < 6 {
			t.Errorf("%s: the random objects filled only %v", c.resource, keys)
		}
	}
}

// A kind no row has a shape for, a Status and a watch of changes: the first two decode whole, the third keeps the
// resourceVersion only.
func TestKindsWithoutAShapeDecodeWhole(t *testing.T) {
	whole := wholeDecoder(t)
	rows := rowSerializer{Serializer: whole, shapeOf: rowShapes}
	cm := []byte(`{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"c","resourceVersion":"5","annotations":{"a":"b"}},"data":{"k":"v"}}`)
	if got, want := decodeWith(t, rows, cm).Object, decodeWith(t, whole, cm).Object; !reflect.DeepEqual(got, want) {
		t.Errorf("a ConfigMap decoded %v, want %v", got, want)
	}
	status := []byte(`{"apiVersion":"v1","kind":"Status","status":"Failure","message":"too old resource version: 10","reason":"Expired","code":410}`)
	for _, d := range []k8sruntime.Decoder{rows, rowSerializer{Serializer: whole, shapeOf: changesShape}} {
		obj, err := k8sruntime.Decode(d, status)
		if err != nil {
			t.Fatal(err)
		}
		if s, ok := obj.(*metav1.Status); !ok || s.Code != 410 {
			t.Errorf("a Status decoded %T %v", obj, obj)
		}
	}
	pod := []byte(`{"kind":"Pod","apiVersion":"v1","metadata":{"name":"p","resourceVersion":"9","labels":{"a":"b"}},"spec":{"containers":[{"name":"c"}]}}`)
	got := decodeWith(t, rowSerializer{Serializer: whole, shapeOf: changesShape}, pod).Object
	want := map[string]interface{}{"kind": "Pod", "apiVersion": "v1", "metadata": map[string]interface{}{"resourceVersion": "9"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("a watch of changes decoded %v, want %v", got, want)
	}
}

// The shape decoder reads JSON as client-go's decoder does — escapes, numbers, nulls, lists, white space — and keeps
// what a shape names, over random documents and shapes; held to the whole decode of the same bytes cut by the shape.
func TestTheShapeDecoderReadsWhatTheWholeDecoderReads(t *testing.T) {
	r := rand.New(rand.NewSource(4))
	keys := []string{"a", "b", "kind", "x\"y", "é", "<&>", "back\\slash", "tab\tkey", ""}
	var value func(depth int) interface{}
	value = func(depth int) interface{} {
		switch n := r.Intn(9); {
		case n < 2 && depth > 0:
			m := map[string]interface{}{}
			for range r.Intn(4) {
				m[keys[r.Intn(len(keys))]] = value(depth - 1)
			}
			return m
		case n < 4 && depth > 0:
			list := []interface{}{}
			for range r.Intn(3) {
				list = append(list, value(depth-1))
			}
			return list
		case n == 4:
			return []interface{}{int64(-3), 1.5, int64(12345678901234), 1e21, 0.000001}[r.Intn(5)]
		case n == 5:
			return []interface{}{true, false, nil}[r.Intn(3)]
		default:
			return []string{"", "plain", "quote\"d", "line\nbreak", "é and ü", "\u2028", "back\\slash", "]}{["}[r.Intn(8)]
		}
	}
	var randomShape func(depth int) *shape
	randomShape = func(depth int) *shape {
		if depth == 0 || r.Intn(3) == 0 {
			return nil
		}
		s := &shape{fields: map[string]*shape{}, others: r.Intn(3) == 0}
		for range r.Intn(4) {
			if s.others && r.Intn(3) == 0 {
				s.fields[keys[r.Intn(len(keys))]] = skip
				continue
			}
			s.fields[keys[r.Intn(len(keys))]] = randomShape(depth - 1)
		}
		return s
	}
	for i := range 3000 {
		doc := map[string]interface{}{}
		for range r.Intn(5) {
			doc[keys[r.Intn(len(keys))]] = value(4)
		}
		doc["kind"], doc["apiVersion"] = "Thing", "test.kubeast.io/v1"
		data, err := json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		if i%2 == 1 {
			var indented bytes.Buffer
			if err := json.Indent(&indented, data, " ", "\t"); err != nil {
				t.Fatal(err)
			}
			data = []byte(" \n" + indented.String() + "\r\n")
		}
		sh := randomShape(4)
		if sh == nil {
			sh = &shape{others: true}
		}
		fullObj := decodeWith(t, wholeDecoder(t), data).Object
		got, err := decodeShape(data, sh)
		if err != nil {
			t.Fatalf("document %d: %v\n%s", i, err, data)
		}
		if want := cutByShape(fullObj, sh); !reflect.DeepEqual(got, want) {
			t.Fatalf("document %d:\n%s\n got %#v\nwant %#v", i, data, got, want)
		}
		if apiVersion, kind, ok := topKind(data); !ok || kind != "Thing" || apiVersion != "test.kubeast.io/v1" {
			t.Fatalf("document %d: topKind %q %q %v", i, apiVersion, kind, ok)
		}
	}
}

// cutByShape is what a shape reads of a value decoded whole.
func cutByShape(v interface{}, sh *shape) interface{} {
	if sh == nil {
		return v
	}
	switch v := v.(type) {
	case map[string]interface{}:
		out := map[string]interface{}{}
		for key, value := range v {
			field, named := sh.fields[key]
			switch {
			case field == skip || !named && !sh.others:
				continue
			case !named:
				field = nil
			}
			out[key] = cutByShape(value, field)
		}
		return out
	case []interface{}:
		out := []interface{}{}
		for _, value := range v {
			out = append(out, cutByShape(value, sh))
		}
		return out
	}
	return v
}

// A value the fast path does not read the way the whole decoder does — escapes, bytes that are not UTF-8, numbers past an
// int64 or a float64 — is left to that decoder, and the object reads the same.
func TestScalarsReadAsTheWholeDecoderReadsThem(t *testing.T) {
	whole := wholeDecoder(t)
	for _, v := range []string{`"plain"`, `""`, `"esc\"aped"`, `"\u00e9"`, "\"\xff\xfe\"", `"é"`, `0`, `-0`, `-12`, `9223372036854775807`,
		`9223372036854775808`, `-9223372036854775809`, `1.5`, `-0.0`, `1e3`, `1E-2`, `2.5e+10`, `true`, `false`, `null`} {
		data := []byte(`{"apiVersion":"v1","kind":"Thing","v":` + v + `}`)
		want := decodeWith(t, whole, data).Object
		got, err := decodeShape(data, &shape{others: true})
		if err != nil {
			t.Fatalf("%s: %v", v, err)
		}
		if !reflect.DeepEqual(got, want) || fmt.Sprintf("%T", got["v"]) != fmt.Sprintf("%T", want["v"]) {
			t.Errorf("%s: got %#v, want %#v", v, got["v"], want["v"])
		}
	}
	for _, v := range []string{`01`, `+1`, `0x10`, `1_000`, `.5`, `5.`, `1e`, `Inf`, `NaN`} {
		if _, ok := scalar([]byte(v)); ok {
			t.Errorf("%s read as a number", v)
		}
	}
}

// What is not JSON the decoder follows goes to client-go's decoder, which says what is wrong.
func TestTheShapeDecoderLeavesWhatItDoesNotFollow(t *testing.T) {
	for _, data := range []string{``, `[]`, `"x"`, `{"kind":"Pod"`, `{"kind":"Pod",}`, `{"kind":"Pod"} x`, `{"kind" "Pod"}`, `{"kind":"Pod","a":[1,}`} {
		if _, err := decodeShape([]byte(data), podShape); err == nil {
			t.Errorf("%q decoded", data)
		}
	}
	whole := wholeDecoder(t)
	if _, err := k8sruntime.Decode(rowSerializer{Serializer: whole, shapeOf: rowShapes}, []byte(`{"kind":"Pod","apiVersion":"v1","metadata":`)); err == nil {
		t.Error("a cut object decoded")
	}
}
