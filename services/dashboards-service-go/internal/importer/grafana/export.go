package grafana

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// Export writes a dashboard as a Grafana classic dashboard JSON — the
// "Classic" model, the one Grafana's community catalog takes and every
// Grafana imports. An imported dashboard gets back every value its import
// kept (Ext, the data source references, the schemaVersion), so importing the
// export gives the same model. A dashboard made in Kubeast is written the way
// Grafana's "share with another instance" export writes one (exporters.ts
// makeExportableV1, v13.3.0): each store a ${DS_<STORE>} input listed in
// __inputs and __requires, which Grafana's import asks the user to pick.

// LatestSchemaVersion is the dashboard schemaVersion of Grafana 13.3.0
// (apps/dashboard/pkg/migration/schemaversion LATEST_VERSION), written on a
// dashboard that was not imported from a classic file.
const LatestSchemaVersion = 42

// ExportReport is what Export did beyond copying.
type ExportReport struct {
	Inputs   []string  `json:"inputs,omitempty"`   // ${DS_…} inputs the importing Grafana asks for
	Adjusted []Finding `json:"adjusted,omitempty"` // values written differently than the model holds them
}

var storePlugins = map[string]struct{ input, name string }{
	model.StorePrometheus:   {"DS_PROMETHEUS", "Prometheus"},
	model.StoreLoki:         {"DS_LOKI", "Loki"},
	model.StoreTempo:        {"DS_TEMPO", "Tempo"},
	model.StoreAlertmanager: {"DS_ALERTMANAGER", "Alertmanager"},
}

type exporter struct {
	d        *model.Dashboard
	rep      *ExportReport
	native   bool // not imported: references are made, not restored
	src      obj  // the classic dashboard the import read, if any
	srcVars  map[string]obj
	inputs   map[string]bool   // stores given a ${DS_…} input
	dsVar    map[string]string // store → name of a cluster variable of that store (native)
	panelIDs map[int]bool
	rowIDs   map[int]int // row index → the id the import kept for it
	nextID   int
}

// Export writes d; see the comment above.
func Export(d *model.Dashboard) ([]byte, *ExportReport, error) {
	if d == nil {
		return nil, nil, fmt.Errorf("no dashboard")
	}
	ex := &exporter{d: d, rep: &ExportReport{}, native: d.Source == nil, inputs: map[string]bool{}, dsVar: map[string]string{}, panelIDs: map[int]bool{}, rowIDs: map[int]int{}}
	ex.src = sourceClassic(d)
	ex.srcVars = sourceVariables(ex.src)
	root := ex.dashboard()
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return out, ex.rep, nil
}

var (
	reExtNested = regexp.MustCompile(`^(time|templating|annotations)\.(.+)$`)
	reExtLink   = regexp.MustCompile(`^links\[(\d+)\](?:\.(.+))?$`)
	rePanelName = regexp.MustCompile(`^p([0-9]+)$`)
)

