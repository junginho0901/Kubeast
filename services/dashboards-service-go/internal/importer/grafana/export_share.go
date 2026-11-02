package grafana

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// ExportShared writes d as Grafana's "Export for sharing externally" does
// (makeExportableV1, v13.3.0): each data source a panel, query, annotation or
// query, ad hoc or group by variable names becomes a ${DS_…} input the
// importing Grafana asks for, a data source variable's current value becomes
// the input of the data source the dashboard used through it, query variables
// lose their options and current value, constants become ${VAR_…} inputs, and
// __requires lists the plugins. Grafana leaves group by variables out, which
// ships their data source; here they are shared as ad hoc ones are. A
// dashboard made in Kubeast is written so by Export too.
//
// Grafana resolves each reference with the data sources of the instance it
// runs in; here only the dashboard is known. A reference names its plugin by
// its type, by the plugin of the data source variable it goes through or, for
// a bare name, as the import reads it; the input is named after the data
// source's name where the dashboard has it (a variable's current text), else
// after the plugin. A reference to the default data source (null) stays as it
// is, as does one whose plugin is not known: both are reported.
func ExportShared(d *model.Dashboard) ([]byte, *ExportReport, error) {
	out, rep, err := Export(d)
	if err != nil || d.Source == nil {
		return out, rep, err
	}
	dec := json.NewDecoder(bytes.NewReader(out))
	dec.UseNumber()
	var root map[string]any
	if err := dec.Decode(&root); err != nil {
		return nil, nil, err
	}
	s := newSharer(root, rep)
	s.share()
	b, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return b, rep, nil
}

// panelPlugins and dsPlugins are the plugin names of Grafana 13.3.0's core and
// bundled plugins (their plugin.json), for __requires and input labels.
var (
	panelPlugins = map[string]string{
		"alertlist": "Alert list", "annolist": "Annotations list", "barchart": "Bar chart", "bargauge": "Bar gauge",
		"candlestick": "Candlestick", "canvas": "Canvas", "dashlist": "Dashboard list", "debug": "Debug",
		"flamegraph": "Flame Graph", "gauge": "Gauge", "geomap": "Geomap", "heatmap": "Heatmap", "histogram": "Histogram",
		"live": "Live", "logs": "Logs", "logstable": "Logs Table", "news": "News", "nodeGraph": "Node Graph",
		"piechart": "Pie chart", "stat": "Stat", "state-timeline": "State timeline", "status-history": "Status history",
		"table": "Table", "text": "Text", "timeseries": "Time series", "traces": "Traces", "trend": "Trend", "xychart": "XY Chart",
	}
	dsPlugins = map[string]string{
		"alertmanager": "Alertmanager", "azuremonitor": "Azure Monitor", "cloudwatch": "CloudWatch",
		"elasticsearch": "Elasticsearch", "grafana-postgresql-datasource": "PostgreSQL",
		"grafana-pyroscope-datasource": "Grafana Pyroscope", "grafana-testdata-datasource": "TestData",
		"graphite": "Graphite", "influxdb": "InfluxDB", "jaeger": "Jaeger", "loki": "Loki",
		"mssql": "Microsoft SQL Server", "mysql": "MySQL", "opentsdb": "OpenTSDB", "prometheus": "Prometheus",
		"stackdriver": "Google Cloud Monitoring", "tempo": "Tempo", "zipkin": "Zipkin",
	}
	builtInDS = map[string]bool{"-- Grafana --": true, "-- Mixed --": true, "-- Dashboard --": true, "grafana": true}
	// varUse is Grafana's variableRegex: $name, ${name}, ${name:format}, [[name]].
	varUse    = regexp.MustCompile(`^(?:\$(\w+)|\[\[(\w+?)(?::(\w+))?\]\]|\$\{(\w+)(?:\.([^:^}]+))?(?::([^}]+))?\})$`)
	notInName = regexp.MustCompile(`[^A-Z0-9_]+`)
)

type dsInput struct{ typ, uid, name string }

