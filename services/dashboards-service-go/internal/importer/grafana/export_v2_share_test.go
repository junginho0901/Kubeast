package grafana

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// shareV2Case is a v2 spec with each reference makeExportableV2 handles.
const shareV2Case = `{
  "variables": [
    {"kind": "DatasourceVariable", "spec": {"name": "ds", "pluginId": "prometheus", "current": {"text": "Main Prom", "value": "P1"}, "options": [{"text": "Main Prom", "value": "P1"}]}},
    {"kind": "DatasourceVariable", "spec": {"name": "unset", "pluginId": "loki", "current": {"text": "", "value": "$__all"}}},
    {"kind": "QueryVariable", "spec": {"name": "via", "query": {"kind": "DataQuery", "group": "prometheus", "version": "v0", "datasource": {"name": "${ds}"}, "spec": {}},
      "current": {"text": "a", "value": "a"}, "options": [{"text": "a", "value": "a"}]}},
    {"kind": "QueryVariable", "spec": {"name": "direct", "query": {"kind": "DataQuery", "group": "prometheus", "version": "v0", "datasource": {"name": "P2"}, "spec": {}},
      "current": {"text": "b", "value": "b"}, "options": []}},
    {"kind": "AdhocVariable", "group": "prometheus", "datasource": {"name": "P2"}, "spec": {"name": "filters"}},
    {"kind": "GroupByVariable", "group": "prometheus", "datasource": {"name": "$ds"}, "spec": {"name": "by"}},
    {"kind": "GroupByVariable", "group": "loki", "datasource": {"name": "$unset"}, "spec": {"name": "by2"}}
  ],
  "elements": {
    "panel-1": {"kind": "Panel", "spec": {"data": {"spec": {"queries": [
      {"kind": "PanelQuery", "spec": {"query": {"kind": "DataQuery", "group": "prometheus", "datasource": {"name": "P2"}, "labels": {"team": "a"}, "spec": {}}}}]}}}},
    "panel-2": {"kind": "Panel", "spec": {"data": {"spec": {"queries": [
      {"kind": "PanelQuery", "spec": {"query": {"kind": "DataQuery", "group": "prometheus", "datasource": {"name": "P3"}, "spec": {}}}},
      {"kind": "PanelQuery", "spec": {"query": {"kind": "DataQuery", "group": "loki", "datasource": {"name": "L1"}, "spec": {}}}},
      {"kind": "PanelQuery", "spec": {"query": {"kind": "DataQuery", "group": "datasource", "datasource": {"name": "-- Dashboard --"}, "spec": {}}}},
      {"kind": "PanelQuery", "spec": {"query": {"kind": "DataQuery", "group": "prometheus", "spec": {}}}},
      {"kind": "PanelQuery", "spec": {"query": {"kind": "DataQuery", "group": "prometheus", "datasource": {"name": "$nope"}, "spec": {}}}}]}}}},
    "panel-3": {"kind": "LibraryPanel", "spec": {"libraryPanel": {"uid": "lib-1", "name": "Shared"}}}
  },
  "layout": {"kind": "RowsLayout", "spec": {"rows": [{"kind": "RowsLayoutRow", "spec": {
    "variables": [{"kind": "DatasourceVariable", "spec": {"name": "secds", "pluginId": "loki", "current": {"text": "Logs", "value": "L1"}}},
                  {"kind": "QueryVariable", "spec": {"name": "secq", "query": {"kind": "DataQuery", "group": "loki", "datasource": {"name": "$secds"}, "spec": {}}, "options": [{"text": "x", "value": "x"}]}}],
    "annotations": [{"kind": "AnnotationQuery", "spec": {"name": "in a row", "query": {"kind": "DataQuery", "group": "tempo", "datasource": {"name": "T1"}, "spec": {}}}}],
    "layout": {"kind": "GridLayout", "spec": {"items": []}}}}]}},
  "annotations": [
    {"kind": "AnnotationQuery", "spec": {"name": "built in", "query": {"kind": "DataQuery", "group": "grafana", "datasource": {"name": "-- Grafana --"}, "spec": {}}}},
    {"kind": "AnnotationQuery", "spec": {"name": "deploys", "query": {"kind": "DataQuery", "group": "loki", "datasource": {"name": "L1"}, "spec": {}}}}
  ]
}`

