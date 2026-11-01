package grafana

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// shareCase is one dashboard with every reference makeExportableV1 handles.
const shareCase = `{
  "uid": "share", "title": "Share", "schemaVersion": 39,
  "annotations": {"list": [
    {"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": true, "name": "Annotations & Alerts"},
    {"datasource": {"type": "loki", "uid": "L1"}, "enable": true, "expr": "{app=\"x\"}", "name": "deploys"}
  ]},
  "templating": {"list": [
    {"name": "ds", "type": "datasource", "query": "prometheus", "current": {"text": "Main Prom", "value": "P1"}},
    {"name": "unused", "type": "datasource", "query": "loki", "current": {"text": "Logs", "value": "L1"}},
    {"name": "ds2", "type": "datasource", "query": "prometheus", "current": {"text": "default", "value": "P1"}},
    {"name": "ns", "type": "query", "datasource": {"type": "prometheus", "uid": "${ds}"}, "query": "label_values(up, namespace)",
     "refresh": 0, "current": {"text": "a", "value": "a"}, "options": [{"text": "a", "value": "a"}]},
    {"name": "job", "type": "query", "datasource": {"type": "prometheus", "uid": "P2"}, "query": "label_values(up, job)", "refresh": 2},
    {"name": "filters", "type": "adhoc", "datasource": {"type": "prometheus", "uid": "P2"}},
    {"name": "env", "label": "Environment", "type": "constant", "query": "prod"}
  ]},
  "panels": [
    {"id": 1, "type": "timeseries", "title": "via variable", "gridPos": {"x": 0, "y": 0, "w": 12, "h": 8},
     "datasource": {"type": "prometheus", "uid": "${ds}"}, "targets": [{"refId": "A", "expr": "up"}]},
    {"id": 2, "type": "stat", "title": "two of a type", "gridPos": {"x": 12, "y": 0, "w": 12, "h": 8},
     "datasource": {"type": "prometheus", "uid": "P2"},
     "targets": [{"refId": "A", "expr": "up"}, {"refId": "B", "expr": "up", "datasource": {"type": "prometheus", "uid": "P3"}}]},
    {"id": 3, "type": "logs", "title": "by name", "gridPos": {"x": 0, "y": 8, "w": 12, "h": 8},
     "datasource": "Loki prod", "targets": [{"refId": "A", "expr": "{app=\"x\"}"}]},
    {"id": 4, "type": "timeseries", "title": "default and unknown", "gridPos": {"x": 12, "y": 8, "w": 12, "h": 8},
     "datasource": null, "targets": [{"refId": "A", "expr": "up", "datasource": {"uid": "Q9"}}]},
    {"id": 5, "type": "row", "title": "closed", "collapsed": true, "gridPos": {"x": 0, "y": 16, "w": 24, "h": 1}, "panels": [
      {"id": 6, "type": "gauge", "title": "inside", "gridPos": {"x": 0, "y": 17, "w": 12, "h": 8},
       "datasource": {"type": "prometheus", "uid": "P1"}, "targets": [{"refId": "A", "expr": "up"}]}
    ]},
    {"id": 7, "type": "stat", "title": "same data source, other variable", "gridPos": {"x": 0, "y": 17, "w": 12, "h": 8},
     "datasource": {"type": "prometheus", "uid": "${ds2}"}, "targets": [{"refId": "A", "expr": "up"}]}
  ]
}`

func shared(t *testing.T, raw []byte) (map[string]any, *ExportReport) {
	t.Helper()
	d, _, err := Import(raw)
	if err != nil {
		t.Fatal(err)
	}
	out, rep, err := ExportShared(d)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	return m, rep
}

func at(v any, path ...any) any {
	for _, p := range path {
		switch k := p.(type) {
		case string:
			m, _ := v.(map[string]any)
			v = m[k]
		case int:
			l, _ := v.([]any)
			if k >= len(l) {
				return nil
			}
			v = l[k]
		}
	}
	return v
}