type sharer struct {
	root     map[string]any
	rep      *ExportReport
	vars     map[string]map[string]any
	given    map[string]bool // input names the source already had
	inputs   []map[string]any
	byKey    map[dsInput]string
	names    map[string]bool
	requires map[string]map[string]any
	viaVar   map[string]string // data source variable → ${input} of what went through it
	current  []dsInput         // the data source variables' current data sources, as the source had them
	left     map[string]int    // reason → references left as they were
}

func newSharer(root map[string]any, rep *ExportReport) *sharer {
	s := &sharer{root: root, rep: rep, vars: map[string]map[string]any{}, given: map[string]bool{}, byKey: map[dsInput]string{},
		names: map[string]bool{}, requires: map[string]map[string]any{}, viaVar: map[string]string{}, left: map[string]int{}}
	for _, v := range s.variables() {
		if n, _ := v["name"].(string); n != "" {
			s.vars[n] = v
		}
		cur, _ := v["current"].(map[string]any)
		if uid, _ := cur["value"].(string); v["type"] == "datasource" && uid != "" {
			typ, _ := v["query"].(string)
			name, _ := cur["text"].(string)
			s.current = append(s.current, dsInput{typ: typ, uid: uid, name: name})
		}
	}
	for _, in := range anyList(root["__inputs"]) {
		if m, ok := in.(map[string]any); ok {
			n, _ := m["name"].(string)
			s.given[n], s.names[n] = true, true
			s.inputs = append(s.inputs, m)
		}
	}
	for _, r := range anyList(root["__requires"]) {
		if m, ok := r.(map[string]any); ok {
			s.requires[fmt.Sprint(m["type"], m["id"])] = m
		}
	}
	return s
}