func (ex *exporter) dashboard() obj {
	d := ex.d
	root := obj{}
	nested := map[string]obj{"time": {}, "templating": {}, "annotations": {}}
	links := map[int]json.RawMessage{} // links[i] kept whole
	linkExt := map[int]obj{}           // links[i].k
	v2only := 0
	for k, v := range d.Spec.Ext {
		switch m := reExtNested.FindStringSubmatch(k); {
		case k == "refresh":
			// the original refresh string; written below
		case m != nil:
			nested[m[1]][m[2]] = v
		case reExtLink.MatchString(k):
			lm := reExtLink.FindStringSubmatch(k)
			i, _ := strconv.Atoi(lm[1])
			if lm[2] == "" {
				links[i] = v
			} else {
				if linkExt[i] == nil {
					linkExt[i] = obj{}
				}
				linkExt[i][lm[2]] = v
			}
		default:
			root[k] = v // top-level keys the model has no field for, and v2-only values ("v2:…")
			if strings.HasPrefix(k, "v2:") {
				v2only++
			}
		}
	}
	if v2only > 0 {
		ex.rep.Adjusted = append(ex.rep.Adjusted, Finding{Path: "v2:", Reason: fmt.Sprintf(
			"%d v2-only values (tabs, auto grids, sub headers, conditional rendering…) have no classic place: carried under their v2 paths, which Grafana's classic dashboard ignores and an import restores", v2only)})
	}

	uid := d.Metadata.Name
	if d.Source != nil && d.Source.UID != "" {
		uid = d.Source.UID
	}
	root["uid"] = mustJSON(uid)
	root["title"] = mustJSON(d.Metadata.Title)
	if d.Metadata.Description != "" {
		root["description"] = mustJSON(d.Metadata.Description)
	}
	tags := d.Metadata.Tags
	if tags == nil {
		tags = []string{}
	}
	root["tags"] = mustJSON(tags)
	if d.Spec.Timezone != "" {
		root["timezone"] = mustJSON(d.Spec.Timezone)
	}
	root["graphTooltip"] = mustJSON(map[string]int{model.CursorSyncShared: 1, model.CursorSyncSharedTooltip: 2}[d.Spec.CursorSync])

	t := nested["time"]
	t["from"], t["to"] = mustJSON(d.Spec.Time.From), mustJSON(d.Spec.Time.To)
	root["time"] = mustJSON(t)
	if orig, ok := d.Spec.Ext["refresh"]; ok {
		root["refresh"] = orig
	} else {
		root["refresh"] = mustJSON(d.Spec.Refresh)
	}
	sv := LatestSchemaVersion
	if d.Source != nil && d.Source.Kind == model.SourceGrafanaV1 && d.Source.SchemaVersion > 0 {
		sv = d.Source.SchemaVersion // Grafana migrates the panels from where the original stood
	}
	root["schemaVersion"] = mustJSON(sv)

	if ex.native {
		for _, v := range d.Spec.Variables {
			if v.Kind == model.VarCluster && v.Store != "" && ex.dsVar[v.Store] == "" {
				ex.dsVar[v.Store] = v.Name
			}
		}
	}
	for name := range d.Spec.Panels {
		if m := rePanelName.FindStringSubmatch(name); m != nil {
			id, _ := strconv.Atoi(m[1])
			ex.panelIDs[id] = true
		}
	}
	for i, r := range d.Spec.Layout.Rows {
		var id int
		if json.Unmarshal(r.Ext["id"], &id) == nil && id > 0 && !ex.panelIDs[id] {
			ex.panelIDs[id] = true
			ex.rowIDs[i] = id
		}
	}

	var vars []json.RawMessage
	for _, v := range d.Spec.Variables {
		vars = append(vars, mustJSON(ex.variable(v)))
	}
	tpl := nested["templating"]
	tpl["list"] = mustJSON(nonNil(vars))
	root["templating"] = mustJSON(tpl)

	var anns []json.RawMessage
	for _, a := range d.Spec.Annotations {
		anns = append(anns, mustJSON(ex.annotation(a)))
	}
	an := nested["annotations"]
	an["list"] = mustJSON(nonNil(anns))
	root["annotations"] = mustJSON(an)

	root["links"] = mustJSON(nonNil(ex.links(links, linkExt)))
	root["panels"] = mustJSON(nonNil(ex.panels()))

	if len(ex.inputs) > 0 {
		var inputs, requires []map[string]any
		for _, store := range sortedKeys(ex.inputs) {
			p := storePlugins[store]
			inputs = append(inputs, map[string]any{"name": p.input, "label": p.name, "description": "", "type": "datasource", "pluginId": store, "pluginName": p.name})
			requires = append(requires, map[string]any{"type": "datasource", "id": store, "name": p.name, "version": "1.0.0"})
			ex.rep.Inputs = append(ex.rep.Inputs, p.input)
		}
		root["__inputs"] = mustJSON(inputs)
		root["__requires"] = mustJSON(requires)
	}
	return root
}

