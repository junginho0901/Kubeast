package grafana

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// The labels Grafana's v2 export for sharing puts on a data source reference
// it takes out (exporters.ts, v13.3.0): which data source of its type it was,
// and its name, which the import's data source picker shows.
const (
	exportLabel          = "grafana.app/export-label"
	exportDatasourceName = "grafana.app/export-datasource-name"
)

// ExportV2Shared writes a dashboard as ExportV2 does, then as Grafana's v2
// "Export for sharing externally" does (makeExportableV2, v13.3.0): a query,
// annotation, ad hoc or group by variable on a data source loses the
// reference and gets the labels <type>-<n> (n counting that type's data
// sources in order) and, where the name is known, the data source's name, so
// the importing Grafana asks which of its data sources to use; one through a
// data source variable keeps it and gets the labels of the variable's current
// data source; one on "-- Dashboard --" stays. Query variables lose their
// options and current value, data source variables their current value. The
// annotations of rows and tabs are shared too; Grafana leaves them out, which
// ships their data source.
//
// A Kubeast-made dashboard's ${DS_…} inputs are shared the same way, one
// <type>-<n> per store. Grafana inlines library panels from its library
// (convertLibraryPanelToInlinePanel) and then shares them as panels; here a
// library panel goes inline where the import read its definition (a classic
// file shared externally carries it in __elements), under the title the
// dashboard shows (Grafana writes the definition's), and one without stays a
// reference and is reported. A data source's name is known where the
// dashboard names it (a bare name, a data source variable's current text).
func ExportV2Shared(d *model.Dashboard) ([]byte, *ExportReport, error) {
	r, rep, err := v2Resource(d, true)
	if err != nil {
		return nil, nil, err
	}
	if raw, ok := r.spec.(json.RawMessage); ok {
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		if err := dec.Decode(&r.spec); err != nil {
			return nil, nil, err
		}
	}
	spec, _ := r.spec.(map[string]any)
	s := &v2sharer{rep: rep, numbers: map[string]map[string]int{}, vars: map[string]string{}, names: map[string]string{}}
	for _, ds := range r.ds {
		if ds.Name != "" {
			s.names[ds.UID] = ds.Name
		}
	}
	s.share(spec)
	if s.labelled > 0 {
		rep.Adjusted = append(rep.Adjusted, Finding{Path: "spec", Reason: fmt.Sprintf(
			"%d data source references labelled for the importing Grafana to choose its own (%s)", s.labelled, exportLabel)})
	}
	b, err := r.marshal()
	return b, rep, err
}

type v2sharer struct {
	rep      *ExportReport
	numbers  map[string]map[string]int // type → uid → n
	vars     map[string]string         // data source variable → its current uid ("" when none)
	names    map[string]string         // uid → data source name
	labelled int
}

func (s *v2sharer) share(spec map[string]any) {
	var sections []map[string]any
	collectSections(spec["layout"], &sections)
	allVars := anyMaps(spec["variables"])
	allAnnotations := anyMaps(spec["annotations"])
	for _, sec := range sections {
		allVars = append(allVars, anyMaps(sec["variables"])...)
	}
	for _, sec := range sections {
		allAnnotations = append(allAnnotations, anyMaps(sec["annotations"])...)
	}
	for _, v := range allVars {
		if v["kind"] != "DatasourceVariable" {
			continue
		}
		vs := mapOr(v["spec"])
		cur := mapOr(vs["current"])
		uid, _ := cur["value"].(string)
		if strings.HasPrefix(uid, "$") {
			uid = ""
		}
		s.vars[str(vs, "name")] = uid
		if t, _ := cur["text"].(string); uid != "" && t != "" && s.names[uid] == "" {
			s.names[uid] = t
		}
	}
	elements := mapOr(spec["elements"])
	for _, key := range sortedSet(elements) {
		el := mapOr(elements[key])
		switch el["kind"] {
		case "Panel":
			for _, q := range anyMaps(mapOr(mapOr(mapOr(el["spec"])["data"])["spec"])["queries"]) {
				s.query(mapOr(mapOr(q["spec"])["query"]))
			}
		case "LibraryPanel":
			lp := mapOr(mapOr(el["spec"])["libraryPanel"])
			s.rep.Adjusted = append(s.rep.Adjusted, Finding{Path: "spec.elements." + key, Reason: fmt.Sprintf(
				"library panel %v (%v) stays a reference: the importing Grafana needs it", lp["name"], lp["uid"])})
		}
	}
	for _, v := range allVars {
		vs := mapOr(v["spec"])
		switch v["kind"] {
		case "QueryVariable":
			s.query(mapOr(vs["query"]))
			vs["options"] = []any{}
			vs["current"] = map[string]any{"text": "", "value": ""}
		case "DatasourceVariable":
			vs["current"] = map[string]any{"text": "", "value": ""}
		case "AdhocVariable", "GroupByVariable":
			s.reference(v)
		}
	}
	for _, a := range allAnnotations {
		s.query(mapOr(mapOr(a["spec"])["query"]))
	}
}

// query is processDataQueryKind.
func (s *v2sharer) query(q map[string]any) {
	ds := mapOr(q["datasource"])
	if name, _ := ds["name"].(string); name == "" || name == "-- Dashboard --" {
		return
	}
	s.reference(q)
}

// reference labels the data source of o (a DataQuery, or an ad hoc or group
// by variable), and takes the reference out unless it goes through a data
// source variable.
func (s *v2sharer) reference(o map[string]any) {
	uid, _ := mapOr(o["datasource"])["name"].(string)
	if uid == "" {
		return
	}
	group, _ := o["group"].(string)
	resolved := uid
	cur, isVar := s.vars[varName(uid)]
	if isVar && cur != "" {
		resolved = cur
	}
	labels := mapOr(o["labels"])
	if labels == nil {
		labels = map[string]any{}
	}
	byType := s.numbers[group]
	if byType == nil {
		byType = map[string]int{}
		s.numbers[group] = byType
	}
	if byType[resolved] == 0 {
		byType[resolved] = len(byType) + 1
	}
	labels[exportLabel] = fmt.Sprintf("%s-%d", group, byType[resolved])
	if name := s.names[resolved]; name != "" && !builtInDS[resolved] {
		labels[exportDatasourceName] = name
	}
	o["labels"] = labels
	s.labelled++
	if !isVar {
		delete(o, "datasource")
	}
}

// varName is the variable a $name or ${name} reference names, else "".
func varName(uid string) string {
	switch {
	case strings.HasPrefix(uid, "${") && strings.HasSuffix(uid, "}"):
		return uid[2 : len(uid)-1]
	case strings.HasPrefix(uid, "$"):
		return uid[1:]
	}
	return ""
}

// collectSections gathers the specs of rows and tabs, nested ones included
// (visitDashboardLayoutSections).
func collectSections(layout any, into *[]map[string]any) {
	l := mapOr(layout)
	spec := mapOr(l["spec"])
	var sections []map[string]any
	switch l["kind"] {
	case "RowsLayout":
		sections = anyMaps(spec["rows"])
	case "TabsLayout":
		sections = anyMaps(spec["tabs"])
	default:
		return
	}
	for _, sec := range sections {
		ss := mapOr(sec["spec"])
		*into = append(*into, ss)
		collectSections(ss["layout"], into)
	}
}
