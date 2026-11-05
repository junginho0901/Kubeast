package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"sync"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	fakedynamic "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func TestTopLevelFields(t *testing.T) {
	report := map[string]interface{}{
		"apiVersion": "wgpolicyk8s.io/v1alpha2",
		"kind":       "PolicyReport",
		"metadata":   map[string]interface{}{"name": "r"},
		"scope":      map[string]interface{}{"kind": "Pod", "name": "web"},
		"summary":    map[string]interface{}{"pass": int64(1), "fail": int64(1)},
		"results":    []interface{}{map[string]interface{}{"result": "fail"}},
	}
	want := map[string]interface{}{"scope": report["scope"], "summary": report["summary"], "results": report["results"]}
	if got := topLevelFields(report); !reflect.DeepEqual(got, want) {
		t.Fatalf("PolicyReport: %v", got)
	}
	if got := topLevelFields(map[string]interface{}{"apiVersion": "v1", "kind": "X", "metadata": nil, "spec": 1, "status": 2}); len(got) != 0 {
		t.Fatalf("spec and status only: %v", got)
	}
}

// crInstancesService serves the CRDs and instances given; refuse answers a list of a plural (in a namespace, "" for
// the list over every namespace or of a cluster-scoped kind) with an error instead.
func crInstancesService(t *testing.T, refuse func(plural, namespace string) error, objects ...*unstructured.Unstructured) *Service {
	t.Helper()
	listKinds := map[schema.GroupVersionResource]string{crdGVR: "CustomResourceDefinitionList"}
	tracked := make([]runtime.Object, 0, len(objects))
	for _, o := range objects {
		tracked = append(tracked, o)
		if o.GetKind() != "CustomResourceDefinition" {
			continue
		}
		group, _, _ := unstructured.NestedString(o.Object, "spec", "group")
		plural, _, _ := unstructured.NestedString(o.Object, "spec", "names", "plural")
		kind, _, _ := unstructured.NestedString(o.Object, "spec", "names", "kind")
		listKinds[schema.GroupVersionResource{Group: group, Version: "v1", Resource: plural}] = kind + "List"
	}
	dyn := fakedynamic.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds, tracked...)
	dyn.PrependReactor("list", "*", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetResource() == crdGVR || refuse == nil {
			return false, nil, nil
		}
		if err := refuse(a.GetResource().Resource, a.GetNamespace()); err != nil {
			return true, nil, err
		}
		return false, nil, nil
	})
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{dynamic: dyn})
	return s
}

func crCRD(group, plural, kind, scope string) *unstructured.Unstructured {
	return obj("apiextensions.k8s.io/v1", "CustomResourceDefinition", "", plural+"."+group, map[string]interface{}{
		"group": group, "scope": scope,
		"names":    map[string]interface{}{"plural": plural, "kind": kind},
		"versions": []interface{}{map[string]interface{}{"name": "v1", "served": true, "storage": true}},
	}, nil)
}

func forbiddenList(plural string) error {
	return apierrors.NewForbidden(schema.GroupResource{Group: "example.com", Resource: plural}, "", errors.New("RBAC: not allowed"))
}

func crNames(items []map[string]interface{}) []string {
	out := []string{}
	for _, it := range items {
		out = append(out, it["kind"].(string)+"/"+it["namespace"].(string)+"/"+it["name"].(string))
	}
	slices.Sort(out)
	return out
}

