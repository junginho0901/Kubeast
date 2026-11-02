package k8s

import (
	"reflect"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// A custom resource's row carries the cells the API server printed for kubectl, every column but the name and the
// creation-time Age, with the value as the server gave it (a number, a bool, a timestamp, a JSON list as a string).
func TestCustomResourceRows(t *testing.T) {
	table := &metav1.Table{
		ColumnDefinitions: []metav1.TableColumnDefinition{
			{Name: "Name", Type: "string", Format: "name"},
			{Name: "Size", Type: "string"},
			{Name: "Replicas", Type: "integer"},
			{Name: "Enabled", Type: "boolean"},
			{Name: "Generation", Type: "integer"},
			{Name: "Seen", Type: "date"},
			{Name: "Owner", Type: "string", Priority: 1},
			{Name: "Age", Type: "date"},
		},
		Rows: []metav1.TableRow{{
			Cells: []interface{}{"w1", "large", int64(3), false, int64(2), "2026-11-02T01:00:00Z", "team-a", "2026-11-01T00:00:00Z"},
			Object: runtime.RawExtension{Raw: []byte(`{"apiVersion":"numbers.kubeast.io/v1","kind":"Widget",` +
				`"metadata":{"name":"w1","namespace":"shop","generation":2,"creationTimestamp":"2026-11-01T00:00:00Z","labels":{"a":"b"}},` +
				`"spec":{"size":"large"},"status":{"lastSeen":"2026-11-02T01:00:00Z"}}`)},
		}},
	}
	rows := customResourceRows(table, "numbers.kubeast.io", "v1")
	if len(rows) != 1 {
		t.Fatalf("rows: %v", rows)
	}
	r := rows[0]
	for k, want := range map[string]interface{}{"name": "w1", "namespace": "shop", "kind": "Widget", "group": "numbers.kubeast.io", "version": "v1", "created_at": "2026-11-01T00:00:00Z"} {
		if r[k] != want {
			t.Errorf("%s = %v, want %v", k, r[k], want)
		}
	}
	if r["spec"] == nil || r["status"] == nil {
		t.Errorf("spec and status kept: %v", r)
	}
	var names []string
	for _, c := range r["printer_cells"].([]map[string]interface{}) {
		names = append(names, c["name"].(string))
	}
	if want := []string{"Size", "Replicas", "Enabled", "Generation", "Seen", "Owner"}; !reflect.DeepEqual(names, want) {
		t.Errorf("columns %v, want %v (no Name, no Age)", names, want)
	}
	cells := r["printer_cells"].([]map[string]interface{})
	if cells[2]["value"] != false || cells[3]["value"] != int64(2) || cells[5]["priority"] != int32(1) {
		t.Errorf("values as the server gave them: %v", cells)
	}
}
