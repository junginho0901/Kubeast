package grafana

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// Schema v2 (dashboard.grafana.app/v2 and v2beta1, Grafana 13's default
// export) is imported by turning it into the classic dashboard Grafana 13.3.0
// serves for it — rows, tabs and auto grids flattened as its v2 → v1
// conversion does — and reading that with the classic import. Every v2 key is
// either carried into a classic key, consumed by the conversion, or stashed
// whole under "v2:<path>" (kept in the dashboard's ext), and the report is
// translated back to the v2 file's paths.

// legacyStringKey holds a query Grafana kept as a plain string.
const legacyStringKey = "__legacyStringValue"

var v2VariableTypes = map[string]string{
	"QueryVariable": "query", "DatasourceVariable": "datasource", "CustomVariable": "custom",
	"ConstantVariable": "constant", "IntervalVariable": "interval", "TextVariable": "textbox",
	"GroupByVariable": "groupby", "AdhocVariable": "adhoc", "SwitchVariable": "switch",
}

var (
	v2Hide    = map[string]int{"dontHide": 0, "hideLabel": 1, "hideVariable": 2, "inControlsMenu": 3}
	v2Refresh = map[string]int{"never": 0, "onDashboardLoad": 1, "onTimeRangeChanged": 2}
	v2Sort    = map[string]int{"disabled": 0, "alphabeticalAsc": 1, "alphabeticalDesc": 2, "numericalAsc": 3, "numericalDesc": 4,
		"alphabeticalCaseInsensitiveAsc": 5, "alphabeticalCaseInsensitiveDesc": 6, "naturalAsc": 7, "naturalDesc": 8}
	v2CursorSync = map[string]int{"Off": 0, "Crosshair": 1, "Tooltip": 2}
	// annotation legacy options that do not override the annotation's own keys
	v2AnnotationReserved = keys("name", "enable", "hide", "iconColor", "datasource", "target", "filter", "builtIn", "placement", "mappings")
	// v2-only section settings: kept, but nothing in the model applies them
	v2SectionOnly = map[string]string{
		"conditionalRendering": "conditional rendering", "variables": "section variables", "annotations": "section annotations",
	}
)

type pathAlias struct{ from, to string }

// cpanel is one classic panel being built, with what it came from.
type cpanel struct {
	m        map[string]any
	children []*cpanel
	row      bool
	src      string // row or tab path, for a row
	elem     string // element path, for a panel
	item     string // layout item path, for a panel
	grid     bool   // the item had x, y, width and height
	queries  []bool // per query: its spec held a legacy string
	trans    []bool // per transformation: its id came from the v2 group
	header   obj    // a row's own keys, stashed if the row is folded away
}

type v2conv struct {
	beta     bool
	elements map[string]obj
	used     map[string]bool
	aliased  map[string]bool
	nextRow  int
	root     map[string]any
	own      map[string]string
	alias    []pathAlias
	adjusted []Finding
	unsupp   []Finding
}

func (c *v2conv) mark(path, how string) { c.own[path] = how }
func (c *v2conv) to(from, to string)    { c.alias = append(c.alias, pathAlias{from, to}) }
func (c *v2conv) adjust(path, why string) {
	c.adjusted = append(c.adjusted, Finding{Path: path, Reason: why})
}
func (c *v2conv) unsupport(path, why string) {
	c.unsupp = append(c.unsupp, Finding{Path: path, Reason: why})
}

// stash keeps a v2 value the classic dashboard has no place for.
func (c *v2conv) stash(path string, raw json.RawMessage) {
	key := "v2:" + path
	c.root[key] = raw
	c.to(path, key)
}

func (c *v2conv) markWrappers(path string, ks ...string) {
	for _, k := range ks {
		c.mark(path+"."+k, "mapped")
	}
}

// importV2 imports a v2 or v2beta1 dashboard resource.
func importV2(envelope obj, raw []byte, beta bool) (*model.Dashboard, *Report, error) {
	spec, ok := asObj(envelope["spec"])
	if !ok {
		return nil, nil, ErrNoPanels
	}
	c := newV2conv(beta)
	classic := c.dashboard(spec)
	for k := range envelope {
		if k != "spec" {
			c.mark(k, "dropped")
		}
	}
	c.mark("spec", "mapped")

	var root obj
	b, err := json.Marshal(classic)
	if err != nil || json.Unmarshal(b, &root) != nil {
		return nil, nil, ErrNotJSON
	}
	im := &importer{rep: &Report{accounted: map[string]string{}}, dsVars: map[string]string{}, names: map[string]bool{}}
	d := im.dashboard(root)

	rep := &Report{Panels: im.rep.Panels, accounted: c.own, alias: c.alias, classic: im.rep.accounted}
	for _, p := range im.rep.Preserved {
		rep.Preserved = append(rep.Preserved, rep.fromClassicAll(p)...)
	}
	for k := range envelope {
		if k != "spec" {
			rep.Dropped = append(rep.Dropped, k)
		}
	}
	for _, p := range im.rep.Dropped {
		rep.Dropped = append(rep.Dropped, rep.fromClassic(p))
	}
	rep.Adjusted = append(c.adjusted, translate(rep, im.rep.Adjusted)...)
	rep.Unsupported = append(c.unsupp, translate(rep, im.rep.Unsupported)...)
	sort.Strings(rep.Preserved)
	sort.Strings(rep.Dropped)

	var meta obj
	_ = json.Unmarshal(envelope["metadata"], &meta)
	var compact bytes.Buffer
	if json.Compact(&compact, raw) == nil {
		raw = compact.Bytes()
	}
	d.Source = &model.Source{Kind: model.SourceGrafanaV2, UID: strOf(meta["name"]), Raw: json.RawMessage(raw)}
	return d, rep, nil
}

