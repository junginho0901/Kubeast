package grafana

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// pair is one schema v2 dashboard stored in Grafana 13.3.0, read back as v2
// and as Grafana's own v1 conversion of it.
type pair struct {
	name   string
	v2, v1 []byte
}

func nativePairs(t *testing.T) []pair {
	t.Helper()
	files, _ := filepath.Glob("testdata/grafana-13.3.0-v2/native/*.v2.json")
	if len(files) == 0 {
		t.Fatal("no native v2 samples")
	}
	var out []pair
	for _, f := range files {
		v2, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		v1, err := os.ReadFile(strings.TrimSuffix(f, ".v2.json") + ".v1.json")
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, pair{strings.TrimSuffix(filepath.Base(f), ".v2.json"), v2, v1})
	}
	return out
}

// corpusPairs reads pairs.tar.gz: the import corpus saved in Grafana 13.3.0 and
// read back as v2, then that v2 stored as it is and read back as v1 (Grafana's
// v2 → v1 conversion of the very document).
func corpusPairs(t *testing.T) []pair {
	t.Helper()
	f, err := os.Open("testdata/grafana-13.3.0-v2/pairs.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		files[h.Name] = b
	}
	var out []pair
	for name, v2 := range files {
		if !strings.HasPrefix(name, "v2/") {
			continue
		}
		base := strings.TrimPrefix(name, "v2/")
		v1, ok := files["v1/"+base]
		if !ok {
			t.Fatalf("%s has no v1", name)
		}
		out = append(out, pair{strings.TrimSuffix(base, ".json"), v2, v1})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	if len(out) < 50 {
		t.Fatalf("pairs.tar.gz holds %d pairs", len(out))
	}
	return out
}

// TestV2_Imports: every v2 document imports, validates, accounts for every key
// it has, gives the same bytes twice and drops only the resource envelope.
func TestV2_Imports(t *testing.T) {
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		d, rep, err := Import(p.v2)
		if err != nil {
			t.Errorf("%s: %v", p.name, err)
			continue
		}
		if d.Source == nil || d.Source.Kind != model.SourceGrafanaV2 || d.Source.UID == "" {
			t.Errorf("%s: source = %+v", p.name, d.Source)
		}
		if probs := model.Validate(d); len(probs) != 0 {
			t.Errorf("%s: not valid: %v", p.name, probs)
		}
		missing, err := unaccountedV2(p.v2, rep)
		if err != nil {
			t.Fatal(err)
		}
		if len(missing) != 0 {
			t.Errorf("%s: keys read by nobody (lost on import): %v", p.name, missing)
		}
		for _, dp := range rep.Dropped {
			if !droppable[dp] || dp == "id" {
				t.Errorf("%s: dropped %s; only the resource envelope may be dropped", p.name, dp)
			}
		}
		first, _ := json.Marshal(d)
		again, _, _ := Import(p.v2)
		second, _ := json.Marshal(again)
		if string(first) != string(second) {
			t.Errorf("%s: importing twice gives different bytes", p.name)
		}
	}
}

// TestV2_LayoutAsGrafanaConverts: the classic panels the conversion builds
// from each v2 document — rows, tabs, auto grids, nesting, collapsed and
// header-less rows, repeats — are the ones Grafana 13.3.0's own v2 → v1
// conversion serves for it, panel by panel.
func TestV2_LayoutAsGrafanaConverts(t *testing.T) {
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		var env, v1 struct {
			APIVersion string         `json:"apiVersion"`
			Spec       map[string]any `json:"spec"`
		}
		if err := json.Unmarshal(p.v2, &env); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(p.v1, &v1); err != nil {
			t.Fatal(err)
		}
		spec, _ := asObj(mustJSON(env.Spec))
		ours := newV2conv(false).dashboard(spec)
		got := layoutView(roundTrip(ours["panels"]))
		want := layoutView(v1.Spec["panels"])
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: layout differs from Grafana's\n got: %v\nwant: %v", p.name, got, want)
		}
	}
}

func roundTrip(v any) any {
	var out any
	_ = json.Unmarshal(mustJSON(v), &out)
	return out
}

// layoutView keeps what a panel's place is made of. A library panel has no
// type of ours (the classic import then names it a library panel to inline);
// Grafana writes "library-panel-ref".
func layoutView(panels any) []string {
	var out []string
	var walk func(prefix string, list any)
	walk = func(prefix string, list any) {
		for _, raw := range asList(list) {
			p := asMap(raw)
			typ, _ := p["type"].(string)
			if typ == "" && p["libraryPanel"] != nil {
				typ = "library-panel-ref"
			}
			line := fmt.Sprintf("%s%s %q %v", prefix, typ, p["title"], p["gridPos"])
			for _, k := range []string{"collapsed", "repeat", "repeatDirection", "maxPerRow"} {
				if v, ok := p[k]; ok {
					line += fmt.Sprintf(" %s=%v", k, v)
				}
			}
			out = append(out, line)
			walk(prefix+"  ", p["panels"])
		}
	}
	walk("", panels)
	return out
}

