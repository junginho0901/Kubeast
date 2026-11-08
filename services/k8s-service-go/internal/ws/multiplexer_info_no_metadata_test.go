package ws

import (
	"fmt"
	"sort"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// rowOf reads a row and turns a panic into its message, naming the kinds it happens on.
func rowOf(resource string, object map[string]interface{}) (row map[string]interface{}, panicked string) {
	defer func() {
		if r := recover(); r != nil {
			panicked = fmt.Sprint(r)
		}
	}()
	return objectToInfo(resource, &unstructured.Unstructured{Object: object}), ""
}

// eachFieldGiven calls visit with every field of node holding each of values in turn, putting the field back after.
func eachFieldGiven(node interface{}, path string, values []interface{}, visit func(path string)) {
	switch n := node.(type) {
	case map[string]interface{}:
		for key, was := range n {
			at := path + "." + key
			for _, value := range values {
				n[key] = value
				visit(at)
			}
			n[key] = was
			eachFieldGiven(was, at, values, visit)
		}
	case []interface{}:
		for i, was := range n {
			at := fmt.Sprintf("%s[%d]", path, i)
			for _, value := range values {
				n[i] = value
				visit(at)
			}
			n[i] = was
			eachFieldGiven(was, at, values, visit)
		}
	}
}

// Every field of every list's sample object, given a value of another type: what the API server's schema does not hold
// (a custom resource, an aggregated API) gives a row and no panic.
func TestAnObjectOfAnyShapeGivesARowAndNoPanic(t *testing.T) {
	values := []interface{}{nil, "x", int64(1), 1.5, true,
		[]interface{}{}, []interface{}{"x"}, []interface{}{nil},
		map[string]interface{}{}, map[string]interface{}{"name": int64(1)}}
	found := map[string]string{}
	runs := 0
	for _, source := range watchRowSources() {
		for _, text := range []string{source.before, source.after} {
			var obj unstructured.Unstructured
			if err := obj.UnmarshalJSON([]byte(text)); err != nil {
				t.Fatal(err)
			}
			eachFieldGiven(obj.Object, "", values, func(path string) {
				runs++
				if _, panicked := rowOf(source.resource, obj.Object); panicked != "" {
					found[source.resource+" "+panicked] = path
				}
			})
		}
	}
	if runs < 1000 {
		t.Fatalf("only %d objects were tried", runs)
	}
	for what, path := range found {
		t.Errorf("%s, with %s of another type", what, path)
	}
}

// An aggregated API server decides what it sends: a frame without usable metadata gives a row with no name, which the
// screens skip, and never a panic.
func TestAFrameWithoutMetadataGivesARowWithNoName(t *testing.T) {
	resources := []string{"a-custom-resource"}
	for resource := range watchKinds {
		resources = append(resources, resource)
	}
	sort.Strings(resources)
	for name, object := range map[string]map[string]interface{}{
		"none":        {"kind": "Thing"},
		"not a map":   {"kind": "Thing", "metadata": "not a map"},
		"null":        {"kind": "Thing", "metadata": nil},
		"empty map":   {"kind": "Thing", "metadata": map[string]interface{}{}},
		"only a spec": {"spec": map[string]interface{}{"replicas": int64(1)}},
	} {
		var panics, named []string
		for _, resource := range resources {
			row, panicked := rowOf(resource, object)
			if panicked != "" {
				panics = append(panics, resource)
				continue
			}
			if got, _ := row["name"].(string); got != "" {
				named = append(named, resource+"="+got)
			}
		}
		if len(panics) > 0 {
			t.Errorf("metadata %s: panics on %s", name, strings.Join(panics, " "))
		}
		if len(named) > 0 {
			t.Errorf("metadata %s: rows with a name from nowhere: %s", name, strings.Join(named, " "))
		}
	}
}