func js(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// Each rule of Grafana's makeExportableV1 on one dashboard.
func TestExportShared_Rules(t *testing.T) {
	m, rep := shared(t, []byte(shareCase))
	want := map[string]string{
		// a panel through a data source variable keeps ${ds}; the variable's current value becomes that data source's input
		"panel 1":          js(at(m, "panels", 0, "datasource")) + " " + js(at(m, "templating", "list", 0, "current")),
		"panel 1 query":    js(at(m, "panels", 0, "targets", 0, "datasource")),
		"unused variable":  js(at(m, "templating", "list", 1, "current")),
		"panel 2":          js(at(m, "panels", 1, "datasource")),
		"panel 2 query A":  js(at(m, "panels", 1, "targets", 0, "datasource")),
		"panel 2 query B":  js(at(m, "panels", 1, "targets", 1, "datasource")),
		"panel 3":          js(at(m, "panels", 2, "datasource")),
		"panel 4":          js(at(m, "panels", 3, "datasource")) + " " + js(at(m, "panels", 3, "targets", 0, "datasource")),
		"row panel":        js(at(m, "panels", 4, "panels", 0, "datasource")),
		"second variable":  js(at(m, "templating", "list", 2, "current")),
		"query variable":   js(at(m, "templating", "list", 3, "datasource")) + " " + js(at(m, "templating", "list", 3, "options")) + " " + js(at(m, "templating", "list", 3, "current")) + " " + js(at(m, "templating", "list", 3, "refresh")),
		"query variable 2": js(at(m, "templating", "list", 4, "datasource")) + " " + js(at(m, "templating", "list", 4, "refresh")),
		"adhoc":            js(at(m, "templating", "list", 5, "datasource")),
		"constant":         js(at(m, "templating", "list", 6, "query")) + " " + js(at(m, "templating", "list", 6, "current")) + " " + js(at(m, "templating", "list", 6, "options")),
		"annotations":      js(at(m, "annotations", "list", 0, "datasource")) + " " + js(at(m, "annotations", "list", 1, "datasource")),
		"elements":         js(m["__elements"]),
	}
	expect := map[string]string{
		"panel 1":          `{"type":"prometheus","uid":"${ds}"} {"selected":true,"text":"","value":"${DS_MAIN_PROM}"}`,
		"panel 1 query":    `{"type":"prometheus","uid":"${ds}"}`,
		"unused variable":  `{}`,
		"second variable":  `{"selected":true,"text":"","value":"${DS_MAIN_PROM}"}`, // the same data source as ds, though named "default" there
		"panel 2":          `{"type":"prometheus","uid":"${DS_PROMETHEUS}"}`,
		"panel 2 query A":  `{"type":"prometheus","uid":"${DS_PROMETHEUS}"}`,
		"panel 2 query B":  `{"type":"prometheus","uid":"${DS_PROMETHEUS_2}"}`,
		"panel 3":          `{"type":"loki","uid":"${DS_LOKI_PROD}"}`,
		"panel 4":          `null {"uid":"Q9"}`, // the import reads a null panel reference as no reference
		"row panel":        `{"type":"prometheus","uid":"${DS_MAIN_PROM}"}`,
		"query variable":   `{"type":"prometheus","uid":"${ds}"} [] {} 1`,
		"query variable 2": `{"type":"prometheus","uid":"${DS_PROMETHEUS}"} 2`,
		"adhoc":            `{"type":"prometheus","uid":"${DS_PROMETHEUS}"}`,
		"constant":         `"${VAR_ENV}" {"selected":false,"text":"${VAR_ENV}","value":"${VAR_ENV}"} [{"selected":false,"text":"${VAR_ENV}","value":"${VAR_ENV}"}]`,
		"annotations":      `{"type":"grafana","uid":"-- Grafana --"} {"type":"loki","uid":"${DS_LOGS}"}`,
		"elements":         `{}`,
	}
	for k, w := range expect {
		if want[k] != w {
			t.Errorf("%s:\n got %s\nwant %s", k, want[k], w)
		}
	}
	var inputs []string
	for _, in := range m["__inputs"].([]any) {
		im := in.(map[string]any)
		inputs = append(inputs, fmt.Sprintf("%v %v %v %v %q", im["name"], im["type"], im["pluginId"], im["label"], im["description"]))
	}
	wantInputs := []string{
		`DS_MAIN_PROM datasource prometheus Main Prom "uid P1 where the dashboard came from"`,
		`DS_PROMETHEUS datasource prometheus Prometheus "uid P2 where the dashboard came from"`,
		`DS_PROMETHEUS_2 datasource prometheus Prometheus "uid P3 where the dashboard came from"`,
		`DS_LOKI_PROD datasource loki Loki prod ""`,
		`DS_LOGS datasource loki Logs "uid L1 where the dashboard came from"`,
		`VAR_ENV constant <nil> Environment ""`,
	}
	if strings.Join(inputs, "\n") != strings.Join(wantInputs, "\n") {
		t.Errorf("inputs:\n%s\nwant\n%s", strings.Join(inputs, "\n"), strings.Join(wantInputs, "\n"))
	}
	if strings.Join(rep.Inputs, " ") != "DS_MAIN_PROM DS_PROMETHEUS DS_PROMETHEUS_2 DS_LOKI_PROD DS_LOGS VAR_ENV" {
		t.Errorf("report inputs = %v", rep.Inputs)
	}
	var reqs []string
	for _, r := range m["__requires"].([]any) {
		rm := r.(map[string]any)
		reqs = append(reqs, fmt.Sprintf("%v/%v/%v/%v", rm["type"], rm["id"], rm["name"], rm["version"]))
	}
	if got := strings.Join(reqs, " "); got != "panel/gauge/Gauge/ grafana/grafana/Grafana/13.3.0 panel/logs/Logs/ datasource/loki/Loki/1.0.0 datasource/prometheus/Prometheus/1.0.0 panel/stat/Stat/ panel/timeseries/Time series/" {
		t.Errorf("requires = %s", got)
	}
	var left []string
	for _, f := range rep.Adjusted {
		if f.Path == "datasource" {
			left = append(left, f.Reason)
		}
	}
	if len(left) != 1 || !strings.Contains(left[0], "1 left as they were: a data source whose plugin the dashboard does not name (panel 4 query A)") {
		t.Errorf("left = %q", left)
	}
}

// What an import never hands over, given to the sharer directly: a null
// reference stays as it is and is reported, as Grafana would resolve it to its
// own default; a query variable that never refreshes is set to refresh on load,
// since it loses its options.
func TestExportShared_Direct(t *testing.T) {
	root := map[string]any{
		"panels":     []any{map[string]any{"id": 1, "type": "stat", "datasource": nil}},
		"templating": map[string]any{"list": []any{map[string]any{"name": "q", "type": "query", "refresh": json.Number("0")}}},
	}
	rep := &ExportReport{}
	newSharer(root, rep).share()
	if got := js(at(root, "templating", "list", 0, "refresh")); got != "1" {
		t.Errorf("refresh = %s, want 1", got)
	}
	if got := js(at(root, "panels", 0, "datasource")); got != "null" {
		t.Errorf("datasource = %s", got)
	}
	if len(rep.Adjusted) != 1 || !strings.Contains(rep.Adjusted[0].Reason, "1 left as they were: the default data source") {
		t.Errorf("adjusted = %v", rep.Adjusted)
	}
}

// The panels' own query rules: a query without a data source takes its
// panel's, a library panel is reported, a row is left alone.
func TestExportShared_LibraryPanel(t *testing.T) {
	raw := []byte(`{"uid": "lib", "title": "Lib", "schemaVersion": 39, "panels": [
		{"id": 1, "type": "timeseries", "title": "lib", "gridPos": {"x": 0, "y": 0, "w": 12, "h": 8},
		 "libraryPanel": {"uid": "LP1", "name": "Shared CPU"}, "datasource": {"type": "prometheus", "uid": "P1"}}]}`)
	m, rep := shared(t, raw)
	if got := js(at(m, "panels", 0, "datasource")); got != `{"type":"prometheus","uid":"${DS_PROMETHEUS-FOR-LIBRARY-PANEL}"}` {
		t.Errorf("library panel data source = %s", got)
	}
	found := false
	for _, f := range rep.Adjusted {
		found = found || strings.Contains(f.Reason, "library panel Shared CPU (LP1)")
	}
	if !found {
		t.Errorf("library panel not reported: %v", rep.Adjusted)
	}
}

// A Kubeast-made dashboard is already written for sharing by Export.
func TestExportShared_NativeIsExport(t *testing.T) {
	for _, d := range nativeDashboards(t) {
		a, _, err := Export(d)
		if err != nil {
			t.Fatal(err)
		}
		b, _, err := ExportShared(d)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(a, b) {
			t.Errorf("%s: ExportShared differs from Export", d.Metadata.Name)
		}
	}
}

// Over every corpus document: the shared file imports into a valid dashboard,
// each ${…} it uses is a variable or an input, each data source input is used,
// a reference to a concrete data source is left only where reported, and
// sharing the shared file again gives the same bytes.
func TestExportShared_Corpus(t *testing.T) {
	type doc struct {
		name string
		raw  []byte
	}
	docs := []doc{{"edge-cases", mustRead(t, "testdata/edge-cases.json")}}
	for _, f := range corpusFiles(t) {
		docs = append(docs, doc{strings.TrimPrefix(f, "testdata/corpus/"), mustRead(t, f)})
	}
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		docs = append(docs, doc{p.name + " (v2)", p.v2}, doc{p.name + " (Grafana's v1)", p.v1})
	}
	if len(docs) < 172 {
		t.Fatalf("%d documents, want the whole corpus", len(docs))
	}
	inputsSeen := 0
	for _, dc := range docs {
		d, _, err := Import(dc.raw)
		if err != nil {
			t.Fatalf("%s: %v", dc.name, err)
		}
		out, rep, err := ExportShared(d)
		if err != nil {
			t.Fatalf("%s: %v", dc.name, err)
		}
		again, _, err := Import(out)
		if err != nil {
			t.Fatalf("%s: shared file does not import: %v", dc.name, err)
		}
		if probs := model.Validate(again); len(probs) != 0 {
			t.Errorf("%s: shared file imports as an invalid dashboard: %v", dc.name, probs)
		}
		twice, rep2, err := ExportShared(again)
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range rep2.Adjusted {
			if strings.Contains(f.Reason, "is no data source variable or input") {
				t.Errorf("%s: sharing the shared file: %s", dc.name, f.Reason) // its ${DS_…} are its own inputs
			}
		}
		if !bytes.Equal(normalUID(out), normalUID(twice)) {
			t.Errorf("%s: sharing the shared file again gives different bytes", dc.name)
		}
		var m map[string]any
		_ = json.Unmarshal(out, &m)
		names := map[string]bool{}
		for _, v := range anyList(at(m, "templating", "list")) {
			names[fmt.Sprint(at(v, "name"))] = true
		}
		var src map[string]any
		_ = json.Unmarshal(dc.raw, &src)
		given := map[string]bool{}
		for _, in := range anyList(src["__inputs"]) {
			given[fmt.Sprint(at(in, "name"))] = true
		}
		dsInputs := map[string]bool{}
		for _, in := range anyList(m["__inputs"]) {
			names[fmt.Sprint(at(in, "name"))] = true
			if at(in, "type") == "datasource" {
				dsInputs[fmt.Sprint(at(in, "name"))] = true
			}
		}
		inputsSeen += len(dsInputs)
		used := map[string]bool{}
		concrete := 0
		var walk func(v any)
		walk = func(v any) {
			switch x := v.(type) {
			case map[string]any:
				for k, e := range x {
					if k == "__inputs" || k == "__requires" {
						continue
					}
					if k == "datasource" || k == "current" {
						var uid string
						switch r := e.(type) {
						case string:
							uid = r
						case map[string]any:
							uid, _ = r["uid"].(string)
							if n, ok := r["name"].(string); ok && len(r) == 1 {
								uid = n // a v2 query's reference, carried for a v2 import
							}
							if k == "current" {
								uid, _ = r["value"].(string)
							}
						}
						if g := varUse.FindStringSubmatch(uid); g != nil {
							n := g[1] + g[2] + g[4]
							used[n] = true
							if k == "datasource" && !names[n] {
								t.Errorf("%s: uses $%s, which is no variable or input", dc.name, n)
							}
						} else if k == "datasource" && uid != "" && !builtInDS[uid] {
							if r, ok := e.(map[string]any); !ok || (r["type"] != "datasource" && r["type"] != "grafana") {
								concrete++
							}
						}
					}
					walk(e)
				}
			case []any:
				for _, e := range x {
					walk(e)
				}
			}
		}
		walk(m)
		for n := range dsInputs {
			if !used[n] && !given[n] {
				t.Errorf("%s: input %s is used nowhere", dc.name, n)
			}
		}
		reported := false
		for _, f := range rep.Adjusted {
			if strings.Contains(f.Reason, "is no data source variable or input") {
				t.Errorf("%s: %s", dc.name, f.Reason) // every ${…} here is a variable or an input (checked above)
			}
			reported = reported || (f.Path == "datasource" && !strings.Contains(f.Reason, "default data source"))
		}
		if concrete > 0 && !reported {
			t.Errorf("%s: %d references to a concrete data source left unreported", dc.name, concrete)
		}
	}
	if inputsSeen == 0 {
		t.Error("no data source input in the whole corpus")
	}
}

// nativeDashboards are the evaluation references and the schema example.
func nativeDashboards(t *testing.T) []*model.Dashboard {
	t.Helper()
	files, _ := filepath.Glob("../../../../../evals/dashboards/*/reference.json")
	files = append(files, "../../../schema/examples/web-red.json")
	var out []*model.Dashboard
	for _, f := range files {
		var d model.Dashboard
		if json.Unmarshal(mustRead(t, f), &d) != nil || d.APIVersion == "" {
			continue // a decline answer
		}
		out = append(out, &d)
	}
	if len(out) < 20 {
		t.Fatalf("%d Kubeast-made dashboards", len(out))
	}
	return out
}
