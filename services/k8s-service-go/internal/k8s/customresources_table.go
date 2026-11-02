package k8s

import (
	"context"
	"encoding/json"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// tableAccept asks the API server for its server-side printing, as kubectl get does (kubectl v1.37 get.go): a
// custom resource's columns are its CRD's additionalPrinterColumns, evaluated by the API server on the whole object.
const tableAccept = "application/json;as=Table;v=v1;g=meta.k8s.io"

// customResourceTable lists group/version/plural over every namespace as the API server prints it for kubectl, each
// row carrying its whole object.
func (s *Service) customResourceTable(ctx context.Context, group, version, plural string) (*metav1.Table, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, errNotLoaded
	}
	raw, err := cs.RESTClient().Get().AbsPath("/apis", group, version, plural).
		Param("includeObject", "Object").SetHeader("Accept", tableAccept).Do(ctx).Raw()
	if err != nil {
		return nil, err
	}
	var t metav1.Table
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("decode table: %w", err)
	}
	return &t, nil
}

// customResourceRows turns the table into the instance rows: the object's own fields as before, and printer_cells —
// every column kubectl prints for it (priority above 0 too, kubectl's wide view) with the API server's value, but the
// name and the creation-time Age, which the page shows on its own.
func customResourceRows(t *metav1.Table, group, version string) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(t.Rows))
	for _, row := range t.Rows {
		obj := &unstructured.Unstructured{}
		if err := json.Unmarshal(row.Object.Raw, &obj.Object); err != nil {
			continue
		}
		createdAt := ""
		if ts := obj.GetCreationTimestamp(); !ts.IsZero() {
			createdAt = ts.UTC().Format("2006-01-02T15:04:05Z")
		}
		entry := map[string]interface{}{
			"name":        obj.GetName(),
			"namespace":   obj.GetNamespace(),
			"kind":        obj.GetKind(),
			"group":       group,
			"version":     version,
			"created_at":  createdAt,
			"labels":      obj.GetLabels(),
			"annotations": obj.GetAnnotations(),
		}
		if spec, ok := obj.Object["spec"]; ok {
			entry["spec"] = spec
		}
		if status, ok := obj.Object["status"]; ok {
			entry["status"] = status
		}
		cells := make([]map[string]interface{}, 0, len(t.ColumnDefinitions))
		for i, c := range t.ColumnDefinitions {
			if c.Format == "name" || (c.Name == "Age" && c.Type == "date") {
				continue
			}
			var v interface{}
			if i < len(row.Cells) {
				v = row.Cells[i]
			}
			cells = append(cells, map[string]interface{}{"name": c.Name, "type": c.Type, "priority": c.Priority, "description": c.Description, "value": v})
		}
		entry["printer_cells"] = cells
		rows = append(rows, entry)
	}
	return rows
}
