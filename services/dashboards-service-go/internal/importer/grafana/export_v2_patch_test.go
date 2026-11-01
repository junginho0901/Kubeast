package grafana

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// v2Edit is a change made in Kubeast to a dashboard imported from v2.
type v2Edit struct {
	name  string
	edit  func(d *model.Dashboard) bool // false: nothing to change in this one
	where []string                      // the spec paths the edit may change
}

func firstPanel(d *model.Dashboard) (string, bool) {
	var names []string
	for n := range d.Spec.Panels {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if _, lib := d.Spec.Panels[n].Ext["libraryPanel"]; !lib {
			return n, true
		}
	}
	return "", false
}

func layoutItems(d *model.Dashboard) []*model.LayoutItem {
	var out []*model.LayoutItem
	for i := range d.Spec.Layout.Items {
		out = append(out, &d.Spec.Layout.Items[i])
	}
	for r := range d.Spec.Layout.Rows {
		for i := range d.Spec.Layout.Rows[r].Items {
			out = append(out, &d.Spec.Layout.Rows[r].Items[i])
		}
	}
	return out
}

var v2Edits = []v2Edit{
	{"dashboard title", func(d *model.Dashboard) bool { d.Metadata.Title += " (edited)"; return true }, []string{".title"}},
	{"time range", func(d *model.Dashboard) bool { d.Spec.Time.From = "now-3h"; return true }, []string{".timeSettings.from"}},
	{"panel title", func(d *model.Dashboard) bool {
		n, ok := firstPanel(d)
		if ok {
			p := d.Spec.Panels[n]
			p.Title += " (edited)"
			d.Spec.Panels[n] = p
		}
		return ok
	}, []string{".elements."}},
	{"query", func(d *model.Dashboard) bool {
		n, ok := firstPanel(d)
		if !ok || len(d.Spec.Panels[n].Queries) == 0 {
			return false
		}
		p := d.Spec.Panels[n]
		qs := append([]model.Query(nil), p.Queries...)
		qs[0].Expr = "sum(up)"
		p.Queries = qs
		d.Spec.Panels[n] = p
		return true
	}, []string{".elements."}},
	{"unit", func(d *model.Dashboard) bool {
		n, ok := firstPanel(d)
		if ok {
			p := d.Spec.Panels[n]
			p.FieldDefaults.Unit = "bytes"
			d.Spec.Panels[n] = p
		}
		return ok
	}, []string{".elements."}},
	{"variable label", func(d *model.Dashboard) bool {
		if len(d.Spec.Variables) == 0 {
			return false
		}
		vs := append([]model.Variable(nil), d.Spec.Variables...)
		vs[0].Label = "Edited"
		d.Spec.Variables = vs
		return true
	}, []string{".variables[", ".layout."}},
	{"new variable", func(d *model.Dashboard) bool {
		d.Spec.Variables = append(append([]model.Variable(nil), d.Spec.Variables...),
			model.Variable{Name: "added", Kind: model.VarCustom, Options: []model.VariableOption{{Text: "a", Value: "a"}}})
		return true
	}, []string{".variables"}},
	{"panel removed", func(d *model.Dashboard) bool {
		n, ok := firstPanel(d)
		if !ok {
			return false
		}
		delete(d.Spec.Panels, n)
		d.Spec.Layout.Items = without(d.Spec.Layout.Items, n)
		for r := range d.Spec.Layout.Rows {
			d.Spec.Layout.Rows[r].Items = without(d.Spec.Layout.Rows[r].Items, n)
		}
		return true
	}, []string{".elements.", ".layout."}},
	{"panel added", func(d *model.Dashboard) bool {
		n, ok := firstPanel(d)
		if !ok {
			return false
		}
		p := d.Spec.Panels[n]
		p.Title = "Added in Kubeast"
		p.Ext = nil
		d.Spec.Panels["p9001"] = p
		it := model.LayoutItem{Panel: "p9001", X: 0, Y: 200, W: 12, H: 8}
		if len(d.Spec.Layout.Rows) > 0 {
			last := len(d.Spec.Layout.Rows) - 1
			d.Spec.Layout.Rows[last].Items = append(d.Spec.Layout.Rows[last].Items, it)
		} else {
			d.Spec.Layout.Items = append(d.Spec.Layout.Items, it)
		}
		return true
	}, []string{".elements.", ".layout."}},
	{"panel narrowed", func(d *model.Dashboard) bool { // narrower: nothing below or beside moves
		n, ok := firstPanel(d)
		if !ok {
			return false
		}
		for _, it := range layoutItems(d) {
			if it.Panel == n && it.W > 2 {
				it.W -= 2
				return true
			}
		}
		return false
	}, []string{".layout."}},
}