func newV2conv(beta bool) *v2conv {
	return &v2conv{beta: beta, elements: map[string]obj{}, used: map[string]bool{}, aliased: map[string]bool{},
		root: map[string]any{}, own: map[string]string{}}
}

func translate(r *Report, fs []Finding) []Finding {
	out := make([]Finding, 0, len(fs))
	for _, f := range fs {
		for _, p := range r.fromClassicAll(f.Path) {
			out = append(out, Finding{Path: p, Reason: f.Reason})
		}
	}
	return out
}

// dashboard builds the classic dashboard of a v2 spec.
func (c *v2conv) dashboard(spec obj) map[string]any {
	for k, raw := range spec {
		p := "spec." + k
		switch k {
		case "title", "description", "tags", "editable", "liveNow", "revision", "preload", "links":
			c.root[k] = raw
			c.to(p, k)
		case "cursorSync":
			c.root["graphTooltip"] = v2CursorSync[strOf(raw)]
			c.mark(p, "mapped")
			c.to(p, "graphTooltip")
		case "timeSettings":
			c.timeSettings(raw)
		case "variables":
			c.variables(raw)
		case "annotations":
			c.annotations(raw)
		case "elements", "layout":
			c.mark(p, "mapped")
		default:
			c.stash(p, raw)
		}
	}
	if _, ok := c.root["annotations"]; !ok {
		c.root["annotations"] = map[string]any{"list": []any{}}
	}

	elements, _ := asObj(spec["elements"])
	maxID := 0
	for name, raw := range elements {
		if e, ok := asObj(raw); ok {
			c.elements[name] = e
			if s, ok := asObj(e["spec"]); ok && intOf(s["id"]) > maxID {
				maxID = intOf(s["id"])
			}
		}
	}
	c.nextRow = maxID + 1

	var panels []*cpanel
	if layout, ok := asObj(spec["layout"]); ok {
		panels = c.layoutTop(layout, "spec.layout")
	}
	list := make([]any, 0, len(panels))
	for i, p := range panels {
		path := fmt.Sprintf("panels[%d]", i)
		c.register(p, path)
		if len(p.children) > 0 {
			kids := make([]any, 0, len(p.children))
			for j, ch := range p.children {
				c.register(ch, fmt.Sprintf("%s.panels[%d]", path, j))
				kids = append(kids, ch.m)
			}
			p.m["panels"] = kids
		}
		list = append(list, p.m)
	}
	c.root["panels"] = list

	names := make([]string, 0, len(elements))
	for name := range elements {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !c.used[name] {
			p := "spec.elements." + name
			c.stash(p, elements[name])
			c.unsupport(p, "element not placed in the layout: kept, not shown (Grafana does not show it either)")
		}
	}
	return c.root
}

func (c *v2conv) timeSettings(raw json.RawMessage) {
	c.mark("spec.timeSettings", "mapped")
	ts, _ := asObj(raw)
	time := map[string]any{"from": "now-6h", "to": "now"}
	picker := map[string]any{}
	for k, v := range ts {
		p := "spec.timeSettings." + k
		switch k {
		case "from", "to":
			if strOf(v) != "" {
				time[k] = v
			}
			c.mark(p, "mapped")
			c.to(p, "time."+k)
		case "timezone":
			c.root["timezone"] = v
			c.to(p, "timezone")
		case "autoRefresh":
			c.root["refresh"] = v
			c.to(p, "refresh")
		case "fiscalYearStartMonth", "weekStart":
			c.root[k] = v
			c.to(p, k)
		case "autoRefreshIntervals":
			picker["refresh_intervals"] = v
			c.to(p, "timepicker.refresh_intervals")
		case "hideTimepicker":
			if boolOf(v) {
				picker["hidden"] = v
			}
			c.mark(p, "mapped")
			c.to(p, "timepicker.hidden")
		case "nowDelay":
			picker["nowDelay"] = v
			c.to(p, "timepicker.nowDelay")
		case "quickRanges":
			picker["quick_ranges"] = v
			c.to(p, "timepicker.quick_ranges")
		default:
			c.stash(p, v)
		}
	}
	c.root["time"] = time
	if len(picker) > 0 {
		c.root["timepicker"] = picker
	}
}

// dsRef is the classic data source of a v2 query: its group is the data
// source type and its datasource.name the uid.
func dsRef(group, name string) map[string]any {
	switch {
	case name != "":
		m := map[string]any{"uid": name}
		if group != "" {
			m["type"] = group
		}
		return m
	case group != "":
		return map[string]any{"type": group}
	}
	return nil
}

// dataQuery reads a DataQuery's wrapper keys and returns its group and data
// source name; its spec is left to the caller.
func (c *v2conv) dataQuery(q obj, p string) (group, name string) {
	for k, v := range q {
		switch k {
		case "kind", "version", "group":
			c.mark(p+"."+k, "mapped")
		case "datasource":
			c.mark(p+".datasource", "mapped")
			ds, _ := asObj(v)
			for dk, dv := range ds {
				if dk == "name" {
					c.mark(p+".datasource.name", "mapped")
				} else {
					c.stash(p+".datasource."+dk, dv)
				}
			}
			name = strOf(ds["name"])
		case "spec":
			c.mark(p+".spec", "mapped")
		default:
			c.stash(p+"."+k, v)
		}
	}
	return strOf(q["group"]), name
}

