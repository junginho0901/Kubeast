package grafana

import (
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
// A dashboard changed since its v2 import is refused (ErrV2Changed) until its
// changes are written into the v2 file it came from.
func ExportV2(d *model.Dashboard) ([]byte, *ExportReport, error) {
	if d == nil {
		return nil, nil, errors.New("no dashboard")
	}
	if d.Source == nil || d.Source.Kind != model.SourceGrafanaV2 || len(d.Source.Raw) == 0 {
		return convertedV2(d)
	}
	again, _, err := Import(d.Source.Raw)
	if err != nil {
		return nil, nil, fmt.Errorf("the source v2 file no longer imports: %w", err)
	}
	if !sameModel(d, again) {
		return nil, nil, ErrV2Changed
	}
	var root obj
	if err := json.Unmarshal(d.Source.Raw, &root); err != nil {
		return nil, nil, ErrNotJSON
	}
	rep := &ExportReport{}
	var meta obj
	_ = json.Unmarshal(root["metadata"], &meta)
	for _, k := range sortedKeys(meta) {
		if k != "name" {
			rep.Adjusted = append(rep.Adjusted, Finding{Path: "metadata." + k, Reason: "the Grafana instance's record of the dashboard, left out"})
		}
	}
	if _, ok := root["status"]; ok {
		rep.Adjusted = append(rep.Adjusted, Finding{Path: "status", Reason: "the Grafana instance's record of the dashboard, left out"})
	}
	name := strOf(meta["name"])
	if name == "" {
		name = d.Metadata.Name
	}
	out := obj{
		"apiVersion": root["apiVersion"],
		"kind":       mustJSON("Dashboard"),
		"metadata":   mustJSON(map[string]string{"name": name}),
		"spec":       root["spec"],
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return b, rep, nil
}

// ErrV2Changed: the dashboard came from a v2 file and has changed since.
var ErrV2Changed = errors.New("this dashboard has changed since it was imported from its v2 file, and writing the change into that file is not built yet: export it as classic")

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
	for _, a := range d.Spec.Annotations {
		add(a.Ext["datasource"], a.Store)
	}
	return out
}

// convertedV2 is ExportV2 for a classic or Kubeast-made dashboard.
func convertedV2(d *model.Dashboard) ([]byte, *ExportReport, error) {
	classic, rep, err := Export(d)
	if err != nil {
		return nil, nil, err
	}
	spec, err := ConvertV2(classic, exportDataSources(d))
	if err != nil {
		return nil, nil, err
	}
	var root struct {
		UID string `json:"uid"`
	}
	_ = json.Unmarshal(classic, &root)
	name := root.UID
	if name == "" {
		name = d.Metadata.Name
	}
	if len(rep.Inputs) > 0 {
		var s any
		if err := json.Unmarshal(spec, &s); err != nil {
			return nil, nil, err
		}
		inputs := map[string]bool{}
		for _, in := range rep.Inputs {
			inputs["${"+in+"}"] = true
		}
		if n := dropInputRefs(s, inputs); n > 0 {
			rep.Adjusted = append(rep.Adjusted, Finding{Path: "spec", Reason: fmt.Sprintf(
				"%d references to an input (%s) written without a data source: Grafana uses its default one of the query's type", n, strings.Join(rep.Inputs, ", "))})
		}
		rep.Inputs = nil
		if spec, err = json.Marshal(s); err != nil {
			return nil, nil, err
		}
	}
	out := obj{
		"apiVersion": mustJSON(resourceGroup + "v2"),
		"kind":       mustJSON("Dashboard"),
		"metadata":   mustJSON(map[string]string{"name": name}),
		"spec":       spec,
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return b, rep, nil
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
