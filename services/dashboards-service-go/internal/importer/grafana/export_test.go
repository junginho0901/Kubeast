package grafana

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// importExport imports raw, exports the model and imports that again.
func importExport(t *testing.T, name string, raw []byte) (first, again *model.Dashboard, out []byte) {
	t.Helper()
	first, _, err := Import(raw)
	if err != nil {
		t.Fatalf("%s: import: %v", name, err)
	}
	out, _, err = Export(first)
	if err != nil {
		t.Fatalf("%s: export: %v", name, err)
	}
	again, _, err = Import(out)
	if err != nil {
		t.Fatalf("%s: import of the export: %v", name, err)
	}
	return first, again, out
}

// withoutSource is the model as JSON without the record of where it came
// from, which an export and its import necessarily change.
func withoutSource(t *testing.T, d *model.Dashboard) any {
	t.Helper()
	c := *d
	c.Source = nil
	var v any
	b, _ := json.Marshal(c)
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// TestExport_RoundTrip: every corpus dashboard (52 published, 6 that Grafana
// 13.3.0 served as v1 resources), the v2 samples and the 53 v2 documents
// Grafana 13.3.0 wrote: import → export → import gives the same model, the
// export is valid for the importer, and exporting again gives the same bytes.
func TestExport_RoundTrip(t *testing.T) {
	type doc struct {
		name string
		raw  []byte
	}
	var docs []doc
	for _, f := range corpusFiles(t) {
		docs = append(docs, doc{strings.TrimPrefix(f, "testdata/corpus/"), mustRead(t, f)})
	}
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		docs = append(docs, doc{p.name + " (v2)", p.v2}, doc{p.name + " (Grafana's v1)", p.v1})
	}
	if len(docs) < 170 {
		t.Fatalf("%d documents, want the whole corpus", len(docs))
	}
	for _, dc := range docs {
		first, again, out := importExport(t, dc.name, dc.raw)
		a, b := withoutSource(t, first), withoutSource(t, again)
		if diff := diffPaths("", a, b, 8); len(diff) > 0 {
			t.Errorf("%s: the export imports differently at %v", dc.name, diff)
		}
		if probs := model.Validate(again); len(probs) != 0 {
			t.Errorf("%s: the export imports as an invalid dashboard: %v", dc.name, probs)
		}
		twice, _, _ := Export(again)
		if !bytes.Equal(normalUID(out), normalUID(twice)) {
			t.Errorf("%s: exporting the re-import gives different bytes", dc.name)
		}
	}
}

// normalUID blanks the uid, which a v2 resource carries in its metadata and a
// classic file at its top.
func normalUID(b []byte) []byte {
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	delete(m, "uid")
	delete(m, "schemaVersion")
	out, _ := json.Marshal(m)
	return out
}

// An export restores what the import kept: the data source references, the
// schemaVersion, the original colours and the panel ids.
func TestExport_RestoresKeptValues(t *testing.T) {
	raw := mustRead(t, "testdata/edge-cases.json")
	var orig map[string]any
	_ = json.Unmarshal(raw, &orig)
	_, _, out := importExport(t, "edge-cases", raw)
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["schemaVersion"] != orig["schemaVersion"] || got["uid"] != orig["uid"] {
		t.Errorf("schemaVersion %v uid %v, want %v %v", got["schemaVersion"], got["uid"], orig["schemaVersion"], orig["uid"])
	}
	ids := func(m map[string]any) []string {
		var out []string
		var walk func(list []any)
		walk = func(list []any) {
			for _, p := range list {
				pm := p.(map[string]any)
				if pm["type"] != "row" {
					out = append(out, fmt.Sprintf("%v %v %v", pm["id"], pm["type"], short(pm["datasource"])))
				}
				if inner, ok := pm["panels"].([]any); ok {
					walk(inner)
				}
			}
		}
		walk(m["panels"].([]any))
		sort.Strings(out)
		return out
	}
	if a, b := ids(orig), ids(got); strings.Join(a, "|") != strings.Join(b, "|") {
		t.Errorf("panels (id type datasource) differ:\n%v\n%v", a, b)
	}
	if _, ok := got["__inputs"]; ok {
		t.Error("an imported dashboard keeps its own references; no inputs")
	}
}