// Each rule of Grafana's makeExportableV2 on one spec. Numbers count each
// type's data sources in the order Grafana meets them: elements (by name),
// variables, section variables, annotations.
func TestExportV2Shared_Rules(t *testing.T) {
	var spec map[string]any
	if err := json.Unmarshal([]byte(shareV2Case), &spec); err != nil {
		t.Fatal(err)
	}
	rep := &ExportReport{}
	s := &v2sharer{rep: rep, numbers: map[string]map[string]int{}, vars: map[string]string{}, names: map[string]string{"P3": "Thanos"}}
	s.share(spec)
	q := func(el string, i int) string {
		return js(at(spec, "elements", el, "spec", "data", "spec", "queries", i, "spec", "query"))
	}
	got := map[string]string{
		"panel query on P2":   q("panel-1", 0),
		"P3":                  q("panel-2", 0),
		"L1":                  q("panel-2", 1),
		"dashboard query":     q("panel-2", 2),
		"no data source":      q("panel-2", 3),
		"not a ds variable":   q("panel-2", 4),
		"query variable via":  js(at(spec, "variables", 2, "spec")),
		"query variable":      js(at(spec, "variables", 3, "spec", "query")),
		"ds variable":         js(at(spec, "variables", 0, "spec", "current")),
		"adhoc":               js(at(spec, "variables", 4)),
		"group by via":        js(at(spec, "variables", 5)),
		"group by unset":      js(at(spec, "variables", 6)),
		"section query":       js(at(spec, "layout", "spec", "rows", 0, "spec", "variables", 1, "spec")),
		"section ds variable": js(at(spec, "layout", "spec", "rows", 0, "spec", "variables", 0, "spec", "current")),
		"built-in annotation": js(at(spec, "annotations", 0, "spec", "query")),
		"annotation":          js(at(spec, "annotations", 1, "spec", "query")),
		"section annotation":  js(at(spec, "layout", "spec", "rows", 0, "spec", "annotations", 0, "spec", "query")),
	}
	want := map[string]string{
		"panel query on P2":   `{"group":"prometheus","kind":"DataQuery","labels":{"grafana.app/export-label":"prometheus-1","team":"a"},"spec":{}}`,
		"P3":                  `{"group":"prometheus","kind":"DataQuery","labels":{"grafana.app/export-datasource-name":"Thanos","grafana.app/export-label":"prometheus-2"},"spec":{}}`,
		"L1":                  `{"group":"loki","kind":"DataQuery","labels":{"grafana.app/export-datasource-name":"Logs","grafana.app/export-label":"loki-1"},"spec":{}}`,
		"dashboard query":     `{"datasource":{"name":"-- Dashboard --"},"group":"datasource","kind":"DataQuery","spec":{}}`,
		"no data source":      `{"group":"prometheus","kind":"DataQuery","spec":{}}`,
		"not a ds variable":   `{"group":"prometheus","kind":"DataQuery","labels":{"grafana.app/export-label":"prometheus-3"},"spec":{}}`,
		"query variable via":  `{"current":{"text":"","value":""},"name":"via","options":[],"query":{"datasource":{"name":"${ds}"},"group":"prometheus","kind":"DataQuery","labels":{"grafana.app/export-datasource-name":"Main Prom","grafana.app/export-label":"prometheus-4"},"spec":{},"version":"v0"}}`,
		"query variable":      `{"group":"prometheus","kind":"DataQuery","labels":{"grafana.app/export-label":"prometheus-1"},"spec":{},"version":"v0"}`,
		"ds variable":         `{"text":"","value":""}`,
		"adhoc":               `{"group":"prometheus","kind":"AdhocVariable","labels":{"grafana.app/export-label":"prometheus-1"},"spec":{"name":"filters"}}`,
		"group by via":        `{"datasource":{"name":"$ds"},"group":"prometheus","kind":"GroupByVariable","labels":{"grafana.app/export-datasource-name":"Main Prom","grafana.app/export-label":"prometheus-4"},"spec":{"name":"by"}}`,
		"group by unset":      `{"datasource":{"name":"$unset"},"group":"loki","kind":"GroupByVariable","labels":{"grafana.app/export-label":"loki-2"},"spec":{"name":"by2"}}`,
		"section query":       `{"current":{"text":"","value":""},"name":"secq","options":[],"query":{"datasource":{"name":"$secds"},"group":"loki","kind":"DataQuery","labels":{"grafana.app/export-datasource-name":"Logs","grafana.app/export-label":"loki-1"},"spec":{}}}`,
		"section ds variable": `{"text":"","value":""}`,
		"built-in annotation": `{"group":"grafana","kind":"DataQuery","labels":{"grafana.app/export-label":"grafana-1"},"spec":{}}`,
		"annotation":          `{"group":"loki","kind":"DataQuery","labels":{"grafana.app/export-datasource-name":"Logs","grafana.app/export-label":"loki-1"},"spec":{}}`,
		"section annotation":  `{"group":"tempo","kind":"DataQuery","labels":{"grafana.app/export-label":"tempo-1"},"spec":{}}`,
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("%s:\n got %s\nwant %s", k, got[k], w)
		}
	}
	var adj []string
	for _, f := range rep.Adjusted {
		adj = append(adj, f.Path)
	}
	if strings.Join(adj, " ") != "spec.elements.panel-3" {
		t.Errorf("adjusted = %v, want the library panel", rep.Adjusted)
	}
}

