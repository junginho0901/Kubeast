package grafana

import (
	"fmt"
	"sort"
	"strconv"
)

// prepareV1 does to a classic dashboard what Grafana 13.3.0 does before it
// converts one to v2 (migration.Migrate): the defaults the frontend's
// DashboardModel and PanelModel set, unique panel ids, the schema migrations
// up to 42, the built-in annotation, and what the frontend's save model drops.
func prepareV1(dash map[string]any) error {
	delete(dash, "__elements")
	delete(dash, "__inputs")
	delete(dash, "__requires")
	for _, p := range anyMaps(dash["panels"]) {
		markOriginals(p)
	}
	frontendDefaults(dash)
	for _, p := range anyMaps(dash["panels"]) {
		panelDefaults(p)
	}
	uniquePanelIDs(dash)
	sv := schemaVersionOf(dash)
	if sv < minSchemaVersion || sv > LatestSchemaVersion {
		return fmt.Errorf("%w: this one is at %d", ErrV2SchemaVersion, sv)
	}
	migrate(dash, sv)
	addBuiltInAnnotation(dash)
	cleanupForSave(dash)
	return nil
}

func schemaVersionOf(dash map[string]any) int {
	switch v := dash["schemaVersion"].(type) {
	case int:
		return v
	case float64:
		return int(v)
	case string:
		n, _ := strconv.Atoi(v)
		return n
	}
	return 0
}

// markOriginals notes, before defaults are added, which panels had
// transformations and a fieldConfig.defaults.custom of their own.
func markOriginals(p map[string]any) {
	if _, ok := p["transformations"]; ok {
		p["_originallyHadTransformations"] = true
	}
	if defs, ok := mapOf(mapOr(p["fieldConfig"])["defaults"]); ok {
		if _, ok := defs["custom"]; ok {
			p["_originallyHadFieldConfigCustom"] = true
		}
	}
	for _, in := range anyMaps(p["panels"]) {
		markOriginals(in)
	}
}

func frontendDefaults(dash map[string]any) {
	setNil(dash, "title", "No Title")
	setNil(dash, "tags", []any{})
	setNil(dash, "timezone", "")
	setNil(dash, "weekStart", "")
	setNil(dash, "editable", true)
	setNil(dash, "graphTooltip", float64(0))
	setNil(dash, "time", map[string]any{"from": "now-6h", "to": "now"})
	setNil(dash, "timepicker", map[string]any{})
	setNil(dash, "schemaVersion", float64(0))
	setNil(dash, "fiscalYearStartMonth", float64(0))
	setNil(dash, "links", []any{})
	for _, k := range []string{"templating", "annotations"} {
		if m, ok := mapOf(dash[k]); ok {
			setNil(m, "list", []any{})
		} else {
			dash[k] = map[string]any{"list": []any{}}
		}
	}
	for _, v := range anyMaps(mapOr(dash["templating"])["list"]) {
		cur, ok := mapOf(v["current"])
		if !ok {
			continue
		}
		val, has := cur["value"]
		if !has {
			continue
		}
		if val == nil {
			delete(cur, "value")
			continue
		}
		if l, ok := val.([]any); ok {
			for _, x := range l {
				if x == nil {
					delete(cur, "value")
					break
				}
			}
		}
	}
}

func panelDefaults(p map[string]any) {
	setNil(p, "gridPos", map[string]any{"x": float64(0), "y": float64(0), "h": float64(3), "w": float64(6)})
	setNil(p, "targets", []any{map[string]any{"refId": "A"}})
	setNil(p, "cachedPluginOptions", map[string]any{})
	setNil(p, "transparent", false)
	setNil(p, "options", map[string]any{})
	setNil(p, "links", []any{})
	if fc, ok := p["fieldConfig"]; !ok {
		p["fieldConfig"] = map[string]any{"defaults": map[string]any{}, "overrides": []any{}}
	} else if m, ok := mapOf(fc); ok {
		if _, ok := m["defaults"]; !ok {
			m["defaults"] = map[string]any{}
		}
		if _, ok := m["overrides"]; !ok {
			m["overrides"] = []any{}
		}
	}
	setNil(p, "title", "")
	queryIDs(p)
}