// links puts each link back at its place: one kept whole (a link to
// dashboards by tag) at its index, the model's links in order between them,
// each with its own kept keys.
func (ex *exporter) links(whole map[int]json.RawMessage, extra map[int]obj) []json.RawMessage {
	n := len(ex.d.Spec.Links) + len(whole)
	var out []json.RawMessage
	next := 0
	for i := 0; i < n; i++ {
		if raw, ok := whole[i]; ok {
			out = append(out, raw)
			continue
		}
		if next >= len(ex.d.Spec.Links) {
			continue
		}
		l := ex.d.Spec.Links[next]
		next++
		o := obj{}
		for k, v := range extra[i] {
			o[k] = v
		}
		o["type"] = mustJSON("link")
		o["title"] = mustJSON(l.Title)
		o["url"] = mustJSON(l.URL)
		if l.NewTab {
			o["targetBlank"] = mustJSON(true)
		}
		out = append(out, mustJSON(o))
	}
	return out
}

// ---- panels and layout ----

// tok is one entry of the top level: a row (its index) or a panel (its name).
type tok struct {
	row  int // -1 for a panel
	name string
}

// panels lays the top level out in the order the import read it, so that
// importing the export puts every panel back in the same place: the order of
// the original file when it still gives this layout, else one rebuilt from
// the positions (a dashboard made or changed in Kubeast).
func (ex *exporter) panels() []json.RawMessage {
	l := ex.d.Spec.Layout
	items := map[string]model.LayoutItem{}
	for _, it := range l.Items {
		items[it.Panel] = it
	}
	for _, r := range l.Rows {
		for _, it := range r.Items {
			items[it.Panel] = it
		}
	}
	order := sourceOrder(ex.src)
	if order == nil || !ex.reproduces(order) {
		order = ex.byPosition()
	}
	var out []json.RawMessage
	for _, t := range order {
		if t.row < 0 {
			out = append(out, ex.panel(items[t.name]))
			continue
		}
		r := l.Rows[t.row]
		var inner []json.RawMessage
		if r.Collapsed {
			for _, it := range r.Items {
				inner = append(inner, ex.panel(it))
			}
		}
		out = append(out, ex.row(t.row, inner))
	}
	return out
}

// reproduces says whether importing the top level in this order gives the
// model's layout: a panel after an open row joins it, any other stays at the
// top, and every row and panel appears once.
func (ex *exporter) reproduces(order []tok) bool {
	l := ex.d.Spec.Layout
	var top []string
	open := map[int][]string{}
	cur := -1
	seen := map[string]bool{}
	rows := 0
	for _, t := range order {
		if t.row >= 0 {
			if t.row >= len(l.Rows) {
				return false
			}
			rows++
			cur = -1
			if !l.Rows[t.row].Collapsed {
				cur = t.row
			}
			continue
		}
		if _, ok := ex.d.Spec.Panels[t.name]; !ok || seen[t.name] {
			return false
		}
		seen[t.name] = true
		if cur >= 0 {
			open[cur] = append(open[cur], t.name)
		} else {
			top = append(top, t.name)
		}
	}
	if rows != len(l.Rows) || !sameNames(top, l.Items) {
		return false
	}
	for i, r := range l.Rows {
		if !r.Collapsed && !sameNames(open[i], r.Items) {
			return false
		}
	}
	return true
}

func sameNames(names []string, items []model.LayoutItem) bool {
	if len(names) != len(items) {
		return false
	}
	for i, it := range items {
		if names[i] != it.Panel {
			return false
		}
	}
	return true
}

