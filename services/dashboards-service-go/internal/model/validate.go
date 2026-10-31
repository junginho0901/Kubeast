package model

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Problem is one thing wrong with a dashboard, at a JSON path such as
// spec.panels.req-rate.queries[0].store.
type Problem struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

func (p Problem) String() string { return p.Path + ": " + p.Message }

// PanelKinds are the panel kinds the model accepts: Grafana's core
// visualizations under the same names, plus Unsupported for a panel kept only
// to be preserved (a plugin panel, a library panel that was not inlined).
var PanelKinds = map[string]bool{
	"timeseries": true, "stat": true, "gauge": true, "bargauge": true, "table": true, "logs": true, "text": true,
	"state-timeline": true, "status-history": true, "barchart": true, "histogram": true, "heatmap": true,
	"piechart": true, "trend": true, "xychart": true, "candlestick": true,
	"dashlist": true, "alertlist": true, "annolist": true,
	"nodeGraph": true, "traces": true, "flamegraph": true,
	"canvas": true, "geomap": true, "news": true,
	Unsupported: true,
}

// Unsupported marks a panel the console does not draw; its source stays in Ext.
const Unsupported = "unsupported"

// ColorTokens are the theme tokens a colour may name.
var ColorTokens = map[string]bool{
	"series-1": true, "series-2": true, "series-3": true, "series-4": true, "series-5": true,
	"series-6": true, "series-7": true, "series-8": true, "series-9": true, "series-10": true,
	"state-ok": true, "state-warn": true, "state-crit": true, "state-info": true, "neutral": true,
}

