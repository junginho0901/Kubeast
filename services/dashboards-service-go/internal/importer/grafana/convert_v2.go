package grafana

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ErrV2SchemaVersion: ConvertV2 takes a classic dashboard from schemaVersion 36
// to 42; Grafana's migrations from older versions are not ported yet.
var ErrV2SchemaVersion = errors.New("only a classic dashboard at schemaVersion 36 to 42 is converted to v2 so far")

// DataSource is one data source of the Grafana a conversion is done for.
type DataSource struct {
	UID, Name, Type string
	Default         bool
}

// DataSources answers what Grafana's data source index answers while it
// converts: the default data source, a data source by uid, and one by name.
type DataSources []DataSource

func (l DataSources) defaultType() string {
	for _, d := range l {
		if d.Default {
			return d.Type
		}
	}
	return "grafana"
}

// typeOf is the type of the data source with that uid, else the default's.
func (l DataSources) typeOf(uid string) string {
	for _, d := range l {
		if uid != "" && d.UID == uid {
			return d.Type
		}
	}
	return l.defaultType()
}

// byName resolves a bare name ("default" is the default data source) to its
// uid and type; a name it does not know stays as the uid, with no type.
func (l DataSources) byName(name string) (uid, typ string) {
	if name == "default" {
		for _, d := range l {
			if d.Default {
				return d.UID, d.Type
			}
		}
	}
	for _, d := range l {
		if d.Name == name {
			return d.UID, d.Type
		}
	}
	for _, d := range l {
		if d.UID == name {
			return d.UID, d.Type
		}
	}
	return name, ""
}

// ConvertV2 converts a classic dashboard to the spec of a schema v2 resource
// (dashboard.grafana.app/v2) as Grafana 13.3.0 does when it serves a classic
// dashboard as v2: prepareV1, then its v1 → v2alpha1 → v2beta1 → v2
// conversions, with ds as the Grafana's data sources.
func ConvertV2(classic []byte, ds DataSources) ([]byte, error) {
	var dash map[string]any
	if err := json.Unmarshal(classic, &dash); err != nil {
		return nil, err
	}
	if inner, ok := mapOf(dash["dashboard"]); ok {
		dash = inner
	}
	if err := prepareV1(dash); err != nil {
		return nil, err
	}
	c := &v2convert{ds: ds}
	spec := c.spec(dash)
	if c.err != nil {
		return nil, c.err
	}
	return json.Marshal(spec)
}

type v2convert struct {
	ds  DataSources
	err error
}

func (c *v2convert) spec(d map[string]any) v2Spec {
	uniquePanelIDs(d)
	s := v2Spec{
		Title:       str(d, "title"),
		Description: nonEmpty(d, "description"),
		Tags:        strList(d, "tags"),
		CursorSync:  map[int]string{1: "Crosshair", 2: "Tooltip"}[intField(d, "graphTooltip", 0)],
		Preload:     boolField(d, "preload", false),
		Editable:    ptr(true),
		LiveNow:     ptr(false),
	}
	if s.CursorSync == "" {
		s.CursorSync = "Off"
	}
	if b, ok := d["liveNow"].(bool); ok {
		s.LiveNow = &b
	}
	if b, ok := d["editable"].(bool); ok {
		s.Editable = &b
	}
	if r, ok := d["revision"].(float64); ok {
		s.Revision = ptr(uint16(r))
	}
	s.TimeSettings = timeSettings(d)
	s.Links = dashboardLinks(d)
	s.Elements, s.Layout = c.layout(d)
	s.Variables = c.variables(d)
	s.Annotations = annotations(d)
	s.Preferences = &v2Preferences{Layout: v2Kind[v2GridLayoutSpec]{Kind: "GridLayout", Spec: v2GridLayoutSpec{Items: []v2Kind[v2GridItemSpec]{}}}}
	return s
}

func timeSettings(d map[string]any) v2TimeSettings {
	t := v2TimeSettings{
		Timezone: ptr("browser"), From: "now-6h", To: "now",
		AutoRefreshIntervals: []string{"5s", "10s", "30s", "1m", "5m", "15m", "30m", "1h", "2h", "1d"},
	}
	if r, ok := mapOf(d["time"]); ok {
		if v := str(r, "from"); v != "" {
			t.From = v
		}
		if v := str(r, "to"); v != "" {
			t.To = v
		}
	}
	if tz, ok := d["timezone"].(string); ok {
		t.Timezone = nil // "" is the viewer's own preference
		if tz != "" {
			t.Timezone = &tz
		}
	}
	if v := str(d, "refresh"); v != "" {
		t.AutoRefresh = v
	}
	t.FiscalYearStartMonth = int64(intField(d, "fiscalYearStartMonth", 0))
	if v, ok := d["weekStart"].(string); ok && v != "" {
		t.WeekStart = &v
	}
	if tp, ok := mapOf(d["timepicker"]); ok {
		if l, ok := tp["refresh_intervals"].([]any); ok {
			var iv []string
			for _, x := range l {
				if s, ok := x.(string); ok {
					iv = append(iv, s)
				}
			}
			if len(iv) > 0 {
				t.AutoRefreshIntervals = iv
			}
		}
		t.HideTimepicker = boolField(tp, "hidden", false)
		if v, ok := tp["nowDelay"].(string); ok && v != "" {
			t.NowDelay = &v
		}
		if l, ok := tp["quick_ranges"].([]any); ok {
			t.QuickRanges = []v2TimeRange{}
			for _, q := range anyMaps(l) {
				t.QuickRanges = append(t.QuickRanges, v2TimeRange{Display: str(q, "display"), From: str(q, "from"), To: str(q, "to")})
			}
		}
	}
	return t
}