// byPosition orders the top level from the positions: the panels before the
// first row, then each row with the panels it holds open, a panel outside the
// rows placed by its y after the last row above it that is folded (after an
// open row it would join that row).
func (ex *exporter) byPosition() []tok {
	l := ex.d.Spec.Layout
	gaps := make([][]string, len(l.Rows)+1)
	gap := 0
	for _, it := range l.Items {
		g := 0
		for i, r := range l.Rows {
			if r.Y <= it.Y && r.Collapsed && i+1 >= gap {
				g = i + 1
			}
		}
		if g < gap {
			g = gap // keep the stored order
		}
		gap = g
		gaps[g] = append(gaps[g], it.Panel)
	}
	var out []tok
	for _, n := range gaps[0] {
		out = append(out, tok{row: -1, name: n})
	}
	for i, r := range l.Rows {
		out = append(out, tok{row: i})
		if !r.Collapsed {
			for _, it := range r.Items {
				out = append(out, tok{row: -1, name: it.Panel})
			}
		}
		for _, n := range gaps[i+1] {
			out = append(out, tok{row: -1, name: n})
		}
	}
	return out
}

// sourceClassic is the classic dashboard the import read — the classic
// file, or the one a v2 file was turned into — or nil for a dashboard made
// in Kubeast. The export reads it for what the model normalizes away: the
// order of the top level and the variables that had no options.
func sourceClassic(d *model.Dashboard) obj {
	if d.Source == nil || len(d.Source.Raw) == 0 {
		return nil
	}
	root, ok := asObj(d.Source.Raw)
	if !ok {
		return nil
	}
	if inner, ok := asObj(root["dashboard"]); ok {
		root = inner
	}
	av := strOf(root["apiVersion"])
	if !strings.HasPrefix(av, resourceGroup) {
		return root
	}
	spec, ok := asObj(root["spec"])
	if !ok {
		return nil
	}
	if v := strings.TrimPrefix(av, resourceGroup); v == "v2" || v == "v2beta1" {
		b, err := json.Marshal(newV2conv(v == "v2beta1").dashboard(spec))
		if err != nil {
			return nil
		}
		spec, _ = asObj(b)
	}
	return spec
}

// sourceOrder is the source's top level, each panel under the name the
// import gave it.
func sourceOrder(src obj) []tok {
	if src == nil {
		return nil
	}
	var list []json.RawMessage
	_ = json.Unmarshal(src["panels"], &list)
	namer := &importer{names: map[string]bool{}}
	var out []tok
	rows := 0
	for _, raw := range list {
		p, ok := asObj(raw)
		if !ok {
			continue
		}
		if strOf(p["type"]) == "row" {
			out = append(out, tok{row: rows})
			rows++
			var inner []json.RawMessage
			_ = json.Unmarshal(p["panels"], &inner)
			for _, ir := range inner {
				if ip, ok := asObj(ir); ok {
					namer.panelName(ip, strOf(ip["title"]))
				}
			}
			continue
		}
		out = append(out, tok{row: -1, name: namer.panelName(p, strOf(p["title"]))})
	}
	return out
}

// sourceVariables are the source's variables by name.
func sourceVariables(src obj) map[string]obj {
	out := map[string]obj{}
	tpl, _ := asObj(src["templating"])
	var list []json.RawMessage
	_ = json.Unmarshal(tpl["list"], &list)
	for _, raw := range list {
		if v, ok := asObj(raw); ok {
			out[strOf(v["name"])] = v
		}
	}
	return out
}

func (ex *exporter) id(name string) int {
	if m := rePanelName.FindStringSubmatch(name); m != nil {
		id, _ := strconv.Atoi(m[1])
		return id
	}
	for ex.nextID++; ex.panelIDs[ex.nextID]; ex.nextID++ {
	}
	ex.panelIDs[ex.nextID] = true
	return ex.nextID
}