var v2MoreEdits = []v2Edit{
	{"variable removed", func(d *model.Dashboard) bool {
		if len(d.Spec.Variables) == 0 {
			return false
		}
		d.Spec.Variables = append([]model.Variable(nil), d.Spec.Variables[1:]...)
		return true
	}, []string{".variables", ".layout."}},
	{"variables reordered", func(d *model.Dashboard) bool {
		if len(d.Spec.Variables) < 2 {
			return false
		}
		vs := append([]model.Variable(nil), d.Spec.Variables...)
		vs[0], vs[1] = vs[1], vs[0]
		d.Spec.Variables = vs
		return true
	}, []string{".variables[", ".layout."}},
	{"bottom panel moved down", func(d *model.Dashboard) bool { // nothing below it to push
		var low *model.LayoutItem
		for _, it := range layoutItems(d) {
			if low == nil || it.Y+it.H > low.Y+low.H {
				low = it
			}
		}
		if low == nil {
			return false
		}
		low.Y += 3
		return true
	}, []string{".layout."}},
	{"row renamed", func(d *model.Dashboard) bool {
		if len(d.Spec.Layout.Rows) == 0 {
			return false
		}
		d.Spec.Layout.Rows[0].Title += " (edited)"
		return true
	}, []string{".layout."}},
}

func without(items []model.LayoutItem, panel string) []model.LayoutItem {
	var out []model.LayoutItem
	for _, it := range items {
		if it.Panel != panel {
			out = append(out, it)
		}
	}
	return out
}

// layoutKinds lists the layout kinds of a v2 spec from the root down.
func layoutKinds(v any) string {
	var out []string
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			if k, ok := x["kind"].(string); ok && strings.HasSuffix(k, "Layout") {
				out = append(out, k)
			}
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if k != "elements" {
					walk(x[k])
				}
			}
		case []any:
			for _, e := range x {
				walk(e)
			}
		}
	}
	walk(mapOr(v)["layout"])
	return strings.Join(out, ",")
}

// A dashboard imported from v2 and changed in Kubeast goes out as its v2 file
// with the change written in (D-12): importing that file gives the changed
// dashboard, and the file keeps the original's layout kinds (tabs, auto grids,
// rows) and what the change did not touch.
func TestExportV2_WritesChangesIntoTheV2File(t *testing.T) {
	type doc struct {
		name string
		raw  []byte
	}
	var docs []doc
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		docs = append(docs, doc{p.name, p.v2})
	}
	tried := 0
	for _, dc := range docs {
		for _, e := range append(append([]v2Edit(nil), v2Edits...), v2MoreEdits...) {
			d, _, err := Import(dc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if !e.edit(d) {
				continue
			}
			tried++
			out, rep, err := ExportV2(d)
			if err != nil {
				t.Errorf("%s / %s: %v", dc.name, e.name, err)
				continue
			}
			var orig, got map[string]any
			_ = json.Unmarshal(dc.raw, &orig)
			_ = json.Unmarshal(out, &got)
			if a, b := layoutKinds(got["spec"]), layoutKinds(orig["spec"]); a != b {
				t.Errorf("%s / %s: layout kinds %s, want the file's %s", dc.name, e.name, a, b)
			}
			again, _, err := Import(out)
			if err != nil {
				t.Errorf("%s / %s: the file does not import: %v", dc.name, e.name, err)
				continue
			}
			for _, path := range diffPaths("", orig["spec"], got["spec"], 1000) {
				ok := false
				for _, w := range e.where {
					ok = ok || strings.HasPrefix(path, w)
				}
				if !ok {
					t.Errorf("%s / %s: changed outside what the edit touches: %s", dc.name, e.name, path)
					break
				}
			}
			auto := strings.Contains(layoutKinds(orig["spec"]), "AutoGrid")
			rowsKept := false
			for _, f := range rep.Adjusted {
				rowsKept = rowsKept || strings.Contains(f.Reason, "has no such row") || strings.Contains(f.Reason, "rows added or removed")
			}
			if !rowsKept && rowTitles(again) != rowTitles(d) {
				t.Errorf("%s / %s: row titles %s, want %s", dc.name, e.name, rowTitles(again), rowTitles(d))
			}
			if e.name == "row renamed" && rowsKept && strings.Contains(layoutKinds(orig["spec"]), "RowsLayout") && !strings.Contains(layoutKinds(orig["spec"]), "Tabs") {
				t.Errorf("%s / %s: a rows file did not take the new title: %v", dc.name, e.name, rep.Adjusted)
			}
			if a, b := editView(again, auto), editView(d, auto); a != b {
				t.Errorf("%s / %s: imports back differently:\n got  %s\n want %s\n(report %v)", dc.name, e.name, a, b, rep.Adjusted)
			}
		}
	}
	if tried < 400 {
		t.Errorf("%d edits tried, want each kind on every v2 document", tried)
	}
}