func dashboardLinks(d map[string]any) []v2DashboardLink {
	out := []v2DashboardLink{}
	for _, l := range anyMaps(d["links"]) {
		dl := v2DashboardLink{
			Title: str(l, "title"), Type: strOr(l, "type", "link"), Icon: str(l, "icon"), Tooltip: str(l, "tooltip"),
			Tags: strList(l, "tags"), AsDropdown: boolField(l, "asDropdown", false), TargetBlank: boolField(l, "targetBlank", false),
			IncludeVars: boolField(l, "includeVars", false), KeepTime: boolField(l, "keepTime", false),
		}
		if u, ok := l["url"].(string); ok {
			dl.URL = ptr(stripBOM(u))
		}
		if p, ok := l["placement"].(string); ok {
			dl.Placement = &p
		}
		out = append(out, dl)
	}
	return out
}

// ---- panels and layout ----

func (c *v2convert) layout(d map[string]any) (map[string]any, any) {
	elements := map[string]any{}
	panels, ok := d["panels"].([]any)
	if !ok {
		return elements, v2Kind[v2GridLayoutSpec]{Kind: "GridLayout", Spec: v2GridLayoutSpec{Items: []v2Kind[v2GridItemSpec]{}}}
	}
	hasRows := false
	for _, p := range anyMaps(panels) {
		if str(p, "type") == "row" {
			hasRows = true
			break
		}
	}
	if !hasRows {
		items := []v2Kind[v2GridItemSpec]{}
		for _, p := range anyMaps(panels) {
			name, el := c.element(p)
			elements[name] = el
			items = append(items, gridItem(p, name, nil))
		}
		return elements, v2Kind[v2GridLayoutSpec]{Kind: "GridLayout", Spec: v2GridLayoutSpec{Items: items}}
	}
	rows := []v2Kind[v2RowSpec]{}
	var cur *v2Kind[v2RowSpec]
	var rowY int64
	for _, p := range anyMaps(panels) {
		if str(p, "type") == "row" {
			if g, ok := mapOf(p["gridPos"]); ok {
				rowY = int64(intField(g, "y", 0))
			}
			if cur != nil {
				if cur.Spec.HideHeader != nil && *cur.Spec.HideHeader {
					cur.Spec.Collapse = ptr(false)
				}
				rows = append(rows, *cur)
			}
			items := []v2Kind[v2GridItemSpec]{}
			for _, in := range anyMaps(p["panels"]) {
				name, el := c.element(in)
				elements[name] = el
				y := yInRow(in, rowY)
				items = append(items, gridItem(in, name, &y))
			}
			r := v2Kind[v2RowSpec]{Kind: "RowsLayoutRow", Spec: v2RowSpec{
				Collapse: ptr(boolField(p, "collapsed", false)),
				Title:    ptr(str(p, "title")),
				Layout:   v2Kind[v2GridLayoutSpec]{Kind: "GridLayout", Spec: v2GridLayoutSpec{Items: items}},
			}}
			if rep := str(p, "repeat"); rep != "" {
				r.Spec.Repeat = &v2RowRepeat{Mode: "variable", Value: rep}
			}
			cur = &r
			continue
		}
		name, el := c.element(p)
		elements[name] = el
		if cur != nil {
			y := yInRow(p, rowY)
			cur.Spec.Layout.Spec.Items = append(cur.Spec.Layout.Spec.Items, gridItem(p, name, &y))
			continue
		}
		// panels above the first row go in a row without a header
		rowY = -1
		zero := int64(0)
		cur = &v2Kind[v2RowSpec]{Kind: "RowsLayoutRow", Spec: v2RowSpec{
			Collapse: ptr(false), Title: ptr(""), HideHeader: ptr(true),
			Layout: v2Kind[v2GridLayoutSpec]{Kind: "GridLayout", Spec: v2GridLayoutSpec{Items: []v2Kind[v2GridItemSpec]{gridItem(p, name, &zero)}}},
		}}
	}
	if cur != nil {
		rows = append(rows, *cur)
	}
	return elements, v2Kind[v2RowsLayoutSpec]{Kind: "RowsLayout", Spec: v2RowsLayoutSpec{Rows: rows}}
}

func yInRow(p map[string]any, rowY int64) int64 {
	if g, ok := mapOf(p["gridPos"]); ok {
		return int64(intField(g, "y", 0)) - rowY - 1
	}
	return 0
}

func gridItem(p map[string]any, name string, y *int64) v2Kind[v2GridItemSpec] {
	it := v2GridItemSpec{Width: 6, Height: 3, Element: v2ElementRef{Kind: "ElementReference", Name: name}}
	if g, ok := mapOf(p["gridPos"]); ok {
		it.X, it.Y = int64(intField(g, "x", 0)), int64(intField(g, "y", 0))
		it.Width, it.Height = int64(intField(g, "w", 6)), int64(intField(g, "h", 3))
	}
	if y != nil {
		it.Y = *y
	}
	if rep := str(p, "repeat"); rep != "" {
		r := &v2RepeatOptions{Mode: "variable", Value: rep}
		if dir := str(p, "repeatDirection"); dir == "h" || dir == "v" {
			r.Direction = &dir
		}
		if m := intField(p, "maxPerRow", 0); m > 0 {
			r.MaxPerRow = ptr(int64(m))
		}
		it.Repeat = r
	}
	return v2Kind[v2GridItemSpec]{Kind: "GridLayoutItem", Spec: it}
}

