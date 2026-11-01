// Package grafana imports a Grafana classic/v1 dashboard JSON into the
// dashboards model without losing anything: every key of every object it
// reads is either carried into a model field (mapped), kept in the Ext map of
// the object it came from (preserved), or left out on purpose (dropped — only
// Grafana's database id). The whole original also stays in Source.Raw. The
// Report says which, so the screen can show what will and will not be drawn.
package grafana

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// MinSchemaVersion is the oldest Grafana dashboard schema imported directly:
// 16 (Grafana 5.0) moved panels to the grid. Older files are opened and saved
// once in Grafana, which upgrades them, then imported.
const MinSchemaVersion = 16

// resourceGroup prefixes the apiVersion of a dashboard Grafana serves as a resource.
const resourceGroup = "dashboard.grafana.app/"

var (
	ErrNotJSON     = errors.New("not a JSON object")
	ErrNoPanels    = errors.New("not a Grafana dashboard: no panels")
	ErrTooOld      = fmt.Errorf("dashboard schemaVersion is below %d: open it in Grafana and save it once, then export it again", MinSchemaVersion)
	ErrNotV1Schema = errors.New("this is a Grafana dashboard schema v2 document, which is not imported yet: export it from Grafana as Classic or V1 Resource")
)

// Report is what Import did with the source.
type Report struct {
	Panels      int       `json:"panels"`
	Preserved   []string  `json:"preserved"`   // paths kept in an Ext map
	Dropped     []string  `json:"dropped"`     // paths left out on purpose
	Adjusted    []Finding `json:"adjusted"`    // values changed to fit the model
	Unsupported []Finding `json:"unsupported"` // kept, but the console will not draw or run them

	accounted map[string]string // every object key read: "mapped", "preserved" or "dropped"
}

type Finding struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// Accounted reports how one source key path was handled ("" if it was not read).
func (r *Report) Accounted(path string) string { return r.accounted[path] }

type obj = map[string]json.RawMessage

