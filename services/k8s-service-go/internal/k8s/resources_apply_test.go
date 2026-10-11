package k8s

import (
	"reflect"
	"testing"
)

// YAMLKinds lists exactly the documents CreateResourcesFromYAML would create:
// empty documents are skipped, and decoding stops at the first broken one.
func TestYAMLKinds(t *testing.T) {
	kinds, err := YAMLKinds("apiVersion: v1\nkind: ConfigMap\n---\n---\nkind: Secret\n")
	if err != nil || !reflect.DeepEqual(kinds, []string{"ConfigMap", "Secret"}) {
		t.Errorf("two documents: %v %v", kinds, err)
	}
	kinds, err = YAMLKinds("kind: ConfigMap\n---\nkind: [unclosed\n---\nkind: Secret\n")
	if err == nil || !reflect.DeepEqual(kinds, []string{"ConfigMap"}) {
		t.Errorf("broken second document: %v %v, want [ConfigMap] and an error", kinds, err)
	}
	kinds, err = YAMLKinds("metadata:\n  name: x\n")
	if err != nil || !reflect.DeepEqual(kinds, []string{""}) {
		t.Errorf("document without kind: %v %v", kinds, err)
	}
}
