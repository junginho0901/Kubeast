package grafana

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// ExportV2 writes a dashboard as a Grafana schema v2 resource
// (dashboard.grafana.app/v2), as Grafana's own v2 export does: data source
// references as the dashboard has them.
//
// A dashboard imported from a v2 file and not changed since is written back
// as that file (v2beta1 when it came as one) — tabs, auto grids, sub headers
// and conditional rendering included — without the Grafana instance's record
// of it: metadata keeps the name only (no uid, resource version, generation,
// timestamps, managed fields, labels or annotations such as who created it),
// and status is left out.
//
// A classic dashboard or one made in Kubeast is its classic export (Export)
// converted as Grafana 13.3.0 converts it (ConvertV2), for a Grafana whose
// default data source is Prometheus and whose other data sources are those
// the dashboard names, of the type the import read them as (a reference that
// names no type is resolved by the Grafana). A Kubeast-made dashboard's
// ${DS_…} inputs have no
// place in v2: those queries go without a data source, which Grafana fills
// with its default one of the query's type.
//
// A dashboard changed since its v2 import is its v2 file with the changes
// written in (patchedV2).
func ExportV2(d *model.Dashboard) ([]byte, *ExportReport, error) {
	r, rep, err := v2Resource(d, false)
	if err != nil {
		return nil, nil, err
	}
	if n := dropInputRefs(r.spec, r.inputs); len(r.inputs) > 0 && n > 0 {
		rep.Adjusted = append(rep.Adjusted, Finding{Path: "spec", Reason: fmt.Sprintf(
			"%d references to an input (%s) written without a data source: Grafana uses its default one of the query's type", n, strings.Join(sortedSet(r.inputs), ", "))})
	}
	b, err := r.marshal()
	return b, rep, err
}

// v2Res is a v2 resource before it is written.
type v2Res struct {
	apiVersion, name string
	spec             any             // the v2 file's spec as it is (json.RawMessage), or decoded: with changes written in, or converted
	inputs           map[string]bool // ${…} references to the inputs of a Kubeast-made dashboard
	ds               DataSources     // the data sources the conversion assumed
}

func (r *v2Res) marshal() ([]byte, error) {
	return json.MarshalIndent(map[string]any{
		"apiVersion": r.apiVersion,
		"kind":       "Dashboard",
		"metadata":   map[string]string{"name": r.name},
		"spec":       r.spec,
	}, "", "  ")
}

// v2Resource is the v2 resource of d: its v2 file, or its classic export
// converted (with inlineLibrary, library panels written inline first).
func v2Resource(d *model.Dashboard, inlineLibrary bool) (*v2Res, *ExportReport, error) {
	if d == nil {
		return nil, nil, errors.New("no dashboard")
	}
	if d.Source == nil || d.Source.Kind != model.SourceGrafanaV2 || len(d.Source.Raw) == 0 {
		return convertedV2(d, inlineLibrary)
	}
	again, _, err := Import(d.Source.Raw)
	if err != nil {
		return nil, nil, fmt.Errorf("the source v2 file no longer imports: %w", err)
	}
	if !sameModel(d, again) {
		return patchedV2(d, again, d.Source.Raw)
	}
	var root struct {
		APIVersion string          `json:"apiVersion"`
		Metadata   map[string]any  `json:"metadata"`
		Spec       json.RawMessage `json:"spec"` // written back byte for byte
		Status     any             `json:"status"`
	}
	if err := json.Unmarshal(d.Source.Raw, &root); err != nil {
		return nil, nil, ErrNotJSON
	}
	rep := leftOut(root.Metadata, root.Status)
	name, _ := root.Metadata["name"].(string)
	if name == "" {
		name = d.Metadata.Name
	}
	return &v2Res{apiVersion: root.APIVersion, name: name, spec: root.Spec}, rep, nil
}