func (c *v2convert) element(p map[string]any) (string, any) {
	id := intField(p, "id", 0)
	name := fmt.Sprintf("panel-%d", id)
	if lp, ok := mapOf(p["libraryPanel"]); ok {
		return name, v2Kind[v2LibraryPanelSpec]{Kind: "LibraryPanel", Spec: v2LibraryPanelSpec{
			ID: float64(id), Title: str(p, "title"), LibraryPanel: v2LibraryPanelRef{UID: str(lp, "uid"), Name: str(lp, "name")},
		}}
	}
	spec := v2PanelSpec{
		ID:    float64(id),
		Title: str(p, "title"),
		Links: dataLinks(p),
		Data: v2Kind[v2QueryGroupSpec]{Kind: "QueryGroup", Spec: v2QueryGroupSpec{
			Queries: c.queries(p), Transformations: transformations(p), QueryOptions: queryOptions(p),
		}},
		VizConfig: vizConfig(p),
	}
	if s, ok := p["description"].(string); ok {
		spec.Description = &s
	}
	if boolField(p, "transparent", false) {
		spec.Transparent = ptr(true)
	}
	return name, v2Kind[v2PanelSpec]{Kind: "Panel", Spec: spec}
}

// ref is a data source reference: the uid becomes the query's datasource
// name, the type its group.
type ref struct{ uid, typ string }

func (c *v2convert) panelRef(p map[string]any) *ref {
	ds, ok := p["datasource"]
	if !ok || ds == nil {
		return nil
	}
	switch v := ds.(type) {
	case map[string]any:
		uid, typ := str(v, "uid"), str(v, "type")
		empty := uid == "" && typ == ""
		if uid != "" && typ == "" && !isVariable(uid) {
			typ = c.ds.typeOf(uid)
		}
		if !empty {
			uid = grafanaUID(typ, uid)
		}
		if typ != "" || uid != "" {
			return &ref{uid, typ}
		}
	case string:
		if isVariable(v) {
			return &ref{uid: v}
		}
		if v != "" {
			uid, typ := c.ds.byName(v)
			if uid != "" {
				return &ref{uid, typ}
			}
		}
	}
	return nil
}

func (c *v2convert) queries(p map[string]any) []v2Kind[v2PanelQuerySpec] {
	targets, ok := p["targets"].([]any)
	if !ok {
		return []v2Kind[v2PanelQuerySpec]{}
	}
	panel := c.panelRef(p)
	taken := map[string]bool{}
	for _, t := range anyMaps(targets) {
		if id := str(t, "refId"); id != "" {
			taken[id] = true
		}
	}
	for _, t := range anyMaps(targets) {
		if str(t, "refId") == "" {
			id := nextRefID(taken)
			t["refId"] = id
			taken[id] = true
		}
	}
	out := []v2Kind[v2PanelQuerySpec]{}
	for _, t := range anyMaps(targets) {
		out = append(out, c.query(t, panel))
	}
	return out
}

// nextRefID is the first of A…Z, AA… that no query has.
func nextRefID(taken map[string]bool) string {
	const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	var name func(int) string
	name = func(n int) string {
		if n < len(letters) {
			return string(letters[n])
		}
		return name(n/len(letters)-1) + string(letters[n%len(letters)])
	}
	for i := 0; ; i++ {
		if id := name(i); !taken[id] {
			return id
		}
	}
}

func (c *v2convert) query(t map[string]any, panel *ref) v2Kind[v2PanelQuerySpec] {
	refID := strOr(t, "refId", "A")
	if refID == "" {
		refID = "A"
	}
	var uid, typ string
	switch ds := t["datasource"].(type) {
	case map[string]any:
		uid, typ = str(ds, "uid"), str(ds, "type")
		if uid != "" || typ != "" {
			if uid != "" && typ == "" && !isVariable(uid) {
				typ = c.ds.typeOf(uid)
			}
			uid = grafanaUID(typ, uid)
		}
	case string:
		if isVariable(ds) {
			uid = ds
		} else if ds != "" {
			uid, typ = c.ds.byName(ds)
		}
	}
	panelUID := panel != nil && panel.uid != "" && panel.uid != "-- Mixed --"
	if panelUID && (uid == "" && typ == "" || (uid != "__expr__" && typ != "__expr__" && uid != panel.uid)) {
		if panel.typ != "" {
			typ = panel.typ
		}
		uid = panel.uid
	} else if panel != nil && panel.typ == "datasource" && uid == "" && typ == "" {
		typ, uid = "datasource", grafanaUID("datasource", "")
	}
	spec := map[string]any{}
	for k, v := range t {
		if k != "refId" && k != "hide" && k != "datasource" {
			spec[k] = v
		}
	}
	return v2Kind[v2PanelQuerySpec]{Kind: "PanelQuery", Spec: v2PanelQuerySpec{
		RefID: refID, Hidden: boolField(t, "hide", false), Query: dataQuery(spec, typ, uid, typ),
	}}
}

// dataQuery is a v2 DataQuery: the group is the reference's type, else the
// kind v2alpha1 gave the query; the datasource name is the uid.
func dataQuery(spec map[string]any, kind, uid, typ string) v2DataQuery {
	q := v2DataQuery{Kind: "DataQuery", Version: "v0", Spec: spec}
	if uid != "" {
		q.Datasource = &v2DSName{Name: ptr(uid)}
		q.Group = typ
	}
	if q.Group == "" {
		q.Group = kind
	}
	return q
}

func grafanaUID(typ, uid string) string {
	if typ == "datasource" && uid == "" {
		return "grafana"
	}
	return uid
}

func isVariable(s string) bool { return strings.HasPrefix(s, "$") }

func transformations(p map[string]any) []v2Transformation {
	out := []v2Transformation{}
	list, ok := p["transformations"].([]any)
	if !ok {
		return out
	}
	for _, t := range anyMaps(list) {
		id := str(t, "id")
		tr := v2Transformation{Kind: "Transformation", Group: id, Spec: v2TransformationSpec{Options: t["options"]}}
		if r := str(t, "refId"); r != "" {
			tr.Spec.RefID = &r
		}
		if dis, ok := t["disabled"].(bool); ok && dis {
			tr.Spec.Disabled = ptr(true)
		}
		if f, ok := mapOf(t["filter"]); ok {
			m := matcher(f)
			tr.Spec.Filter = &m
		}
		out = append(out, tr)
	}
	return out
}