// Import converts a Grafana v1 dashboard. It accepts the dashboard itself or an
// API envelope ({"dashboard": {...}, "meta": {...}}).
func Import(raw []byte) (*model.Dashboard, *Report, error) {
	var root obj
	if err := json.Unmarshal(raw, &root); err != nil || root == nil {
		return nil, nil, ErrNotJSON
	}
	if inner, ok := root["dashboard"]; ok {
		if err := json.Unmarshal(inner, &root); err != nil || root == nil {
			return nil, nil, ErrNotJSON
		}
		raw = inner
	}
	// Grafana 12 and later serve a dashboard as a Kubernetes-style resource:
	// apiVersion dashboard.grafana.app/<version>, metadata and spec. In
	// v0alpha1, v1beta1 and v1 the spec is the classic dashboard; v2alpha1,
	// v2beta1 and v2 hold the new schema (Grafana 13's default export).
	var envelope obj
	if av := strOf(root["apiVersion"]); strings.HasPrefix(av, resourceGroup) {
		if strings.HasPrefix(strings.TrimPrefix(av, resourceGroup), "v2") {
			return nil, nil, ErrNotV1Schema
		}
		var spec obj
		if err := json.Unmarshal(root["spec"], &spec); err != nil || spec == nil {
			return nil, nil, ErrNoPanels
		}
		envelope, root = root, spec
	}
	sv := intOf(root["schemaVersion"])
	if sv > 0 && sv < MinSchemaVersion {
		return nil, nil, ErrTooOld
	}
	if _, ok := root["panels"]; !ok {
		switch {
		case root["elements"] != nil:
			return nil, nil, ErrNotV1Schema
		case root["rows"] != nil:
			return nil, nil, ErrTooOld // pre-grid layout without a schemaVersion
		}
		return nil, nil, ErrNoPanels
	}

	im := &importer{rep: &Report{accounted: map[string]string{}}, dsVars: map[string]string{}, names: map[string]bool{}}
	d := im.dashboard(root)
	uid := strOf(root["uid"])
	if envelope != nil {
		// The envelope is the Grafana instance's record of the dashboard (its
		// name, resource version, who changed it); source.raw keeps all of it.
		for k := range envelope {
			if k == "spec" {
				im.mark(k, "mapped")
				continue
			}
			im.mark(k, "dropped")
			im.rep.Dropped = append(im.rep.Dropped, k)
		}
		if uid == "" {
			var meta obj
			_ = json.Unmarshal(envelope["metadata"], &meta)
			uid = strOf(meta["name"])
		}
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err == nil {
		raw = compact.Bytes()
	}
	d.Source = &model.Source{Kind: model.SourceGrafanaV1, SchemaVersion: sv, UID: uid, Raw: json.RawMessage(raw)}
	sort.Strings(im.rep.Preserved)
	sort.Strings(im.rep.Dropped)
	return d, im.rep, nil
}

type importer struct {
	rep    *Report
	dsVars map[string]string // data source variable name → store
	names  map[string]bool   // panel names taken
}

var dashboardKeys = keys("uid", "id", "title", "tags", "description", "timezone", "graphTooltip", "time", "refresh",
	"templating", "annotations", "links", "panels", "schemaVersion", "version")

func (im *importer) dashboard(root obj) *model.Dashboard {
	d := &model.Dashboard{APIVersion: model.APIVersion, Kind: model.Kind}
	d.Spec.Ext = im.split(root, dashboardKeys, "", map[string]bool{"id": true})
	d.Metadata.Title = strOf(root["title"])
	if d.Metadata.Title == "" {
		d.Metadata.Title = "Imported dashboard"
	}
	d.Metadata.Name = slug(d.Metadata.Title)
	d.Metadata.Description = strOf(root["description"])
	_ = json.Unmarshal(root["tags"], &d.Metadata.Tags)
	d.Metadata.Scope.Cluster = "*"

	d.Spec.Timezone = strOf(root["timezone"])
	if d.Spec.Timezone == "" {
		d.Spec.Timezone = "browser"
	}
	d.Spec.CursorSync = map[int]string{0: model.CursorSyncNone, 1: model.CursorSyncShared, 2: model.CursorSyncSharedTooltip}[intOf(root["graphTooltip"])]
	d.Spec.Time = model.TimeRange{From: "now-6h", To: "now"}
	if t, ok := asObj(root["time"]); ok {
		if v := strOf(t["from"]); v != "" {
			d.Spec.Time.From = v
		}
		if v := strOf(t["to"]); v != "" {
			d.Spec.Time.To = v
		}
		for k := range t {
			if k != "from" && k != "to" {
				d.Spec.Ext["time."+k] = t[k]
				im.mark("time."+k, "preserved")
			} else {
				im.mark("time."+k, "mapped")
			}
		}
	}
	d.Spec.Refresh = im.refresh(strOf(root["refresh"]), d.Spec.Ext)

	if tpl, ok := asObj(root["templating"]); ok {
		im.mark("templating.list", "mapped")
		var list []json.RawMessage
		_ = json.Unmarshal(tpl["list"], &list)
		// Data source variables first, so queries that name them resolve.
		for _, raw := range list {
			if v, ok := asObj(raw); ok && strOf(v["type"]) == "datasource" {
				im.dsVars[strOf(v["name"])] = storeOfType(strOf(v["query"]))
			}
		}
		for i, raw := range list {
			if v, ok := asObj(raw); ok {
				d.Spec.Variables = append(d.Spec.Variables, im.variable(v, fmt.Sprintf("templating.list[%d]", i)))
			}
		}
		for k := range tpl {
			if k != "list" {
				d.Spec.Ext["templating."+k] = tpl[k]
				im.mark("templating."+k, "preserved")
			}
		}
	}

	d.Spec.Panels = map[string]model.Panel{}
	var panels []json.RawMessage
	_ = json.Unmarshal(root["panels"], &panels)
	im.panels(panels, d)

	if ann, ok := asObj(root["annotations"]); ok {
		var list []json.RawMessage
		_ = json.Unmarshal(ann["list"], &list)
		im.mark("annotations.list", "mapped")
		for i, raw := range list {
			if a, ok := asObj(raw); ok {
				if an, keep := im.annotation(a, fmt.Sprintf("annotations.list[%d]", i)); keep {
					d.Spec.Annotations = append(d.Spec.Annotations, an)
				}
			}
		}
		for k := range ann {
			if k != "list" {
				d.Spec.Ext["annotations."+k] = ann[k]
				im.mark("annotations."+k, "preserved")
			}
		}
	}

	var links []json.RawMessage
	_ = json.Unmarshal(root["links"], &links)
	for i, raw := range links {
		path := fmt.Sprintf("links[%d]", i)
		l, ok := asObj(raw)
		if !ok {
			continue
		}
		if strOf(l["type"]) == "dashboards" {
			// A link to dashboards by tag: kept whole until the dashboard list exists (v1).
			d.Spec.Ext[path] = raw
			im.markAll(l, path, "preserved")
			im.unsupported(path, "links to dashboards by tag are kept but not shown yet")
			continue
		}
		ext := im.split(l, keys("title", "url", "targetBlank", "type"), path, nil)
		for k, v := range ext {
			d.Spec.Ext[path+"."+k] = v
		}
		d.Spec.Links = append(d.Spec.Links, model.Link{Title: strOf(l["title"]), URL: strOf(l["url"]), NewTab: boolOf(l["targetBlank"])})
	}
	if len(d.Spec.Ext) == 0 {
		d.Spec.Ext = nil
	}
	return d
}

func (im *importer) refresh(r string, ext obj) string {
	if r == "" {
		return ""
	}
	secs, ok := model.RefreshSeconds(r)
	if !ok {
		ext["refresh"] = mustJSON(r)
		im.adjusted("refresh", fmt.Sprintf("%q is not a refresh interval; auto refresh is off (original kept)", r))
		return ""
	}
	if secs < model.MinRefreshSeconds {
		ext["refresh"] = mustJSON(r)
		im.adjusted("refresh", fmt.Sprintf("%s raised to %ds, the shortest refresh (original kept)", r, model.MinRefreshSeconds))
		return fmt.Sprintf("%ds", model.MinRefreshSeconds)
	}
	return r
}

// ---- panels and layout ----

func (im *importer) panels(list []json.RawMessage, d *model.Dashboard) {
	var row *model.LayoutRow // the open (expanded) row panels after it belong to
	for i, raw := range list {
		path := fmt.Sprintf("panels[%d]", i)
		p, ok := asObj(raw)
		if !ok {
			continue
		}
		if strOf(p["type"]) == "row" {
			r := im.row(p, path, d)
			d.Spec.Layout.Rows = append(d.Spec.Layout.Rows, r)
			row = &d.Spec.Layout.Rows[len(d.Spec.Layout.Rows)-1]
			if r.Collapsed {
				row = nil // a folded row holds its panels inside it
			}
			continue
		}
		name, panel, item := im.panel(p, path)
		d.Spec.Panels[name] = panel
		if row != nil {
			row.Items = append(row.Items, item)
		} else {
			d.Spec.Layout.Items = append(d.Spec.Layout.Items, item)
		}
	}
}

var rowKeys = keys("type", "title", "collapsed", "gridPos", "panels", "repeat", "id")

func (im *importer) row(p obj, path string, d *model.Dashboard) model.LayoutRow {
	ext := im.split(p, rowKeys, path, nil)
	for k, v := range ext {
		if d.Spec.Ext == nil {
			d.Spec.Ext = obj{}
		}
		d.Spec.Ext[path+"."+k] = v
	}
	r := model.LayoutRow{Title: strOf(p["title"]), Collapsed: boolOf(p["collapsed"]), Repeat: strOf(p["repeat"])}
	if g, ok := asObj(p["gridPos"]); ok {
		r.Y = intOf(g["y"])
	}
	var inner []json.RawMessage
	_ = json.Unmarshal(p["panels"], &inner)
	for j, raw := range inner {
		if ip, ok := asObj(raw); ok {
			name, panel, item := im.panel(ip, fmt.Sprintf("%s.panels[%d]", path, j))
			d.Spec.Panels[name] = panel
			r.Items = append(r.Items, item)
		}
	}
	return r
}

var panelKeys = keys("id", "type", "title", "description", "gridPos", "targets", "datasource", "fieldConfig", "options",
	"transformations", "repeat", "repeatDirection", "maxPerRow", "libraryPanel")

// legacyKinds are old Grafana panel types and the core panel Grafana itself
// migrates them to when a dashboard loads.
var legacyKinds = map[string]string{
	"graph": "timeseries", "singlestat": "stat", "table-old": "table",
	"grafana-singlestat-panel": "stat", "grafana-piechart-panel": "piechart", "grafana-worldmap-panel": "geomap",
}

func (im *importer) panel(p obj, path string) (string, model.Panel, model.LayoutItem) {
	im.rep.Panels++
	out := model.Panel{Title: strOf(p["title"]), Description: strOf(p["description"])}
	out.Ext = im.split(p, panelKeys, path, nil)
	if raw, ok := p["datasource"]; ok && string(raw) != "null" {
		out.Ext["datasource"] = raw // the instance reference, kept for a later export
	}

	typ := strOf(p["type"])
	switch {
	case model.PanelKinds[typ] && typ != model.Unsupported:
		out.Kind = typ
	case legacyKinds[typ] != "":
		out.Kind = legacyKinds[typ]
		out.Ext["legacyType"] = mustJSON(typ)
		im.adjusted(path+".type", fmt.Sprintf("%s is drawn as %s, as Grafana migrates it; its old settings are kept", typ, out.Kind))
	case typ == "" && p["libraryPanel"] != nil:
		out.Kind = model.Unsupported
		im.unsupported(path, "library panel that was not inlined: export the dashboard with \"Export for sharing externally\"")
	default:
		out.Kind = model.Unsupported
		out.Ext["pluginType"] = mustJSON(typ)
		im.unsupported(path, fmt.Sprintf("Grafana plugin panel %q is kept but not drawn", typ))
	}
	if raw, ok := p["libraryPanel"]; ok {
		out.Ext["libraryPanel"] = raw
	}

	panelStore, _ := im.storeOf(p["datasource"], path+".datasource")
	var targets []json.RawMessage
	_ = json.Unmarshal(p["targets"], &targets)
	var queryPaths []string
	for j, raw := range targets {
		if t, ok := asObj(raw); ok {
			qp := fmt.Sprintf("%s.targets[%d]", path, j)
			out.Queries = append(out.Queries, im.query(t, qp, panelStore))
			queryPaths = append(queryPaths, qp)
		}
	}
	im.nameQueries(out.Queries, queryPaths)

	if fc, ok := asObj(p["fieldConfig"]); ok {
		im.fieldConfig(fc, path+".fieldConfig", &out)
	}
	if raw, ok := p["options"]; ok && string(raw) != "null" {
		out.Options = raw
	}
	var transforms []json.RawMessage
	_ = json.Unmarshal(p["transformations"], &transforms)
	for j, raw := range transforms {
		if t, ok := asObj(raw); ok {
			out.Transforms = append(out.Transforms, im.transform(t, fmt.Sprintf("%s.transformations[%d]", path, j)))
		}
	}
	if v := strOf(p["repeat"]); v != "" {
		out.Repeat = &model.Repeat{Variable: v, Direction: strOf(p["repeatDirection"]), MaxPerRow: intOf(p["maxPerRow"])}
	}

	item := model.LayoutItem{W: 12, H: 8}
	if g, ok := asObj(p["gridPos"]); ok {
		item.X, item.Y, item.W, item.H = intOf(g["x"]), intOf(g["y"]), intOf(g["w"]), intOf(g["h"])
		if item.W < 1 {
			item.W = 12
		}
		if item.H < 1 {
			item.H = 8
		}
	}
	if len(out.Ext) == 0 {
		out.Ext = nil
	}
	item.Panel = im.panelName(p, out.Title)
	return item.Panel, out, item
}

func (im *importer) panelName(p obj, title string) string {
	base := ""
	if id := intOf(p["id"]); id > 0 {
		base = fmt.Sprintf("p%d", id)
	} else if s := slug(title); s != "imported" {
		base = s
	} else {
		base = "panel"
	}
	name := base
	for n := 2; im.names[name]; n++ {
		name = fmt.Sprintf("%s-%d", base, n)
	}
	im.names[name] = true
	return name
}

var targetKeys = keys("refId", "expr", "query", "legendFormat", "instant", "interval", "hide", "datasource")

func (im *importer) query(t obj, path, panelStore string) model.Query {
	q := model.Query{RefID: strOf(t["refId"]), Legend: strOf(t["legendFormat"]), Instant: boolOf(t["instant"]), MinStep: strOf(t["interval"]), Hide: boolOf(t["hide"])}
	q.Ext = im.split(t, targetKeys, path, nil)
	store := panelStore
	if raw, ok := t["datasource"]; ok && string(raw) != "null" {
		q.Ext["datasource"] = raw
		if s, known := im.storeOf(raw, path+".datasource"); known {
			store = s
		}
	}
	q.Store = store
	switch store {
	case model.StoreTempo:
		q.Expr = strOf(t["query"]) // TraceQL
		if raw, ok := t["expr"]; ok {
			q.Ext["expr"] = raw
		}
	default:
		q.Expr = strOf(t["expr"])
		if raw, ok := t["query"]; ok {
			q.Ext["query"] = raw
		}
	}
	if store == "" {
		im.unsupported(path, "data source the console has no store for; the query is kept but not run")
	}
	if len(q.Ext) == 0 {
		q.Ext = nil
	}
	return q
}

var fieldConfigKeys = keys("defaults", "overrides")
var defaultsKeys = keys("unit", "min", "max", "decimals", "displayName", "color", "thresholds", "mappings", "noValue", "links")

func (im *importer) fieldConfig(fc obj, path string, out *model.Panel) {
	for k, v := range im.split(fc, fieldConfigKeys, path, nil) {
		out.Ext["fieldConfig."+k] = v
	}
	if def, ok := asObj(fc["defaults"]); ok {
		dp := path + ".defaults"
		for k, v := range im.split(def, defaultsKeys, dp, nil) {
			out.Ext["fieldConfig.defaults."+k] = v // custom (per-visualization options) lands here
		}
		f := &out.FieldDefaults
		f.Unit, f.DisplayName, f.NoValue = strOf(def["unit"]), strOf(def["displayName"]), strOf(def["noValue"])
		f.Min, f.Max = floatPtr(def["min"]), floatPtr(def["max"])
		if v := floatPtr(def["decimals"]); v != nil {
			n := int(*v)
			f.Decimals = &n
		}
		_ = json.Unmarshal(def["mappings"], &f.Mappings)
		var links []obj
		_ = json.Unmarshal(def["links"], &links)
		for _, l := range links {
			f.Links = append(f.Links, model.Link{Title: strOf(l["title"]), URL: strOf(l["url"]), NewTab: boolOf(l["targetBlank"])})
		}
		if c, ok := asObj(def["color"]); ok {
			f.Color = &model.Color{Mode: strOf(c["mode"])}
			if fixed := strOf(c["fixedColor"]); fixed != "" {
				token, exact := Token(fixed)
				f.Color.Token = token
				if !exact {
					out.Ext["fieldConfig.defaults.color"] = def["color"]
					im.adjusted(dp+".color.fixedColor", fmt.Sprintf("%s drawn as the theme colour %s (original kept)", fixed, token))
				}
			}
		}
		if th, ok := asObj(def["thresholds"]); ok {
			t := &model.Thresholds{Mode: strOf(th["mode"])}
			if t.Mode != "percentage" && t.Mode != "absolute" {
				// Grafana draws every mode but percentage as absolute (thresholds.ts, v13.3.0).
				if t.Mode != "" {
					out.Ext["fieldConfig.defaults.thresholds.mode"] = th["mode"]
				}
				im.adjusted(dp+".thresholds.mode", fmt.Sprintf("mode %q read as absolute, as Grafana draws it", t.Mode))
				t.Mode = "absolute"
			}
			var steps []obj
			_ = json.Unmarshal(th["steps"], &steps)
			changed := false
			for _, s := range steps {
				token, exact := Token(strOf(s["color"]))
				if token == "" {
					token = "neutral"
				}
				changed = changed || !exact
				t.Steps = append(t.Steps, model.ThresholdStep{Value: floatPtr(s["value"]), Color: token})
			}
			if changed {
				out.Ext["fieldConfig.defaults.thresholds"] = def["thresholds"]
				im.adjusted(dp+".thresholds", "threshold colours drawn as the nearest theme colours (original kept)")
			}
			f.Thresholds = t
		}
	}
	var overrides []obj
	_ = json.Unmarshal(fc["overrides"], &overrides)
	for i, o := range overrides {
		op := fmt.Sprintf("%s.overrides[%d]", path, i)
		im.markObj(o, op, keys("matcher", "properties"))
		var m obj
		_ = json.Unmarshal(o["matcher"], &m)
		kind := map[string]string{"byName": model.MatchByName, "byRegexp": model.MatchByRegexp, "byType": model.MatchByType,
			"byFrameRefID": model.MatchByRefID, "byValue": model.MatchByValue}[strOf(m["id"])]
		if kind == "" {
			out.Ext[fmt.Sprintf("fieldConfig.overrides[%d]", i)] = mustJSON(o)
			im.unsupported(op, fmt.Sprintf("override matcher %q is kept but not applied", strOf(m["id"])))
			continue
		}
		ov := model.Override{Matcher: model.Matcher{Kind: kind, Value: m["options"]}, Set: obj{}}
		var props []obj
		_ = json.Unmarshal(o["properties"], &props)
		for _, pr := range props {
			if id := strOf(pr["id"]); id != "" {
				ov.Set[id] = pr["value"]
			}
		}
		out.Overrides = append(out.Overrides, ov)
	}
}

// runTransforms are the transformations the console runs in v0 (Grafana's most
// used); the rest are kept on the panel and reported.
var runTransforms = keys("reduce", "organize", "merge", "joinByField", "filterFieldsByName", "filterByValue", "groupBy",
	"calculateField", "renameByRegex", "sortBy", "labelsToFields")

func (im *importer) transform(t obj, path string) model.Transform {
	out := model.Transform{ID: strOf(t["id"]), Options: t["options"], Disabled: boolOf(t["disabled"])}
	out.Ext = im.split(t, keys("id", "options", "disabled"), path, nil)
	if len(out.Ext) == 0 {
		out.Ext = nil
	}
	if !runTransforms[out.ID] {
		im.unsupported(path, fmt.Sprintf("transformation %q is kept but not run yet", out.ID))
	}
	return out
}

// ---- variables ----

var variableKeys = keys("name", "label", "type", "datasource", "query", "definition", "regex", "sort", "refresh", "options",
	"multi", "includeAll", "allValue", "current", "hide")

var (
	reLabelValues = regexp.MustCompile(`^\s*label_values\(\s*(?:(.+?)\s*,\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$`)
	reLabelNames  = regexp.MustCompile(`^\s*label_names\(\s*(.*?)\s*\)\s*$`)
	reMetrics     = regexp.MustCompile(`^\s*metrics\(\s*(.*?)\s*\)\s*$`)
	reQueryResult = regexp.MustCompile(`^\s*query_result\(\s*(.+)\s*\)\s*$`)
)

func (im *importer) variable(v obj, path string) model.Variable {
	out := model.Variable{Name: strOf(v["name"]), Label: strOf(v["label"]), Regex: strOf(v["regex"]), Sort: intOf(v["sort"]),
		Multi: boolOf(v["multi"]), IncludeAll: boolOf(v["includeAll"]), AllValue: strOf(v["allValue"]), Hide: intOf(v["hide"])}
	out.Ext = im.split(v, variableKeys, path, nil)
	if raw, ok := v["current"]; ok && string(raw) != "null" {
		out.Current = raw
	}
	out.Refresh = map[int]string{1: model.RefreshOnLoad, 2: model.RefreshOnTimeRange}[intOf(v["refresh"])]
	var opts []obj
	_ = json.Unmarshal(v["options"], &opts)
	for _, o := range opts {
		out.Options = append(out.Options, model.VariableOption{Text: textOf(o["text"]), Value: textOf(o["value"])})
	}
	queryText := strOf(v["query"])
	if q, ok := asObj(v["query"]); ok {
		queryText = strOf(q["query"])
		out.Ext["query"] = v["query"]
	}
	if def := strOf(v["definition"]); def != "" {
		out.Ext["definition"] = v["definition"]
	}

	typ := strOf(v["type"])
	switch typ {
	case "datasource":
		out.Kind = model.VarCluster
		out.Store = storeOfType(queryText)
		out.Ext["datasource.query"] = mustJSON(queryText)
		im.adjusted(path, "data source variable becomes the Kubeast cluster selector")
	case "query":
		store, _ := im.storeOf(v["datasource"], path+".datasource")
		if raw, ok := v["datasource"]; ok && string(raw) != "null" {
			out.Ext["datasource"] = raw
		}
		if isClusterVar(out.Name) {
			out.Kind = model.VarCluster
			out.Store = store
			out.Ext["clusterQuery"] = mustJSON(queryText)
			im.adjusted(path, fmt.Sprintf("variable %q is bound to the Kubeast cluster selector; the server adds the cluster to every query", out.Name))
			break
		}
		out.Kind, out.Store = model.VarQuery, store
		out.Query = variableQuery(queryText, store)
		if store == "" {
			im.unsupported(path, "query variable on a data source the console has no store for")
			out.Store = model.StorePrometheus // keeps the document valid; the original is in ext
		}
	case "custom", "interval":
		out.Kind = map[string]string{"custom": model.VarCustom, "interval": model.VarInterval}[typ]
		if len(out.Options) == 0 && queryText != "" {
			for _, s := range strings.Split(queryText, ",") {
				if s = strings.TrimSpace(s); s != "" {
					out.Options = append(out.Options, model.VariableOption{Text: s, Value: s})
				}
			}
		}
		if queryText != "" {
			out.Ext["query"] = mustJSON(queryText)
		}
	case "textbox", "constant", "switch":
		out.Kind = typ
		if queryText != "" {
			out.Ext["query"] = mustJSON(queryText)
		}
	case "adhoc":
		out.Kind = model.VarAdhoc
		if raw, ok := v["datasource"]; ok {
			out.Ext["datasource"] = raw
		}
	default:
		out.Kind = model.VarConstant
		out.Ext["grafanaType"] = mustJSON(typ)
		im.unsupported(path, fmt.Sprintf("variable type %q is kept as a constant", typ))
	}
	if out.Kind == model.VarCustom && len(out.Options) == 0 {
		out.Options = []model.VariableOption{{Text: "", Value: ""}}
	}
	if len(out.Ext) == 0 {
		out.Ext = nil
	}
	return out
}

func isClusterVar(name string) bool {
	switch strings.ToLower(name) {
	case "cluster", "k8s_cluster", "kube_cluster":
		return true
	}
	return false
}

func variableQuery(q, store string) *model.VariableQuery {
	if store == model.StoreLoki {
		return &model.VariableQuery{Fn: "logql", Expr: q}
	}
	if m := reLabelValues.FindStringSubmatch(q); m != nil {
		return &model.VariableQuery{Fn: "label_values", Expr: m[1], Label: m[2]}
	}
	if m := reLabelNames.FindStringSubmatch(q); m != nil {
		return &model.VariableQuery{Fn: "label_names", Expr: m[1]}
	}
	if m := reMetrics.FindStringSubmatch(q); m != nil {
		return &model.VariableQuery{Fn: "metrics", Expr: m[1]}
	}
	if m := reQueryResult.FindStringSubmatch(q); m != nil {
		return &model.VariableQuery{Fn: "query_result", Expr: m[1]}
	}
	return &model.VariableQuery{Fn: "raw", Expr: q}
}

// ---- annotations ----

var annotationKeys = keys("name", "datasource", "enable", "iconColor", "expr", "builtIn", "hide", "type", "target")

func (im *importer) annotation(a obj, path string) (model.Annotation, bool) {
	out := model.Annotation{Name: strOf(a["name"]), Enable: boolOf(a["enable"])}
	out.Ext = im.split(a, annotationKeys, path, nil)
	for _, k := range []string{"datasource", "builtIn", "hide", "type", "target"} {
		if raw, ok := a[k]; ok {
			out.Ext[k] = raw
		}
	}
	if c := strOf(a["iconColor"]); c != "" {
		token, exact := Token(c)
		out.Color = token
		if !exact {
			out.Ext["iconColor"] = a["iconColor"]
		}
	}
	if intOf(a["builtIn"]) == 1 {
		im.unsupported(path, "Grafana's built-in annotations and alerts are kept but not shown")
		return out, true
	}
	store, _ := im.storeOf(a["datasource"], path+".datasource")
	out.Store = store
	out.Expr = strOf(a["expr"])
	if t, ok := asObj(a["target"]); ok && out.Expr == "" {
		out.Expr = strOf(t["expr"])
	}
	if store == "" {
		im.unsupported(path, "annotation on a data source the console has no store for")
	}
	return out, true
}

// ---- data sources ----

// storeOfType maps a Grafana data source plugin id to a store.
func storeOfType(t string) string {
	switch strings.ToLower(t) {
	case "prometheus":
		return model.StorePrometheus
	case "loki":
		return model.StoreLoki
	case "tempo":
		return model.StoreTempo
	case "alertmanager":
		return model.StoreAlertmanager
	}
	return ""
}

var varRef = regexp.MustCompile(`^\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::[a-z]+)?\}?$`)

// storeOf reads a datasource reference — {"type","uid"}, a name, a variable
// such as ${DS_PROMETHEUS}, or null — and says which store it means. known is
// false when the reference names nothing the console can run; null means the
// Grafana default data source, taken as Prometheus.
func (im *importer) storeOf(raw json.RawMessage, path string) (store string, known bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return model.StorePrometheus, true
	}
	if o, ok := asObj(raw); ok {
		typ, uid := strOf(o["type"]), strOf(o["uid"])
		if s := storeOfType(typ); s != "" {
			return s, true
		}
		if m := varRef.FindStringSubmatch(uid); m != nil {
			if s, ok := im.dsVars[m[1]]; ok {
				return s, s != ""
			}
		}
		if typ == "datasource" || typ == "grafana" || typ == "" {
			return model.StorePrometheus, true // mixed / dashboard / default: the query's own reference decides
		}
		return "", false
	}
	name := strOf(raw)
	if m := varRef.FindStringSubmatch(name); m != nil {
		if s, ok := im.dsVars[m[1]]; ok {
			return s, s != ""
		}
		if strings.HasPrefix(strings.ToUpper(m[1]), "DS_") {
			// ${DS_PROMETHEUS}: an "export for sharing" input, named after its plugin.
			if s := storeOfType(strings.TrimPrefix(strings.ToLower(m[1]), "ds_")); s != "" {
				return s, true
			}
		}
		return "", false
	}
	lower := strings.ToLower(name)
	for _, t := range []string{"prometheus", "loki", "tempo", "alertmanager"} {
		if strings.Contains(lower, t) {
			im.adjusted(path, fmt.Sprintf("data source %q taken as %s from its name", name, t))
			return storeOfType(t), true
		}
	}
	if strings.HasPrefix(name, "-- ") {
		return model.StorePrometheus, true // -- Mixed -- / -- Dashboard --
	}
	return "", false
}

