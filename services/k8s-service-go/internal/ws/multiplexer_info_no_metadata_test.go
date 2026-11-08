package ws

import (
	"fmt"
	"sort"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// rowOf reads a row and turns a panic into its message: nothing above the watch loop recovers, so a panic here takes
// the whole service down.
func rowOf(resource string, object map[string]interface{}) (row map[string]interface{}, panicked string) {
	defer func() {
		if r := recover(); r != nil {
			panicked = fmt.Sprint(r)
		}
	}()
	return objectToInfo(resource, &unstructured.Unstructured{Object: object}), ""
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
