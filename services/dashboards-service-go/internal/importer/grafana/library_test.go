package grafana

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// testdata/library-panels.json is written as Grafana 13.3.0's export for
// sharing externally writes one (makeExportableV1): references at the top
// trimmed to gridPos, id and libraryPanel, the saved references
// (library-panel-ref, with a title) in rows, the definitions in __elements.

func TestImport_LibraryPanelsFromTheirDefinitions(t *testing.T) {
	raw := mustRead(t, "testdata/library-panels.json")
	d, rep, err := Import(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ name, kind, title, unit, expr string }{
		{"p1", "timeseries", "CPU (library)", "percentunit", "sum(rate(container_cpu_usage_seconds_total[5m])) by (pod)"}, // no title of its own
		{"p4", "timeseries", "CPU, this dashboard's title", "percentunit", "sum(rate(container_cpu_usage_seconds_total[5m])) by (pod)"},
		{"p7", "stat", "Memory", "bytes", "sum(container_memory_working_set_bytes)"}, // in a folded row
	} {
		p := d.Spec.Panels[c.name]
		if p.Kind != c.kind || p.Title != c.title || p.FieldDefaults.Unit != c.unit {
			t.Errorf("%s: %s %q unit %q, want %s %q unit %q", c.name, p.Kind, p.Title, p.FieldDefaults.Unit, c.kind, c.title, c.unit)
		}
		if len(p.Queries) != 1 || p.Queries[0].Expr != c.expr || p.Queries[0].Store != model.StorePrometheus {
			t.Errorf("%s: queries %+v, want the definition's on Prometheus", c.name, p.Queries)
		}
		if p.Ext["libraryPanelStub"] == nil || p.Ext["libraryPanel"] != nil {
			t.Errorf("%s: the reference should be kept as libraryPanelStub only: %v", c.name, sortedKeys(p.Ext))
		}
	}
	if got := d.Spec.Panels["p1"].Description; got != "Kept in the library" {
		t.Errorf("p1 description %q, want the definition's", got)
	}
	if d.Spec.Panels["p7"].Ext["maxDataPoints"] == nil {
		t.Error("p7 lost the definition's maxDataPoints")
	}
	missing := d.Spec.Panels["p5"]
	if missing.Kind != model.Unsupported || string(missing.Ext["pluginType"]) != `"library-panel-ref"` || missing.Ext["libraryPanel"] == nil {
		t.Errorf("p5 (definition not in the file): %s %v", missing.Kind, sortedKeys(missing.Ext))
	}
	if !layoutHas(d.Spec.Layout.Rows[0].Items, "p4") || !layoutHas(d.Spec.Layout.Rows[1].Items, "p7") || !layoutHas(d.Spec.Layout.Items, "p1") {
		t.Errorf("layout %+v", d.Spec.Layout)
	}

	drawn := 0
	for _, f := range rep.Adjusted {
		if strings.Contains(f.Reason, "drawn from its definition in __elements") {
			drawn++
		}
	}
	if drawn != 3 {
		t.Errorf("%d library panels reported as drawn from __elements, want 3: %v", drawn, rep.Adjusted)
	}
	var notHere []string
	for _, f := range rep.Unsupported {
		if strings.Contains(f.Reason, "library-panel-ref") {
			t.Errorf("a library panel reference read as a plugin panel: %v", f)
		}
		if strings.Contains(f.Reason, "library panel whose definition is not in this file") {
			notHere = append(notHere, f.Path)
		}
	}
	if !reflect.DeepEqual(notHere, []string{"panels[4]"}) {
		t.Errorf("library panels without a definition %v, want panels[4]", notHere)
	}

	if missing, err := unaccounted(raw, rep); err != nil || len(missing) > 0 {
		t.Errorf("unaccounted %v (%v)", missing, err)
	}
	for _, p := range rep.Preserved {
		if strings.HasPrefix(p, "panels[0].") && p != "panels[0].libraryPanel" {
			t.Errorf("the definition's keys are listed under the reference: %s", p)
		}
	}
}