// queryIDs gives a query without a refId the first free letter, as the
// frontend's ensureQueryIds does (A…Z only).
func queryIDs(p map[string]any) {
	targets := anyMaps(p["targets"])
	missing := false
	taken := map[string]bool{}
	for _, t := range targets {
		if t["refId"] == nil {
			missing = true
		} else if s, ok := t["refId"].(string); ok {
			taken[s] = true
		}
	}
	if !missing {
		return
	}
	const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	i := 0
	for _, t := range targets {
		if t["refId"] != nil {
			continue
		}
		for ; i < len(letters); i++ {
			if id := string(letters[i]); !taken[id] {
				t["refId"] = id
				taken[id] = true
				break
			}
		}
		i++
	}
}

// allPanels lists the top-level panels, each followed by those it holds.
func allPanels(dash map[string]any) []map[string]any {
	var out []map[string]any
	for _, p := range anyMaps(dash["panels"]) {
		out = append(out, p)
		out = append(out, anyMaps(p["panels"])...)
	}
	return out
}

// uniquePanelIDs gives a panel with no id, or one an earlier panel has, the
// next id above the largest.
func uniquePanelIDs(dash map[string]any) {
	panels := allPanels(dash)
	next := 0
	for _, p := range panels {
		if id, ok := p["id"].(float64); ok && id > 0 && int(id) > next {
			next = int(id)
		}
	}
	next++
	seen := map[float64]bool{}
	for _, p := range panels {
		if id, ok := p["id"].(float64); ok && id > 0 && !seen[id] {
			seen[id] = true
			continue
		}
		p["id"] = float64(next)
		next++
	}
}

func addBuiltInAnnotation(dash map[string]any) {
	an, ok := mapOf(dash["annotations"])
	if !ok {
		return
	}
	list, ok := an["list"].([]any)
	if !ok {
		return
	}
	for _, a := range anyMaps(list) {
		if b, ok := a["builtIn"].(float64); ok && b == 1 {
			return
		}
	}
	an["list"] = append([]any{map[string]any{
		"datasource": map[string]any{"uid": "-- Grafana --", "type": "grafana"},
		"name":       "Annotations & Alerts",
		"type":       "dashboard",
		"iconColor":  "rgba(0, 211, 255, 1)",
		"enable":     true,
		"hide":       true,
		"builtIn":    float64(1),
	}}, list...)
}

func cleanupForSave(dash map[string]any) {
	for _, k := range []string{"events", "meta", "originalTime", "originalTemplating", "originalLibraryPanels", "panelInEdit",
		"panelInView", "getVariablesFromState", "formatDate", "appEventsSubscription", "panelsAffectedByVariableChange",
		"lastRefresh", "timeRangeUpdatedDuringEditOrView", "originalDashboard", "variables"} {
		delete(dash, k)
	}
	if v, ok := dash["gnetId"]; ok && v == nil {
		delete(dash, "gnetId")
	}
	if tpl, ok := mapOf(dash["templating"]); ok {
		dropNulls(tpl)
		for _, v := range anyMaps(tpl["list"]) {
			cleanupVariable(v)
		}
	}
	if panels, ok := dash["panels"].([]any); ok {
		kept := []any{}
		for _, p := range anyMaps(panels) {
			if truthy(p["repeatPanelId"]) || truthy(p["repeatedByRow"]) {
				continue
			}
			kept = append(kept, p)
		}
		for _, p := range anyMaps(kept) {
			cleanupPanel(p, false)
			for _, in := range anyMaps(p["panels"]) {
				cleanupPanel(in, true)
			}
		}
		sort.SliceStable(kept, func(i, j int) bool {
			yi, xi := gridYX(kept[i])
			yj, xj := gridYX(kept[j])
			if yi == yj {
				return xi < xj
			}
			return yi < yj
		})
		dash["panels"] = kept
	} else {
		dash["panels"] = []any{}
	}
	if v, ok := dash["style"]; ok && looseEqual(v, "dark") {
		delete(dash, "style")
	}
	if v, ok := dash["hideControls"]; ok && looseEqual(v, false) {
		delete(dash, "hideControls")
	}
	if v, ok := dash["id"]; ok && v == nil {
		delete(dash, "id")
	}
	for _, k := range []string{"version", "iteration", "nav", "pulldowns"} {
		delete(dash, k)
	}
}