// The Read role's case on the screen: the kinds it may list are listed as before, a refused kind is named (with its
// group where another CRD has that Kind), another error is named with its status, a CRD gone between the two lists
// is not named.
func TestGetAllCustomResourceInstances_NamesTheKindsItMayNotList(t *testing.T) {
	widget := obj("a.example.com/v1", "Widget", "web", "w1", map[string]interface{}{"size": "s"}, nil)
	widget.SetLabels(map[string]string{"app": "web"})
	s := crInstancesService(t, func(plural, ns string) error {
		switch plural {
		case "gadgets", "widgets-e":
			return forbiddenList(plural)
		case "things":
			return apierrors.NewInternalError(errors.New("conversion webhook for things.c.example.com failed"))
		case "gones":
			return apierrors.NewNotFound(schema.GroupResource{Group: "d.example.com", Resource: plural}, "")
		case "slows":
			return errors.New("context deadline exceeded")
		}
		return nil
	},
		crCRD("a.example.com", "widgets", "Widget", "Namespaced"),
		crCRD("e.example.com", "widgets-e", "Widget", "Namespaced"),
		crCRD("b.example.com", "gadgets", "Gadget", "Namespaced"),
		crCRD("c.example.com", "things", "Thing", "Cluster"),
		crCRD("d.example.com", "gones", "Gone", "Namespaced"),
		crCRD("f.example.com", "slows", "Slow", "Namespaced"),
		widget,
		obj("b.example.com/v1", "Gadget", "web", "g1", nil, nil),
	)

	got, err := s.GetAllCustomResourceInstances(context.Background())
	if err != nil {
		t.Fatalf("one CRD's failure fails the screen: %v", err)
	}
	wantItem := map[string]interface{}{
		"name": "w1", "namespace": "web", "kind": "Widget", "group": "a.example.com", "version": "v1", "scope": "Namespaced",
		"crd_name": "widgets.a.example.com", "created_at": "", "labels": map[string]string{"app": "web"},
	}
	if len(got.Items) != 1 || !reflect.DeepEqual(got.Items[0], wantItem) {
		t.Errorf("the readable instance as before: %#v", got.Items)
	}
	if want := []string{"Gadget", "Widget (e.example.com)"}; !reflect.DeepEqual(got.ForbiddenKinds, want) {
		t.Errorf("forbidden kinds = %q, want %q", got.ForbiddenKinds, want)
	}
	if len(got.FailedKinds) != 2 {
		t.Fatalf("failed kinds = %#v, want Slow and Thing", got.FailedKinds)
	}
	if f := got.FailedKinds[0]; f.Kind != "Slow" || f.Code != 0 || f.Error != "context deadline exceeded" {
		t.Errorf("an error without an answer: %#v", f)
	}
	if f := got.FailedKinds[1]; f.Kind != "Thing" || f.Code != 500 || f.Error == "" {
		t.Errorf("a server error with its status: %#v", f)
	}
}

// Everything readable: the answer is the instances alone, nothing named.
func TestGetAllCustomResourceInstances_AllReadableNamesNothing(t *testing.T) {
	s := crInstancesService(t, nil,
		crCRD("a.example.com", "widgets", "Widget", "Namespaced"),
		obj("a.example.com/v1", "Widget", "web", "w1", nil, nil),
		obj("a.example.com/v1", "Widget", "api", "w2", nil, nil),
	)
	got, err := s.GetAllCustomResourceInstances(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if names, want := crNames(got.Items), []string{"Widget/api/w2", "Widget/web/w1"}; !reflect.DeepEqual(names, want) {
		t.Errorf("instances = %v, want %v", names, want)
	}
	raw, _ := json.Marshal(got)
	var keys map[string]json.RawMessage
	_ = json.Unmarshal(raw, &keys)
	if _, ok := keys["items"]; !ok || len(keys) != 1 {
		t.Errorf("answer = %s, want items only", raw)
	}
	empty, _ := json.Marshal(&CustomResourceInstances{Items: []map[string]interface{}{}})
	if string(empty) != `{"items":[]}` {
		t.Errorf("no instances: %s", empty)
	}
}

// A grant limited to namespaces: a namespaced kind is listed in each of them, one refused in some is named with
// those, one refused in all by its Kind; a cluster-scoped kind is listed once.
func TestGetAllCustomResourceInstances_ScopedGrantNamesRefusedNamespaces(t *testing.T) {
	var mu sync.Mutex
	var asked []string
	s := crInstancesService(t, func(plural, ns string) error {
		mu.Lock()
		asked = append(asked, plural+"@"+ns)
		mu.Unlock()
		if plural == "gadgets" || plural == "widgets" && ns == "b" {
			return forbiddenList(plural)
		}
		return nil
	},
		crCRD("a.example.com", "widgets", "Widget", "Namespaced"),
		crCRD("b.example.com", "gadgets", "Gadget", "Namespaced"),
		crCRD("c.example.com", "things", "Thing", "Cluster"),
		obj("a.example.com/v1", "Widget", "a", "w-a", nil, nil),
		obj("a.example.com/v1", "Widget", "b", "w-b", nil, nil),
		obj("a.example.com/v1", "Widget", "other", "w-other", nil, nil),
		obj("c.example.com/v1", "Thing", "", "t1", nil, nil),
	)
	ctx := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"a", "b"}}})
	got, err := s.GetAllCustomResourceInstances(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if names, want := crNames(got.Items), []string{"Thing//t1", "Widget/a/w-a"}; !reflect.DeepEqual(names, want) {
		t.Errorf("instances = %v, want %v", names, want)
	}
	if want := []string{"Gadget", "Widget (b)"}; !reflect.DeepEqual(got.ForbiddenKinds, want) {
		t.Errorf("forbidden kinds = %q, want %q", got.ForbiddenKinds, want)
	}
	if len(got.FailedKinds) != 0 {
		t.Errorf("failed kinds = %#v", got.FailedKinds)
	}
	slices.Sort(asked)
	if want := []string{"gadgets@a", "gadgets@b", "things@", "widgets@a", "widgets@b"}; !reflect.DeepEqual(asked, want) {
		t.Errorf("lists asked = %v, want %v", asked, want)
	}
}