// Every value of a classic dashboard comes back in its export, at the same
// path: the corpus, edge-cases and Grafana's v1 of each v2 sample. Not counted:
// values Grafana reads as not set (empty, and the few defaults in absentMeans),
// the database id and save counter the import drops, the resource envelope.
func TestExport_EveryValueComesBack(t *testing.T) {
	type doc struct {
		name string
		raw  []byte
	}
	docs := []doc{{"edge-cases", mustRead(t, "testdata/edge-cases.json")}}
	for _, f := range corpusFiles(t) {
		docs = append(docs, doc{strings.TrimPrefix(f, "testdata/corpus/"), mustRead(t, f)})
	}
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		docs = append(docs, doc{p.name + " (Grafana's v1)", p.v1})
	}
	if len(docs) < 119 {
		t.Fatalf("%d documents, want the whole corpus", len(docs))
	}
	for _, dc := range docs {
		var root map[string]any
		if err := json.Unmarshal(dc.raw, &root); err != nil {
			t.Fatal(err)
		}
		if spec, ok := root["spec"].(map[string]any); ok && root["apiVersion"] != nil {
			root = spec
		}
		delete(root, "id")
		delete(root, "version")
		_, _, out := importExport(t, dc.name, dc.raw)
		var got any
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatal(err)
		}
		want, have := map[string]int{}, map[string]int{}
		leaves(root, "", want)
		leaves(got, "", have)
		var missing []string
		for k, n := range want {
			if have[k] < n {
				missing = append(missing, k)
			}
		}
		sort.Strings(missing)
		if len(missing) > 0 {
			t.Errorf("%s: %d values do not come back, e.g. %v", dc.name, len(missing), missing[:min(len(missing), 5)])
		}
	}
}

// absentMeans: values Grafana reads the same as no key (v1_to_v2alpha1.go,
// v13.3.0), by the end of their path.
var absentMeans = map[string]string{
	".templating.list[].hide": "0", ".templating.list[].includeAll": "false", ".templating.list[].multi": "false",
	".templating.list[].refresh": "0", ".templating.list[].sort": "0",
	".targets[].hide": "false", ".targets[].instant": "false",
}

// leaves counts each value under its path, list positions as [].
func leaves(v any, path string, into map[string]int) {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			leaves(e, path+"."+k, into)
		}
	case []any:
		for _, e := range x {
			leaves(e, path+"[]", into)
		}
	case nil:
	default:
		b, _ := json.Marshal(x)
		if string(b) == `""` {
			return
		}
		for end, v := range absentMeans {
			if strings.HasSuffix(path, end) && string(b) == v {
				return
			}
		}
		into[path+" = "+string(b)]++
	}
}

// A row keeps its id unless a panel or an earlier row has it; then it gets a
// free one and the report says so.
func TestExport_RowIDs(t *testing.T) {
	raw := []byte(`{"title": "rows", "schemaVersion": 42, "panels": [
		{"type": "row", "id": 7, "title": "a", "collapsed": false, "gridPos": {"x": 0, "y": 0, "w": 24, "h": 1}, "panels": []},
		{"type": "timeseries", "id": 1, "title": "p", "gridPos": {"x": 0, "y": 1, "w": 12, "h": 8}},
		{"type": "row", "id": 1, "title": "b", "collapsed": false, "gridPos": {"x": 0, "y": 9, "w": 24, "h": 1}, "panels": []},
		{"type": "row", "id": 7, "title": "c", "collapsed": true, "gridPos": {"x": 0, "y": 10, "w": 24, "h": 1}, "panels": []}]}`)
	d, _, err := Import(raw)
	if err != nil {
		t.Fatal(err)
	}
	out, rep, err := Export(d)
	if err != nil {
		t.Fatal(err)
	}
	var got struct{ Panels []struct{ ID int } }
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	var ids []int
	for _, p := range got.Panels {
		ids = append(ids, p.ID)
	}
	if fmt.Sprint(ids) != "[7 1 2 3]" {
		t.Errorf("ids = %v, want [7 1 2 3]", ids)
	}
	var paths []string
	for _, f := range rep.Adjusted {
		paths = append(paths, f.Path)
	}
	if strings.Join(paths, " ") != "layout.rows[1].id layout.rows[2].id" {
		t.Errorf("adjusted = %v, want the two rows whose id was taken", rep.Adjusted)
	}
}