func gridYX(p any) (float64, float64) {
	g, _ := mapOf(mapOr(p)["gridPos"])
	y, _ := g["y"].(float64)
	x, _ := g["x"].(float64)
	return y, x
}

func cleanupVariable(v map[string]any) {
	delete(v, "index")
	switch v["type"] {
	case "query":
		if refreshInt(v["refresh"], 1) != 0 {
			setMissing(v, "options", []any{})
		}
	case "constant":
		delete(v, "options")
	case "datasource":
		v["options"] = []any{}
	}
}

func refreshInt(v any, def int) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return def
}

// panelSaveDefaults are the PanelModel defaults its save model leaves out.
var panelSaveDefaults = map[string]func() any{
	"gridPos":             func() any { return map[string]any{"x": float64(0), "y": float64(0), "h": float64(3), "w": float64(6)} },
	"targets":             func() any { return []any{map[string]any{"refId": "A"}} },
	"cachedPluginOptions": func() any { return map[string]any{} },
	"transparent":         func() any { return false },
	"options":             func() any { return map[string]any{} },
	"links":               func() any { return []any{} },
	"fieldConfig":         func() any { return map[string]any{"defaults": map[string]any{}, "overrides": []any{}} },
	"title":               func() any { return "" },
}

var notPersisted = []string{"events", "isViewing", "isEditing", "isInView", "hasRefreshed", "cachedPluginOptions", "plugin",
	"queryRunner", "replaceVariables", "configRev", "hasSavedPanelEditChange", "getDisplayTitle", "dataSupport", "key",
	"isNew", "refreshWhenInView", "scopedVars"}

// cleanupPanel is PanelModel.getSaveModel as Grafana's backend repeats it.
func cleanupPanel(p map[string]any, nested bool) {
	if t, ok := p["type"].(string); ok {
		if nt := angularTarget(t, p); nt != "" {
			p["autoMigrateFrom"] = t
			p["type"] = nt
		}
	}
	if lp, ok := p["libraryPanel"]; ok && lp != nil {
		keep := map[string]any{"id": p["id"], "title": p["title"], "gridPos": p["gridPos"], "libraryPanel": lp}
		for k := range p {
			delete(p, k)
		}
		for k, v := range keep {
			if v != nil {
				p[k] = v
			}
		}
		return
	}
	if p["type"] == "row" {
		if v, ok := p["repeat"]; ok && looseEqual(v, "") {
			delete(p, "repeat")
		}
	}
	original := map[string]bool{}
	for k := range p {
		original[k] = true
	}
	for _, k := range notPersisted {
		delete(p, k)
	}
	for k, def := range panelSaveDefaults {
		if v, ok := p[k]; ok && looseEqual(v, def()) {
			delete(p, k)
		}
	}
	if tr, ok := p["transformations"].([]any); ok && len(tr) == 0 {
		if p["_originallyHadTransformations"] != true || !nested {
			delete(p, "transformations")
		}
	}
	dropNulls(p)
	saveDefaults(p, original)
	delete(p, "_originallyHadTransformations")
	delete(p, "_originallyHadFieldConfigCustom")
}

