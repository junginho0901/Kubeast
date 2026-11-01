package grafana

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// ExportV2 writes a dashboard as a Grafana schema v2 resource
// (dashboard.grafana.app/v2, or v2beta1 when it came as one). A dashboard
// imported from a v2 file and not changed since is written back as that
// file — tabs, auto grids, sub headers and conditional rendering included —
// without the Grafana instance's record of it: metadata keeps the name only
// (no uid, resource version, generation, timestamps, managed fields, labels
// or annotations such as who created it), and status is left out.
//
// Any other dashboard (classic, made in Kubeast, or changed since its v2
// import) needs Grafana's classic → v2 conversion, which is not built yet:
// ErrV2NeedsConversion, and the classic export (Export) is what to use —
// Grafana converts a classic dashboard when it imports one.
func ExportV2(d *model.Dashboard) ([]byte, *ExportReport, error) {
	if d == nil {
		return nil, nil, errors.New("no dashboard")
	}
	if d.Source == nil || d.Source.Kind != model.SourceGrafanaV2 || len(d.Source.Raw) == 0 {
		return nil, nil, ErrV2NeedsConversion
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

var (
	// ErrV2NeedsConversion: the dashboard did not come from a v2 file.
	ErrV2NeedsConversion = errors.New("this dashboard needs Grafana's classic to v2 conversion, which Kubeast does not do yet: export it as classic, which Grafana converts when it imports it")
	// ErrV2Changed: the dashboard came from a v2 file and has changed since.
	ErrV2Changed = errors.New("this dashboard has changed since it was imported from its v2 file, and writing the change into v2 needs Grafana's classic to v2 conversion, which Kubeast does not do yet: export it as classic")
)

// sameModel compares two dashboards without the record of where they came from.
func sameModel(a, b *model.Dashboard) bool {
	ac, bc := *a, *b
	ac.Source, bc.Source = nil, nil
	ab, err1 := json.Marshal(ac)
	bb, err2 := json.Marshal(bc)
	return err1 == nil && err2 == nil && string(ab) == string(bb)
}