func (c *v2conv) variables(raw json.RawMessage) {
	c.mark("spec.variables", "mapped")
	var list []json.RawMessage
	_ = json.Unmarshal(raw, &list)
	out := []any{}
	for i, item := range list {
		p := fmt.Sprintf("spec.variables[%d]", i)
		v, _ := asObj(item)
		kind := strOf(v["kind"])
		typ := v2VariableTypes[kind]
		if typ == "" {
			c.stash(p, item)
			c.unsupport(p, fmt.Sprintf("variable kind %q is kept but not read", kind))
			continue
		}
		cp := fmt.Sprintf("templating.list[%d]", len(out))
		m := map[string]any{"type": typ}
		c.mark(p+".kind", "mapped")
		c.to(p+".kind", cp+".type")
		c.mark(p+".spec", "mapped")
		c.to(p+".spec", cp)
		var group, dsName string
		for k, x := range v {
			switch k {
			case "kind", "spec":
			case "group":
				group = strOf(x)
				c.mark(p+".group", "mapped")
			case "datasource":
				c.mark(p+".datasource", "mapped")
				ds, _ := asObj(x)
				for dk, dv := range ds {
					if dk == "name" {
						c.mark(p+".datasource.name", "mapped")
					} else {
						c.stash(p+".datasource."+dk, dv)
					}
				}
				dsName = strOf(ds["name"])
			default:
				c.stash(p+"."+k, x)
			}
		}
		if ds := dsRef(group, dsName); ds != nil {
			m["datasource"] = ds
		}
		spec, _ := asObj(v["spec"])
		for k, x := range spec {
			sp := p + ".spec." + k
			switch {
			case k == "hide":
				h := v2Hide[strOf(x)]
				if kind == "ConstantVariable" {
					h = 2 // Grafana hides a constant in v1
				}
				m["hide"] = h
				c.mark(sp, "mapped")
				c.to(sp, cp+".hide")
			case k == "refresh":
				// An interval variable's only refresh is onTimeRangeChanged, which
				// Grafana's conversion leaves out.
				if kind != "IntervalVariable" {
					m["refresh"] = v2Refresh[strOf(x)]
				}
				c.mark(sp, "mapped")
				c.to(sp, cp+".refresh")
			case k == "sort":
				m["sort"] = v2Sort[strOf(x)]
				c.mark(sp, "mapped")
				c.to(sp, cp+".sort")
			case k == "query" && kind == "QueryVariable":
				q, _ := asObj(x)
				c.mark(sp, "mapped")
				g, n := c.dataQuery(q, sp)
				if ds := dsRef(g, n); ds != nil {
					m["datasource"] = ds
				}
				qs, _ := asObj(q["spec"])
				if legacy, ok := qs[legacyStringKey]; ok && strOf(legacy) != "" {
					m["query"] = legacy
					c.mark(sp+".spec", "mapped")
					c.to(sp+".spec."+legacyStringKey, cp+".query")
					for qk, qv := range qs {
						if qk != legacyStringKey {
							c.stash(sp+".spec."+qk, qv)
						}
					}
				} else {
					m["query"] = q["spec"]
					c.to(sp+".spec", cp+".query")
				}
			case k == "pluginId":
				m["query"] = x
				c.to(sp, cp+".query")
			case kind == "SwitchVariable" && k == "current":
				m["current"] = map[string]any{"text": x, "value": x}
				c.mark(sp, "mapped")
				c.to(sp, cp+".current")
			case kind == "SwitchVariable" && (k == "enabledValue" || k == "disabledValue"):
				c.mark(sp, "mapped")
				c.to(sp, cp+".options")
			default:
				m[k] = x
				c.to(sp, cp+"."+k)
			}
		}
		if kind == "SwitchVariable" {
			cur, on, off := strOf(spec["current"]), strOf(spec["enabledValue"]), strOf(spec["disabledValue"])
			m["query"] = ""
			m["options"] = []any{
				map[string]any{"text": on, "value": on, "selected": cur == on},
				map[string]any{"text": off, "value": off, "selected": cur == off},
			}
		}
		out = append(out, m)
	}
	if len(out) > 0 {
		c.root["templating"] = map[string]any{"list": out}
	}
}

func (c *v2conv) annotations(raw json.RawMessage) {
	c.mark("spec.annotations", "mapped")
	var list []json.RawMessage
	_ = json.Unmarshal(raw, &list)
	out := []any{}
	for i, item := range list {
		p := fmt.Sprintf("spec.annotations[%d]", i)
		a, _ := asObj(item)
		cp := fmt.Sprintf("annotations.list[%d]", len(out))
		for k, x := range a {
			if k != "kind" && k != "spec" {
				c.stash(p+"."+k, x)
			}
		}
		c.mark(p+".kind", "mapped")
		c.mark(p+".spec", "mapped")
		c.to(p+".spec", cp)
		spec, _ := asObj(a["spec"])
		m := map[string]any{}
		for k, x := range spec {
			sp := p + ".spec." + k
			switch k {
			case "builtIn":
				if boolOf(x) {
					m["builtIn"] = 1
					m["type"] = "dashboard"
				}
				c.mark(sp, "mapped")
				c.to(sp, cp+".builtIn")
			case "query":
				q, _ := asObj(x)
				c.mark(sp, "mapped")
				g, n := c.dataQuery(q, sp)
				if ds := dsRef(g, n); ds != nil {
					m["datasource"] = ds
				}
				if qs, _ := asObj(q["spec"]); len(qs) > 0 {
					m["target"] = q["spec"]
					c.to(sp+".spec", cp+".target")
				} else {
					c.mark(sp+".spec", "mapped")
				}
			case "legacyOptions":
			default:
				m[k] = x
				c.to(sp, cp+"."+k)
			}
		}
		if lo, ok := asObj(spec["legacyOptions"]); ok {
			lp := p + ".spec.legacyOptions"
			c.mark(lp, "mapped")
			for k, x := range lo {
				if v2AnnotationReserved[k] {
					c.stash(lp+"."+k, x)
					continue
				}
				m[k] = x
				c.to(lp+"."+k, cp+"."+k)
			}
		} else if _, ok := spec["legacyOptions"]; ok {
			c.stash(p+".spec.legacyOptions", spec["legacyOptions"])
		}
		out = append(out, m)
	}
	c.root["annotations"] = map[string]any{"list": out}
}

// ---- layout ----

func gridPos(x, y, w, h int) map[string]any { return map[string]any{"x": x, "y": y, "w": w, "h": h} }

