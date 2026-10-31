package grafana

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

func load(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func importEdgeCases(t *testing.T) (*model.Dashboard, *Report) {
	t.Helper()
	d, rep, err := Import(load(t, "edge-cases.json"))
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	return d, rep
}

func TestImport_ResultIsAValidDashboard(t *testing.T) {
	d, rep := importEdgeCases(t)
	if probs := model.Validate(d); len(probs) != 0 {
		t.Fatalf("imported dashboard is not valid: %v", probs)
	}
	if rep.Panels != 10 {
		t.Errorf("panels read = %d, want 10 (rows are not panels)", rep.Panels)
	}
	if d.Metadata.Name != "web-red" || d.Metadata.Title != "Web — RED" || d.Metadata.Scope.Cluster != "*" {
		t.Errorf("metadata = %+v", d.Metadata)
	}
	if d.Spec.CursorSync != model.CursorSyncShared || d.Spec.Timezone != "browser" || d.Spec.Time.From != "now-3h" {
		t.Errorf("spec basics = cursor %q tz %q from %q", d.Spec.CursorSync, d.Spec.Timezone, d.Spec.Time.From)
	}
	if d.Source == nil || d.Source.Kind != model.SourceGrafanaV1 || d.Source.SchemaVersion != 39 || d.Source.UID != "web-red-01" {
		t.Errorf("source = %+v", d.Source)
	}
}

// TestImport_EveryKeyIsAccounted is the loss-0 check: every key of every
// object the importer reads is mapped, preserved or dropped — none is skipped.
func TestImport_EveryKeyIsAccounted(t *testing.T) {
	raw := load(t, "edge-cases.json")
	_, rep, err := Import(raw)
	if err != nil {
		t.Fatal(err)
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatal(err)
	}
	var missing []string
	need := func(path string, o map[string]any) {
		for k := range o {
			p := k
			if path != "" {
				p = path + "." + k
			}
			if rep.Accounted(p) == "" {
				missing = append(missing, p)
			}
		}
	}
	need("", root)
	need("time", root["time"].(map[string]any))
	tpl := root["templating"].(map[string]any)
	need("templating", tpl)
	for i, v := range tpl["list"].([]any) {
		need(fmt.Sprintf("templating.list[%d]", i), v.(map[string]any))
	}
	ann := root["annotations"].(map[string]any)
	need("annotations", ann)
	for i, a := range ann["list"].([]any) {
		need(fmt.Sprintf("annotations.list[%d]", i), a.(map[string]any))
	}
	for i, l := range root["links"].([]any) {
		need(fmt.Sprintf("links[%d]", i), l.(map[string]any))
	}
	var walkPanel func(path string, p map[string]any)
	walkPanel = func(path string, p map[string]any) {
		need(path, p)
		for j, tg := range asList(p["targets"]) {
			need(fmt.Sprintf("%s.targets[%d]", path, j), tg.(map[string]any))
		}
		if fc, ok := p["fieldConfig"].(map[string]any); ok {
			need(path+".fieldConfig", fc)
			if def, ok := fc["defaults"].(map[string]any); ok {
				need(path+".fieldConfig.defaults", def)
			}
			for k, o := range asList(fc["overrides"]) {
				need(fmt.Sprintf("%s.fieldConfig.overrides[%d]", path, k), o.(map[string]any))
			}
		}
		for k, tr := range asList(p["transformations"]) {
			need(fmt.Sprintf("%s.transformations[%d]", path, k), tr.(map[string]any))
		}
		if p["type"] == "row" {
			for j, inner := range asList(p["panels"]) {
				walkPanel(fmt.Sprintf("%s.panels[%d]", path, j), inner.(map[string]any))
			}
		}
	}
	for i, p := range root["panels"].([]any) {
		walkPanel(fmt.Sprintf("panels[%d]", i), p.(map[string]any))
	}
	if len(missing) > 0 {
		t.Fatalf("keys read by nobody (lost on import): %v", missing)
	}
	if strings.Join(rep.Dropped, ",") != "id" {
		t.Errorf("dropped = %v, want only Grafana's database id", rep.Dropped)
	}
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func TestImport_PanelKindsAndStores(t *testing.T) {
	d, _ := importEdgeCases(t)
	cases := []struct {
		name, kind, store string
	}{
		{"p1", "timeseries", model.StorePrometheus}, // datasource {type: prometheus, uid: ${ds}}
		{"p2", "stat", model.StorePrometheus},       // legacy singlestat; datasource "${ds}"
		{"p3", "timeseries", model.StorePrometheus}, // legacy graph; no datasource = default
		{"p5", "table", model.StoreLoki},            // datasource named "Loki"
		{"p7", "logs", model.StoreLoki},
		{"p8", "gauge", model.StorePrometheus},
		{"p10", "table", ""}, // Elasticsearch: kept, not run
		{"p11", "text", ""},
	}
	for _, c := range cases {
		p, ok := d.Spec.Panels[c.name]
		if !ok {
			t.Fatalf("panel %s missing; have %v", c.name, keysOf(d.Spec.Panels))
		}
		if p.Kind != c.kind {
			t.Errorf("%s kind = %q, want %q", c.name, p.Kind, c.kind)
		}
		if c.store != "" && (len(p.Queries) == 0 || p.Queries[0].Store != c.store) {
			t.Errorf("%s store = %+v, want %q", c.name, p.Queries, c.store)
		}
	}
	if p := d.Spec.Panels["p10"]; p.Queries[0].Store != "" || p.Ext["datasource"] == nil || p.Queries[0].Ext["query"] == nil {
		t.Errorf("Elasticsearch panel should keep its datasource and query and run on no store: %+v / %+v", p.Ext, p.Queries[0])
	}
	if p := d.Spec.Panels["p9"]; p.Kind != model.Unsupported || string(p.Ext["pluginType"]) != `"grafana-clock-panel"` {
		t.Errorf("plugin panel = %+v", p)
	}
	if p := d.Spec.Panels["p12"]; p.Kind != model.Unsupported || p.Ext["libraryPanel"] == nil {
		t.Errorf("library panel = %+v", p)
	}
	if p := d.Spec.Panels["p3"]; string(p.Ext["legacyType"]) != `"graph"` || p.Ext["yaxes"] == nil || p.Queries[0].MinStep != "30s" {
		t.Errorf("legacy graph should keep its old settings: %+v", p.Ext)
	}
	if q := d.Spec.Panels["p1"].Queries; len(q) != 2 || !q[1].Hide || q[0].Legend != "{{code}}" || q[0].Ext["editorMode"] == nil {
		t.Errorf("p1 queries = %+v", q)
	}
}

func TestImport_Layout(t *testing.T) {
	d, _ := importEdgeCases(t)
	top := map[string]model.LayoutItem{}
	for _, it := range d.Spec.Layout.Items {
		top[it.Panel] = it
	}
	for _, name := range []string{"p1", "p2", "p3", "p9", "p10", "p11", "p12"} {
		if _, ok := top[name]; !ok {
			t.Errorf("%s should be on the top-level grid; items = %+v", name, d.Spec.Layout.Items)
		}
	}
	if it := top["p1"]; it != (model.LayoutItem{Panel: "p1", X: 0, Y: 0, W: 12, H: 8}) {
		t.Errorf("p1 position = %+v", it)
	}
	if len(d.Spec.Layout.Rows) != 2 {
		t.Fatalf("rows = %+v", d.Spec.Layout.Rows)
	}
	pods, details := d.Spec.Layout.Rows[0], d.Spec.Layout.Rows[1]
	if pods.Title != "Pods" || pods.Collapsed || pods.Y != 11 || len(pods.Items) != 1 || pods.Items[0].Panel != "p5" {
		t.Errorf("expanded row should take the panels after it: %+v", pods)
	}
	if details.Title != "Details" || !details.Collapsed || len(details.Items) != 2 || details.Items[0].Panel != "p7" || details.Items[1].Panel != "p8" {
		t.Errorf("collapsed row should hold its own panels: %+v", details)
	}
	if r := d.Spec.Panels["p8"].Repeat; r == nil || r.Variable != "namespace" || r.Direction != "h" || r.MaxPerRow != 3 {
		t.Errorf("p8 repeat = %+v", r)
	}
}

func TestImport_FieldConfig(t *testing.T) {
	d, _ := importEdgeCases(t)
	p1 := d.Spec.Panels["p1"]
	f := p1.FieldDefaults
	if f.Unit != "reqps" || f.Min == nil || *f.Min != 0 || f.Decimals == nil || *f.Decimals != 1 {
		t.Errorf("p1 defaults = %+v", f)
	}
	if f.Color == nil || f.Color.Mode != "fixed" || f.Color.Token != "state-ok" {
		t.Errorf("semi-dark-green should become state-ok: %+v", f.Color)
	}
	if f.Thresholds == nil || len(f.Thresholds.Steps) != 2 || f.Thresholds.Steps[0].Value != nil || f.Thresholds.Steps[1].Color != "state-crit" || *f.Thresholds.Steps[1].Value != 80 {
		t.Errorf("thresholds = %+v", f.Thresholds)
	}
	if p1.Ext["fieldConfig.defaults.custom"] == nil || p1.Ext["fieldConfig.defaults.color"] == nil {
		t.Errorf("custom options and the original colour should be kept: %v", keysOf(p1.Ext))
	}
	if len(p1.Overrides) != 2 || p1.Overrides[0].Matcher.Kind != model.MatchByName || p1.Overrides[1].Matcher.Kind != model.MatchByRefID {
		t.Errorf("overrides = %+v", p1.Overrides)
	}
	if p1.Ext["fieldConfig.overrides[2]"] == nil {
		t.Errorf("the byNames override should be kept in ext: %v", keysOf(p1.Ext))
	}
	if len(p1.Transforms) != 2 || p1.Transforms[0].ID != "organize" || !p1.Transforms[1].Disabled {
		t.Errorf("transforms = %+v", p1.Transforms)
	}
	g := d.Spec.Panels["p8"].FieldDefaults.Thresholds
	if g == nil || g.Mode != "percentage" || g.Steps[0].Color != "state-ok" || g.Steps[1].Color != "state-warn" || g.Steps[2].Color != "state-crit" {
		t.Errorf("hex thresholds should map to state tokens: %+v", g)
	}
}

func TestImport_Variables(t *testing.T) {
	d, _ := importEdgeCases(t)
	byName := map[string]model.Variable{}
	for _, v := range d.Spec.Variables {
		byName[v.Name] = v
	}
	if v := byName["ds"]; v.Kind != model.VarCluster || v.Store != model.StorePrometheus {
		t.Errorf("data source variable = %+v", v)
	}
	if v := byName["cluster"]; v.Kind != model.VarCluster || v.Ext["clusterQuery"] == nil {
		t.Errorf("cluster variable should bind to the cluster selector: %+v", v)
	}
	ns := byName["namespace"]
	if ns.Kind != model.VarQuery || ns.Store != model.StorePrometheus || ns.Query == nil ||
		ns.Query.Fn != "label_values" || ns.Query.Expr != `kube_pod_info{cluster="$cluster"}` || ns.Query.Label != "namespace" {
		t.Errorf("namespace variable = %+v query %+v", ns, ns.Query)
	}
	if ns.Refresh != model.RefreshOnTimeRange || !ns.Multi || !ns.IncludeAll || ns.AllValue != ".*" || ns.Sort != 1 || ns.Regex != "/^web-.*/" {
		t.Errorf("namespace variable options = %+v", ns)
	}
	if v := byName["env"]; v.Kind != model.VarCustom || len(v.Options) != 2 || v.Options[1].Value != "staging" {
		t.Errorf("custom variable = %+v", v)
	}
	if v := byName["interval"]; v.Kind != model.VarInterval || len(v.Options) != 3 || v.Ext["auto"] == nil {
		t.Errorf("interval variable = %+v", v)
	}
	if v := byName["filter"]; v.Kind != model.VarTextbox {
		t.Errorf("textbox variable = %+v", v)
	}
	if v := byName["Filters"]; v.Kind != model.VarAdhoc {
		t.Errorf("adhoc variable = %+v", v)
	}
}

func TestImport_ReportAndPreservation(t *testing.T) {
	d, rep := importEdgeCases(t)
	if d.Spec.Refresh != "10s" || string(d.Spec.Ext["refresh"]) != `"5s"` {
		t.Errorf("refresh 5s should rise to 10s and keep the original: %q %s", d.Spec.Refresh, d.Spec.Ext["refresh"])
	}
	for _, k := range []string{"editable", "fiscalYearStartMonth", "liveNow", "weekStart", "timepicker", "links[1]", "links[0].icon"} {
		if d.Spec.Ext[k] == nil {
			t.Errorf("spec.ext should keep %q; has %v", k, keysOf(d.Spec.Ext))
		}
	}
	wantUnsupported := []string{
		"panels[3]",                          // clock plugin
		"panels[4].targets[0]",               // Elasticsearch query
		"panels[6]",                          // library panel
		"panels[0].transformations[1]",       // spatial
		"panels[0].fieldConfig.overrides[2]", // byNames
		"annotations.list[0]",                // built-in annotations
		"links[1]",                           // dashboards link
	}
	have := map[string]bool{}
	for _, f := range rep.Unsupported {
		have[f.Path] = true
	}
	for _, p := range wantUnsupported {
		if !have[p] {
			t.Errorf("unsupported should list %s; got %+v", p, rep.Unsupported)
		}
	}
	adjusted := map[string]bool{}
	for _, f := range rep.Adjusted {
		adjusted[f.Path] = true
	}
	for _, p := range []string{"refresh", "panels[1].type", "panels[2].type", "templating.list[0]", "templating.list[1]", "panels[8].datasource", "panels[0].fieldConfig.defaults.color.fixedColor"} {
		if !adjusted[p] {
			t.Errorf("adjusted should list %s; got %+v", p, rep.Adjusted)
		}
	}
	if a := d.Spec.Annotations; len(a) != 2 || a[1].Store != model.StorePrometheus || a[1].Color != "state-info" || a[1].Ext["step"] == nil {
		t.Errorf("annotations = %+v", a)
	}
}

func TestImport_SourceAndDeterminism(t *testing.T) {
	raw := load(t, "edge-cases.json")
	d1, _, err1 := Import(raw)
	d2, _, err2 := Import(raw)
	if err1 != nil || err2 != nil {
		t.Fatal(err1, err2)
	}
	var want bytes.Buffer
	if err := json.Compact(&want, raw); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(d1.Source.Raw, want.Bytes()) {
		t.Error("Source.Raw should be the whole original, compacted")
	}
	b1, _ := json.Marshal(d1)
	b2, _ := json.Marshal(d2)
	if !bytes.Equal(b1, b2) {
		t.Error("importing the same file twice should give the same document")
	}
}

func TestImport_Refusals(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want error
	}{
		{"not JSON", `[1, 2]`, ErrNotJSON},
		{"no panels", `{"title": "x"}`, ErrNoPanels},
		{"schema v2", `{"elements": {}, "layout": {}}`, ErrNotV1Schema},
		{"pre-grid rows", `{"title": "x", "rows": []}`, ErrTooOld},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, _, err := Import([]byte(c.in)); !errors.Is(err, c.want) {
				t.Errorf("Import = %v, want %v", err, c.want)
			}
		})
	}
	if _, _, err := Import(load(t, "old-schema.json")); !errors.Is(err, ErrTooOld) {
		t.Errorf("schemaVersion 14 = %v, want ErrTooOld", err)
	}
}

