package k8s

import (
	"reflect"
	"testing"
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
