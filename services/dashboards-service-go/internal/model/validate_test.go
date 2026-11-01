package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func f(v float64) *float64 { return &v }

// valid returns the smallest dashboard the validator accepts; each case below
// breaks one thing in a copy of it.
func valid() *Dashboard {
	return &Dashboard{
		APIVersion: APIVersion,
		Kind:       Kind,
		Metadata: Metadata{
			Name:  "web-red",
			Title: "web — RED",
			Scope: Scope{Cluster: "*", Namespaces: []string{"web"}},
		},
		Spec: Spec{
			Time:       TimeRange{From: "now-6h", To: "now"},
			Refresh:    "30s",
			CursorSync: CursorSyncShared,
			Variables: []Variable{
				{Name: "cluster", Kind: VarCluster},
				{Name: "pod", Kind: VarQuery, Store: StorePrometheus, Query: &VariableQuery{Fn: "label_values", Expr: "up", Label: "pod"}, Refresh: RefreshOnTimeRange, Multi: true, IncludeAll: true},
			},
			Panels: map[string]Panel{
				"req-rate": {
					Title:   "Requests",
					Kind:    "timeseries",
					Queries: []Query{{RefID: "A", Store: StorePrometheus, Expr: `sum(rate(http_requests_total[$__rate_interval]))`, Legend: "{{pod}}"}},
					FieldDefaults: FieldConfig{
						Unit:  "reqps",
						Color: &Color{Mode: "palette", Token: "series-1"},
						Thresholds: &Thresholds{Mode: "absolute", Steps: []ThresholdStep{
							{Color: "state-ok"}, {Value: f(100), Color: "state-warn"}, {Value: f(500), Color: "state-crit"},
						}},
					},
					Overrides: []Override{{Matcher: Matcher{Kind: MatchByName, Value: json.RawMessage(`"5xx"`)}, Set: map[string]json.RawMessage{"color": json.RawMessage(`"state-crit"`)}}},
					Repeat:    &Repeat{Variable: "pod", Direction: "h", MaxPerRow: 4},
				},
				"note": {Kind: "text", Options: json.RawMessage(`{"content":"Runbook: …"}`)},
			},
			Layout: Layout{
				Items: []LayoutItem{{Panel: "req-rate", X: 0, Y: 0, W: 12, H: 8}},
				Rows:  []LayoutRow{{Title: "Notes", Y: 8, Collapsed: true, Items: []LayoutItem{{Panel: "note", X: 0, Y: 9, W: 24, H: 3}}}},
			},
			Annotations: []Annotation{{Name: "Deploys", Store: StorePrometheus, Expr: "changes(kube_deployment_status_observed_generation[1m]) > 0", Color: "series-3", Enable: true}},
		},
	}
}

func TestValidate_AcceptsAValidDashboard(t *testing.T) {
	if probs := Validate(valid()); len(probs) != 0 {
		t.Fatalf("valid dashboard got problems: %v", probs)
	}
}

