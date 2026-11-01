package grafana

// minSchemaVersion is the oldest classic dashboard ConvertV2 takes: the
// migrations below are Grafana 13.3.0's from 37 on (schemaversion/v37.go …
// v42.go); each brings a dashboard from the version before to its own.
const minSchemaVersion = 36

var schemaMigrations = map[int]func(map[string]any){
	37: func(d map[string]any) { eachPanel(d["panels"], legendShown) },
	38: func(d map[string]any) { eachPanel(d["panels"], tableCellOptions) },
	39: func(d map[string]any) { eachPanel(d["panels"], timeSeriesTableStats) },
	40: func(d map[string]any) { d["refresh"] = str(d, "refresh") },
	41: func(d map[string]any) {
		if tp, ok := mapOf(d["timepicker"]); ok {
			delete(tp, "time_options")
		}
	},
	42: func(d map[string]any) {
		for _, p := range anyMaps(d["panels"]) {
			hideFromTooltip(p)
		}
	},
}

// migrate runs the migrations from the dashboard's version up to the latest.
func migrate(dash map[string]any, from int) {
	for v := from + 1; v <= LatestSchemaVersion; v++ {
		schemaMigrations[v](dash)
		dash["schemaVersion"] = float64(v)
	}
}

// eachPanel calls f on each panel that is not a row, the panels of a row
// included.
func eachPanel(panels any, f func(map[string]any)) {
	for _, p := range anyMaps(panels) {
		if p["type"] == "row" {
			eachPanel(p["panels"], f)
			continue
		}
		f(p)
	}
}

// legendShown (v37) writes showLegend: a hidden legend becomes a list legend
// not shown.
func legendShown(p map[string]any) {
	legend, ok := mapOf(mapOr(p["options"])["legend"])
	if !ok {
		return
	}
	show, has := legend["showLegend"].(bool)
	if str(legend, "displayMode") == "hidden" || (has && !show) {
		legend["displayMode"] = "list"
		legend["showLegend"] = false
	} else {
		legend["showLegend"] = true
	}
}

// tableCellOptions (v38) turns a table's displayMode into cellOptions, in the
// defaults and in overrides.
func tableCellOptions(p map[string]any) {
	if p["type"] != "table" {
		return
	}
	fc, ok := mapOf(p["fieldConfig"])
	if !ok {
		return
	}
	if custom, ok := mapOf(mapOr(fc["defaults"])["custom"]); ok {
		if mode, has := custom["displayMode"]; has {
			if s, ok := mode.(string); ok {
				custom["cellOptions"] = cellOptions(s)
			}
			delete(custom, "displayMode")
		}
	}
	for _, o := range anyMaps(fc["overrides"]) {
		for _, prop := range anyMaps(o["properties"]) {
			if prop["id"] != "custom.displayMode" {
				continue
			}
			prop["id"] = "custom.cellOptions"
			if v, has := prop["value"]; has {
				if s, ok := v.(string); ok {
					prop["value"] = cellOptions(s)
				}
			} else {
				prop["value"] = map[string]any{}
			}
		}
	}
}

func cellOptions(mode string) map[string]any {
	switch mode {
	case "basic", "gradient-gauge", "lcd-gauge":
		gauge := map[string]string{"basic": "basic", "gradient-gauge": "gradient", "lcd-gauge": "lcd"}[mode]
		return map[string]any{"type": "gauge", "mode": gauge}
	case "color-background", "color-background-solid":
		m := "basic"
		if mode == "color-background" {
			m = "gradient"
		}
		return map[string]any{"type": "color-background", "mode": m}
	}
	return map[string]any{"type": mode}
}

// timeSeriesTableStats (v39) moves each refId's stat of the timeSeriesTable
// transformation under {stat}.
func timeSeriesTableStats(p map[string]any) {
	for _, t := range anyMaps(p["transformations"]) {
		if t["id"] != "timeSeriesTable" {
			continue
		}
		stats, ok := mapOf(mapOr(t["options"])["refIdToStat"])
		if !ok {
			continue
		}
		opts := map[string]any{}
		for ref, stat := range stats {
			opts[ref] = map[string]any{"stat": stat}
		}
		t["options"] = opts
	}
}

// hideFromTooltip (v42): a series hidden from the visualization is hidden
// from the tooltip too.
func hideFromTooltip(p map[string]any) {
	for _, o := range anyMaps(mapOr(p["fieldConfig"])["overrides"]) {
		for _, prop := range anyMaps(o["properties"]) {
			if v, ok := mapOf(prop["value"]); ok && str(prop, "id") == "custom.hideFrom" && boolField(v, "viz", false) {
				v["tooltip"] = true
			}
		}
	}
	for _, in := range anyMaps(p["panels"]) {
		hideFromTooltip(in)
	}
}