// ---- accounting ----

// split marks every key of o under path: keys in drop as dropped, known keys as
// mapped, the rest preserved and returned for the object's Ext.
func (im *importer) split(o obj, known map[string]bool, path string, drop map[string]bool) obj {
	ext := obj{}
	for k, v := range o {
		p := join(path, k)
		switch {
		case drop[k]:
			im.mark(p, "dropped")
			im.rep.Dropped = append(im.rep.Dropped, p)
		case known[k]:
			im.mark(p, "mapped")
		default:
			ext[k] = v
			im.mark(p, "preserved")
			im.rep.Preserved = append(im.rep.Preserved, p)
		}
	}
	return ext
}

func (im *importer) markObj(o obj, path string, known map[string]bool) {
	for k := range o {
		if known[k] {
			im.mark(join(path, k), "mapped")
		} else {
			im.mark(join(path, k), "preserved")
		}
	}
}

func (im *importer) markAll(o obj, path, how string) {
	for k := range o {
		im.mark(join(path, k), how)
	}
}

func (im *importer) mark(path, how string) { im.rep.accounted[path] = how }

// nameQueries gives a query without a refId the name Grafana gives it when it
// loads the panel (PanelModel.ensureQueryIds with getNextRefId, v13.3.0): in
// order, the first of A…Z, AA… that no query of the panel has. Generated
// dashboards such as the kubernetes-mixin's leave refId out.
func (im *importer) nameQueries(qs []model.Query, paths []string) {
	used := map[string]bool{}
	for _, q := range qs {
		used[q.RefID] = true
	}
	for i := range qs {
		if qs[i].RefID != "" {
			continue
		}
		for n := 0; ; n++ {
			if id := refID(n); !used[id] {
				qs[i].RefID, used[id] = id, true
				im.adjusted(paths[i]+".refId", "no refId: named "+id+", as Grafana names it")
				break
			}
		}
	}
}