func matcher(m map[string]any) v2MatcherConfig {
	mc := v2MatcherConfig{ID: str(m, "id"), Options: m["options"]}
	if s, ok := m["scope"].(string); ok {
		mc.Scope = &s
	}
	return mc
}

func queryOptions(p map[string]any) v2QueryOptions {
	o := v2QueryOptions{}
	o.CacheTimeout = nonEmpty(p, "cacheTimeout")
	if n := intField(p, "maxDataPoints", 0); n > 0 {
		o.MaxDataPoints = ptr(int64(n))
	}
	o.Interval = nonEmpty(p, "interval")
	if boolField(p, "hideTimeOverride", false) {
		o.HideTimeOverride = ptr(true)
	}
	switch v := p["queryCachingTTL"].(type) {
	case string:
		if n, err := strconv.ParseInt(v, 10, 64); v != "" && err == nil {
			o.QueryCachingTTL = &n
		}
	case float64:
		o.QueryCachingTTL = ptr(int64(v))
	}
	o.TimeFrom = nonEmpty(p, "timeFrom")
	o.TimeShift = nonEmpty(p, "timeShift")
	o.TimeCompare = nonEmpty(p, "timeCompare")
	return o
}

func dataLinks(p map[string]any) []v2DataLink {
	out := []v2DataLink{}
	for _, l := range anyMaps(p["links"]) {
		dl := v2DataLink{Title: str(l, "title"), URL: stripBOM(str(l, "url"))}
		if _, ok := l["targetBlank"]; ok {
			dl.TargetBlank = ptr(boolField(l, "targetBlank", false))
		}
		out = append(out, dl)
	}
	return out
}

// knownPanelKeys are the classic panel keys of the schema; the others are an
// old panel's own options, kept for its migration.
var knownPanelKeys = keys("type", "id", "pluginVersion", "targets", "title", "description", "transparent", "datasource",
	"gridPos", "links", "repeat", "repeatDirection", "maxPerRow", "maxDataPoints", "transformations", "interval",
	"timeFrom", "timeShift", "hideTimeOverride", "timeCompare", "libraryPanel", "cacheTimeout", "queryCachingTTL",
	"options", "fieldConfig", "autoMigrateFrom")

func vizConfig(p map[string]any) v2VizConfig {
	typ := strOr(p, "type", "timeseries")
	options := map[string]any{}
	for k, v := range mapOr(p["options"]) {
		options[k] = v
	}
	from, has := p["autoMigrateFrom"].(string)
	original := map[string]any{}
	for k, v := range p {
		if !knownPanelKeys[k] {
			original[k] = v
		}
	}
	if !has || from == "" {
		if nt := angularTarget(typ, p); nt != "" {
			from, typ = typ, nt
		} else if len(original) > 0 {
			from = typ
		}
	}
	if from != "" {
		options["__angularMigration"] = map[string]any{"autoMigrateFrom": from, "originalOptions": original}
	}
	options, _ = stripBOMs(options).(map[string]any)
	return v2VizConfig{Kind: "VizConfig", Group: typ, Version: str(p, "pluginVersion"), Spec: v2VizConfigSpec{
		Options: options, FieldConfig: fieldConfigSource(mapOr(p["fieldConfig"])),
	}}
}

func fieldConfigSource(fc map[string]any) v2FieldConfigSource {
	s := v2FieldConfigSource{Overrides: []v2Override{}}
	if d, ok := mapOf(fc["defaults"]); ok {
		s.Defaults = fieldDefaults(d)
	}
	for _, o := range anyMaps(fc["overrides"]) {
		ov := v2Override{}
		if r, ok := o["__systemRef"].(string); ok {
			ov.SystemRef = &r
		}
		if m, ok := mapOf(o["matcher"]); ok {
			ov.Matcher = matcher(m)
		}
		ov.Properties = []v2DynamicValue{}
		if props, ok := o["properties"].([]any); ok {
			for _, pr := range anyMaps(props) {
				ov.Properties = append(ov.Properties, v2DynamicValue{ID: str(pr, "id"), Value: stripBOMs(pr["value"])})
			}
		}
		s.Overrides = append(s.Overrides, ov)
	}
	return s
}

// fieldDefaults keeps Grafana's field config fields only. Grafana also sets an
// empty custom object when none is there, which the JSON leaves out.
func fieldDefaults(d map[string]any) v2FieldConfig {
	f := v2FieldConfig{}
	if c, ok := mapOf(d["color"]); ok {
		fc := &v2FieldColor{}
		fc.Mode, _ = c["mode"].(string)
		if s, ok := c["fixedColor"].(string); ok {
			fc.FixedColor = &s
		}
		if s, ok := c["seriesBy"].(string); ok {
			fc.SeriesBy = &s
		}
		f.Color = fc
	}
	if m, ok := mapOf(d["custom"]); ok {
		f.Custom = m
	}
	for k, dst := range map[string]**float64{"decimals": &f.Decimals, "max": &f.Max, "min": &f.Min} {
		if v, ok := d[k].(float64); ok {
			*dst = &v
		}
	}
	for k, dst := range map[string]**string{"description": &f.Description, "displayName": &f.DisplayName,
		"displayNameFromDS": &f.DisplayNameFromDS, "noValue": &f.NoValue, "path": &f.Path, "unit": &f.Unit, "nullValueMode": &f.NullValueMode} {
		if v, ok := d[k].(string); ok {
			*dst = &v
		}
	}
	for k, dst := range map[string]**bool{"filterable": &f.Filterable, "writeable": &f.Writeable, "fieldMinMax": &f.FieldMinMax} {
		if v, ok := d[k].(bool); ok {
			*dst = &v
		}
	}
	if l, ok := d["links"].([]any); ok {
		f.Links, _ = stripBOMs(l).([]any)
	}
	if l, ok := d["actions"].([]any); ok {
		f.Actions = actions(l)
	}
	if m, ok := d["mappings"]; ok {
		f.Mappings = valueMappings(m)
	}
	if t, ok := mapOf(d["thresholds"]); ok {
		th := &v2Thresholds{}
		th.Mode, _ = t["mode"].(string)
		th.Steps = []v2Threshold{}
		if steps, ok := t["steps"].([]any); ok {
			for _, st := range anyMaps(steps) {
				s := v2Threshold{}
				if v, ok := st["value"].(float64); ok {
					s.Value = &v
				}
				if v, ok := st["valueExpr"].(string); ok {
					s.ValueExpr = &v
				}
				s.Color, _ = st["color"].(string)
				th.Steps = append(th.Steps, s)
			}
		}
		f.Thresholds = th
	}
	return f
}