func TestValidate_FindsEachProblem(t *testing.T) {
	cases := []struct {
		name     string
		break_   func(d *Dashboard)
		wantPath string
		wantMsg  string
	}{
		{"wrong apiVersion", func(d *Dashboard) { d.APIVersion = "v1" }, "apiVersion", "must be"},
		{"bad name", func(d *Dashboard) { d.Metadata.Name = "Web RED" }, "metadata.name", "lowercase"},
		{"no title", func(d *Dashboard) { d.Metadata.Title = " " }, "metadata.title", "required"},
		{"no scope cluster", func(d *Dashboard) { d.Metadata.Scope.Cluster = "" }, "metadata.scope.cluster", "required"},
		{"bad namespace", func(d *Dashboard) { d.Metadata.Scope.Namespaces = []string{"Web_NS"} }, "metadata.scope.namespaces[0]", "namespace"},
		{"refresh too short", func(d *Dashboard) { d.Spec.Refresh = "5s" }, "spec.refresh", "at least 10s"},
		{"refresh not a duration", func(d *Dashboard) { d.Spec.Refresh = "fast" }, "spec.refresh", "duration"},
		{"cursor sync", func(d *Dashboard) { d.Spec.CursorSync = "2" }, "spec.cursorSync", "none, shared"},
		{"duplicate variable", func(d *Dashboard) { d.Spec.Variables[1].Name = "cluster" }, "spec.variables[1].name", "another variable"},
		{"query variable without store", func(d *Dashboard) { d.Spec.Variables[1].Store = "" }, "spec.variables[1].store", "needs a store"},
		{"unknown panel kind", func(d *Dashboard) {
			p := d.Spec.Panels["req-rate"]
			p.Kind = "graph"
			d.Spec.Panels["req-rate"] = p
		}, "spec.panels.req-rate.kind", "panel kind"},
		{"unknown store", func(d *Dashboard) {
			p := d.Spec.Panels["req-rate"]
			p.Queries = []Query{{RefID: "A", Store: "elasticsearch", Expr: "x"}}
			d.Spec.Panels["req-rate"] = p
		}, "spec.panels.req-rate.queries[0].store", "store"},
		{"empty expr", func(d *Dashboard) {
			p := d.Spec.Panels["req-rate"]
			p.Queries = []Query{{RefID: "A", Store: StorePrometheus}}
			d.Spec.Panels["req-rate"] = p
		}, "spec.panels.req-rate.queries[0].expr", "required"},
		{"duplicate refId", func(d *Dashboard) {
			p := d.Spec.Panels["req-rate"]
			p.Queries = append(p.Queries, Query{RefID: "A", Store: StorePrometheus, Expr: "up"})
			d.Spec.Panels["req-rate"] = p
		}, "spec.panels.req-rate.queries[1].refId", "another query"},
		{"hex colour", func(d *Dashboard) {
			p := d.Spec.Panels["req-rate"]
			p.FieldDefaults.Color = &Color{Mode: "fixed", Token: "#ff0000"}
			d.Spec.Panels["req-rate"] = p
		}, "spec.panels.req-rate.fieldDefaults.color.token", "theme token"},
		{"thresholds going down", func(d *Dashboard) {
			p := d.Spec.Panels["req-rate"]
			p.FieldDefaults.Thresholds.Steps[2].Value = f(50)
			d.Spec.Panels["req-rate"] = p
		}, "spec.panels.req-rate.fieldDefaults.thresholds.steps[2].value", "go up"},
		{"repeat on a missing variable", func(d *Dashboard) {
			p := d.Spec.Panels["req-rate"]
			p.Repeat.Variable = "node"
			d.Spec.Panels["req-rate"] = p
		}, "spec.panels.req-rate.repeat.variable", "no variable"},
		{"unknown matcher", func(d *Dashboard) {
			p := d.Spec.Panels["req-rate"]
			p.Overrides[0].Matcher.Kind = "byFrameRefID"
			d.Spec.Panels["req-rate"] = p
		}, "spec.panels.req-rate.overrides[0].matcher.kind", "matcher"},
		{"wider than the grid", func(d *Dashboard) { d.Spec.Layout.Items[0].W = 20; d.Spec.Layout.Items[0].X = 6 }, "spec.layout.items[0]", "at most 24"},
		{"layout names a missing panel", func(d *Dashboard) { d.Spec.Layout.Items[0].Panel = "gone" }, "spec.layout.items[0].panel", "names no panel"},
		{"panel not placed", func(d *Dashboard) { d.Spec.Layout.Rows = nil }, "spec.panels.note", "not placed"},
		{"panel placed twice", func(d *Dashboard) {
			d.Spec.Layout.Items = append(d.Spec.Layout.Items, LayoutItem{Panel: "note", X: 12, Y: 0, W: 12, H: 8})
		}, "spec.panels.note", "placed 2 times"},
		{"annotation hex colour", func(d *Dashboard) { d.Spec.Annotations[0].Color = "#00ff00" }, "spec.annotations[0].color", "theme token"},
		{"unknown source kind", func(d *Dashboard) { d.Source = &Source{Kind: "grafana-v2"} }, "source.kind", "must be"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := valid()
			tc.break_(d)
			probs := Validate(d)
			for _, p := range probs {
				if p.Path == tc.wantPath && strings.Contains(p.Message, tc.wantMsg) {
					return
				}
			}
			t.Fatalf("want a problem at %s containing %q, got %v", tc.wantPath, tc.wantMsg, probs)
		})
	}
}

func TestValidate_UnsupportedPanelKeepsItsQueriesUnchecked(t *testing.T) {
	d := valid()
	p := d.Spec.Panels["req-rate"]
	p.Kind = Unsupported
	p.Queries = []Query{{RefID: "A", Store: "", Ext: map[string]json.RawMessage{"datasource": json.RawMessage(`{"type":"elasticsearch"}`)}}}
	d.Spec.Panels["req-rate"] = p
	if probs := Validate(d); len(probs) != 0 {
		t.Fatalf("an unsupported panel is kept as it came, got %v", probs)
	}
}

func TestRefreshSeconds(t *testing.T) {
	for in, want := range map[string]int{"10s": 10, "5m": 300, "1h": 3600, "1d": 86400} {
		if got, ok := RefreshSeconds(in); !ok || got != want {
			t.Errorf("RefreshSeconds(%q) = %d, %v; want %d", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "10", "1w", "-5s", "5 s"} {
		if _, ok := RefreshSeconds(in); ok {
			t.Errorf("RefreshSeconds(%q) should not parse", in)
		}
	}
}