// leftOut reports what of a v2 file's resource is the Grafana instance's
// record of the dashboard, which an export leaves out.
func leftOut(metadata map[string]any, status any) *ExportReport {
	rep := &ExportReport{}
	for _, k := range sortedSet(metadata) {
		if k != "name" {
			rep.Adjusted = append(rep.Adjusted, Finding{Path: "metadata." + k, Reason: "the Grafana instance's record of the dashboard, left out"})
		}
	}
	if status != nil {
		rep.Adjusted = append(rep.Adjusted, Finding{Path: "status", Reason: "the Grafana instance's record of the dashboard, left out"})
	}
	return rep
}

// sortedSet lists a map's keys in order.
func sortedSet[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// exportDataSources stand for the Grafana ExportV2 writes for: Prometheus as
// its default data source, and each data source the dashboard names without
// a type (a bare name, or a uid alone) of the type the import read it as.
func exportDataSources(d *model.Dashboard) DataSources {
	out := DataSources{{Type: model.StorePrometheus, Default: true}}
	seen := map[DataSource]bool{}
	add := func(raw json.RawMessage, store string) {
		var src DataSource
		if s := strOf(raw); s != "" {
			src = DataSource{UID: s, Name: s}
		} else if o, ok := asObj(raw); ok && strOf(o["type"]) == "" {
			src.UID = strOf(o["uid"])
		}
		if src.UID == "" || src.UID == "default" || isVariable(src.UID) || builtInDS[src.UID] || store == "" || seen[src] {
			return
		}
		seen[src] = true
		src.Type = store
		out = append(out, src)
	}
	names := make([]string, 0, len(d.Spec.Panels))
	for n := range d.Spec.Panels {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		p := d.Spec.Panels[n]
		for _, q := range p.Queries {
			if raw, ok := q.Ext["datasource"]; ok {
				add(raw, q.Store)
			} else {
				add(p.Ext["datasource"], q.Store) // a query without its own takes the panel's
			}
		}
	}
	for _, v := range d.Spec.Variables {
		add(v.Ext["datasource"], v.Store)
	}
	return out // an annotation's reference needs its type and uid both (ConvertV2), so none is looked up
}

// convertedV2 is the v2 resource of a classic or Kubeast-made dashboard.
func convertedV2(d *model.Dashboard, inlineLibrary bool) (*v2Res, *ExportReport, error) {
	classic, rep, err := exportClassic(d, inlineLibrary)
	if err != nil {
		return nil, nil, err
	}
	ds := exportDataSources(d)
	spec, err := ConvertV2(classic, ds)
	if err != nil {
		return nil, nil, err
	}
	var root struct {
		UID string `json:"uid"`
	}
	_ = json.Unmarshal(classic, &root)
	r := &v2Res{apiVersion: resourceGroup + "v2", name: root.UID, ds: ds, inputs: map[string]bool{}}
	if r.name == "" {
		r.name = d.Metadata.Name
	}
	for _, in := range rep.Inputs {
		r.inputs["${"+in+"}"] = true
	}
	rep.Inputs = nil
	dec := json.NewDecoder(bytes.NewReader(spec))
	dec.UseNumber()
	if err := dec.Decode(&r.spec); err != nil {
		return nil, nil, err
	}
	return r, rep, nil
}

// dropInputRefs removes each data source reference ({name: ${input}}) to one
// of the inputs and counts them.
func dropInputRefs(v any, inputs map[string]bool) int {
	n := 0
	switch x := v.(type) {
	case map[string]any:
		if ds, ok := x["datasource"].(map[string]any); ok {
			if name, _ := ds["name"].(string); inputs[name] {
				delete(x, "datasource")
				n++
			}
		}
		for _, e := range x {
			n += dropInputRefs(e, inputs)
		}
	case []any:
		for _, e := range x {
			n += dropInputRefs(e, inputs)
		}
	}
	return n
}

// sameModel compares two dashboards without the record of where they came from.
func sameModel(a, b *model.Dashboard) bool {
	ac, bc := *a, *b
	ac.Source, bc.Source = nil, nil
	ab, err1 := json.Marshal(ac)
	bb, err2 := json.Marshal(bc)
	return err1 == nil && err2 == nil && string(ab) == string(bb)
}