func valueMappings(v any) []any {
	var out []any
	for _, m := range anyMaps(v) {
		typ, ok := m["type"].(string)
		if !ok {
			continue
		}
		opts, isMap := mapOf(m["options"])
		switch typ {
		case "value":
			vm := &v2ValueMap{Type: "value", Options: map[string]v2MappingResult{}}
			if isMap {
				for k, r := range opts {
					if rm, ok := mapOf(r); ok {
						vm.Options[k] = mappingResult(rm)
					}
				}
			}
			out = append(out, vm)
		case "range":
			if !isMap || len(opts) == 0 || (opts["from"] == nil && opts["to"] == nil) {
				continue
			}
			rm := &v2RangeMap{Type: "range"}
			if f, ok := opts["from"].(float64); ok {
				rm.Options.From = &f
			}
			if t, ok := opts["to"].(float64); ok {
				rm.Options.To = &t
			}
			if r, ok := mapOf(opts["result"]); ok {
				rm.Options.Result = mappingResult(r)
			}
			out = append(out, rm)
		case "regex":
			if !isMap {
				continue
			}
			rx := &v2RegexMap{Type: "regex"}
			rx.Options.Pattern, _ = opts["pattern"].(string)
			if r, ok := mapOf(opts["result"]); ok {
				rx.Options.Result = mappingResult(r)
			}
			out = append(out, rx)
		case "special":
			if !isMap || len(opts) == 0 {
				continue
			}
			sm := &v2SpecialMap{Type: "special"}
			sm.Options.Match, _ = opts["match"].(string)
			if r, ok := mapOf(opts["result"]); ok {
				sm.Options.Result = mappingResult(r)
			}
			out = append(out, sm)
		}
	}
	return out
}

func mappingResult(m map[string]any) v2MappingResult {
	r := v2MappingResult{}
	if s, ok := m["text"].(string); ok {
		r.Text = &s
	}
	if s, ok := m["color"].(string); ok {
		r.Color = &s
	}
	if s, ok := m["icon"].(string); ok {
		r.Icon = &s
	}
	if f, ok := m["index"].(float64); ok {
		r.Index = ptr(int32(f))
	}
	return r
}

func actions(l []any) []v2Action {
	if len(l) == 0 {
		return nil
	}
	out := []v2Action{}
	for _, a := range anyMaps(l) {
		act := v2Action{Type: str(a, "type"), Title: str(a, "title")}
		if s, ok := a["confirmation"].(string); ok && s != "" {
			act.Confirmation = &s
		}
		if b, ok := a["oneClick"].(bool); ok {
			act.OneClick = &b
		}
		if f, ok := mapOf(a["fetch"]); ok {
			fo := &v2FetchOptions{Method: str(f, "method"), URL: str(f, "url")}
			if b, ok := f["body"].(string); ok {
				fo.Body = &b
			}
			if q, ok := f["queryParams"].([]any); ok {
				fo.QueryParams = stringPairs(q)
			}
			if h, ok := f["headers"].([]any); ok {
				fo.Headers = stringPairs(h)
			}
			act.Fetch = fo
		}
		if f, ok := mapOf(a["infinity"]); ok {
			io := &v2InfinityOptions{Method: str(f, "method"), URL: str(f, "url"), DatasourceUID: str(f, "datasourceUid")}
			if b, ok := f["body"].(string); ok {
				io.Body = &b
			}
			if q, ok := f["queryParams"].([]any); ok {
				io.QueryParams = stringPairs(q)
			}
			if h, ok := f["headers"].([]any); ok {
				io.Headers = stringPairs(h)
			}
			act.Infinity = io
		}
		if vs, ok := a["variables"].([]any); ok && len(vs) > 0 {
			for _, v := range anyMaps(vs) {
				act.Variables = append(act.Variables, v2ActionVariable{Key: str(v, "key"), Name: str(v, "name"), Type: str(v, "type")})
			}
		}
		if s, ok := mapOf(a["style"]); ok {
			st := &v2ActionStyle{}
			if b, ok := s["backgroundColor"].(string); ok {
				st.BackgroundColor = &b
			}
			act.Style = st
		}
		out = append(out, act)
	}
	return out
}

func stringPairs(l []any) [][]string {
	out := [][]string{}
	for _, x := range l {
		in, ok := x.([]any)
		if !ok {
			continue
		}
		row := []string{}
		for _, s := range in {
			if str, ok := s.(string); ok {
				row = append(row, str)
			}
		}
		out = append(out, row)
	}
	return out
}

// ---- variables ----

func (c *v2convert) variables(d map[string]any) []any {
	out := []any{}
	for _, v := range anyMaps(mapOr(d["templating"])["list"]) {
		if x := c.variable(v); x != nil {
			out = append(out, x)
		}
	}
	return out
}

type commonVar struct {
	name, hide         string
	label, description *string
	skip               bool
}