// saveDefaults is filterDefaultValues. Its own gridPos default is written
// with ints, which never equal a decoded number, so it keeps every gridPos.
func saveDefaults(p map[string]any, original map[string]bool) {
	hadCustom := p["_originallyHadFieldConfigCustom"] == true
	if p["type"] == "table" {
		for _, k := range []string{"pageSize", "scroll", "fontSize", "showHeader", "sort"} {
			if _, ok := p[k]; !ok {
				continue
			}
			if p["autoMigrateFrom"] == "table-old" && original[k] {
				continue
			}
			delete(p, k)
		}
	}
	for k, def := range panelSaveDefaults {
		v, ok := p[k]
		if !ok || k == "gridPos" || !looseEqual(v, def()) {
			continue
		}
		if k == "fieldConfig" {
			if hadCustom {
				if defs, ok := mapOf(mapOr(v)["defaults"]); ok {
					setMissing(defs, "custom", map[string]any{})
					continue
				}
			}
			delete(p, k)
		} else if !original[k] {
			delete(p, k)
		}
	}
	if t, ok := p["targets"].([]any); ok && len(t) == 0 {
		delete(p, "targets")
	}
	if _, ok := p["fieldConfig"]; hadCustom && !ok {
		p["fieldConfig"] = map[string]any{"defaults": map[string]any{"custom": map[string]any{}}, "overrides": []any{}}
	}
	if defs, ok := mapOf(mapOr(p["fieldConfig"])["defaults"]); ok {
		dropSinglestatCustom(defs, p)
		if hadCustom {
			setMissing(defs, "custom", map[string]any{})
		}
	}
}

// dropSinglestatCustom removes the empty custom object of a panel migrated
// from singlestat (cleanupFieldConfigDefaults).
func dropSinglestatCustom(defs, p map[string]any) {
	custom, ok := mapOf(defs["custom"])
	if !ok || len(custom) != 0 {
		return
	}
	from := p["autoMigrateFrom"]
	migrated := from == "singlestat" || from == "grafana-singlestat-panel"
	if !migrated {
		if c, ok := mapOf(defs["color"]); ok {
			_, fixed := c["fixedColor"].(string)
			_, maps := defs["mappings"].([]any)
			migrated = fixed && c["mode"] == "fixed" && maps
		}
	}
	if migrated {
		delete(defs, "custom")
	}
}

// angularTargets are the old panels Grafana loads as a core panel
// (schemaversion.AngularPanelMigrations).
var angularTargets = map[string]string{
	"table-old": "table", "singlestat": "stat", "grafana-singlestat-panel": "stat",
	"grafana-piechart-panel": "piechart", "grafana-worldmap-panel": "geomap", "natel-discrete-panel": "state-timeline",
}

func angularTarget(t string, p map[string]any) string {
	if t == "graph" || t == "graphite" {
		switch mapOr(p["xaxis"])["mode"] {
		case "series":
			if v, _ := mapOr(p["legend"])["values"].(bool); v {
				return "bargauge"
			}
			return "barchart"
		case "histogram":
			return "histogram"
		}
		return "timeseries"
	}
	return angularTargets[t]
}

// looseEqual is the backend's isEqual: same JSON kind and value, maps by
// their keys.
func looseEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	switch av := a.(type) {
	case bool:
		bv, ok := b.(bool)
		return ok && av == bv
	case string:
		bv, ok := b.(string)
		return ok && av == bv
	case float64:
		bv, ok := b.(float64)
		return ok && av == bv
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !looseEqual(av[i], bv[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, v := range av {
			if !looseEqual(v, bv[k]) {
				return false
			}
		}
		return true
	}
	return false
}

func dropNulls(v any) {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			if e == nil {
				delete(x, k)
			} else {
				dropNulls(e)
			}
		}
	case []any:
		for _, e := range x {
			if e != nil {
				dropNulls(e)
			}
		}
	}
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	}
	return true
}

func setNil(m map[string]any, k string, v any) {
	if m[k] == nil {
		m[k] = v
	}
}

func setMissing(m map[string]any, k string, v any) {
	if _, ok := m[k]; !ok {
		m[k] = v
	}
}

func mapOf(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func mapOr(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func anyMaps(v any) []map[string]any {
	l, _ := v.([]any)
	out := make([]map[string]any, 0, len(l))
	for _, e := range l {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}