// layoutKind reads a layout's kind and spec wrappers.
func (c *v2conv) layoutKind(l obj, path string) (string, obj) {
	c.mark(path, "mapped")
	for k, v := range l {
		switch k {
		case "kind", "spec":
			c.mark(path+"."+k, "mapped")
		default:
			c.stash(path+"."+k, v)
		}
	}
	spec, _ := asObj(l["spec"])
	return strOf(l["kind"]), spec
}

// layoutSpec stashes a layout spec's keys other than its list (and, for an auto
// grid, the settings the conversion reads).
func (c *v2conv) layoutSpec(spec obj, sp string, read ...string) {
	known := keys(read...)
	for k, v := range spec {
		if known[k] {
			c.mark(sp+"."+k, "mapped")
		} else {
			c.stash(sp+"."+k, v)
		}
	}
}

func (c *v2conv) layoutTop(l obj, path string) []*cpanel {
	kind, spec := c.layoutKind(l, path)
	sp := path + ".spec"
	switch kind {
	case "GridLayout":
		ps, _ := c.gridItems(spec, sp, 0)
		return ps
	case "RowsLayout":
		ps, _ := c.rowsLayout(spec, sp, 0)
		return ps
	case "AutoGridLayout":
		return c.autoGrid(spec, sp, 0)
	case "TabsLayout":
		ps, _ := c.tabsLayout(spec, sp, 0)
		return ps
	}
	c.stash(sp, l["spec"])
	c.unsupport(path, fmt.Sprintf("layout %q is kept but not placed", kind))
	return nil
}

func objList(raw json.RawMessage) []obj {
	var list []json.RawMessage
	_ = json.Unmarshal(raw, &list)
	out := make([]obj, 0, len(list))
	for _, r := range list {
		o, _ := asObj(r)
		out = append(out, o)
	}
	return out
}

// gridItems places a grid's items, their y moved down by offset; end is the
// lowest edge, counted from 0 as Grafana does.
func (c *v2conv) gridItems(spec obj, sp string, offset int) (ps []*cpanel, end int) {
	c.layoutSpec(spec, sp, "items")
	for n, it := range objList(spec["items"]) {
		ip := fmt.Sprintf("%s.items[%d]", sp, n)
		p, bottom := c.gridItem(it, ip, offset)
		if p != nil {
			ps = append(ps, p)
		}
		if bottom > end {
			end = bottom
		}
	}
	return ps, end
}

func (c *v2conv) elementRef(s obj, ip string) string {
	c.mark(ip+".spec.element", "mapped")
	e, _ := asObj(s["element"])
	for k, v := range e {
		if k == "kind" || k == "name" {
			c.mark(ip+".spec.element."+k, "mapped")
		} else {
			c.stash(ip+".spec.element."+k, v)
		}
	}
	return strOf(e["name"])
}

func (c *v2conv) itemWrapper(it obj, ip string) obj {
	for k, v := range it {
		switch k {
		case "kind", "spec":
			c.mark(ip+"."+k, "mapped")
		default:
			c.stash(ip+"."+k, v)
		}
	}
	s, _ := asObj(it["spec"])
	return s
}

func (c *v2conv) gridItem(it obj, ip string, offset int) (*cpanel, int) {
	s := c.itemWrapper(it, ip)
	name := c.elementRef(s, ip)
	x, y, w, h := intOf(s["x"]), intOf(s["y"])+offset, intOf(s["width"]), intOf(s["height"])
	extra := map[string]any{}
	for k, v := range s {
		switch k {
		case "element":
		case "x", "y", "width", "height":
			c.mark(ip+".spec."+k, "mapped")
		case "repeat":
			c.mark(ip+".spec.repeat", "mapped")
			r, _ := asObj(v)
			for rk, rv := range r {
				switch rk {
				case "mode":
					c.mark(ip+".spec.repeat.mode", "mapped")
				case "value":
					extra["repeat"] = rv
				case "direction":
					extra["repeatDirection"] = rv
				case "maxPerRow":
					extra["maxPerRow"] = rv
				default:
					c.stash(ip+".spec.repeat."+rk, rv)
				}
			}
		default:
			extra[k] = v
		}
	}
	p := c.panelFor(name, ip, x, y, w, h, extra)
	if p != nil {
		p.grid = true
	}
	return p, y + h
}

// autoGrid places an auto grid's items on fixed cells as Grafana converts it:
// width 24 / maxColumnCount (default 3, rounded down), height by rowHeightMode
// (short 5, standard 9, tall 14, custom = rowHeight px in 38 px rows), filled
// left to right.
func (c *v2conv) autoGrid(spec obj, sp string, offset int) []*cpanel {
	c.layoutSpec(spec, sp, "items", "maxColumnCount", "rowHeightMode", "rowHeight")
	cols := 3.0
	var mc float64
	if json.Unmarshal(spec["maxColumnCount"], &mc) == nil && mc > 0 {
		cols = mc
	}
	width := int(24 / cols)
	height := 9
	switch strOf(spec["rowHeightMode"]) {
	case "short":
		height = 5
	case "tall":
		height = 14
	case "custom":
		var px float64
		if json.Unmarshal(spec["rowHeight"], &px) == nil && px > 0 {
			height = int(math.Ceil(px / 38))
		}
	}
	c.adjust(sp, fmt.Sprintf("auto grid placed on fixed cells as Grafana converts it: width %d, height %d", width, height))
	var ps []*cpanel
	x, y := 0, offset
	for n, it := range objList(spec["items"]) {
		ip := fmt.Sprintf("%s.items[%d]", sp, n)
		s := c.itemWrapper(it, ip)
		name := c.elementRef(s, ip)
		extra := map[string]any{}
		for k, v := range s {
			switch k {
			case "element":
			case "repeat":
				c.mark(ip+".spec.repeat", "mapped")
				r, _ := asObj(v)
				for rk, rv := range r {
					switch rk {
					case "mode":
						c.mark(ip+".spec.repeat.mode", "mapped")
					case "value":
						extra["repeat"] = rv
						extra["repeatDirection"] = "h"
						extra["maxPerRow"] = int(cols)
					default:
						c.stash(ip+".spec.repeat."+rk, rv)
					}
				}
			default:
				extra[k] = v
				if what, ok := v2SectionOnly[k]; ok {
					c.unsupport(ip+".spec."+k, what+" is kept but not applied")
				}
			}
		}
		if p := c.panelFor(name, ip, x, y, width, height, extra); p != nil {
			ps = append(ps, p)
		}
		x += width
		if x >= 24 {
			x, y = 0, y+height
		}
	}
	return ps
}