// Over every converter case: the shared v2 resource keeps only references
// through a data source variable and to "-- Dashboard --", each reference
// ExportV2 wrote is labelled, query variables have no options, and the file
// imports back with the same panels, sizes and variables (the queries' data
// sources aside, which the importing Grafana chooses).
func TestExportV2Shared_Corpus(t *testing.T) {
	count := 0
	for _, c := range convCases(t) {
		if c.direct {
			continue
		}
		var d *model.Dashboard
		if strings.HasPrefix(c.key, "kubeast/") {
			d = nativeByKey(t, c.key)
		} else {
			var err error
			if d, _, err = Import(c.raw); err != nil {
				t.Fatalf("%s: %v", c.key, err)
			}
		}
		plain, _, err := ExportV2(d)
		if err != nil {
			t.Fatalf("%s: %v", c.key, err)
		}
		out, _, err := ExportV2Shared(d)
		if err != nil {
			t.Fatalf("%s: %v", c.key, err)
		}
		count++
		var p, sh map[string]any
		_ = json.Unmarshal(plain, &p)
		_ = json.Unmarshal(out, &sh)
		before, after := refsOf(p["spec"]), refsOf(sh["spec"])
		for _, r := range after.kept {
			if !strings.HasPrefix(r, "$") && r != "-- Dashboard --" {
				t.Errorf("%s: a reference to %q is left", c.key, r)
			}
		}
		if after.labelled < len(before.kept)-countKeptAsIs(before.kept) {
			t.Errorf("%s: %d references labelled, want at least %d", c.key, after.labelled, len(before.kept)-countKeptAsIs(before.kept))
		}
		for _, v := range anyMaps(mapOr(sh["spec"])["variables"]) {
			if v["kind"] == "QueryVariable" && len(anyList(mapOr(v["spec"])["options"])) != 0 {
				t.Errorf("%s: query variable %v keeps its options", c.key, mapOr(v["spec"])["name"])
			}
		}
		again, _, err := Import(out)
		if err != nil {
			t.Fatalf("%s: the shared file does not import: %v", c.key, err)
		}
		if a, b := contentsWithoutStores(again), contentsWithoutStores(d); !c.v2 && a != b {
			t.Errorf("%s: imports back differently:\n got  %s\n want %s", c.key, a, b)
		}
	}
	if count < 207 {
		t.Errorf("%d dashboards shared, want every converter case", count)
	}
}

type v2refs struct {
	kept     []string // datasource names left on queries and variables
	labelled int
}

// refsOf collects the data source references of a v2 spec and counts the
// export labels.
func refsOf(v any) v2refs {
	var r v2refs
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			if name, ok := mapOr(x["datasource"])["name"].(string); ok {
				if _, isQuery := x["group"]; isQuery {
					r.kept = append(r.kept, name)
				}
			}
			if _, ok := mapOr(x["labels"])[exportLabel]; ok {
				r.labelled++
			}
			for _, e := range x {
				walk(e)
			}
		case []any:
			for _, e := range x {
				walk(e)
			}
		}
	}
	walk(v)
	sort.Strings(r.kept)
	return r
}

func countKeptAsIs(names []string) int {
	n := 0
	for _, s := range names {
		if s == "-- Dashboard --" {
			n++
		}
	}
	return n
}

// contentsWithoutStores is contents with the queries' stores left out.
func contentsWithoutStores(d *model.Dashboard) string {
	c := *d
	c.Spec.Panels = map[string]model.Panel{}
	for n, p := range d.Spec.Panels {
		qs := make([]model.Query, len(p.Queries))
		for i, q := range p.Queries {
			q.Store = ""
			qs[i] = q
		}
		p.Queries = qs
		c.Spec.Panels[n] = p
	}
	vars := make([]model.Variable, len(d.Spec.Variables))
	for i, v := range d.Spec.Variables {
		v.Store = ""
		vars[i] = v
	}
	c.Spec.Variables = vars
	return fmt.Sprint(contents(&c))
}