func (ex *exporter) row(i int, inner []json.RawMessage) json.RawMessage {
	r := ex.d.Spec.Layout.Rows[i]
	o := obj{}
	for k, v := range r.Ext {
		o[k] = v
	}
	o["type"] = mustJSON("row")
	id, ok := ex.rowIDs[i]
	if !ok {
		id = ex.id("")
		if kept, had := r.Ext["id"]; had {
			ex.rep.Adjusted = append(ex.rep.Adjusted, Finding{Path: fmt.Sprintf("layout.rows[%d].id", i), Reason: fmt.Sprintf("row id %s is taken by a panel or another row: written as %d", kept, id)})
		}
	}
	o["id"] = mustJSON(id)
	o["title"] = mustJSON(r.Title)
	o["collapsed"] = mustJSON(r.Collapsed)
	o["gridPos"] = mustJSON(map[string]int{"x": 0, "y": r.Y, "w": model.GridColumns, "h": 1})
	o["panels"] = mustJSON(nonNil(inner))
	if r.Repeat != "" {
		o["repeat"] = mustJSON(r.Repeat)
	}
	return mustJSON(o)
}

func (ex *exporter) panel(it model.LayoutItem) json.RawMessage {
	p := ex.d.Spec.Panels[it.Panel]
	o := obj{}
	fc := obj{}
	defs := obj{}
	wholeOverrides := map[int]json.RawMessage{}
	for k, v := range p.Ext {
		switch {
		case k == "legacyType" || k == "pluginType":
			// written as the type below
		case strings.HasPrefix(k, "fieldConfig.defaults."):
			defs[strings.TrimPrefix(k, "fieldConfig.defaults.")] = v
		case strings.HasPrefix(k, "fieldConfig.overrides["):
			i, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(k, "fieldConfig.overrides["), "]"))
			wholeOverrides[i] = v
		case strings.HasPrefix(k, "fieldConfig."):
			fc[strings.TrimPrefix(k, "fieldConfig.")] = v
		default:
			o[k] = v // datasource, libraryPanel and the keys the model has no field for
		}
	}
	o["id"] = mustJSON(ex.id(it.Panel))
	switch {
	case p.Ext["legacyType"] != nil:
		o["type"] = p.Ext["legacyType"]
	case p.Ext["pluginType"] != nil:
		o["type"] = p.Ext["pluginType"]
	case p.Kind == model.Unsupported:
		// a library panel that was not inlined has no type of its own
	default:
		o["type"] = mustJSON(p.Kind)
	}
	if p.Title != "" {
		o["title"] = mustJSON(p.Title)
	}
	if p.Description != "" {
		o["description"] = mustJSON(p.Description)
	}
	o["gridPos"] = mustJSON(map[string]int{"x": it.X, "y": it.Y, "w": it.W, "h": it.H})

	stores := map[string]bool{}
	for _, q := range p.Queries {
		if q.Store != "" {
			stores[q.Store] = true
		}
	}
	single := ""
	if len(stores) == 1 {
		single = sortedKeys(stores)[0]
	}
	if ex.native && o["datasource"] == nil && len(stores) > 0 {
		if single != "" {
			o["datasource"] = ex.dsRef(single)
		} else {
			o["datasource"] = mustJSON(map[string]string{"type": "datasource", "uid": "-- Mixed --"})
		}
	}
	var targets []json.RawMessage
	for _, q := range p.Queries {
		targets = append(targets, mustJSON(ex.query(q, single == "")))
	}
	if len(targets) > 0 || p.Kind != model.Unsupported {
		o["targets"] = mustJSON(nonNil(targets))
	}

	ex.fieldDefaults(p, defs, it.Panel)
	fc["defaults"] = mustJSON(defs)
	fc["overrides"] = mustJSON(nonNil(overrides(p.Overrides, wholeOverrides)))
	if p.Kind != model.Unsupported || len(defs) > 0 || len(p.Overrides) > 0 {
		o["fieldConfig"] = mustJSON(fc)
	}
	if len(p.Options) > 0 {
		o["options"] = p.Options
	}
	var ts []json.RawMessage
	for _, t := range p.Transforms {
		to := obj{}
		for k, v := range t.Ext {
			to[k] = v
		}
		to["id"] = mustJSON(t.ID)
		if len(t.Options) > 0 {
			to["options"] = t.Options
		}
		if t.Disabled {
			to["disabled"] = mustJSON(true)
		}
		ts = append(ts, mustJSON(to))
	}
	if len(ts) > 0 {
		o["transformations"] = mustJSON(ts)
	}
	if r := p.Repeat; r != nil {
		o["repeat"] = mustJSON(r.Variable)
		if r.Direction != "" {
			o["repeatDirection"] = mustJSON(r.Direction)
		}
		if r.MaxPerRow > 0 {
			o["maxPerRow"] = mustJSON(r.MaxPerRow)
		}
	}
	return mustJSON(o)
}