// A colour that is not the one Grafana name of its token comes back as it was.
func TestExport_ColoursKeepTheirName(t *testing.T) {
	raw := []byte(`{"schemaVersion": 39, "title": "c", "panels": [{"id": 1, "type": "stat", "gridPos": {"x": 0, "y": 0, "w": 6, "h": 4},
		"fieldConfig": {"defaults": {"color": {"mode": "fixed", "fixedColor": "yellow"},
		"thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": null}, {"color": "yellow", "value": 80}]}}, "overrides": []}}]}`)
	_, _, out := importExport(t, "colours", raw)
	for _, want := range []string{`"fixedColor": "yellow"`, `"color": "yellow"`, `"value": 80`} {
		if !bytes.Contains(out, []byte(want)) {
			t.Errorf("export lacks %s:\n%s", want, out)
		}
	}
	d, _, _ := Import(raw)
	if d.Spec.Panels["p1"].FieldDefaults.Color.Token != "state-warn" {
		t.Errorf("yellow still draws as state-warn: %+v", d.Spec.Panels["p1"].FieldDefaults.Color)
	}
}

// The top level comes back in the order it was read: panels before the first
// row, a row followed by the panels it holds open, a folded row with its
// panels inside, and panels after a folded row after it.
func TestExport_LayoutOrder(t *testing.T) {
	raw := []byte(`{"schemaVersion": 39, "title": "l", "panels": [
		{"id": 1, "type": "stat", "gridPos": {"x": 0, "y": 0, "w": 12, "h": 4}},
		{"id": 2, "type": "row", "title": "open", "collapsed": false, "gridPos": {"x": 0, "y": 4, "w": 24, "h": 1}, "panels": []},
		{"id": 3, "type": "stat", "gridPos": {"x": 0, "y": 5, "w": 12, "h": 4}},
		{"id": 4, "type": "row", "title": "folded", "collapsed": true, "gridPos": {"x": 0, "y": 9, "w": 24, "h": 1}, "color": "x",
			"panels": [{"id": 5, "type": "stat", "gridPos": {"x": 0, "y": 10, "w": 12, "h": 4}}]},
		{"id": 6, "type": "stat", "gridPos": {"x": 0, "y": 10, "w": 12, "h": 4}}]}`)
	_, again, out := importExport(t, "layout", raw)
	var got struct {
		Panels []struct {
			ID     int    `json:"id"`
			Type   string `json:"type"`
			Title  string `json:"title"`
			Color  string `json:"color"`
			Panels []struct {
				ID int `json:"id"`
			} `json:"panels"`
		} `json:"panels"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, p := range got.Panels {
		if p.Type == "row" {
			order = append(order, "row "+p.Title+p.Color)
			for _, ip := range p.Panels {
				order = append(order, fmt.Sprintf(" in %d", ip.ID))
			}
			continue
		}
		order = append(order, fmt.Sprintf("%d", p.ID))
	}
	if want := "1|row open|3|row foldedx| in 5|6"; strings.Join(order, "|") != want {
		t.Errorf("order %v, want %s", order, want)
	}
	if again.Spec.Layout.Rows[1].Ext == nil {
		t.Error("the row's own key should stay on the row")
	}
}

// A dashboard made in Kubeast is exported for another Grafana: each store an
// input (or its cluster variable), a mixed panel's queries naming their own.
func TestExport_Native(t *testing.T) {
	files, _ := filepath.Glob("../../../../../evals/dashboards/*/reference.json")
	files = append(files, "../../../schema/examples/web-red.json")
	exported := 0
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var d model.Dashboard
		if json.Unmarshal(raw, &d) != nil || d.APIVersion == "" {
			continue // a decline answer
		}
		exported++
		out, rep, err := Export(&d)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		back, _, err := Import(out)
		if err != nil {
			t.Fatalf("%s: the export does not import: %v", f, err)
		}
		if probs := model.Validate(back); len(probs) != 0 {
			t.Errorf("%s: %v", f, probs)
		}
		if got, want := shape(back), shape(&d); got != want {
			t.Errorf("%s: panels differ after the round trip:\n got  %s\n want %s", f, got, want)
		}
		var root map[string]any
		_ = json.Unmarshal(out, &root)
		if root["schemaVersion"] != float64(LatestSchemaVersion) {
			t.Errorf("%s: schemaVersion %v", f, root["schemaVersion"])
		}
		if uid := root["uid"]; uid != d.Metadata.Name {
			t.Errorf("%s: uid %v, want the dashboard's name", f, uid)
		}
		for _, in := range rep.Inputs {
			if !bytes.Contains(out, []byte("${"+in+"}")) {
				t.Errorf("%s: input %s listed but not used", f, in)
			}
		}
		if bytes.Contains(out, []byte(`"datasource": null`)) {
			t.Errorf("%s: a reference left to the default data source", f)
		}
	}
	if exported < 25 {
		t.Fatalf("%d native dashboards, want the evaluation's references", exported)
	}
}

// shape is what a dashboard draws, panel by panel in layout order: kind,
// title, unit, queries and place. Grafana has no panel names, so a dashboard
// made in Kubeast comes back with p<id> names; the shape ignores them.
func shape(d *model.Dashboard) string {
	type item struct {
		at   [2]int
		text string
	}
	var items []item
	add := func(it model.LayoutItem) {
		p := d.Spec.Panels[it.Panel]
		var qs []string
		for _, q := range p.Queries {
			qs = append(qs, q.RefID+":"+q.Store+":"+q.Expr+":"+q.Legend)
		}
		items = append(items, item{[2]int{it.Y, it.X}, fmt.Sprintf("%s %q %s %dx%d [%s]", p.Kind, p.Title, p.FieldDefaults.Unit, it.W, it.H, strings.Join(qs, "; "))})
	}
	for _, it := range d.Spec.Layout.Items {
		add(it)
	}
	for _, r := range d.Spec.Layout.Rows {
		for _, it := range r.Items {
			add(it)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].at[0] != items[j].at[0] {
			return items[i].at[0] < items[j].at[0]
		}
		return items[i].at[1] < items[j].at[1]
	})
	var out []string
	for _, it := range items {
		out = append(out, it.text)
	}
	var vs []string
	for _, v := range d.Spec.Variables {
		q := ""
		if v.Query != nil {
			q = v.Query.Fn + "(" + v.Query.Expr + "," + v.Query.Label + ")"
		}
		vs = append(vs, v.Name+":"+v.Kind+":"+v.Store+":"+q)
	}
	return strings.Join(out, " | ") + " || " + strings.Join(vs, " | ")
}

func TestExport_NativeReferences(t *testing.T) {
	d := &model.Dashboard{APIVersion: model.APIVersion, Kind: model.Kind,
		Metadata: model.Metadata{Name: "mixed", Title: "Mixed", Scope: model.Scope{Cluster: "*"}},
		Spec: model.Spec{Time: model.TimeRange{From: "now-1h", To: "now"},
			Variables: []model.Variable{{Name: "cluster", Kind: model.VarCluster, Store: model.StorePrometheus},
				{Name: "pod", Kind: model.VarQuery, Store: model.StoreLoki, Query: &model.VariableQuery{Fn: "logql", Expr: `label_values(k8s_pod_name)`}}},
			Panels: map[string]model.Panel{
				"cpu":  {Kind: "timeseries", Queries: []model.Query{{RefID: "A", Store: model.StorePrometheus, Expr: "up"}}},
				"both": {Kind: "timeseries", Queries: []model.Query{{RefID: "A", Store: model.StorePrometheus, Expr: "up"}, {RefID: "B", Store: model.StoreTempo, Expr: "{} | rate()"}}},
			},
			Layout: model.Layout{Items: []model.LayoutItem{{Panel: "cpu", W: 12, H: 8}, {Panel: "both", X: 12, W: 12, H: 8}}}}}
	out, rep, err := Export(d)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		`"uid": "${cluster}"`,    // the Prometheus panel through the cluster variable
		`"uid": "-- Mixed --"`,   // the panel of two stores
		`"uid": "${DS_TEMPO}"`,   // a store without a cluster variable: an input
		`"uid": "${DS_LOKI}"`,    // the Loki variable's data source
		`"query": "{} | rate()"`, // TraceQL in query
		`"query": "prometheus"`,  // the cluster variable as Grafana's data source picker
		`"type": "datasource"`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("export lacks %s", want)
		}
	}
	if strings.Join(rep.Inputs, ",") != "DS_LOKI,DS_TEMPO" {
		t.Errorf("inputs %v", rep.Inputs)
	}
	back, _, err := Import(out)
	if err != nil {
		t.Fatal(err)
	}
	if v := back.Spec.Variables[0]; v.Kind != model.VarCluster || v.Store != model.StorePrometheus {
		t.Errorf("the cluster variable comes back as %+v", v)
	}
	var stores []string
	for _, n := range sortedKeys(back.Spec.Panels) {
		for _, q := range back.Spec.Panels[n].Queries {
			stores = append(stores, q.Store)
		}
	}
	sort.Strings(stores)
	if strings.Join(stores, ",") != "prometheus,prometheus,tempo" {
		t.Errorf("stores after the round trip: %v", stores)
	}
}

// Links and overrides the import kept whole go back to their places.
func TestExport_PositionsOfKeptWholes(t *testing.T) {
	raw := []byte(`{"schemaVersion": 39, "title": "p",
		"links": [{"title": "a", "url": "https://a", "type": "link"}, {"type": "dashboards", "tags": ["x"]}, {"title": "b", "url": "https://b", "targetBlank": true, "icon": "doc"}],
		"panels": [{"id": 1, "type": "timeseries", "gridPos": {"x": 0, "y": 0, "w": 12, "h": 8},
		"fieldConfig": {"defaults": {}, "overrides": [
			{"matcher": {"id": "byName", "options": "x"}, "properties": [{"id": "unit", "value": "s"}]},
			{"matcher": {"id": "byNames", "options": ["a"]}, "properties": []},
			{"matcher": {"id": "byRegexp", "options": "y.*"}, "properties": [{"id": "min", "value": 0}, {"id": "color", "value": {"mode": "fixed"}}]}]}}]}`)
	first, again, out := importExport(t, "positions", raw)
	if diff := diffPaths("", withoutSource(t, first), withoutSource(t, again), 5); len(diff) > 0 {
		t.Fatalf("differs at %v", diff)
	}
	var got struct {
		Links  []map[string]any `json:"links"`
		Panels []struct {
			FieldConfig struct {
				Overrides []struct {
					Matcher map[string]any `json:"matcher"`
				} `json:"overrides"`
			} `json:"fieldConfig"`
		} `json:"panels"`
	}
	_ = json.Unmarshal(out, &got)
	if len(got.Links) != 3 || got.Links[1]["type"] != "dashboards" || got.Links[2]["icon"] != "doc" || got.Links[2]["targetBlank"] != true {
		t.Errorf("links %v", got.Links)
	}
	var ids []string
	for _, o := range got.Panels[0].FieldConfig.Overrides {
		ids = append(ids, fmt.Sprint(o.Matcher["id"]))
	}
	if strings.Join(ids, ",") != "byName,byNames,byRegexp" {
		t.Errorf("overrides %v", ids)
	}
}

// Without the original file (a dashboard changed in Kubeast) the order comes
// from the positions and still gives the same layout; every corpus dashboard
// with rows is tried that way.
func TestExport_OrderFromPositions(t *testing.T) {
	tried := 0
	docs := map[string][]byte{}
	for _, f := range corpusFiles(t) {
		docs[f] = mustRead(t, f)
	}
	for _, p := range append(nativePairs(t), corpusPairs(t)...) {
		docs[p.name+" (Grafana's v1)"] = p.v1 // v2-rows-mixed: panels after a folded row placed above an open one
	}
	for _, f := range sortedKeys(docs) {
		d, _, err := Import(docs[f])
		if err != nil || len(d.Spec.Layout.Rows) == 0 {
			continue
		}
		tried++
		want := withoutSource(t, d)
		d.Source = nil
		out, _, err := Export(d)
		if err != nil {
			t.Fatal(err)
		}
		back, _, err := Import(out)
		if err != nil {
			t.Fatal(err)
		}
		got := withoutSource(t, back)
		wl := want.(map[string]any)["spec"].(map[string]any)["layout"]
		gl := got.(map[string]any)["spec"].(map[string]any)["layout"]
		if diff := diffPaths("", wl, gl, 5); len(diff) > 0 {
			t.Errorf("%s: layout from positions differs at %v", f, diff)
		}
	}
	if tried < 10 {
		t.Fatalf("%d dashboards with rows, want the corpus's", tried)
	}
}

// topLevel lists an exported top level: row titles and panel ids.
func topLevel(t *testing.T, raw []byte) []string {
	t.Helper()
	var d struct {
		Panels []struct {
			ID    int    `json:"id"`
			Type  string `json:"type"`
			Title string `json:"title"`
		} `json:"panels"`
		Spec *struct {
			Panels []struct {
				ID    int    `json:"id"`
				Type  string `json:"type"`
				Title string `json:"title"`
			} `json:"panels"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	if d.Spec != nil {
		d.Panels = d.Spec.Panels
	}
	var out []string
	for _, p := range d.Panels {
		if p.Type == "row" {
			out = append(out, "row "+p.Title)
		} else {
			out = append(out, fmt.Sprint(p.ID))
		}
	}
	return out
}

// An imported dashboard keeps the order of its source file, also where the
// positions say otherwise (Grafana's v1 of a v2 file with panels after a
// folded row at y 0 and 3).
func TestExport_KeepsSourceOrder(t *testing.T) {
	raw := mustRead(t, "testdata/grafana-13.3.0-v2/native/v2-rows-mixed.v1.json")
	_, _, out := importExport(t, "rows-mixed", raw)
	if got, want := strings.Join(topLevel(t, out), "|"), strings.Join(topLevel(t, raw), "|"); got != want {
		t.Errorf("top level\n got  %s\n want %s", got, want)
	}
}

// A layout changed in Kubeast no longer matches the source's order, which is
// then not used: a panel moved into an open row stays there.
func TestExport_ChangedLayoutLeavesTheSourceOrder(t *testing.T) {
	d, _, err := Import(mustRead(t, "testdata/grafana-13.3.0-v2/native/v2-rows-mixed.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	l := &d.Spec.Layout
	open := -1
	for i, r := range l.Rows {
		if !r.Collapsed {
			open = i
			break
		}
	}
	if open < 0 || len(l.Items) == 0 {
		t.Fatal("the sample should have an open row and panels outside the rows")
	}
	moved := l.Items[0]
	l.Items = l.Items[1:]
	moved.Y = l.Rows[open].Y + 20
	l.Rows[open].Items = append(l.Rows[open].Items, moved)
	out, _, err := Export(d)
	if err != nil {
		t.Fatal(err)
	}
	back, _, err := Import(out)
	if err != nil {
		t.Fatal(err)
	}
	if diff := diffPaths("", withoutSource(t, d).(map[string]any)["spec"].(map[string]any)["layout"],
		withoutSource(t, back).(map[string]any)["spec"].(map[string]any)["layout"], 5); len(diff) > 0 {
		t.Errorf("the changed layout comes back differently at %v", diff)
	}
}

// What the Grafana 13.3.0 check found (kubeast/raw/20261101/dash-export):
// values the model normalized away or an import did not keep.
func TestExport_FoundInGrafana(t *testing.T) {
	raw := []byte(`{"schemaVersion": 41, "title": "found", "timezone": "",
		"templating": {"list": [
			{"name": "by", "type": "groupby", "datasource": {"type": "prometheus", "uid": "prom"}, "current": {"text": "job", "value": "job"}},
			{"name": "env", "type": "custom", "query": "prod,stage", "current": {"text": "stage", "value": "stage"}},
			{"name": "zone", "type": "custom", "query": "a,b", "current": {"text": "b", "value": "b"},
				"options": [{"text": "a", "value": "a", "selected": false}, {"text": "b", "value": "b", "selected": true}]}]},
		"panels": [{"id": 1, "type": "timeseries", "gridPos": {"x": 0, "y": 0, "w": 12, "h": 8},
			"fieldConfig": {"defaults": {"color": {"mode": "palette-classic", "seriesBy": "last"},
				"thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": null, "comment": "base"}]}}, "overrides": []}}]}`)
	first, again, out := importExport(t, "found", raw)
	if diff := diffPaths("", withoutSource(t, first), withoutSource(t, again), 5); len(diff) > 0 {
		t.Fatalf("differs at %v", diff)
	}
	var got struct {
		Timezone   *string `json:"timezone"`
		Templating struct {
			List []map[string]json.RawMessage `json:"list"`
		} `json:"templating"`
		Panels []struct {
			FieldConfig struct {
				Defaults struct {
					Color      map[string]any `json:"color"`
					Thresholds struct {
						Steps []map[string]any `json:"steps"`
					} `json:"thresholds"`
				} `json:"defaults"`
			} `json:"fieldConfig"`
		} `json:"panels"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	// an empty timezone is the viewer's default, not "browser"
	if got.Timezone != nil || first.Spec.Timezone != "" {
		t.Errorf("timezone %v / model %q, want none", got.Timezone, first.Spec.Timezone)
	}
	vars := map[string]map[string]json.RawMessage{}
	for _, v := range got.Templating.List {
		vars[strOf(v["name"])] = v
	}
	// a group by keeps its data source (without one Grafana's v2 conversion panics)
	var ds map[string]string
	_ = json.Unmarshal(vars["by"]["datasource"], &ds)
	if ds["type"] != "prometheus" || ds["uid"] != "prom" {
		t.Errorf("group by data source %s", vars["by"]["datasource"])
	}
	// options the import read from the query of a variable that had none stay out
	if _, ok := vars["env"]["options"]; ok {
		t.Errorf("env got options it never had: %s", vars["env"]["options"])
	}
	// the current value's option is selected
	var zone []map[string]any
	_ = json.Unmarshal(vars["zone"]["options"], &zone)
	if len(zone) != 2 || zone[0]["selected"] != false || zone[1]["selected"] != true {
		t.Errorf("zone options %v", zone)
	}
	d := got.Panels[0].FieldConfig.Defaults
	if d.Color["seriesBy"] != "last" || d.Thresholds.Steps[0]["comment"] != "base" {
		t.Errorf("colour %v, thresholds %v: their own keys are lost", d.Color, d.Thresholds.Steps)
	}
}

// v2-only values stay v2 values: a classic panel key Grafana does not know
// is read back as an old panel option (__angularMigration).
func TestExport_V2OnlyValuesStayOffThePanel(t *testing.T) {
	raw := mustRead(t, "testdata/grafana-13.3.0-v2/native/v2-features.v2.json")
	d, rep, err := Import(raw)
	if err != nil {
		t.Fatal(err)
	}
	for name, p := range d.Spec.Panels {
		for _, k := range []string{"subtitle", "conditionalRendering", "v2Element"} {
			if _, ok := p.Ext[k]; ok {
				t.Errorf("%s keeps %s on the panel", name, k)
			}
		}
	}
	var stashed []string
	for k := range d.Spec.Ext {
		if strings.HasSuffix(k, ".subtitle") || strings.HasSuffix(k, ".conditionalRendering") {
			stashed = append(stashed, k)
		}
	}
	if len(stashed) < 2 {
		t.Errorf("subtitle and item conditional rendering should be v2 values: %v", stashed)
	}
	_, exrep, err := Export(d)
	if err != nil || len(exrep.Adjusted) == 0 || exrep.Adjusted[0].Path != "v2:" {
		t.Errorf("the export report should say the v2-only values have no classic place: %+v", exrep)
	}
	reported := false
	for _, f := range rep.Unsupported {
		reported = reported || (strings.HasSuffix(f.Path, ".spec.conditionalRendering") && strings.Contains(f.Path, ".items["))
	}
	if !reported {
		t.Error("an item's conditional rendering should be reported as kept but not applied")
	}
}

// A grid item's conditional rendering is a v2 value too.
func TestExport_GridItemConditionalRendering(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal(mustRead(t, "testdata/grafana-13.3.0-v2/native/v2-tabs.v2.json"), &doc); err != nil {
		t.Fatal(err)
	}
	tab := doc["spec"].(map[string]any)["layout"].(map[string]any)["spec"].(map[string]any)["tabs"].([]any)[0].(map[string]any)
	item := tab["spec"].(map[string]any)["layout"].(map[string]any)["spec"].(map[string]any)["items"].([]any)[0].(map[string]any)
	item["spec"].(map[string]any)["conditionalRendering"] = map[string]any{"kind": "ConditionalRenderingGroup", "spec": map[string]any{"condition": "and", "items": []any{}}}
	raw, _ := json.Marshal(doc)
	d, rep, err := Import(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := d.Spec.Panels["p1"].Ext["conditionalRendering"]; ok {
		t.Error("the grid item's conditional rendering went onto the panel")
	}
	const path = "spec.layout.spec.tabs[0].spec.layout.spec.items[0].spec.conditionalRendering"
	if _, ok := d.Spec.Ext["v2:"+path]; !ok {
		t.Errorf("not kept as a v2 value: %v", sortedKeys(d.Spec.Ext))
	}
	found := false
	for _, f := range rep.Unsupported {
		found = found || f.Path == path
	}
	if !found {
		t.Errorf("not reported: %+v", rep.Unsupported)
	}
}