func common(v map[string]any) commonVar {
	return commonVar{name: str(v, "name"), hide: hideEnum(v["hide"]), label: nonEmpty(v, "label"),
		description: nonEmpty(v, "description"), skip: boolField(v, "skipUrlSync", false)}
}

func (c *v2convert) variable(v map[string]any) any {
	cv := common(v)
	switch str(v, "type") {
	case "query":
		uid, typ := c.variableRef(v, false)
		q := v2QueryVariableSpec{
			Name: cv.name, Label: cv.label, Description: cv.description, Hide: cv.hide, SkipURLSync: cv.skip,
			Current: current(v["current"]), Multi: boolField(v, "multi", false), IncludeAll: boolField(v, "includeAll", false),
			Refresh: refreshEnum(v["refresh"]), Sort: sortEnum(v["sort"]), Regex: str(v, "regex"),
			RegexApplyTo: nonEmpty(v, "regexApplyTo"), AllowCustomValue: boolField(v, "allowCustomValue", true),
			Options: options(v["options"]), StaticOptions: options(v["staticOptions"]),
			Query: dataQuery(v2VariableQuery(v["query"]), typ, uid, typ),
		}
		if def, ok := v["definition"].(string); ok {
			q.Definition = &def
		}
		if o, ok := v["staticOptionsOrder"].(string); ok && (o == "before" || o == "after" || o == "sorted") {
			q.StaticOptionsOrder = &o
		}
		q.AllValue = nonEmpty(v, "allValue")
		return v2Kind[v2QueryVariableSpec]{Kind: "QueryVariable", Spec: q}
	case "datasource":
		plugin := c.ds.defaultType()
		if s, ok := v["query"].(string); ok {
			plugin = s
		}
		return v2Kind[v2DatasourceVariableSpec]{Kind: "DatasourceVariable", Spec: v2DatasourceVariableSpec{
			Name: cv.name, Label: cv.label, Description: cv.description, Hide: cv.hide, SkipURLSync: cv.skip,
			PluginID: plugin, Current: current(v["current"]), Multi: boolField(v, "multi", false),
			IncludeAll: boolField(v, "includeAll", false), Refresh: refreshEnum(v["refresh"]), Regex: str(v, "regex"),
			AllowCustomValue: boolField(v, "allowCustomValue", true), Options: options(v["options"]), AllValue: nonEmpty(v, "allValue"),
		}}
	case "custom":
		s := v2CustomVariableSpec{
			Name: cv.name, Label: cv.label, Description: cv.description, Hide: cv.hide, SkipURLSync: cv.skip,
			Query: str(v, "query"), Current: current(v["current"]), Multi: boolField(v, "multi", false),
			IncludeAll: boolField(v, "includeAll", false), AllowCustomValue: boolField(v, "allowCustomValue", true),
			Options: options(v["options"]), AllValue: nonEmpty(v, "allValue"),
		}
		if f := str(v, "valuesFormat"); f == "json" || f == "csv" {
			s.ValuesFormat = &f
		}
		return v2Kind[v2CustomVariableSpec]{Kind: "CustomVariable", Spec: s}
	case "adhoc":
		uid, typ := c.variableRef(v, false)
		s := v2AdhocVariableSpec{
			Name: cv.name, Label: cv.label, Description: cv.description, Hide: cv.hide, SkipURLSync: cv.skip,
			AllowCustomValue: boolField(v, "allowCustomValue", true),
			BaseFilters:      []v2AdhocFilter{}, Filters: []v2AdhocFilter{}, DefaultKeys: []v2MetricValue{},
		}
		if b, ok := v["enableGroupBy"].(bool); ok {
			s.EnableGroupBy = &b
		}
		if l, ok := v["baseFilters"].([]any); ok {
			s.BaseFilters = adhocFilters(l)
		}
		if l, ok := v["filters"].([]any); ok {
			s.Filters = adhocFilters(l)
		}
		if l, ok := v["defaultKeys"].([]any); ok {
			s.DefaultKeys = metricValues(l)
		}
		out := v2DSVariable[v2AdhocVariableSpec]{Kind: "AdhocVariable", Datasource: &v2DSName{}, Spec: s}
		if uid != "" {
			out.Group, out.Datasource.Name = typ, ptr(uid)
		}
		return out
	case "constant":
		return v2Kind[v2ConstantVariableSpec]{Kind: "ConstantVariable", Spec: constantVariable(v, cv)}
	case "interval":
		return v2Kind[v2IntervalVariableSpec]{Kind: "IntervalVariable", Spec: intervalVariable(v, cv)}
	case "textbox":
		return v2Kind[v2TextVariableSpec]{Kind: "TextVariable", Spec: v2TextVariableSpec{
			Name: cv.name, Label: cv.label, Description: cv.description, Hide: cv.hide, SkipURLSync: cv.skip,
			Query: str(v, "query"), Current: current(v["current"]),
		}}
	case "switch":
		return v2Kind[v2SwitchVariableSpec]{Kind: "SwitchVariable", Spec: switchVariable(v, cv)}
	case "groupby":
		uid, typ := c.variableRef(v, true)
		s := v2GroupByVariableSpec{
			Name: cv.name, Label: cv.label, Description: cv.description, Hide: cv.hide, SkipURLSync: cv.skip,
			Current: current(v["current"]), Multi: boolField(v, "multi", true), Options: options(v["options"]),
		}
		if dv, ok := mapOf(v["defaultValue"]); ok {
			o := current(dv)
			s.DefaultValue = &o
		}
		if uid == "" || typ == "" {
			// Grafana's v2alpha1 → v2beta1 step reads the reference's type without a check and fails
			c.err = fmt.Errorf("group by variable %q has no data source of a known type, which Grafana 13.3.0 cannot convert to v2", cv.name)
			return nil
		}
		return v2DSVariable[v2GroupByVariableSpec]{Kind: "GroupByVariable", Group: typ, Datasource: &v2DSName{Name: ptr(uid)}, Spec: s}
	}
	return nil // Grafana skips a variable of another type
}