// query writes one target; own says whether it names its data source (a
// panel of several stores).
func (ex *exporter) query(q model.Query, own bool) obj {
	t := obj{}
	for k, v := range q.Ext {
		t[k] = v
	}
	t["refId"] = mustJSON(q.RefID)
	if q.Expr != "" {
		if q.Store == model.StoreTempo {
			t["query"] = mustJSON(q.Expr) // TraceQL
		} else {
			t["expr"] = mustJSON(q.Expr)
		}
	}
	if q.Legend != "" {
		t["legendFormat"] = mustJSON(q.Legend)
	}
	if q.Instant {
		t["instant"] = mustJSON(true)
	}
	if q.MinStep != "" {
		t["interval"] = mustJSON(q.MinStep)
	}
	if q.Hide {
		t["hide"] = mustJSON(true)
	}
	if ex.native && own && t["datasource"] == nil && q.Store != "" {
		t["datasource"] = ex.dsRef(q.Store)
	}
	return t
}

// dsRef names a store on a dashboard made in Kubeast: its cluster variable,
// else a ${DS_…} input.
func (ex *exporter) dsRef(store string) json.RawMessage {
	if v := ex.dsVar[store]; v != "" {
		return mustJSON(map[string]string{"type": store, "uid": "${" + v + "}"})
	}
	if _, ok := storePlugins[store]; !ok {
		return mustJSON(map[string]string{"type": store})
	}
	ex.inputs[store] = true
	return mustJSON(map[string]string{"type": store, "uid": "${" + storePlugins[store].input + "}"})
}

func (ex *exporter) fieldDefaults(p model.Panel, defs obj, panel string) {
	f := p.FieldDefaults
	if f.Unit != "" {
		defs["unit"] = mustJSON(f.Unit)
	}
	if f.Min != nil {
		defs["min"] = mustJSON(*f.Min)
	}
	if f.Max != nil {
		defs["max"] = mustJSON(*f.Max)
	}
	if f.Decimals != nil {
		defs["decimals"] = mustJSON(*f.Decimals)
	}
	if f.DisplayName != "" {
		defs["displayName"] = mustJSON(f.DisplayName)
	}
	if f.NoValue != "" {
		defs["noValue"] = mustJSON(f.NoValue)
	}
	if f.Mappings != nil {
		defs["mappings"] = mustJSON(f.Mappings)
	}
	if len(f.Links) > 0 {
		var ls []map[string]any
		for _, l := range f.Links {
			m := map[string]any{"title": l.Title, "url": l.URL}
			if l.NewTab {
				m["targetBlank"] = true
			}
			ls = append(ls, m)
		}
		defs["links"] = mustJSON(ls)
	}
	// An original colour the import kept (a fixed colour it drew as a token)
	// is already in defs; otherwise the token's Grafana colour.
	if c := f.Color; c != nil && defs["color"] == nil {
		m := map[string]string{"mode": c.Mode}
		if c.Token != "" {
			m["fixedColor"] = ex.color(c.Token, "panels."+panel+".fieldDefaults.color.token")
		}
		defs["color"] = mustJSON(m)
	}
	if th := f.Thresholds; th != nil && defs["thresholds"] == nil {
		mode := mustJSON(th.Mode)
		if orig, ok := defs["thresholds.mode"]; ok {
			mode = orig // a mode Grafana draws as absolute, as it was written
		}
		steps := []map[string]any{}
		for i, s := range th.Steps {
			step := map[string]any{"color": ex.color(s.Color, fmt.Sprintf("panels.%s.fieldDefaults.thresholds.steps[%d].color", panel, i))}
			if s.Value != nil {
				step["value"] = *s.Value
			} else {
				step["value"] = nil
			}
			steps = append(steps, step)
		}
		defs["thresholds"] = mustJSON(map[string]any{"mode": mode, "steps": steps})
	}
	delete(defs, "thresholds.mode")
}