// bottomOf is the lowest edge of the top-level panels, or cur.
func bottomOf(ps []*cpanel, cur int) int {
	end := cur
	for _, p := range ps {
		if g, ok := p.m["gridPos"].(map[string]any); ok {
			if b := g["y"].(int) + g["h"].(int); b > end {
				end = b
			}
		}
	}
	return end
}

func (c *v2conv) newRow(src string, y int, header obj, withGrid bool) *cpanel {
	m := map[string]any{"type": "row", "id": c.nextRow}
	c.nextRow++
	if withGrid {
		m["gridPos"] = gridPos(0, y, 24, 1)
	}
	return &cpanel{m: m, row: true, src: src, header: header}
}

// section reads a row's or tab's own keys: title, repeat and the v2-only
// settings, which go on the classic row (kept in its ext) or, if the row is
// not drawn, are stashed.
func (c *v2conv) section(s obj, sp string, drawn bool, own ...string) (title json.RawMessage, repeat json.RawMessage, extra map[string]any) {
	known := keys(own...)
	extra = map[string]any{}
	for k, v := range s {
		switch {
		case k == "layout" || known[k]:
		case k == "title":
			title = v
			if !drawn {
				c.stash(sp+".title", v)
			}
		case k == "repeat":
			c.mark(sp+".repeat", "mapped")
			r, _ := asObj(v)
			for rk, rv := range r {
				switch rk {
				case "mode":
					c.mark(sp+".repeat.mode", "mapped")
				case "value":
					repeat = rv
					if !drawn {
						c.stash(sp+".repeat.value", rv)
					}
				default:
					c.stash(sp+".repeat."+rk, rv)
				}
			}
		default:
			if what, ok := v2SectionOnly[k]; ok {
				c.unsupport(sp+"."+k, what+" is kept but not applied")
			}
			if drawn {
				extra[k] = v
			} else {
				c.stash(sp+"."+k, v)
			}
		}
	}
	return title, repeat, extra
}

func (c *v2conv) rowsLayout(spec obj, sp string, startY int) ([]*cpanel, int) {
	c.layoutSpec(spec, sp, "rows")
	var ps []*cpanel
	cur := startY
	for r, row := range objList(spec["rows"]) {
		got, next := c.rowItem(row, fmt.Sprintf("%s.rows[%d]", sp, r), cur)
		ps = append(ps, got...)
		cur = next
	}
	return ps, cur
}

func (c *v2conv) rowItem(row obj, rp string, startY int) ([]*cpanel, int) {
	s := c.itemWrapper(row, rp)
	sp := rp + ".spec"
	hidden, collapsed := boolOf(s["hideHeader"]), boolOf(s["collapse"])
	c.mark(sp+".hideHeader", "mapped")
	c.mark(sp+".collapse", "mapped")
	title, repeat, extra := c.section(s, sp, !hidden, "hideHeader", "collapse")
	lay, _ := asObj(s["layout"])
	lp := sp + ".layout"
	kind, lspec := c.layoutKind(lay, lp)
	header := obj{}
	for _, k := range []string{"title", "collapse", "hideHeader", "repeat"} {
		if v, ok := s[k]; ok {
			header[k] = v
		}
	}
	for k, v := range extra {
		header[k] = mustJSON(v)
	}
	var ps []*cpanel
	cur := startY
	row1 := func(withGrid bool) *cpanel {
		p := c.newRow(rp, cur, header, withGrid)
		if title != nil {
			p.m["title"] = title
		}
		for k, v := range extra {
			p.m[k] = v
		}
		return p
	}
	switch kind {
	case "RowsLayout":
		if !hidden {
			p := row1(true)
			if strOf(repeat) != "" {
				p.m["repeat"] = repeat
			}
			p.m["collapsed"] = false
			ps = append(ps, p)
			cur++
		}
		nested, _ := c.rowsLayout(lspec, lp+".spec", cur)
		if strOf(repeat) != "" && !hidden {
			// A repeated row repeats only its own panels in v1, so Grafana moves the
			// nested rows' panels up into it and leaves their headers out.
			c.adjust(rp, "rows inside a repeated row are folded into it, as Grafana converts it; their headers are kept")
			for _, n := range nested {
				if n.row {
					c.foldRow(n)
					ps = append(ps, n.children...)
					continue
				}
				ps = append(ps, n)
			}
		} else {
			ps = append(ps, nested...)
		}
		return ps, bottomOf(nested, cur)
	case "TabsLayout":
		if !hidden {
			p := row1(true)
			if repeat != nil {
				c.stash(sp+".repeat.value", repeat)
				c.adjust(sp+".repeat", "repeat on a row holding tabs is kept but not applied, as Grafana converts it")
			}
			p.m["collapsed"] = false
			ps = append(ps, p)
			cur++
		}
		nested, _ := c.tabsLayout(lspec, lp+".spec", cur)
		return append(ps, nested...), bottomOf(nested, cur)
	case "GridLayout", "AutoGridLayout":
	default:
		if !hidden {
			ps = append(ps, row1(true))
			cur++
		}
		c.stash(lp+".spec", lay["spec"])
		c.unsupport(lp, fmt.Sprintf("layout %q is kept but not placed", kind))
		return ps, cur
	}
	if !hidden {
		content := kind == "AutoGridLayout" || (kind == "GridLayout" && len(objList(lspec["items"])) > 0)
		p := row1(content || collapsed)
		if _, ok := s["collapse"]; ok {
			p.m["collapsed"] = collapsed
		}
		if strOf(repeat) != "" {
			p.m["repeat"] = repeat
		}
		if collapsed {
			p.children = c.folded(kind, lspec, lp+".spec", cur+1)
		}
		ps = append(ps, p)
		cur++
	} else {
		c.adjust(sp+".hideHeader", "row without a header: its panels are placed at the top level, as Grafana converts it")
	}
	if !collapsed || hidden {
		got, end := c.expanded(kind, lspec, lp+".spec", cur, hidden, startY)
		ps = append(ps, got...)
		cur = end
	}
	return ps, cur
}