func rowTitles(d *model.Dashboard) string {
	var out []string
	for _, r := range d.Spec.Layout.Rows {
		out = append(out, fmt.Sprintf("%q", r.Title))
	}
	return strings.Join(out, ",")
}

// editView is what the edits change, in a fixed order: the title, the time,
// the variables, the panels and where they sit (only which panels, in a file
// with auto grids, which place them themselves).
func editView(d *model.Dashboard, auto bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%q %s..%s |", d.Metadata.Title, d.Spec.Time.From, d.Spec.Time.To)
	for _, v := range d.Spec.Variables {
		var opts []string
		for _, o := range v.Options {
			opts = append(opts, o.Text)
		}
		fmt.Fprintf(&b, " %s:%s:%q:%v", v.Name, v.Kind, v.Label, opts)
	}
	b.WriteString(" |")
	names := make([]string, 0, len(d.Spec.Panels))
	for n := range d.Spec.Panels {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		p := d.Spec.Panels[n]
		var qs []string
		for _, q := range p.Queries {
			qs = append(qs, q.RefID+"="+q.Expr)
		}
		fmt.Fprintf(&b, " %s:%q:%s:%s:%v", n, p.Title, p.Kind, p.FieldDefaults.Unit, qs)
	}
	b.WriteString(" |")
	var items []string
	for _, it := range layoutItems(d) {
		if auto {
			items = append(items, it.Panel)
		} else {
			items = append(items, fmt.Sprintf("%s@%d,%d,%dx%d", it.Panel, it.X, it.Y, it.W, it.H))
		}
	}
	sort.Strings(items)
	b.WriteString(" " + strings.Join(items, " "))
	return b.String()
}

// A layout change the file cannot hold is reported and the file's layout
// kept: a panel's size in an auto grid, a panel moved to another row.
func TestExportV2_ReportsLayoutItCannotWrite(t *testing.T) {
	report := func(name string, edit func(*model.Dashboard)) (string, map[string]any, map[string]any) {
		t.Helper()
		var raw []byte
		for _, p := range nativePairs(t) {
			if p.name == name {
				raw = p.v2
			}
		}
		d, _, err := Import(raw)
		if err != nil {
			t.Fatal(err)
		}
		edit(d)
		out, rep, err := ExportV2(d)
		if err != nil {
			t.Fatal(err)
		}
		var reasons []string
		for _, f := range rep.Adjusted {
			if f.Path == "spec.layout" {
				reasons = append(reasons, f.Reason)
			}
		}
		var orig, got map[string]any
		_ = json.Unmarshal(raw, &orig)
		_ = json.Unmarshal(out, &got)
		return strings.Join(reasons, "; "), mapOr(orig["spec"]), mapOr(got["spec"])
	}
	r, orig, got := report("v2-autogrid-4-short", func(d *model.Dashboard) {
		for _, it := range layoutItems(d) {
			it.W -= 2
			break
		}
	})
	if !strings.Contains(r, "auto grid") || !reflectEqual(orig["layout"], got["layout"]) {
		t.Errorf("auto grid size: report %q, layout kept %v", r, reflectEqual(orig["layout"], got["layout"]))
	}
	r, orig, got = report("v2-rows-mixed", func(d *model.Dashboard) {
		rows := d.Spec.Layout.Rows
		if len(rows) < 2 || len(rows[0].Items) == 0 {
			t.Fatal("v2-rows-mixed has no two rows")
		}
		it := rows[0].Items[0]
		rows[0].Items = rows[0].Items[1:]
		rows[1].Items = append(rows[1].Items, it)
	})
	if !strings.Contains(r, "moved to another row") || !reflectEqual(orig["layout"], got["layout"]) {
		t.Errorf("panel moved to another row: report %q, layout kept %v", r, reflectEqual(orig["layout"], got["layout"]))
	}
}

func reflectEqual(a, b any) bool { return len(diffPaths("", a, b, 1)) == 0 }