func TestExport_LibraryPanelsGoBackAsReferences(t *testing.T) {
	raw := mustRead(t, "testdata/library-panels.json")
	d, _, _ := Import(raw)
	out, rep, err := Export(d)
	if err != nil {
		t.Fatal(err)
	}
	var got, want map[string]any
	_ = json.Unmarshal(out, &got)
	_ = json.Unmarshal(raw, &want)
	gp, wp := anyList(got["panels"]), anyList(want["panels"])
	for _, i := range []int{0, 3, 4, 5} { // the references, the folded row holding one
		if !reflect.DeepEqual(gp[i], wp[i]) {
			t.Errorf("panels[%d]:\n got  %s\n want %s", i, js(gp[i]), js(wp[i]))
		}
	}
	if !reflect.DeepEqual(got["__elements"], want["__elements"]) || !reflect.DeepEqual(got["__inputs"], want["__inputs"]) {
		t.Error("__elements or __inputs did not come back as they were")
	}
	for _, f := range rep.Adjusted {
		if strings.Contains(f.Reason, "unlinked") {
			t.Errorf("an unchanged library panel went out unlinked: %v", f)
		}
	}
}

func TestExport_LibraryPanelTitleStaysOnTheReference(t *testing.T) {
	d, _, _ := Import(mustRead(t, "testdata/library-panels.json"))
	for _, n := range []string{"p1", "p4"} {
		p := d.Spec.Panels[n]
		p.Title = "Renamed " + n
		d.Spec.Panels[n] = p
	}
	out, rep, _ := Export(d)
	var got map[string]any
	_ = json.Unmarshal(out, &got)
	panels := anyList(got["panels"])
	for _, c := range []struct {
		i    int
		want string
	}{
		{0, `{"gridPos":{"h":8,"w":12,"x":0,"y":0},"id":1,"libraryPanel":{"name":"CPU by pod","uid":"lib-cpu"},"title":"Renamed p1"}`},
		{3, `{"gridPos":{"h":8,"w":12,"x":0,"y":9},"id":4,"libraryPanel":{"name":"CPU by pod","uid":"lib-cpu"},"title":"Renamed p4","type":"library-panel-ref"}`},
	} {
		if g := js(panels[c.i]); g != c.want {
			t.Errorf("panels[%d] %s, want %s", c.i, g, c.want)
		}
	}
	for _, f := range rep.Adjusted {
		if strings.Contains(f.Reason, "unlinked") {
			t.Errorf("a new title unlinked the panel: %v", f)
		}
	}
	again, _, _ := Import(out)
	if again.Spec.Panels["p1"].Title != "Renamed p1" || again.Spec.Panels["p1"].Kind != "timeseries" {
		t.Errorf("p1 imports back as %q %s", again.Spec.Panels["p1"].Title, again.Spec.Panels["p1"].Kind)
	}
}

func TestExport_ChangedLibraryPanelGoesOutUnlinked(t *testing.T) {
	d, _, _ := Import(mustRead(t, "testdata/library-panels.json"))
	p := d.Spec.Panels["p4"]
	p.Queries = append([]model.Query(nil), p.Queries...)
	p.Queries[0].Expr = "up"
	d.Spec.Panels["p4"] = p
	out, rep, err := Export(d)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	_ = json.Unmarshal(out, &got)
	panels := anyList(got["panels"])
	plain := mapOr(panels[3])
	if plain["libraryPanel"] != nil || plain["libraryPanelStub"] != nil || plain["type"] != "timeseries" ||
		plain["title"] != "CPU, this dashboard's title" || plain["description"] != "Kept in the library" || plain["pluginVersion"] != "13.3.0" {
		t.Errorf("the changed panel: %s", js(plain))
	}
	q := mapOr(anyList(plain["targets"])[0])
	if q["expr"] != "up" || js(q["datasource"]) != `{"type":"prometheus","uid":"${DS_PROMETHEUS-FOR-LIBRARY-PANEL}"}` {
		t.Errorf("the changed query: %s", js(q))
	}
	if _, ref := mapOr(panels[0])["libraryPanel"]; !ref {
		t.Error("p1, unchanged and of the same library panel, should stay a reference")
	}
	unlinked := false
	for _, f := range rep.Adjusted {
		unlinked = unlinked || (f.Path == "panels.p4" && strings.Contains(f.Reason, `unlinked from library panel "CPU by pod" (lib-cpu)`))
	}
	if !unlinked {
		t.Errorf("no report of the unlinked panel: %v", rep.Adjusted)
	}
	again, _, err := Import(out)
	if err != nil {
		t.Fatal(err)
	}
	if a := again.Spec.Panels["p4"]; a.Kind != "timeseries" || a.Queries[0].Expr != "up" || a.Ext["libraryPanelStub"] != nil {
		t.Errorf("p4 imports back as %s %+v %v", a.Kind, a.Queries, sortedKeys(a.Ext))
	}
}