// refID is Grafana's getRefId: 0 → A, 25 → Z, 26 → AA.
func refID(n int) string {
	const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	if n < len(letters) {
		return letters[n : n+1]
	}
	return refID(n/len(letters)-1) + letters[n%len(letters):n%len(letters)+1]
}

func (im *importer) adjusted(path, reason string) {
	im.rep.Adjusted = append(im.rep.Adjusted, Finding{Path: path, Reason: reason})
}

func (im *importer) unsupported(path, reason string) {
	im.rep.Unsupported = append(im.rep.Unsupported, Finding{Path: path, Reason: reason})
}

// ---- small JSON helpers ----

func keys(ks ...string) map[string]bool {
	m := make(map[string]bool, len(ks))
	for _, k := range ks {
		m[k] = true
	}
	return m
}

func join(path, k string) string {
	if path == "" {
		return k
	}
	return path + "." + k
}

func asObj(raw json.RawMessage) (obj, bool) {
	var o obj
	if len(raw) == 0 || raw[0] != '{' {
		return nil, false
	}
	if err := json.Unmarshal(raw, &o); err != nil {
		return nil, false
	}
	return o, true
}

func strOf(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

// textOf reads a variable option's text or value, which Grafana writes as a
// string or, for multi-value options, an array of strings.
func textOf(raw json.RawMessage) string {
	if s := strOf(raw); s != "" {
		return s
	}
	var ss []string
	if json.Unmarshal(raw, &ss) == nil {
		return strings.Join(ss, ",")
	}
	return ""
}

func intOf(raw json.RawMessage) int {
	var f float64
	if json.Unmarshal(raw, &f) == nil {
		return int(f)
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		var n int
		if _, err := fmt.Sscanf(s, "%d", &n); err == nil {
			return n
		}
	}
	return 0
}

func boolOf(raw json.RawMessage) bool {
	var b bool
	if json.Unmarshal(raw, &b) == nil {
		return b
	}
	return intOf(raw) != 0
}

func floatPtr(raw json.RawMessage) *float64 {
	var f float64
	if len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, &f) != nil {
		return nil
	}
	return &f
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// slug makes a metadata.name from a title: lowercase ASCII letters, digits and
// dashes, at most 63; a title with none of those becomes "imported".
func slug(title string) string {
	s := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(title), "-"), "-")
	if len(s) > 63 {
		s = strings.TrimRight(s[:63], "-")
	}
	if s == "" {
		return "imported"
	}
	return s
}