// TestV2_SameModelAsGrafanasV1: importing a dashboard's v2 document gives the
// model that importing Grafana's own v1 conversion of it gives — everything
// but ext and source, which record where each came from.
func TestV2_SameModelAsGrafanasV1(t *testing.T) {
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		a, _, err := Import(p.v2)
		if err != nil {
			t.Errorf("%s v2: %v", p.name, err)
			continue
		}
		b, _, err := Import(p.v1)
		if err != nil {
			t.Errorf("%s v1: %v", p.name, err)
			continue
		}
		ga, gb := semantic(a), semantic(b)
		if !reflect.DeepEqual(ga, gb) {
			t.Errorf("%s: the v2 import differs from the v1 import at %v", p.name, diffPaths("", ga, gb, 6))
		}
	}
}

func semantic(d *model.Dashboard) any { return strip(roundTrip(d)) }

func strip(v any) any {
	switch x := v.(type) {
	case map[string]any:
		delete(x, "ext")
		delete(x, "source")
		for k, y := range x {
			x[k] = strip(y)
		}
	case []any:
		for i := range x {
			x[i] = strip(x[i])
		}
	}
	return v
}

// diffPaths lists up to max paths where a and b differ.
func diffPaths(path string, a, b any, max int) []string {
	var out []string
	var walk func(p string, x, y any)
	walk = func(p string, x, y any) {
		if len(out) >= max {
			return
		}
		mx, okx := x.(map[string]any)
		my, oky := y.(map[string]any)
		if okx && oky {
			ks := map[string]bool{}
			for k := range mx {
				ks[k] = true
			}
			for k := range my {
				ks[k] = true
			}
			names := make([]string, 0, len(ks))
			for k := range ks {
				names = append(names, k)
			}
			sort.Strings(names)
			for _, k := range names {
				walk(p+"."+k, mx[k], my[k])
			}
			return
		}
		lx, okx := x.([]any)
		ly, oky := y.([]any)
		if okx && oky && len(lx) == len(ly) {
			for i := range lx {
				walk(fmt.Sprintf("%s[%d]", p, i), lx[i], ly[i])
			}
			return
		}
		if !reflect.DeepEqual(x, y) {
			out = append(out, fmt.Sprintf("%s: v2 %s, v1 %s", p, short(x), short(y)))
		}
	}
	walk(path, a, b)
	return out
}

func short(v any) string {
	s := string(mustJSON(v))
	if len(s) > 120 {
		s = s[:120] + "…"
	}
	return s
}

func TestV2_RefusedForms(t *testing.T) {
	alpha := []byte(`{"apiVersion": "dashboard.grafana.app/v2alpha1", "kind": "Dashboard", "metadata": {"name": "a"}, "spec": {"elements": {}, "layout": {}}}`)
	if _, _, err := Import(alpha); err != ErrV2Alpha1 {
		t.Errorf("v2alpha1: err = %v, want ErrV2Alpha1", err)
	}
	bare := []byte(`{"title": "t", "elements": {}, "layout": {"kind": "GridLayout", "spec": {"items": []}}}`)
	if _, _, err := Import(bare); err != ErrV2NoEnvelope {
		t.Errorf("bare v2 spec: err = %v, want ErrV2NoEnvelope", err)
	}
}

// TestV2Beta1_SameAsV2: Grafana serves the same stored dashboard as v2beta1
// (the transformation named in kind and spec.id); it imports to the same model.
func TestV2Beta1_SameAsV2(t *testing.T) {
	files, _ := filepath.Glob("testdata/grafana-13.3.0-v2/native/*.v2beta1.json")
	if len(files) == 0 {
		t.Fatal("no v2beta1 samples")
	}
	for _, f := range files {
		beta, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		v2, err := os.ReadFile(strings.TrimSuffix(f, ".v2beta1.json") + ".v2.json")
		if err != nil {
			t.Fatal(err)
		}
		a, rep, err := Import(beta)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		b, _, err := Import(v2)
		if err != nil {
			t.Fatal(err)
		}
		if ga, gb := semantic(a), semantic(b); !reflect.DeepEqual(ga, gb) {
			t.Errorf("%s: v2beta1 import differs from v2 at %v", f, diffPaths("", ga, gb, 6))
		}
		if missing, _ := unaccountedV2(beta, rep); len(missing) != 0 {
			t.Errorf("%s: keys read by nobody: %v", f, missing)
		}
	}
}