func (s *sharer) variables() []map[string]any {
	tpl, _ := s.root["templating"].(map[string]any)
	var out []map[string]any
	for _, v := range anyList(tpl["list"]) {
		if m, ok := v.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func (s *sharer) share() {
	for _, p := range anyList(s.root["panels"]) {
		pm, _ := p.(map[string]any)
		s.panel(pm)
		if c, _ := pm["collapsed"].(bool); c {
			for _, in := range anyList(pm["panels"]) {
				ip, _ := in.(map[string]any)
				s.panel(ip)
			}
		}
	}
	for _, v := range s.variables() {
		switch v["type"] {
		case "query":
			s.templatize(v, nil, "query variable "+fmt.Sprint(v["name"]))
			v["options"], v["current"] = []any{}, map[string]any{}
			if r, ok := v["refresh"].(json.Number); !ok || r.String() == "0" {
				v["refresh"] = 1 // a query variable without options has to run
			}
		case "datasource":
			if in := s.viaVar[fmt.Sprint(v["name"])]; in != "" {
				v["current"] = map[string]any{"text": "", "value": in, "selected": true}
			} else {
				v["current"] = map[string]any{}
			}
		case "adhoc", "groupby": // Grafana 13.3.0 leaves group by variables out and so ships their data source
			s.templatize(v, nil, v["type"].(string)+" variable "+fmt.Sprint(v["name"]))
		}
	}
	an, _ := s.root["annotations"].(map[string]any)
	for _, a := range anyList(an["list"]) {
		am, _ := a.(map[string]any)
		s.templatize(am, nil, "annotation "+fmt.Sprint(am["name"]))
	}
	s.v2Queries(s.root)
	s.require("grafana", "grafana", "Grafana", grafanaVersion)
	for _, v := range s.variables() {
		if v["type"] != "constant" {
			continue
		}
		name := "VAR_" + notInName.ReplaceAllString(strings.ToUpper(fmt.Sprint(v["name"])), "_")
		label, _ := v["label"].(string)
		if label == "" {
			label = fmt.Sprint(v["name"])
		}
		if !s.names[name] {
			s.names[name] = true
			s.inputs = append(s.inputs, map[string]any{"name": name, "type": "constant", "label": label, "value": v["query"], "description": ""})
		}
		ref := "${" + name + "}"
		v["query"] = ref
		v["current"] = map[string]any{"value": ref, "text": ref, "selected": false}
		v["options"] = []any{v["current"]}
	}
	s.finish()
}

// grafanaVersion is the Grafana an export is checked against.
const grafanaVersion = "13.3.0"

func (s *sharer) panel(p map[string]any) {
	if p == nil || p["type"] == "row" {
		return
	}
	where := "panel " + fmt.Sprint(p["id"])
	s.templatize(p, nil, where)
	for _, t := range anyList(p["targets"]) {
		if tm, ok := t.(map[string]any); ok {
			s.templatize(tm, p["datasource"], where+" query "+fmt.Sprint(tm["refId"]))
		}
	}
	if lp, ok := p["libraryPanel"].(map[string]any); ok && !s.defined(lp["uid"]) {
		s.rep.Adjusted = append(s.rep.Adjusted, Finding{Path: where, Reason: fmt.Sprintf(
			"library panel %v (%v) is referenced, not included: the importing Grafana needs it", lp["name"], lp["uid"])})
	}
	t, _ := p["type"].(string)
	if name, ok := panelPlugins[t]; ok {
		s.require("panel", t, name, "")
	}
}

// defined says whether the file carries the library panel's definition in
// __elements, as the shared file it was imported from did.
func (s *sharer) defined(uid any) bool {
	id, _ := uid.(string)
	for key, el := range mapOr(s.root["__elements"]) {
		if u, _ := mapOr(el)["uid"].(string); id != "" && (u == id || (u == "" && key == id)) {
			return true
		}
	}
	return false
}

// templatize is Grafana's templateizeDatasourceUsage on o.
func (s *sharer) templatize(o map[string]any, fallback any, where string) {
	if o == nil {
		return
	}
	ref, ok := o["datasource"]
	if !ok {
		if fallback != nil {
			o["datasource"] = fallback
		}
		return
	}
	var typ, uid, name string
	switch r := ref.(type) {
	case nil:
		s.left["the default data source (null), which the importing Grafana reads as its own default"]++
		return
	case string:
		uid = r
	case map[string]any:
		typ, _ = r["type"].(string)
		uid, _ = r["uid"].(string)
	default:
		s.left[fmt.Sprintf("a reference that is neither a name nor an object (%s)", where)]++
		return
	}
	if typ == "datasource" || typ == "grafana" || builtInDS[uid] {
		return
	}
	var viaVar string
	if m := varUse.FindStringSubmatch(uid); m != nil {
		v := m[1] + m[2] + m[4]
		if s.viaVar[v] != "" {
			return
		}
		dv, isVar := s.vars[v]
		switch {
		case isVar && dv["type"] == "datasource":
			viaVar = v
			typ, _ = dv["query"].(string)
			cur, _ := dv["current"].(map[string]any)
			uid, _ = cur["value"].(string)
			name, _ = cur["text"].(string)
			if g := varUse.FindStringSubmatch(uid); g != nil && s.given[g[1]+g[2]+g[4]] {
				s.viaVar[v] = uid // already set to an input of the shared file this came from
				return
			}
		case s.given[v]:
			return // already an input of the shared file this came from
		default:
			s.left[fmt.Sprintf("a reference to $%s, which is no data source variable or input", v)]++
			return
		}
	} else if _, isObj := ref.(map[string]any); !isObj {
		name, uid = uid, ""
		if t, found := nameStore(name); found {
			typ = t
		}
	}
	if t, n := s.byCurrent(uid); t != "" && (typ == "" || typ == t) {
		typ = t
		if name == "" {
			name = n
		}
	}
	if typ == "" {
		s.left[fmt.Sprintf("a data source whose plugin the dashboard does not name (%s)", where)]++
		return
	}
	in := s.input(dsInput{typ: typ, uid: uid, name: name}, o["libraryPanel"] != nil)
	if viaVar != "" {
		s.viaVar[viaVar] = "${" + in + "}"
		return
	}
	o["datasource"] = map[string]any{"type": typ, "uid": "${" + in + "}"}
}

// v2Queries shares the v2 queries that v2-only values carry for a v2 import
// (Grafana's classic reads none of them): {group, datasource: {name: uid}}.
func (s *sharer) v2Queries(v any) {
	switch x := v.(type) {
	case map[string]any:
		typ, _ := x["group"].(string)
		ref, _ := x["datasource"].(map[string]any)
		if uid, ok := ref["name"].(string); ok && len(ref) == 1 && typ != "" && typ != "datasource" && typ != "grafana" &&
			!builtInDS[uid] && varUse.FindStringSubmatch(uid) == nil {
			_, name := s.byCurrent(uid)
			ref["name"] = "${" + s.input(dsInput{typ: typ, uid: uid, name: name}, false) + "}"
		}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys) // inputs are named in the order data sources are met
		for _, k := range keys {
			s.v2Queries(x[k])
		}
	case []any:
		for _, e := range x {
			s.v2Queries(e)
		}
	}
}

// byCurrent finds the data source variable whose current value is uid: its
// plugin and the data source's name.
func (s *sharer) byCurrent(uid string) (typ, name string) {
	if uid == "" {
		return "", ""
	}
	for _, c := range s.current {
		if c.uid == uid {
			return c.typ, c.name
		}
	}
	return "", ""
}

// nameStore reads a bare data source name as the import does.
func nameStore(name string) (string, bool) {
	lower := strings.ToLower(name)
	for _, t := range []string{"prometheus", "loki", "tempo", "alertmanager"} {
		if strings.Contains(lower, t) {
			return t, true
		}
	}
	return "", false
}

// input names the data source k: DS_ and its name (or its plugin's), with a
// number after it when another data source has that name.
func (s *sharer) input(k dsInput, library bool) string {
	key := k
	if k.uid != "" {
		key.name = "" // one data source, whatever name a reference gives it
	}
	if library {
		key.name += "\x00library"
	}
	if n, ok := s.byKey[key]; ok {
		return n
	}
	plugin := dsPlugins[k.typ]
	if plugin == "" {
		plugin = k.typ
	}
	label := k.name
	if label == "" || label == "default" || strings.HasPrefix(label, "$") {
		label = plugin
	}
	base := "DS_" + notInName.ReplaceAllString(strings.ToUpper(label), "_")
	if library {
		base += "-FOR-LIBRARY-PANEL"
	}
	name := base
	for n := 2; s.names[name]; n++ {
		name = fmt.Sprintf("%s_%d", base, n)
	}
	s.names[name], s.byKey[key] = true, name
	desc := ""
	if k.uid != "" && !strings.HasPrefix(k.uid, "$") {
		desc = "uid " + k.uid + " where the dashboard came from"
	}
	s.inputs = append(s.inputs, map[string]any{"name": name, "label": label, "description": desc, "type": "datasource", "pluginId": k.typ, "pluginName": plugin})
	s.require("datasource", k.typ, plugin, "1.0.0")
	return name
}

// require adds a plugin to __requires unless the source listed it already.
func (s *sharer) require(typ, id, name, version string) {
	if _, ok := s.requires[typ+id]; !ok {
		s.requires[typ+id] = map[string]any{"type": typ, "id": id, "name": name, "version": version}
	}
}

func (s *sharer) finish() {
	var inputs []any
	s.rep.Inputs = nil
	for _, in := range s.inputs {
		inputs = append(inputs, in)
		s.rep.Inputs = append(s.rep.Inputs, fmt.Sprint(in["name"]))
	}
	reqs := make([]map[string]any, 0, len(s.requires))
	for _, r := range s.requires {
		reqs = append(reqs, r)
	}
	sort.SliceStable(reqs, func(i, j int) bool {
		a, b := fmt.Sprint(reqs[i]["id"]), fmt.Sprint(reqs[j]["id"])
		if a != b {
			return a < b
		}
		return fmt.Sprint(reqs[i]["type"]) < fmt.Sprint(reqs[j]["type"])
	})
	s.root["__inputs"] = nonNilAny(inputs)
	s.root["__requires"] = reqs
	if _, ok := s.root["__elements"]; !ok {
		s.root["__elements"] = map[string]any{}
	}
	reasons := make([]string, 0, len(s.left))
	for r := range s.left {
		reasons = append(reasons, r)
	}
	sort.Strings(reasons)
	for _, r := range reasons {
		s.rep.Adjusted = append(s.rep.Adjusted, Finding{Path: "datasource", Reason: fmt.Sprintf("%d left as they were: %s", s.left[r], r)})
	}
}

func anyList(v any) []any {
	l, _ := v.([]any)
	return l
}

func nonNilAny(l []any) []any {
	if l == nil {
		return []any{}
	}
	return l
}