// variableRef is the data source of a query, ad hoc or group by variable.
func (c *v2convert) variableRef(v map[string]any, groupBy bool) (uid, typ string) {
	switch ds := v["datasource"].(type) {
	case map[string]any:
		uid, typ = str(ds, "uid"), str(ds, "type")
		if uid != "" && typ == "" && !isVariable(uid) {
			typ = c.ds.typeOf(uid)
		} else if uid == "" && typ == "" {
			typ = c.ds.defaultType()
		}
		if groupBy {
			uid = grafanaUID(typ, uid)
		}
	case string:
		if isVariable(ds) {
			uid = ds
		} else if ds != "" {
			uid, typ = c.ds.byName(ds)
		} else {
			typ = c.ds.defaultType()
		}
	default:
		typ = c.ds.defaultType()
	}
	return uid, typ
}

// v2VariableQuery is a variable's query as a DataQuery spec: an object as it
// is, a string under __legacyStringValue.
func v2VariableQuery(q any) map[string]any {
	switch v := q.(type) {
	case map[string]any:
		return v
	case string:
		if v != "" {
			return map[string]any{"__legacyStringValue": v}
		}
	}
	return map[string]any{}
}

func constantVariable(v map[string]any, cv commonVar) v2ConstantVariableSpec {
	s := v2ConstantVariableSpec{Name: cv.name, Label: cv.label, Description: cv.description, Hide: cv.hide, SkipURLSync: cv.skip}
	q, hasQuery := v["query"]
	if hasQuery {
		s.Query, _ = q.(string)
	}
	switch cur, ok := v["current"]; {
	case ok && cur != nil:
		s.Current = current(cur)
	case hasQuery && q != nil:
		qs, _ := q.(string)
		s.Current = v2Option{Text: text(qs), Value: text(qs)}
	default:
		s.Current = v2Option{Text: text(""), Value: text("")}
	}
	return s
}

func intervalVariable(v map[string]any, cv commonVar) v2IntervalVariableSpec {
	q := str(v, "query")
	if q == "" {
		var vals []string
		for _, o := range anyMaps(v["options"]) {
			if val, ok := o["value"]; ok {
				if s, ok := val.(string); ok && s != "" {
					vals = append(vals, s)
				}
			} else if t, ok := o["text"].(string); ok && t != "" {
				vals = append(vals, t)
			}
		}
		q = strings.Join(vals, ",")
	}
	return v2IntervalVariableSpec{
		Name: cv.name, Label: cv.label, Description: cv.description, Hide: cv.hide, SkipURLSync: cv.skip,
		Query: q, Current: current(v["current"]), Refresh: "onTimeRangeChanged", Auto: boolField(v, "auto", false),
		AutoMin: str(v, "auto_min"), AutoCount: int64(intField(v, "auto_count", 0)), Options: options(v["options"]),
	}
}

func switchVariable(v map[string]any, cv commonVar) v2SwitchVariableSpec {
	optionValue := func(o map[string]any) string {
		if s, ok := o["value"].(string); ok && s != "" {
			return s
		}
		if s, ok := o["text"].(string); ok && s != "" {
			return s
		}
		return ""
	}
	cur := ""
	if m, ok := mapOf(v["current"]); ok {
		cur = optionValue(m)
	}
	on, off := "true", "false"
	opts := anyMaps(v["options"])
	if len(opts) > 0 {
		if s := optionValue(opts[0]); s != "" {
			on = s
		}
	}
	if len(opts) > 1 {
		if s := optionValue(opts[1]); s != "" {
			off = s
		}
	}
	if cur == "" {
		cur = off
	}
	return v2SwitchVariableSpec{Name: cv.name, Label: cv.label, Description: cv.description, Hide: cv.hide, SkipURLSync: cv.skip,
		Current: cur, EnabledValue: on, DisabledValue: off}
}

func adhocFilters(l []any) []v2AdhocFilter {
	out := []v2AdhocFilter{}
	for _, f := range anyMaps(l) {
		origin := str(f, "origin")
		if origin != "" && origin != "dashboard" {
			continue
		}
		af := v2AdhocFilter{Key: str(f, "key"), Operator: strOr(f, "operator", "="), Value: str(f, "value")}
		if origin == "dashboard" {
			af.Origin = &origin
		}
		af.KeyLabel = nonEmpty(f, "keyLabel")
		af.Condition = nonEmpty(f, "condition")
		if vs := strList(f, "values"); len(vs) > 0 {
			af.Values = vs
		}
		if vs := strList(f, "valueLabels"); len(vs) > 0 {
			af.ValueLabels = vs
		}
		out = append(out, af)
	}
	return out
}

func metricValues(l []any) []v2MetricValue {
	out := []v2MetricValue{}
	for _, x := range l {
		switch v := x.(type) {
		case map[string]any:
			if t := str(v, "text"); t != "" {
				out = append(out, v2MetricValue{Text: t, Value: ptr(t)})
			}
		case string:
			out = append(out, v2MetricValue{Text: v, Value: ptr(v)})
		}
	}
	return out
}

func text(s string) v2Text { return v2Text{s: &s} }

// v2TextOf is buildStringOrArrayOfString.
func v2TextOf(v any) v2Text {
	switch x := v.(type) {
	case string:
		return text(x)
	case []any:
		l := []string{}
		for _, e := range x {
			if s, ok := e.(string); ok {
				l = append(l, s)
			}
		}
		return v2Text{list: l}
	case map[string]any:
		if s, ok := x["__legacyStringValue"].(string); ok {
			return text(s)
		}
	}
	return text("")
}