var (
	stores        = map[string]bool{StorePrometheus: true, StoreLoki: true, StoreTempo: true, StoreAlertmanager: true}
	variableKinds = map[string]bool{VarQuery: true, VarCustom: true, VarInterval: true, VarTextbox: true, VarConstant: true, VarSwitch: true, VarAdhoc: true, VarCluster: true}
	matcherKinds  = map[string]bool{MatchByName: true, MatchByRegexp: true, MatchByType: true, MatchByRefID: true, MatchByValue: true}
	cursorSyncs   = map[string]bool{"": true, CursorSyncNone: true, CursorSyncShared: true, CursorSyncSharedTooltip: true}
	refreshPoints = map[string]bool{"": true, RefreshOnLoad: true, RefreshOnTimeRange: true}

	slugRe      = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	panelNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$`)
	varNameRe   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
	dnsLabelRe  = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)
	// Grafana-style durations: 30s, 5m, 1h, 1d.
	refreshRe = regexp.MustCompile(`^([0-9]+)(s|m|h|d)$`)
)

// Validate lists every problem in d; nil means the document is valid. The order
// is stable (by path) so callers and tests can compare it.
func Validate(d *Dashboard) []Problem {
	v := &validator{}
	v.check(d.APIVersion == APIVersion, "apiVersion", fmt.Sprintf("must be %q", APIVersion))
	v.check(d.Kind == Kind, "kind", fmt.Sprintf("must be %q", Kind))
	v.metadata(&d.Metadata)
	v.spec(&d.Spec)
	sort.SliceStable(v.problems, func(i, j int) bool { return v.problems[i].Path < v.problems[j].Path })
	return v.problems
}

type validator struct{ problems []Problem }

func (v *validator) add(path, msg string) {
	v.problems = append(v.problems, Problem{Path: path, Message: msg})
}

func (v *validator) check(ok bool, path, msg string) {
	if !ok {
		v.add(path, msg)
	}
}

func (v *validator) metadata(m *Metadata) {
	v.check(slugRe.MatchString(m.Name), "metadata.name", "must be lowercase letters, digits and dashes (at most 63)")
	v.check(strings.TrimSpace(m.Title) != "", "metadata.title", "is required")
	v.check(m.Scope.Cluster != "", "metadata.scope.cluster", `is required (a cluster ID or "*")`)
	for i, ns := range m.Scope.Namespaces {
		v.check(dnsLabelRe.MatchString(ns), fmt.Sprintf("metadata.scope.namespaces[%d]", i), "is not a namespace name")
	}
}

func (v *validator) spec(s *Spec) {
	v.check(s.Time.From != "" && s.Time.To != "", "spec.time", "from and to are required")
	if s.Refresh != "" {
		if secs, ok := refreshSeconds(s.Refresh); !ok {
			v.add("spec.refresh", "must be a duration such as 30s, 5m or 1h")
		} else if secs < MinRefreshSeconds {
			v.add("spec.refresh", fmt.Sprintf("must be at least %ds", MinRefreshSeconds))
		}
	}
	v.check(cursorSyncs[s.CursorSync], "spec.cursorSync", "must be none, shared or sharedTooltip")

	varNames := map[string]bool{}
	for i := range s.Variables {
		v.variable(fmt.Sprintf("spec.variables[%d]", i), &s.Variables[i], varNames)
	}

	v.check(len(s.Panels) > 0, "spec.panels", "a dashboard needs at least one panel")
	names := make([]string, 0, len(s.Panels))
	for name := range s.Panels {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		p := s.Panels[name]
		v.panel("spec.panels."+name, name, &p, varNames)
	}
	v.layout(&s.Layout, s.Panels)

	for i, l := range s.Links {
		v.check(l.URL != "", fmt.Sprintf("spec.links[%d].url", i), "is required")
	}
	for i, a := range s.Annotations {
		path := fmt.Sprintf("spec.annotations[%d]", i)
		v.check(a.Name != "", path+".name", "is required")
		v.check(a.Store == "" || stores[a.Store], path+".store", "is not a known store")
		v.check(a.Color == "" || ColorTokens[a.Color], path+".color", "must be a theme token")
	}
}

func (v *validator) variable(path string, va *Variable, seen map[string]bool) {
	if !varNameRe.MatchString(va.Name) {
		v.add(path+".name", "must be a letter or underscore followed by letters, digits or underscores")
	} else if seen[va.Name] {
		v.add(path+".name", "is used by another variable")
	}
	seen[va.Name] = true
	v.check(variableKinds[va.Kind], path+".kind", "is not a known variable kind")
	v.check(refreshPoints[va.Refresh], path+".refresh", "must be load or timeRange")
	if va.Kind == VarQuery {
		v.check(stores[va.Store], path+".store", "a query variable needs a store")
		v.check(va.Query != nil && va.Query.Fn != "", path+".query", "a query variable needs a query")
	}
	if va.Kind == VarCustom {
		v.check(len(va.Options) > 0, path+".options", "a custom variable needs options")
	}
}

func (v *validator) panel(path, name string, p *Panel, vars map[string]bool) {
	v.check(panelNameRe.MatchString(name), path, "panel name must be letters, digits, dot, dash or underscore (at most 63)")
	v.check(PanelKinds[p.Kind], path+".kind", "is not a known panel kind")
	refs := map[string]bool{}
	for i, q := range p.Queries {
		qp := fmt.Sprintf("%s.queries[%d]", path, i)
		v.check(q.RefID != "", qp+".refId", "is required")
		v.check(!refs[q.RefID], qp+".refId", "is used by another query of this panel")
		refs[q.RefID] = true
		if p.Kind == Unsupported {
			continue // kept as it came; nothing runs it
		}
		v.check(q.Store == "" || stores[q.Store], qp+".store", "is not a known store")
		v.check(q.Hide || q.Store == "" || strings.TrimSpace(q.Expr) != "", qp+".expr", "is required for a query that runs")
	}
	if c := p.FieldDefaults.Color; c != nil {
		v.check(c.Token == "" || ColorTokens[c.Token], path+".fieldDefaults.color.token", "must be a theme token")
	}
	if t := p.FieldDefaults.Thresholds; t != nil {
		v.thresholds(path+".fieldDefaults.thresholds", t)
	}
	for i, o := range p.Overrides {
		v.check(matcherKinds[o.Matcher.Kind], fmt.Sprintf("%s.overrides[%d].matcher.kind", path, i), "is not a known matcher")
	}
	for i, t := range p.Transforms {
		v.check(t.ID != "", fmt.Sprintf("%s.transforms[%d].id", path, i), "is required")
	}
	if p.Repeat != nil {
		v.check(vars[p.Repeat.Variable], path+".repeat.variable", "names no variable of this dashboard")
		v.check(p.Repeat.Direction == "" || p.Repeat.Direction == "h" || p.Repeat.Direction == "v", path+".repeat.direction", "must be h or v")
	}
}

func (v *validator) thresholds(path string, t *Thresholds) {
	v.check(t.Mode == "absolute" || t.Mode == "percentage", path+".mode", "must be absolute or percentage")
	var last *float64
	for i, s := range t.Steps {
		sp := fmt.Sprintf("%s.steps[%d]", path, i)
		v.check(ColorTokens[s.Color], sp+".color", "must be a theme token")
		if i == 0 {
			continue // the base step starts at minus infinity
		}
		if s.Value == nil {
			v.add(sp+".value", "is required after the first step")
			continue
		}
		if last != nil && *s.Value < *last {
			v.add(sp+".value", "steps must go up")
		}
		last = s.Value
	}
}

// layout checks the grid and that every panel is placed exactly once.
func (v *validator) layout(l *Layout, panels map[string]Panel) {
	placed := map[string]int{}
	checkItems := func(path string, items []LayoutItem) {
		for i, it := range items {
			ip := fmt.Sprintf("%s[%d]", path, i)
			if _, ok := panels[it.Panel]; !ok {
				v.add(ip+".panel", fmt.Sprintf("names no panel (%q)", it.Panel))
			}
			placed[it.Panel]++
			v.check(it.W >= 1 && it.H >= 1, ip, "w and h must be at least 1")
			v.check(it.X >= 0 && it.Y >= 0, ip, "x and y must not be negative")
			v.check(it.X+it.W <= GridColumns, ip, fmt.Sprintf("x + w must be at most %d", GridColumns))
		}
	}
	checkItems("spec.layout.items", l.Items)
	for i, r := range l.Rows {
		checkItems(fmt.Sprintf("spec.layout.rows[%d].items", i), r.Items)
	}
	names := make([]string, 0, len(panels))
	for name := range panels {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		switch n := placed[name]; {
		case n == 0:
			v.add("spec.panels."+name, "is not placed in the layout")
		case n > 1:
			v.add("spec.panels."+name, fmt.Sprintf("is placed %d times in the layout", n))
		}
	}
}

// refreshSeconds reads a Grafana refresh interval.
func refreshSeconds(s string) (int, bool) {
	m := refreshRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	var n int
	if _, err := fmt.Sscanf(m[1], "%d", &n); err != nil {
		return 0, false
	}
	unit := map[string]time.Duration{"s": time.Second, "m": time.Minute, "h": time.Hour, "d": 24 * time.Hour}[m[2]]
	return int((time.Duration(n) * unit) / time.Second), true
}

// RefreshSeconds is refreshSeconds for callers outside the package (the
// importer raises a refresh below the minimum).
func RefreshSeconds(s string) (int, bool) { return refreshSeconds(s) }