func (ex *exporter) color(token, path string) string {
	if c := ColorOf(token); c != "" {
		if strings.HasPrefix(c, "#") {
			ex.rep.Adjusted = append(ex.rep.Adjusted, Finding{Path: path, Reason: fmt.Sprintf("%s has no Grafana colour name: written as %s", token, c)})
		}
		return c
	}
	ex.rep.Adjusted = append(ex.rep.Adjusted, Finding{Path: path, Reason: fmt.Sprintf("unknown token %q written as text", token)})
	return "text"
}

var matcherIDs = map[string]string{model.MatchByName: "byName", model.MatchByRegexp: "byRegexp", model.MatchByType: "byType",
	model.MatchByRefID: "byFrameRefID", model.MatchByValue: "byValue"}

// overrides puts an override the import kept whole back at its index and the
// model's overrides in order between them, each property sorted by id.
func overrides(list []model.Override, whole map[int]json.RawMessage) []json.RawMessage {
	n := len(list) + len(whole)
	var out []json.RawMessage
	next := 0
	for i := 0; i < n; i++ {
		if raw, ok := whole[i]; ok {
			out = append(out, raw)
			continue
		}
		if next >= len(list) {
			continue
		}
		ov := list[next]
		next++
		m := map[string]any{"id": matcherIDs[ov.Matcher.Kind]}
		if len(ov.Matcher.Value) > 0 {
			m["options"] = ov.Matcher.Value
		}
		props := []map[string]any{}
		for _, id := range sortedKeys(ov.Set) {
			props = append(props, map[string]any{"id": id, "value": ov.Set[id]})
		}
		out = append(out, mustJSON(map[string]any{"matcher": m, "properties": props}))
	}
	return out
}

// ---- variables ----

