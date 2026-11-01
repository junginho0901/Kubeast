package grafana

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// patchedV2 is the v2 resource of a dashboard changed since its v2 import
// (D-12): its v2 file with the changes written in, so what the classic model
// cannot hold (tabs, auto grids, sub headers, conditional rendering…) stays.
//
// The changes are what differs between the dashboard as imported (orig) and
// as it is now (d), both converted to v2 the same way (ConvertV2 of Export):
// that difference is the edit and nothing else. It goes into the file by
// panel id, variable name, annotation name and occurrence, top-level key and
// time setting; a panel's position and size by the amount it moved, which
// holds whatever frame the file's layout uses. A change of the layout's
// structure (rows added, removed or reordered, a panel moved to another row)
// has no place in a file of tabs or auto grids and is reported, not written.
func patchedV2(d, orig *model.Dashboard, raw []byte) (*v2Res, *ExportReport, error) {
	c0, err := convertedSpec(orig)
	if err != nil {
		return nil, nil, err
	}
	c1, err := convertedSpec(d)
	if err != nil {
		return nil, nil, err
	}
	var root struct {
		APIVersion string         `json:"apiVersion"`
		Metadata   map[string]any `json:"metadata"`
		Spec       map[string]any `json:"spec"`
		Status     any            `json:"status"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil || root.Spec == nil {
		return nil, nil, ErrNotJSON
	}
	rep := leftOut(root.Metadata, root.Status)
	p := &v2patcher{r: root.Spec, c0: c0, c1: c1, rep: rep}
	p.patch()
	rep.Adjusted = append(rep.Adjusted, Finding{Path: "spec", Reason: fmt.Sprintf(
		"%d changes since the v2 import written into the v2 file it came from", p.changes)})
	name, _ := root.Metadata["name"].(string)
	if name == "" {
		name = d.Metadata.Name
	}
	return &v2Res{apiVersion: root.APIVersion, name: name, spec: root.Spec}, rep, nil
}

// convertedSpec is the v2 spec of a dashboard's classic export.
func convertedSpec(d *model.Dashboard) (map[string]any, error) {
	classic, _, err := Export(d)
	if err != nil {
		return nil, err
	}
	spec, err := ConvertV2(classic, exportDataSources(d))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	dec := json.NewDecoder(bytes.NewReader(spec))
	dec.UseNumber()
	return out, dec.Decode(&out)
}

type v2patcher struct {
	r, c0, c1 map[string]any
	rep       *ExportReport
	changes   int
}

// structural keys of the spec, patched each in its own way
var v2StructuralKeys = map[string]bool{"elements": true, "layout": true, "variables": true, "annotations": true, "timeSettings": true, "preferences": true}

func (p *v2patcher) patch() {
	for _, k := range unionKeys(p.c0, p.c1) {
		if !v2StructuralKeys[k] {
			p.set(p.r, k, p.c0[k], p.c1[k])
		}
	}
	ts := mapOr(p.r["timeSettings"])
	if ts == nil {
		ts = map[string]any{}
		p.r["timeSettings"] = ts
	}
	for _, k := range unionKeys(mapOr(p.c0["timeSettings"]), mapOr(p.c1["timeSettings"])) {
		p.set(ts, k, mapOr(p.c0["timeSettings"])[k], mapOr(p.c1["timeSettings"])[k])
	}
	p.elements()
	p.named("variables", func(v map[string]any) string { return str(mapOr(v["spec"]), "name") })
	p.named("annotations", func(a map[string]any) string { return str(mapOr(a["spec"]), "name") })
	p.layout()
}

// set writes key k of r where a and b differ: b's value, or no key.
func (p *v2patcher) set(r map[string]any, k string, a, b any) {
	if reflect.DeepEqual(a, b) {
		return
	}
	if b == nil {
		if _, ok := r[k]; ok {
			delete(r, k)
			p.changes++
		}
		return
	}
	r[k] = applyDiff(r[k], a, b)
	p.changes++
}

// applyDiff writes into r what changed from a to b: map keys and list items
// one by one where the shapes agree, b whole where they do not.
func applyDiff(r, a, b any) any {
	if reflect.DeepEqual(a, b) {
		return r
	}
	rm, rok := r.(map[string]any)
	am, aok := a.(map[string]any)
	bm, bok := b.(map[string]any)
	if rok && aok && bok {
		for _, k := range unionKeys(am, bm) {
			av, ina := am[k]
			bv, inb := bm[k]
			switch {
			case ina && inb && reflect.DeepEqual(av, bv):
			case !inb:
				delete(rm, k)
			case ina:
				rm[k] = applyDiff(rm[k], av, bv)
			default:
				rm[k] = deepCopy(bv)
			}
		}
		return rm
	}
	rl, rok := r.([]any)
	al, aok := a.([]any)
	bl, bok := b.([]any)
	if rok && aok && bok && len(rl) == len(al) && len(al) == len(bl) {
		for i := range rl {
			rl[i] = applyDiff(rl[i], al[i], bl[i])
		}
		return rl
	}
	return deepCopy(b)
}

func deepCopy(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = deepCopy(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = deepCopy(e)
		}
		return out
	}
	return v
}

func unionKeys(a, b map[string]any) []string {
	seen := map[string]bool{}
	for k := range a {
		seen[k] = true
	}
	for k := range b {
		seen[k] = true
	}
	return sortedSet(seen)
}

// ---- elements ----

// byID indexes elements by their panel id: id → element name.
func byID(elements map[string]any) map[string]string {
	out := map[string]string{}
	for name, e := range elements {
		if id := fmt.Sprint(mapOr(mapOr(e)["spec"])["id"]); id != "<nil>" {
			out[id] = name
		}
	}
	return out
}

func (p *v2patcher) elements() {
	e0, e1, er := mapOr(p.c0["elements"]), mapOr(p.c1["elements"]), mapOr(p.r["elements"])
	if er == nil {
		er = map[string]any{}
		p.r["elements"] = er
	}
	i0, i1, ir := byID(e0), byID(e1), byID(er)
	ids := map[string]bool{}
	for id := range i0 {
		ids[id] = true
	}
	for id := range i1 {
		ids[id] = true
	}
	for _, id := range sortedSet(ids) {
		n0, in0 := i0[id]
		n1, in1 := i1[id]
		nr, inr := ir[id]
		switch {
		case in0 && in1 && inr:
			a, b := e0[n0], e1[n1]
			if reflect.DeepEqual(a, b) {
				continue
			}
			if mapOr(a)["kind"] != mapOr(b)["kind"] {
				er[nr] = deepCopy(b)
			} else {
				er[nr] = applyDiff(er[nr], a, b)
			}
			p.changes++
		case in1 && !in0 && !inr:
			name := n1
			for k := 2; er[name] != nil; k++ {
				name = fmt.Sprintf("%s-%d", n1, k)
			}
			er[name] = deepCopy(e1[n1])
			p.place(name, n1)
			p.changes++
		case in0 && !in1 && inr:
			delete(er, nr)
			removeRefs(p.r["layout"], nr)
			p.changes++
		}
	}
}

// ---- variables and annotations ----

// v2Entry is one variable or annotation of the file: the list it is in and
// its place there.
type v2Entry struct {
	list *[]any
	i    int
}

func (p *v2patcher) named(key string, nameOf func(map[string]any) string) {
	keyed := func(list []any) (map[string]map[string]any, []string) {
		out, order, seen := map[string]map[string]any{}, []string{}, map[string]int{}
		for _, x := range anyMaps(list) {
			n := nameOf(x)
			k := fmt.Sprintf("%s\x00%d", n, seen[n])
			seen[n]++
			out[k], order = x, append(order, k)
		}
		return out, order
	}
	m0, _ := keyed(anyList(p.c0[key]))
	m1, order1 := keyed(anyList(p.c1[key]))
	top := anyList(p.r[key])
	lists := []*[]any{&top}
	var sections []map[string]any
	collectSections(p.r["layout"], &sections)
	sectionLists := make([][]any, len(sections))
	for i, sec := range sections {
		sectionLists[i] = anyList(sec[key])
		lists = append(lists, &sectionLists[i])
	}
	entries, seen := map[string]v2Entry{}, map[string]int{}
	for _, l := range lists {
		for i, x := range anyMaps(*l) {
			n := nameOf(x)
			entries[fmt.Sprintf("%s\x00%d", n, seen[n])] = v2Entry{l, i}
			seen[n]++
		}
	}
	var drop []v2Entry
	for _, k := range unionKeys(toAny(m0), toAny(m1)) {
		a, in0 := m0[k]
		b, in1 := m1[k]
		e, inr := entries[k]
		switch {
		case in0 && in1 && inr && !reflect.DeepEqual(a, b):
			(*e.list)[e.i] = applyDiff((*e.list)[e.i], a, b)
			p.changes++
		case in1 && !in0 && !inr:
			top = append(top, deepCopy(b))
			p.changes++
		case in0 && !in1 && inr:
			drop = append(drop, e)
			p.changes++
		}
	}
	sort.Slice(drop, func(i, j int) bool { return drop[i].i > drop[j].i })
	for _, e := range drop {
		*e.list = append((*e.list)[:e.i], (*e.list)[e.i+1:]...)
	}
	// the top-level order of the converted dashboard, for the entries it has
	rank := map[string]int{}
	for i, k := range order1 {
		rank[k] = i
	}
	type ranked struct {
		key string
		v   any
	}
	var keysTop []string
	seen = map[string]int{}
	for _, x := range anyMaps(top) {
		n := nameOf(x)
		keysTop = append(keysTop, fmt.Sprintf("%s\x00%d", n, seen[n]))
		seen[n]++
	}
	var slots []int
	var in []ranked
	for i, k := range keysTop {
		if _, ok := rank[k]; ok {
			slots = append(slots, i)
			in = append(in, ranked{k, top[i]})
		}
	}
	sorted := append([]ranked(nil), in...)
	sort.SliceStable(sorted, func(a, b int) bool { return rank[sorted[a].key] < rank[sorted[b].key] })
	for j, i := range slots {
		if sorted[j].key != in[j].key {
			top[i] = sorted[j].v
			p.changes++
		}
	}
	if len(top) > 0 || p.r[key] != nil {
		p.r[key] = nonNilAny(top)
	}
	for i, sec := range sections {
		if sec[key] != nil || len(sectionLists[i]) > 0 {
			sec[key] = nonNilAny(sectionLists[i])
		}
	}
}

func toAny[V any](m map[string]V) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// ---- layout ----

// v2Place is where a grid layout or auto grid item sits: its item and the
// row (title and number) of a rows layout, if any.
type v2Place struct {
	item     map[string]any
	row      string
	auto     bool
	rowIndex int
}

// places finds the item of each element in a layout tree.
func places(layout any) map[string]v2Place {
	out := map[string]v2Place{}
	var walk func(l map[string]any, row string, rowIndex int)
	walk = func(l map[string]any, row string, rowIndex int) {
		spec := mapOr(l["spec"])
		switch l["kind"] {
		case "GridLayout", "AutoGridLayout":
			for _, it := range anyMaps(spec["items"]) {
				name := str(mapOr(mapOr(it["spec"])["element"]), "name")
				out[name] = v2Place{item: it, row: row, rowIndex: rowIndex, auto: l["kind"] == "AutoGridLayout"}
			}
		case "RowsLayout":
			for i, r := range anyMaps(spec["rows"]) {
				rs := mapOr(r["spec"])
				walk(mapOr(rs["layout"]), str(rs, "title"), i)
			}
		case "TabsLayout":
			for _, t := range anyMaps(spec["tabs"]) {
				walk(mapOr(mapOr(t["spec"])["layout"]), row, rowIndex)
			}
		}
	}
	walk(mapOr(layout), "", -1)
	return out
}

var gridFields = []string{"x", "y", "width", "height"}

func (p *v2patcher) layout() {
	e0, e1, er := mapOr(p.c0["elements"]), mapOr(p.c1["elements"]), mapOr(p.r["elements"])
	i0, i1, ir := byID(e0), byID(e1), byID(er)
	p0, p1, pr := places(p.c0["layout"]), places(p.c1["layout"]), places(p.r["layout"])
	for _, id := range sortedSet(i0) {
		n1, in1 := i1[id]
		nr, inr := ir[id]
		if !in1 || !inr {
			continue
		}
		a, b, r := p0[i0[id]], p1[n1], pr[nr]
		if a.item == nil || b.item == nil || r.item == nil {
			continue
		}
		if a.row != b.row || a.rowIndex != b.rowIndex {
			p.rep.Adjusted = append(p.rep.Adjusted, Finding{Path: "spec.layout", Reason: fmt.Sprintf(
				"panel %s moved to another row: the v2 file keeps its own layout there", id)})
			continue
		}
		as, bs, rs := mapOr(a.item["spec"]), mapOr(b.item["spec"]), mapOr(r.item["spec"])
		for _, f := range gridFields {
			delta := num(bs[f]) - num(as[f])
			if delta == 0 {
				continue
			}
			if r.auto {
				p.rep.Adjusted = append(p.rep.Adjusted, Finding{Path: "spec.layout", Reason: fmt.Sprintf(
					"panel %s %s changed by %d: it sits in an auto grid, which places panels itself", id, f, delta)})
				continue
			}
			rs[f] = json.Number(fmt.Sprint(num(rs[f]) + delta))
			p.changes++
		}
		if !reflect.DeepEqual(as["repeat"], bs["repeat"]) {
			if bs["repeat"] == nil {
				delete(rs, "repeat")
			} else {
				rs["repeat"] = deepCopy(bs["repeat"])
			}
			p.changes++
		}
	}
	p.rows()
}

// rows writes row titles, collapse and repeat by number where the file has
// the same rows; any other change of the rows is reported.
func (p *v2patcher) rows() {
	l0, l1, lr := mapOr(p.c0["layout"]), mapOr(p.c1["layout"]), mapOr(p.r["layout"])
	r0, r1 := anyMaps(mapOr(l0["spec"])["rows"]), anyMaps(mapOr(l1["spec"])["rows"])
	if l0["kind"] != l1["kind"] || len(r0) != len(r1) {
		p.rep.Adjusted = append(p.rep.Adjusted, Finding{Path: "spec.layout", Reason: "rows added or removed: the v2 file keeps its own layout"})
		return
	}
	rr := anyMaps(mapOr(lr["spec"])["rows"])
	for i := range r0 {
		a, b := mapOr(r0[i]["spec"]), mapOr(r1[i]["spec"])
		for _, f := range []string{"title", "collapse", "repeat"} {
			if reflect.DeepEqual(a[f], b[f]) {
				continue
			}
			if lr["kind"] != "RowsLayout" || len(rr) != len(r0) {
				p.rep.Adjusted = append(p.rep.Adjusted, Finding{Path: "spec.layout", Reason: fmt.Sprintf(
					"row %d %s changed: the v2 file's layout has no such row", i+1, f)})
				continue
			}
			p.set(mapOr(rr[i]["spec"]), f, a[f], b[f])
		}
	}
}

// place puts a new element into the file's layout: into the grid of the row
// with the title it has in the converted dashboard, else the last container.
func (p *v2patcher) place(name, convName string) {
	src := places(p.c1["layout"])[convName]
	item := map[string]any{"kind": "GridLayoutItem", "spec": map[string]any{"x": json.Number("0"), "y": json.Number("0"),
		"width": json.Number("12"), "height": json.Number("8"), "element": map[string]any{"kind": "ElementReference", "name": name}}}
	if src.item != nil {
		item = deepCopy(src.item).(map[string]any)
		mapOr(mapOr(item["spec"])["element"])["name"] = name
	}
	target := lastGrid(mapOr(p.r["layout"]), src.row)
	if target == nil {
		p.r["layout"] = map[string]any{"kind": "GridLayout", "spec": map[string]any{"items": []any{item}}}
		return
	}
	spec := mapOr(target["spec"])
	if target["kind"] == "AutoGridLayout" {
		item = map[string]any{"kind": "AutoGridLayoutItem", "spec": map[string]any{"element": map[string]any{"kind": "ElementReference", "name": name}}}
	}
	spec["items"] = append(anyList(spec["items"]), item)
}

// lastGrid is the grid of the row titled row, else the last grid of the tree.
func lastGrid(l map[string]any, row string) map[string]any {
	spec := mapOr(l["spec"])
	switch l["kind"] {
	case "GridLayout", "AutoGridLayout":
		return l
	case "RowsLayout":
		rows := anyMaps(spec["rows"])
		for _, r := range rows {
			if rs := mapOr(r["spec"]); row != "" && str(rs, "title") == row {
				if g := lastGrid(mapOr(rs["layout"]), ""); g != nil {
					return g
				}
			}
		}
		for i := len(rows) - 1; i >= 0; i-- {
			if g := lastGrid(mapOr(mapOr(rows[i]["spec"])["layout"]), row); g != nil {
				return g
			}
		}
	case "TabsLayout":
		tabs := anyMaps(spec["tabs"])
		for i := len(tabs) - 1; i >= 0; i-- {
			if g := lastGrid(mapOr(mapOr(tabs[i]["spec"])["layout"]), row); g != nil {
				return g
			}
		}
	}
	return nil
}

// removeRefs takes the items of an element out of a layout tree.
func removeRefs(layout any, name string) {
	l := mapOr(layout)
	spec := mapOr(l["spec"])
	switch l["kind"] {
	case "GridLayout", "AutoGridLayout":
		var keep []any
		for _, it := range anyList(spec["items"]) {
			if str(mapOr(mapOr(mapOr(it)["spec"])["element"]), "name") != name {
				keep = append(keep, it)
			}
		}
		spec["items"] = nonNilAny(keep)
	case "RowsLayout":
		for _, r := range anyMaps(spec["rows"]) {
			removeRefs(mapOr(r["spec"])["layout"], name)
		}
	case "TabsLayout":
		for _, t := range anyMaps(spec["tabs"]) {
			removeRefs(mapOr(t["spec"])["layout"], name)
		}
	}
}

func num(v any) int64 {
	switch x := v.(type) {
	case json.Number:
		n, _ := x.Int64()
		return n
	case float64:
		return int64(x)
	}
	return 0
}