func TestExportShared_LibraryPanelsInTheFile(t *testing.T) {
	d, _, _ := Import(mustRead(t, "testdata/library-panels.json"))
	out, rep, err := ExportShared(d)
	if err != nil {
		t.Fatal(err)
	}
	var notIncluded []string
	for _, f := range rep.Adjusted {
		if strings.Contains(f.Reason, "is referenced, not included") {
			notIncluded = append(notIncluded, f.Reason)
		}
	}
	if len(notIncluded) != 1 || !strings.Contains(notIncluded[0], "lib-disk") {
		t.Errorf("reported as not included %v, want lib-disk only", notIncluded)
	}
	var got map[string]any
	_ = json.Unmarshal(out, &got)
	if len(mapOr(got["__elements"])) != 3 {
		t.Errorf("__elements %s", js(got["__elements"]))
	}
	names := map[string]bool{}
	for _, in := range anyList(got["__inputs"]) {
		names[mapOr(in)["name"].(string)] = true
	}
	if !names["DS_PROMETHEUS-FOR-LIBRARY-PANEL"] {
		t.Errorf("the definitions' input is gone: %v", names)
	}
}

func TestExportV2_LibraryPanelReferences(t *testing.T) {
	d, _, _ := Import(mustRead(t, "testdata/library-panels.json"))
	out, _, err := ExportV2(d)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	_ = json.Unmarshal(out, &got)
	byID := map[string]string{}
	for _, el := range mapOr(mapOr(got["spec"])["elements"]) {
		e := mapOr(el)
		spec := mapOr(e["spec"])
		kind, _ := e["kind"].(string)
		if lp := mapOr(spec["libraryPanel"]); len(lp) > 0 {
			kind += ":" + fmtAny(lp["uid"])
		}
		byID[js(spec["id"])] = kind
	}
	want := map[string]string{"1": "LibraryPanel:lib-cpu", "2": "Panel", "4": "LibraryPanel:lib-cpu", "5": "LibraryPanel:lib-disk", "7": "LibraryPanel:lib-mem"}
	if !reflect.DeepEqual(byID, want) {
		t.Errorf("v2 elements %v, want %v", byID, want)
	}
}

func fmtAny(v any) string {
	s, _ := v.(string)
	return s
}

func layoutHas(items []model.LayoutItem, name string) bool {
	for _, it := range items {
		if it.Panel == name {
			return true
		}
	}
	return false
}

func TestLibraryDefinitions(t *testing.T) {
	got := libraryDefinitions(json.RawMessage(`{
		"by-key": {"name": "A", "kind": 1, "model": {"type": "stat"}},
		"other-key": {"name": "B", "uid": "by-uid", "kind": 1, "model": {"type": "gauge"}},
		"no-kind": {"name": "C", "model": {"type": "table"}},
		"variable": {"name": "D", "uid": "variable", "kind": 2, "model": {"type": "query"}},
		"no-model": {"name": "E", "uid": "no-model", "kind": 1}
	}`))
	kinds := map[string]string{}
	for uid, m := range got {
		kinds[uid] = strOf(m["type"])
	}
	if want := map[string]string{"by-key": "stat", "by-uid": "gauge", "no-kind": "table"}; !reflect.DeepEqual(kinds, want) {
		t.Errorf("definitions %v, want %v", kinds, want)
	}
	if got := libraryDefinitions(json.RawMessage(`[]`)); len(got) != 0 {
		t.Errorf("an empty list gave %v", got)
	}
}
