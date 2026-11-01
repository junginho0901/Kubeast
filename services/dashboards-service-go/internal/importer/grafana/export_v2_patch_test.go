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
		for _, e := range v2Edits {
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
			if a, b := editView(again, auto), editView(d, auto); a != b {
				t.Errorf("%s / %s: imports back differently:\n got  %s\n want %s\n(report %v)", dc.name, e.name, a, b, rep.Adjusted)
			}
		}
	}
	if tried < 400 {
		t.Errorf("%d edits tried, want each kind on every v2 document", tried)
	}
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