func current(v any) v2Option {
	if m, ok := mapOf(v); ok {
		return v2Option{Text: v2TextOf(m["text"]), Value: v2TextOf(m["value"])}
	}
	return v2Option{Text: text(""), Value: text("")}
}

func options(v any) []v2Option {
	out := []v2Option{}
	for _, o := range anyMaps(v) {
		out = append(out, v2Option{Text: v2TextOf(o["text"]), Value: v2TextOf(o["value"]), Selected: ptr(boolField(o, "selected", false))})
	}
	return out
}

func hideEnum(v any) string {
	switch x := v.(type) {
	case float64:
		if s := map[int]string{1: "hideLabel", 2: "hideVariable", 3: "inControlsMenu"}[int(x)]; s != "" {
			return s
		}
	case string:
		switch x {
		case "hideLabel", "hideVariable", "inControlsMenu":
			return x
		}
	}
	return "dontHide"
}

func refreshEnum(v any) string {
	switch x := v.(type) {
	case float64:
		if s := map[int]string{1: "onDashboardLoad", 2: "onTimeRangeChanged"}[int(x)]; s != "" {
			return s
		}
	case string:
		if x == "onDashboardLoad" || x == "onTimeRangeChanged" {
			return x
		}
	}
	return "never"
}

func sortEnum(v any) string {
	switch x := v.(type) {
	case float64:
		if s := map[int]string{1: "alphabeticalAsc", 2: "alphabeticalDesc", 3: "numericalAsc", 4: "numericalDesc"}[int(x)]; s != "" {
			return s
		}
	case string:
		switch x {
		case "alphabeticalAsc", "alphabeticalDesc", "numericalAsc", "numericalDesc", "alphabeticalCaseInsensitiveAsc",
			"alphabeticalCaseInsensitiveDesc", "naturalAsc", "naturalDesc":
			return x
		}
	}
	return "disabled"
}

// ---- annotations ----

func annotations(d map[string]any) []v2AnnotationKind {
	out := []v2AnnotationKind{}
	for _, a := range anyMaps(mapOr(d["annotations"])["list"]) {
		out = append(out, annotation(a))
	}
	return out
}

func annotation(a map[string]any) v2AnnotationKind {
	var uid, typ string
	if ds, ok := mapOf(a["datasource"]); ok {
		uid, typ = str(ds, "uid"), str(ds, "type")
	}
	spec := map[string]any{}
	if t, ok := mapOf(a["target"]); ok {
		spec = t
	}
	q := v2DataQuery{Kind: "DataQuery", Version: "v0", Spec: spec, Group: typ}
	if uid != "" && typ != "" {
		q.Datasource = &v2DSName{Name: ptr(uid)}
	}
	s := v2AnnotationSpec{
		Name: str(a, "name"), Query: q, Enable: boolField(a, "enable", false), Hide: boolField(a, "hide", false),
		IconColor: str(a, "iconColor"),
	}
	switch b := a["builtIn"].(type) {
	case float64:
		s.BuiltIn = ptr(b != 0)
	case bool:
		s.BuiltIn = &b
	}
	if f, ok := mapOf(a["filter"]); ok {
		af := &v2AnnotationFilter{IDs: []float64{}}
		if boolField(f, "exclude", false) {
			af.Exclude = ptr(true)
		}
		if ids, ok := f["ids"].([]any); ok {
			for _, id := range ids {
				if n, ok := id.(float64); ok {
					af.IDs = append(af.IDs, n)
				}
			}
		}
		s.Filter = af
	}
	if m, ok := mapOf(a["mappings"]); ok {
		s.Mappings = eventMappings(m)
	}
	legacy := map[string]any{}
	if t := str(a, "type"); t != "" {
		legacy["type"] = t
	}
	for k, v := range a {
		switch k {
		case "name", "datasource", "enable", "hide", "iconColor", "filter", "target", "builtIn", "type", "mappings":
		default:
			legacy[k] = v
		}
	}
	if len(legacy) > 0 {
		s.LegacyOptions = legacy
	}
	return v2AnnotationKind{Kind: "AnnotationQuery", Spec: s}
}

func eventMappings(m map[string]any) map[string]v2EventMapping {
	out := map[string]v2EventMapping{}
	for k, v := range m {
		if s, ok := v.(string); ok && s != "" {
			out[k] = v2EventMapping{Source: ptr("field"), Value: ptr(s)}
			continue
		}
		mm, ok := mapOf(v)
		if !ok {
			continue
		}
		em := v2EventMapping{Source: ptr("field")}
		if s, ok := mm["source"].(string); ok && s != "" {
			em.Source = &s
		}
		em.Value = nonEmpty(mm, "value")
		em.Regex = nonEmpty(mm, "regex")
		out[k] = em
	}
	return out
}

// ---- values ----

func ptr[T any](v T) *T { return &v }

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func strOr(m map[string]any, k, def string) string {
	if s, ok := m[k].(string); ok {
		return s
	}
	return def
}

func nonEmpty(m map[string]any, k string) *string {
	if s, ok := m[k].(string); ok && s != "" {
		return &s
	}
	return nil
}

func strList(m map[string]any, k string) []string {
	out := []string{}
	l, ok := m[k].([]any)
	if !ok {
		return out
	}
	for _, x := range l {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func boolField(m map[string]any, k string, def bool) bool {
	if b, ok := m[k].(bool); ok {
		return b
	}
	return def
}

func intField(m map[string]any, k string, def int) int {
	switch v := m[k].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func stripBOM(s string) string { return strings.ReplaceAll(s, "\ufeff", "") }

func stripBOMs(v any) any {
	switch x := v.(type) {
	case string:
		return stripBOM(x)
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = stripBOMs(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = stripBOMs(e)
		}
		return out
	}
	return v
}