// foldRow stashes the header of a row that is folded into its parent.
func (c *v2conv) foldRow(p *cpanel) {
	for k, v := range p.header {
		c.stash(p.src+".spec."+k, v)
	}
}

// expanded places an expanded or header-less row's grid. A header-less row's
// grid keeps its own y, and the next row starts at its lowest edge — both as
// Grafana converts it.
func (c *v2conv) expanded(kind string, spec obj, sp string, cur int, hidden bool, startY int) ([]*cpanel, int) {
	switch kind {
	case "GridLayout":
		off := cur
		if hidden {
			off = 0
		}
		return c.gridItems(spec, sp, off)
	case "AutoGridLayout":
		off := cur
		if hidden {
			off = startY
		}
		ps := c.autoGrid(spec, sp, off)
		return ps, bottomOf(ps, off)
	}
	return nil, startY
}

// folded is the panels of a collapsed row, kept inside it at absolute y;
// nested rows and tabs lose their headers there, as Grafana converts it.
func (c *v2conv) folded(kind string, spec obj, sp string, baseY int) []*cpanel {
	switch kind {
	case "GridLayout":
		ps, _ := c.gridItems(spec, sp, baseY)
		return ps
	case "AutoGridLayout":
		return c.autoGrid(spec, sp, baseY)
	case "RowsLayout", "TabsLayout":
		list := "rows"
		if kind == "TabsLayout" {
			list = "tabs"
		}
		c.layoutSpec(spec, sp, list)
		var ps []*cpanel
		cur := baseY
		for i, sec := range objList(spec[list]) {
			secPath := fmt.Sprintf("%s.%s[%d]", sp, list, i)
			s := c.itemWrapper(sec, secPath)
			_, _, _ = c.section(s, secPath+".spec", false)
			c.adjust(secPath, "section inside a collapsed row: its panels stay in the row, its header is kept")
			lay, _ := asObj(s["layout"])
			lk, ls := c.layoutKind(lay, secPath+".spec.layout")
			ps = append(ps, c.folded(lk, ls, secPath+".spec.layout.spec", cur)...)
			cur += sectionHeight(lk, ls, kind == "TabsLayout")
		}
		return ps
	}
	return nil
}

// sectionHeight is the height Grafana counts for a folded section: a grid's
// lowest edge; in a tab, an auto grid's rows of 9.
func sectionHeight(kind string, spec obj, tab bool) int {
	switch {
	case kind == "GridLayout":
		end := 0
		for _, it := range objList(spec["items"]) {
			s, _ := asObj(it["spec"])
			if b := intOf(s["y"]) + intOf(s["height"]); b > end {
				end = b
			}
		}
		return end
	case kind == "AutoGridLayout" && tab:
		cols := 3
		if n := intOf(spec["maxColumnCount"]); n > 0 {
			cols = n
		}
		items := len(objList(spec["items"]))
		return (items + cols - 1) / cols * 9
	}
	return 0
}

func (c *v2conv) tabsLayout(spec obj, sp string, startY int) ([]*cpanel, int) {
	c.layoutSpec(spec, sp, "tabs")
	var ps []*cpanel
	cur := startY
	for t, tab := range objList(spec["tabs"]) {
		got, next := c.tabItem(tab, fmt.Sprintf("%s.tabs[%d]", sp, t), cur)
		ps = append(ps, got...)
		cur = next
	}
	return ps, cur
}

func (c *v2conv) tabItem(tab obj, tp string, startY int) ([]*cpanel, int) {
	s := c.itemWrapper(tab, tp)
	sp := tp + ".spec"
	title, repeat, extra := c.section(s, sp, true)
	header := obj{}
	for _, k := range []string{"title", "repeat"} {
		if v, ok := s[k]; ok {
			header[k] = v
		}
	}
	p := c.newRow(tp, startY, header, true)
	p.m["collapsed"] = false
	if title != nil {
		p.m["title"] = title
	}
	if strOf(repeat) != "" {
		p.m["repeat"] = repeat
	}
	for k, v := range extra {
		p.m[k] = v
	}
	c.adjust(tp, "tab shown as an expanded row: the model has no tabs yet, and Grafana converts tabs the same way")
	ps := []*cpanel{p}
	cur := startY + 1
	lay, _ := asObj(s["layout"])
	lp := sp + ".layout"
	kind, lspec := c.layoutKind(lay, lp)
	switch kind {
	case "RowsLayout":
		nested, _ := c.rowsLayout(lspec, lp+".spec", cur)
		return append(ps, nested...), bottomOf(nested, cur)
	case "TabsLayout":
		nested, _ := c.tabsLayout(lspec, lp+".spec", cur)
		return append(ps, nested...), bottomOf(nested, cur)
	case "GridLayout":
		got, end := c.gridItems(lspec, lp+".spec", cur)
		if end < cur {
			end = cur
		}
		return append(ps, got...), end
	case "AutoGridLayout":
		got := c.autoGrid(lspec, lp+".spec", cur)
		return append(ps, got...), bottomOf(got, cur)
	}
	c.stash(lp+".spec", lay["spec"])
	c.unsupport(lp, fmt.Sprintf("layout %q is kept but not placed", kind))
	return ps, cur
}