func TestImport_APIEnvelope(t *testing.T) {
	inner := load(t, "edge-cases.json")
	env := append(append([]byte(`{"meta": {"slug": "web-red", "folderTitle": "web"}, "dashboard": `), inner...), '}')
	d, _, err := Import(env)
	if err != nil || d.Metadata.Title != "Web — RED" {
		t.Fatalf("envelope import = %v, %+v", err, d)
	}
}

func TestImport_PanelNamesWithoutIDs(t *testing.T) {
	in := `{"title": "t", "schemaVersion": 39, "panels": [
		{"type": "stat", "title": "CPU", "gridPos": {"x": 0, "y": 0, "w": 6, "h": 4}, "targets": [{"refId": "A", "expr": "up"}]},
		{"type": "stat", "title": "CPU", "gridPos": {"x": 6, "y": 0, "w": 6, "h": 4}, "targets": [{"refId": "A", "expr": "up"}]},
		{"type": "text", "gridPos": {"x": 12, "y": 0, "w": 6, "h": 4}}
	]}`
	d, _, err := Import([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"cpu", "cpu-2", "panel"} {
		if _, ok := d.Spec.Panels[name]; !ok {
			t.Errorf("want panel %q; have %v", name, keysOf(d.Spec.Panels))
		}
	}
	if probs := model.Validate(d); len(probs) != 0 {
		t.Errorf("problems: %v", probs)
	}
}

func TestVariableQuery(t *testing.T) {
	cases := map[string]model.VariableQuery{
		"label_values(up, job)":                   {Fn: "label_values", Expr: "up", Label: "job"},
		"label_values(job)":                       {Fn: "label_values", Label: "job"},
		`label_values(up{ns="a,b"}, pod)`:         {Fn: "label_values", Expr: `up{ns="a,b"}`, Label: "pod"},
		"label_names()":                           {Fn: "label_names"},
		"metrics(node_.*)":                        {Fn: "metrics", Expr: "node_.*"},
		"query_result(topk(5, sum by (pod) (x)))": {Fn: "query_result", Expr: "topk(5, sum by (pod) (x))"},
		"up": {Fn: "raw", Expr: "up"},
	}
	for in, want := range cases {
		if got := variableQuery(in, model.StorePrometheus); *got != want {
			t.Errorf("variableQuery(%q) = %+v, want %+v", in, *got, want)
		}
	}
	if got := variableQuery(`{app="web"}`, model.StoreLoki); got.Fn != "logql" {
		t.Errorf("a Loki variable query = %+v", got)
	}
}

func TestSlug(t *testing.T) {
	for in, want := range map[string]string{
		"Web — RED": "web-red",
		"  Kubernetes / Compute Resources / Pod ": "kubernetes-compute-resources-pod",
		"노드 대시보드":                                 "imported",
		strings.Repeat("a", 80):                   strings.Repeat("a", 63),
	} {
		if got := slug(in); got != want {
			t.Errorf("slug(%q) = %q, want %q", in, got, want)
		}
	}
}

func keysOf[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