// TestV2_ReportSpeaksV2: every path in a v2 import's report is a path of the
// v2 file, none of the classic dashboard it went through.
func TestV2_ReportSpeaksV2(t *testing.T) {
	classic := []string{"panels[", "templating.", "annotations.list", "time.", "timepicker", "v2:", "graphTooltip", "refresh"}
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		_, rep, err := Import(p.v2)
		if err != nil {
			t.Fatal(err)
		}
		var paths []string
		paths = append(paths, rep.Preserved...)
		paths = append(paths, rep.Dropped...)
		for _, f := range append(append([]Finding{}, rep.Adjusted...), rep.Unsupported...) {
			paths = append(paths, f.Path)
		}
		for _, path := range paths {
			for _, c := range classic {
				if strings.HasPrefix(path, c) {
					t.Errorf("%s: report path %q is the classic dashboard's", p.name, path)
				}
			}
		}
	}
	// What the native features sample needs, in its own paths.
	_, rep, _ := Import(mustRead(t, "testdata/grafana-13.3.0-v2/native/v2-features.v2.json"))
	want := map[string]string{
		"spec.elements.panel-8":                              "element not placed",
		"spec.layout.spec.rows[0].spec.conditionalRendering": "conditional rendering",
		"spec.layout.spec.rows[0].spec.variables":            "section variables",
		"spec.layout.spec.rows[1].spec.layout.spec":          "auto grid placed",
		"spec.elements.lib.spec":                             "library panel",
	}
	found := map[string]bool{}
	for _, f := range append(append([]Finding{}, rep.Adjusted...), rep.Unsupported...) {
		for path, words := range want {
			if f.Path == path && strings.Contains(f.Reason, words) {
				found[path] = true
			}
		}
	}
	for path := range want {
		if !found[path] {
			t.Errorf("features: no finding at %s (%q); report: %+v %+v", path, want[path], rep.Adjusted, rep.Unsupported)
		}
	}
}

func mustRead(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestV2_OddDocuments: kinds the conversion does not know, a layout item that
// names no element, an element placed twice — each kept and reported, nothing
// lost.
func TestV2_OddDocuments(t *testing.T) {
	raw := []byte(`{"apiVersion": "dashboard.grafana.app/v2", "kind": "Dashboard", "metadata": {"name": "odd"}, "spec": {
		"title": "Odd", "cursorSync": "Crosshair", "preload": false, "tags": [], "links": [], "annotations": [],
		"timeSettings": {"from": "", "to": "", "autoRefresh": "", "autoRefreshIntervals": [], "hideTimepicker": false, "fiscalYearStartMonth": 0, "futureSetting": 1},
		"variables": [{"kind": "FutureVariable", "spec": {"name": "x"}}],
		"elements": {
			"panel-1": {"kind": "Panel", "spec": {"id": 1, "title": "Twice", "links": [],
				"data": {"kind": "QueryGroup", "spec": {"queries": [], "transformations": [], "queryOptions": {}}},
				"vizConfig": {"kind": "VizConfig", "group": "stat", "version": "13.3.0", "spec": {"options": {}, "fieldConfig": {"defaults": {}, "overrides": []}}}}},
			"widget": {"kind": "FutureElement", "spec": {"id": 2}}
		},
		"layout": {"kind": "RowsLayout", "spec": {"rows": [
			{"kind": "RowsLayoutRow", "spec": {"title": "A", "layout": {"kind": "GridLayout", "spec": {"items": [
				{"kind": "GridLayoutItem", "spec": {"x": 0, "y": 0, "width": 12, "height": 4, "element": {"kind": "ElementReference", "name": "panel-1"}}},
				{"kind": "GridLayoutItem", "spec": {"x": 12, "y": 0, "width": 12, "height": 4, "element": {"kind": "ElementReference", "name": "panel-1"}}},
				{"kind": "GridLayoutItem", "spec": {"x": 0, "y": 4, "width": 12, "height": 4, "element": {"kind": "ElementReference", "name": "gone"}}},
				{"kind": "GridLayoutItem", "spec": {"x": 12, "y": 4, "width": 12, "height": 4, "element": {"kind": "ElementReference", "name": "widget"}}}
			]}}}},
			{"kind": "RowsLayoutRow", "spec": {"title": "B", "layout": {"kind": "FutureLayout", "spec": {"cells": []}}}}
		]}}
	}}`)
	d, rep, err := Import(raw)
	if err != nil {
		t.Fatal(err)
	}
	if d.Spec.CursorSync != model.CursorSyncShared || d.Spec.Time.From != "now-6h" || d.Spec.Time.To != "now" {
		t.Errorf("cursor %q, time %+v", d.Spec.CursorSync, d.Spec.Time)
	}
	if len(d.Spec.Panels) != 3 { // panel-1 twice, the future element once
		t.Errorf("panels = %d, want 3", len(d.Spec.Panels))
	}
	if missing, _ := unaccountedV2(raw, rep); len(missing) != 0 {
		t.Errorf("keys read by nobody: %v", missing)
	}
	var reasons []string
	for _, f := range rep.Unsupported {
		reasons = append(reasons, f.Path+": "+f.Reason)
	}
	got := strings.Join(reasons, "\n")
	for _, want := range []string{
		`spec.variables[0]: variable kind "FutureVariable"`,
		`items[2].spec.element.name: names no element ("gone")`,
		`spec.elements.widget: element kind "FutureElement"`,
		`rows[1].spec.layout: layout "FutureLayout"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("no finding %q in\n%s", want, got)
		}
	}
	if _, _, err := Import([]byte(`{"apiVersion": "dashboard.grafana.app/v2", "kind": "Dashboard", "metadata": {"name": "x"}}`)); err != ErrNoPanels {
		t.Errorf("no spec: err = %v, want ErrNoPanels", err)
	}
}