func (ex *exporter) variable(v model.Variable) obj {
	o := obj{}
	special := map[string]bool{"query": true, "definition": true, "datasource.query": true, "clusterQuery": true, "grafanaType": true}
	for k, val := range v.Ext {
		if !special[k] {
			o[k] = val // datasource and the keys the model has no field for
		}
	}
	o["name"] = mustJSON(v.Name)
	if v.Label != "" {
		o["label"] = mustJSON(v.Label)
	}
	if def, ok := v.Ext["definition"]; ok {
		o["definition"] = def
	}
	typ, query := v.Kind, json.RawMessage(nil)
	switch v.Kind {
	case model.VarCluster:
		switch {
		case v.Ext["datasource.query"] != nil:
			typ, query = "datasource", v.Ext["datasource.query"]
		case v.Ext["clusterQuery"] != nil:
			typ, query = "query", v.Ext["clusterQuery"]
		default:
			typ, query = "datasource", mustJSON(v.Store) // Kubeast's cluster selector is Grafana's data source picker
		}
		if q, ok := v.Ext["query"]; ok {
			query = q
		}
	case model.VarQuery:
		query = v.Ext["query"]
		if query == nil && v.Query != nil {
			query = mustJSON(variableQueryText(v.Query))
		}
		if ex.native && o["datasource"] == nil && v.Store != "" {
			o["datasource"] = ex.dsRef(v.Store)
		}
	case model.VarConstant:
		if gt, ok := v.Ext["grafanaType"]; ok {
			typ = strOf(gt)
		}
		query = v.Ext["query"]
	case model.VarAdhoc:
		query = v.Ext["query"]
	default: // custom, interval, textbox, switch
		query = v.Ext["query"]
		if query == nil && v.Kind == model.VarCustom && len(v.Options) > 0 && v.Options[0].Value != "" {
			var vals []string
			for _, op := range v.Options {
				vals = append(vals, op.Value)
			}
			query = mustJSON(strings.Join(vals, ","))
		}
	}
	o["type"] = mustJSON(typ)
	if query != nil {
		o["query"] = query
	}
	if v.Regex != "" {
		o["regex"] = mustJSON(v.Regex)
	}
	if v.Sort != 0 {
		o["sort"] = mustJSON(v.Sort)
	}
	if r := map[string]int{model.RefreshOnLoad: 1, model.RefreshOnTimeRange: 2}[v.Refresh]; r != 0 {
		o["refresh"] = mustJSON(r)
	}
	derived := false // options the import read from the query of a variable that had none
	if orig, ok := ex.srcVars[v.Name]; ok && (v.Kind == model.VarCustom || v.Kind == model.VarInterval) {
		var opts []json.RawMessage
		_ = json.Unmarshal(orig["options"], &opts)
		derived = len(opts) == 0
	}
	if len(v.Options) > 0 && !derived && !(v.Kind == model.VarCustom && len(v.Options) == 1 && v.Options[0] == (model.VariableOption{})) {
		// Grafana marks the options of the current value selected.
		chosen := currentValues(v.Current)
		var opts []map[string]any
		for _, op := range v.Options {
			opts = append(opts, map[string]any{"text": op.Text, "value": op.Value, "selected": chosen[op.Value]})
		}
		o["options"] = mustJSON(opts)
	}
	if v.Multi {
		o["multi"] = mustJSON(true)
	}
	if v.IncludeAll {
		o["includeAll"] = mustJSON(true)
	}
	if v.AllValue != "" {
		o["allValue"] = mustJSON(v.AllValue)
	}
	if len(v.Current) > 0 {
		o["current"] = v.Current
	}
	if v.Hide != 0 {
		o["hide"] = mustJSON(v.Hide)
	}
	return o
}

// currentValues are the values a variable's current selection holds.
func currentValues(current json.RawMessage) map[string]bool {
	var cur struct {
		Value json.RawMessage `json:"value"`
	}
	out := map[string]bool{}
	if json.Unmarshal(current, &cur) != nil {
		return out
	}
	if s := strOf(cur.Value); s != "" {
		out[s] = true
	}
	var many []string
	if json.Unmarshal(cur.Value, &many) == nil {
		for _, s := range many {
			out[s] = true
		}
	}
	return out
}

// variableQueryText writes a query variable's source as Grafana's Prometheus
// helpers read it.
func variableQueryText(q *model.VariableQuery) string {
	switch q.Fn {
	case "label_values":
		if q.Expr == "" {
			return "label_values(" + q.Label + ")"
		}
		return "label_values(" + q.Expr + ", " + q.Label + ")"
	case "label_names", "metrics", "query_result":
		return q.Fn + "(" + q.Expr + ")"
	}
	return q.Expr // logql, raw
}

// ---- annotations ----

func (ex *exporter) annotation(a model.Annotation) obj {
	o := obj{}
	for k, v := range a.Ext {
		o[k] = v
	}
	o["name"] = mustJSON(a.Name)
	o["enable"] = mustJSON(a.Enable)
	if o["iconColor"] == nil && a.Color != "" {
		o["iconColor"] = mustJSON(ex.color(a.Color, "annotations."+a.Name+".color"))
	}
	if a.Expr != "" {
		var target obj
		if t, ok := asObj(a.Ext["target"]); ok {
			target = t
		}
		if target == nil || strOf(target["expr"]) != a.Expr {
			o["expr"] = mustJSON(a.Expr)
		}
	}
	if ex.native && o["datasource"] == nil && a.Store != "" {
		o["datasource"] = ex.dsRef(a.Store)
	}
	return o
}

// ---- helpers ----

func nonNil(list []json.RawMessage) []json.RawMessage {
	if list == nil {
		return []json.RawMessage{}
	}
	return list
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