// ---- elements ----

// panelFor builds the classic panel of an element placed by a layout item.
func (c *v2conv) panelFor(name, ip string, x, y, w, h int, extra map[string]any) *cpanel {
	el, ok := c.elements[name]
	if !ok {
		c.unsupport(ip+".spec.element.name", fmt.Sprintf("names no element (%q); nothing placed", name))
		return nil
	}
	ep := "spec.elements." + name
	p := &cpanel{m: map[string]any{"gridPos": gridPos(x, y, w, h)}, elem: ep, item: ip}
	for k, v := range extra {
		p.m[k] = v
	}
	if c.used[name] {
		return c.fill(p, el, ep, name, false)
	}
	c.used[name] = true
	return c.fill(p, el, ep, name, true)
}

func (c *v2conv) fill(p *cpanel, el obj, ep, name string, first bool) *cpanel {
	if first {
		c.mark(ep, "mapped")
		for k, v := range el {
			switch k {
			case "kind", "spec":
				c.mark(ep+"."+k, "mapped")
			default:
				c.stash(ep+"."+k, v)
			}
		}
	}
	spec, _ := asObj(el["spec"])
	switch strOf(el["kind"]) {
	case "Panel":
		for k, v := range spec {
			switch k {
			case "data":
				c.data(v, ep+".spec.data", p, first)
			case "vizConfig":
				c.vizConfig(v, ep+".spec.vizConfig", p, first)
			default:
				p.m[k] = v
			}
		}
	case "LibraryPanel":
		// No type: the classic import then reports it as a library panel to inline.
		for k, v := range spec {
			p.m[k] = v
		}
	default:
		if first {
			c.stash(ep+".spec", el["spec"])
			c.unsupport(ep, fmt.Sprintf("element kind %q is kept but not drawn", strOf(el["kind"])))
		}
		p.m["type"] = model.Unsupported
	}
	if want := fmt.Sprintf("panel-%d", intOf(spec["id"])); name != want {
		p.m["v2Element"] = name
	}
	return p
}

func (c *v2conv) data(raw json.RawMessage, dp string, p *cpanel, first bool) {
	d, _ := asObj(raw)
	if first {
		c.mark(dp, "mapped")
		for k, v := range d {
			switch k {
			case "kind", "spec":
				c.mark(dp+"."+k, "mapped")
			default:
				c.stash(dp+"."+k, v)
			}
		}
	}
	spec, _ := asObj(d["spec"])
	for k, v := range spec {
		sp := dp + ".spec." + k
		switch k {
		case "queries":
			if first {
				c.mark(sp, "mapped")
			}
			var targets []any
			type ref struct{ uid, typ string }
			var refs []ref
			for qi, pq := range objList(v) {
				qp := fmt.Sprintf("%s[%d]", sp, qi)
				t, legacy, uid, typ := c.query(pq, qp, first)
				targets = append(targets, t)
				p.queries = append(p.queries, legacy)
				refs = append(refs, ref{uid, typ})
			}
			p.m["targets"] = targets
			// The panel's data source, as Grafana derives it from its queries.
			mixed := false
			for _, r := range refs[min(1, len(refs)):] {
				mixed = mixed || r != refs[0]
			}
			switch {
			case len(refs) == 0:
			case mixed:
				p.m["datasource"] = map[string]any{"type": "mixed", "uid": "-- Mixed --"}
			case refs[0].uid == "-- Dashboard --":
				p.m["datasource"] = map[string]any{"type": "datasource", "uid": "-- Dashboard --"}
			default:
				if ds := dsRef(refs[0].typ, refs[0].uid); ds != nil {
					p.m["datasource"] = ds
				}
			}
		case "transformations":
			if first {
				c.mark(sp, "mapped")
			}
			var list []any
			for ti, t := range objList(v) {
				tm, fromGroup := c.transformation(t, fmt.Sprintf("%s[%d]", sp, ti), first)
				list = append(list, tm)
				p.trans = append(p.trans, fromGroup)
			}
			if len(list) > 0 {
				p.m["transformations"] = list
			}
		case "queryOptions":
			if first {
				c.mark(sp, "mapped")
			}
			qo, _ := asObj(v)
			for qk, qv := range qo {
				p.m[qk] = qv
			}
		default:
			if first {
				c.stash(sp, v)
			}
		}
	}
}

func (c *v2conv) query(pq obj, qp string, first bool) (t map[string]any, legacy bool, uid, typ string) {
	if first {
		for k, v := range pq {
			switch k {
			case "kind", "spec":
				c.mark(qp+"."+k, "mapped")
			default:
				c.stash(qp+"."+k, v)
			}
		}
	}
	s, _ := asObj(pq["spec"])
	t = map[string]any{}
	for k, v := range s {
		switch k {
		case "refId":
			t["refId"] = v
		case "hidden":
			if boolOf(v) {
				t["hide"] = true
			}
			if first {
				c.mark(qp+".spec.hidden", "mapped")
			}
		case "query":
			q, _ := asObj(v)
			if first {
				c.mark(qp+".spec.query", "mapped")
			}
			var g, n string
			if first {
				g, n = c.dataQuery(q, qp+".spec.query")
			} else {
				g = strOf(q["group"])
				ds, _ := asObj(q["datasource"])
				n = strOf(ds["name"])
			}
			uid, typ = n, g
			qs, _ := asObj(q["spec"])
			for qk, qv := range qs {
				if qk == legacyStringKey {
					legacy = true
					if strOf(qv) != "" {
						t["query"] = qv
					}
					continue
				}
				t[qk] = qv
			}
			if ds := dsRef(g, n); ds != nil {
				t["datasource"] = ds
			}
		default:
			t[k] = v
		}
	}
	return t, legacy, uid, typ
}