// What the file has and the converted dashboards do not stays: an element's
// sub header, a time setting the classic model has no field for, a removed
// panel's element and items both go, and a move is written as the amount
// moved in the file's own frame.
func TestV2Patcher_KeepsWhatTheChangeDoesNotTouch(t *testing.T) {
	parse := func(s string) map[string]any {
		var m map[string]any
		if err := json.Unmarshal([]byte(s), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	r := parse(`{"title": "T", "timeSettings": {"from": "now-6h", "to": "now", "nowDelay": "1m"},
		"elements": {"a": {"kind": "Panel", "spec": {"id": 1, "title": "A", "subtitle": "kept"}},
		             "b": {"kind": "Panel", "spec": {"id": 2, "title": "B"}}},
		"layout": {"kind": "TabsLayout", "spec": {"tabs": [{"kind": "TabsLayoutTab", "spec": {"layout": {"kind": "GridLayout", "spec": {"items": [
			{"kind": "GridLayoutItem", "spec": {"x": 0, "y": 2, "width": 12, "height": 8, "element": {"kind": "ElementReference", "name": "a"}}},
			{"kind": "GridLayoutItem", "spec": {"x": 12, "y": 2, "width": 12, "height": 8, "element": {"kind": "ElementReference", "name": "b"}}}]}}}}]}}}`)
	c0 := parse(`{"title": "T", "timeSettings": {"from": "now-6h", "to": "now"},
		"elements": {"panel-1": {"kind": "Panel", "spec": {"id": 1, "title": "A"}}, "panel-2": {"kind": "Panel", "spec": {"id": 2, "title": "B"}}},
		"layout": {"kind": "GridLayout", "spec": {"items": [
			{"kind": "GridLayoutItem", "spec": {"x": 0, "y": 10, "width": 12, "height": 8, "element": {"kind": "ElementReference", "name": "panel-1"}}},
			{"kind": "GridLayoutItem", "spec": {"x": 12, "y": 10, "width": 12, "height": 8, "element": {"kind": "ElementReference", "name": "panel-2"}}}]}}}`)
	c1 := parse(`{"title": "T", "timeSettings": {"from": "now-3h", "to": "now"},
		"elements": {"panel-1": {"kind": "Panel", "spec": {"id": 1, "title": "A edited"}}},
		"layout": {"kind": "GridLayout", "spec": {"items": [
			{"kind": "GridLayoutItem", "spec": {"x": 0, "y": 13, "width": 12, "height": 8, "element": {"kind": "ElementReference", "name": "panel-1"}}}]}}}`)
	p := &v2patcher{r: r, c0: c0, c1: c1, rep: &ExportReport{}}
	p.patch()
	want := `{"elements":{"a":{"kind":"Panel","spec":{"id":1,"subtitle":"kept","title":"A edited"}}},` +
		`"layout":{"kind":"TabsLayout","spec":{"tabs":[{"kind":"TabsLayoutTab","spec":{"layout":{"kind":"GridLayout","spec":{"items":[` +
		`{"kind":"GridLayoutItem","spec":{"element":{"kind":"ElementReference","name":"a"},"height":8,"width":12,"x":0,"y":5}}]}}}}]}},` +
		`"timeSettings":{"from":"now-3h","nowDelay":"1m","to":"now"},"title":"T"}`
	if got := js(r); got != want {
		t.Errorf("patched:\n got %s\nwant %s", got, want)
	}
}

// Every element the layout of a patched file names is in its elements, and
// every panel element is placed.
func TestExportV2_PatchedFilesHold(t *testing.T) {
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		for _, e := range []v2Edit{v2Edits[7], v2Edits[8]} { // panel removed, panel added
			d, _, _ := Import(p.v2)
			if !e.edit(d) {
				continue
			}
			out, _, err := ExportV2(d)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			_ = json.Unmarshal(out, &got)
			spec := mapOr(got["spec"])
			elements := mapOr(spec["elements"])
			placed := places(spec["layout"])
			for name := range placed {
				if elements[name] == nil {
					t.Errorf("%s / %s: the layout names %s, which is no element", p.name, e.name, name)
				}
			}
			var orig map[string]any
			_ = json.Unmarshal(p.v2, &orig)
			before := places(mapOr(orig["spec"])["layout"])
			for name := range elements {
				if _, ok := placed[name]; !ok {
					if _, was := before[name]; was || mapOr(elements[name])["kind"] == "Panel" && !strings.Contains(js(orig), `"`+name+`"`) {
						t.Errorf("%s / %s: element %s is not placed", p.name, e.name, name)
					}
				}
			}
		}
	}
}