// transformation: v2 names the transformation in group; v2beta1 in kind and
// spec.id.
func (c *v2conv) transformation(t obj, tp string, first bool) (map[string]any, bool) {
	m := map[string]any{}
	fromGroup := false
	for k, v := range t {
		switch k {
		case "kind":
			if first {
				c.mark(tp+".kind", "mapped")
			}
		case "group":
			m["id"] = v
			fromGroup = true
		case "spec":
			if first {
				c.mark(tp+".spec", "mapped")
			}
		default:
			if first {
				c.stash(tp+"."+k, v)
			}
		}
	}
	s, _ := asObj(t["spec"])
	for k, v := range s {
		if k == "id" && fromGroup {
			if first {
				c.stash(tp+".spec.id", v)
			}
			continue
		}
		m[k] = v
	}
	if _, ok := m["id"]; !ok && c.beta {
		m["id"] = t["kind"]
	}
	return m, fromGroup
}

func (c *v2conv) vizConfig(raw json.RawMessage, vp string, p *cpanel, first bool) {
	v, _ := asObj(raw)
	if first {
		c.mark(vp, "mapped")
	}
	for k, x := range v {
		switch k {
		case "kind", "spec":
			if first {
				c.mark(vp+"."+k, "mapped")
			}
		case "group":
			p.m["type"] = x
		case "version":
			p.m["pluginVersion"] = x
		default:
			if first {
				c.stash(vp+"."+k, x)
			}
		}
	}
	spec, _ := asObj(v["spec"])
	for k, x := range spec {
		p.m[k] = x
	}
}

// register maps a classic panel's path back to what it came from.
func (c *v2conv) register(p *cpanel, path string) {
	if p.row {
		c.to(p.src+".spec", path)
		c.to(p.src+".spec.collapse", path+".collapsed")
		c.to(p.src+".spec.repeat.value", path+".repeat")
		return
	}
	// The element first: a finding on the whole panel names the element.
	if !c.aliased[p.elem] {
		c.aliased[p.elem] = true
		c.elementAliases(p, path)
	}
	if p.grid {
		g := map[string]string{"x": "x", "y": "y", "width": "w", "height": "h"}
		for from, to := range g {
			c.to(p.item+".spec."+from, path+".gridPos."+to)
		}
		c.to(p.item+".spec.repeat.direction", path+".repeatDirection")
		c.to(p.item+".spec.repeat.maxPerRow", path+".maxPerRow")
	}
	c.to(p.item+".spec.repeat.value", path+".repeat")
	c.to(p.item+".spec", path)
}

func (c *v2conv) elementAliases(p *cpanel, path string) {
	ep := p.elem
	c.to(ep+".spec", path)
	c.to(ep+".spec.vizConfig.group", path+".type")
	c.to(ep+".spec.vizConfig.version", path+".pluginVersion")
	c.to(ep+".spec.vizConfig.spec", path)
	c.to(ep+".spec.data.spec.queryOptions", path)
	for k, legacy := range p.queries {
		q := fmt.Sprintf("%s.spec.data.spec.queries[%d]", ep, k)
		t := fmt.Sprintf("%s.targets[%d]", path, k)
		c.to(q+".spec.query.spec", t)
		c.to(q+".spec.refId", t+".refId")
		c.to(q+".spec", t)
		if legacy {
			c.to(q+".spec.query.spec."+legacyStringKey, t+".query")
		}
	}
	for k, fromGroup := range p.trans {
		tr := fmt.Sprintf("%s.spec.data.spec.transformations[%d]", ep, k)
		t := fmt.Sprintf("%s.transformations[%d]", path, k)
		c.to(tr+".spec", t)
		if fromGroup {
			c.to(tr+".group", t+".id")
		} else if c.beta {
			c.to(tr+".kind", t+".id")
		}
	}
}

// ---- report paths ----

func boundary(path, prefix string) bool {
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	return len(path) == len(prefix) || path[len(prefix)] == '.' || path[len(prefix)] == '['
}

// toClassic is the classic path a v2 path was carried to.
func (r *Report) toClassic(path string) (string, bool) {
	best := -1
	for i, a := range r.alias {
		if boundary(path, a.from) && (best < 0 || len(a.from) > len(r.alias[best].from)) {
			best = i
		}
	}
	if best < 0 {
		return "", false
	}
	a := r.alias[best]
	return a.to + path[len(a.from):], true
}

// fromClassic is the v2 path a classic path came from (unchanged if none).
func (r *Report) fromClassic(path string) string {
	best := -1
	for i, a := range r.alias {
		if boundary(path, a.to) && (best < 0 || len(a.to) > len(r.alias[best].to)) {
			best = i
		}
	}
	if best < 0 {
		return path
	}
	a := r.alias[best]
	return a.from + path[len(a.to):]
}

// fromClassicAll is fromClassic, or for a classic object the conversion put
// together from several v2 keys (timepicker), those keys.
func (r *Report) fromClassicAll(path string) []string {
	if p := r.fromClassic(path); p != path {
		return []string{p}
	}
	var out []string
	for _, a := range r.alias {
		if strings.HasPrefix(a.to, path+".") {
			out = append(out, a.from)
		}
	}
	if len(out) == 0 {
		return []string{path}
	}
	sort.Strings(out)
	return out
}

// classicHow is how the classic import handled a path: its own mark, or
// "preserved" when an object above it was kept whole.
func classicHow(acc map[string]string, path string) string {
	if how := acc[path]; how != "" {
		return how
	}
	for p := path; ; {
		i := strings.LastIndexAny(p, ".[")
		if i <= 0 {
			return ""
		}
		p = p[:i]
		if acc[p] == "preserved" {
			return "preserved"
		}
	}
}
