package grafana

import (
	"encoding/json"
	"fmt"
	"sort"
)

// unaccounted walks every object of a Grafana v1 dashboard that the importer
// reads and lists the keys its report did not account for: the loss-0 check.
func unaccounted(raw []byte, rep *Report) ([]string, error) {
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, err
	}
	var missing []string
	if av, _ := root["apiVersion"].(string); len(av) > len(resourceGroup) && av[:len(resourceGroup)] == resourceGroup {
		for k := range root {
			if rep.Accounted(k) == "" {
				missing = append(missing, k)
			}
		}
		root, _ = root["spec"].(map[string]any)
	}
	need := func(path string, v any) {
		o, _ := v.(map[string]any)
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
	// A key preserved whole sits in an Ext map as it came, so its insides are
	// kept too; the walk goes into a key only when the importer read it.
	read := func(path string) bool { return rep.Accounted(path) != "preserved" }
	each := func(path string, v any, fn func(string, any)) {
		if !read(path) {
			return
		}
		for i, x := range asList(v) {
			fn(fmt.Sprintf("%s[%d]", path, i), x)
		}
	}
	for k := range root {
		if rep.Accounted(k) == "" {
			missing = append(missing, k)
		}
	}
	if read("time") {
		need("time", root["time"])
	}
	if tpl, ok := root["templating"].(map[string]any); ok && read("templating") {
		need("templating", tpl)
		each("templating.list", tpl["list"], need)
	}
	if ann, ok := root["annotations"].(map[string]any); ok && read("annotations") {
		need("annotations", ann)
		each("annotations.list", ann["list"], need)
	}
	each("links", root["links"], need)
	var panel func(path string, v any)
	panel = func(path string, v any) {
		p, _ := v.(map[string]any)
		need(path, p)
		each(path+".targets", p["targets"], need)
		if fc, ok := p["fieldConfig"].(map[string]any); ok && read(path+".fieldConfig") {
			need(path+".fieldConfig", fc)
			if read(path + ".fieldConfig.defaults") {
				need(path+".fieldConfig.defaults", fc["defaults"])
			}
			each(path+".fieldConfig.overrides", fc["overrides"], need)
		}
		each(path+".transformations", p["transformations"], need)
		if p["type"] == "row" {
			each(path+".panels", p["panels"], panel)
		}
	}
	each("panels", root["panels"], panel)
	sort.Strings(missing)
	return missing, nil
}

// unaccountedV2 is unaccounted for a schema v2 resource: the objects the
// classic walk checks, in the v2 file's own shape (kind/spec wrappers, the
// elements map, the layout tree), and the wrappers themselves.
func unaccountedV2(raw []byte, rep *Report) ([]string, error) {
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, err
	}
	w := &v2walk{rep: rep}
	w.keys("", root)
	spec := asMap(root["spec"])
	w.keys("spec", spec)
	w.keys("spec.timeSettings", spec["timeSettings"])
	for i, l := range asList(spec["links"]) {
		w.keys(fmt.Sprintf("spec.links[%d]", i), l)
	}
	w.keys("spec.elements", spec["elements"])
	for name, e := range asMap(spec["elements"]) {
		w.element("spec.elements."+name, e)
	}
	w.layout("spec.layout", spec["layout"])
	for i, v := range asList(spec["variables"]) {
		p := fmt.Sprintf("spec.variables[%d]", i)
		w.keys(p, v)
		w.keys(p+".datasource", asMap(v)["datasource"])
		s := asMap(asMap(v)["spec"])
		w.keys(p+".spec", s)
		if q, ok := s["query"].(map[string]any); ok {
			w.keys(p+".spec.query", q)
			w.keys(p+".spec.query.datasource", q["datasource"])
		}
	}
	for i, a := range asList(spec["annotations"]) {
		p := fmt.Sprintf("spec.annotations[%d]", i)
		w.keys(p, a)
		s := asMap(asMap(a)["spec"])
		w.keys(p+".spec", s)
		q := asMap(s["query"])
		w.keys(p+".spec.query", q)
		w.keys(p+".spec.query.datasource", q["datasource"])
		w.keys(p+".spec.legacyOptions", s["legacyOptions"])
	}
	sort.Strings(w.missing)
	return w.missing, nil
}

type v2walk struct {
	rep     *Report
	missing []string
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// kept: an object the import stashed or preserved whole, insides included.
func (w *v2walk) kept(path string) bool { return w.rep.Accounted(path) == "preserved" }

func (w *v2walk) keys(path string, v any) {
	m, ok := v.(map[string]any)
	if !ok || (path != "" && w.kept(path)) {
		return
	}
	for k := range m {
		p := k
		if path != "" {
			p = path + "." + k
		}
		if w.rep.Accounted(p) == "" {
			w.missing = append(w.missing, p)
		}
	}
}

func (w *v2walk) element(p string, e any) {
	if w.kept(p) {
		return
	}
	w.keys(p, e)
	s := asMap(asMap(e)["spec"])
	w.keys(p+".spec", s)
	d := asMap(s["data"])
	w.keys(p+".spec.data", d)
	ds := asMap(d["spec"])
	w.keys(p+".spec.data.spec", ds)
	for i, q := range asList(ds["queries"]) {
		qp := fmt.Sprintf("%s.spec.data.spec.queries[%d]", p, i)
		w.keys(qp, q)
		qs := asMap(asMap(q)["spec"])
		w.keys(qp+".spec", qs)
		dq := asMap(qs["query"])
		w.keys(qp+".spec.query", dq)
		w.keys(qp+".spec.query.datasource", dq["datasource"])
		w.keys(qp+".spec.query.spec", dq["spec"])
	}
	for i, t := range asList(ds["transformations"]) {
		tp := fmt.Sprintf("%s.spec.data.spec.transformations[%d]", p, i)
		w.keys(tp, t)
		w.keys(tp+".spec", asMap(t)["spec"])
	}
	w.keys(p+".spec.data.spec.queryOptions", ds["queryOptions"])
	v := asMap(s["vizConfig"])
	w.keys(p+".spec.vizConfig", v)
	vs := asMap(v["spec"])
	w.keys(p+".spec.vizConfig.spec", vs)
	fc := asMap(vs["fieldConfig"])
	w.keys(p+".spec.vizConfig.spec.fieldConfig", fc)
	w.keys(p+".spec.vizConfig.spec.fieldConfig.defaults", fc["defaults"])
	for i, o := range asList(fc["overrides"]) {
		w.keys(fmt.Sprintf("%s.spec.vizConfig.spec.fieldConfig.overrides[%d]", p, i), o)
	}
}

func (w *v2walk) layout(p string, l any) {
	if w.kept(p) {
		return
	}
	w.keys(p, l)
	s := asMap(asMap(l)["spec"])
	w.keys(p+".spec", s)
	for i, it := range asList(s["items"]) {
		ip := fmt.Sprintf("%s.spec.items[%d]", p, i)
		w.keys(ip, it)
		is := asMap(asMap(it)["spec"])
		w.keys(ip+".spec", is)
		w.keys(ip+".spec.element", is["element"])
		w.keys(ip+".spec.repeat", is["repeat"])
	}
	for _, list := range []string{"rows", "tabs"} {
		for i, r := range asList(s[list]) {
			rp := fmt.Sprintf("%s.spec.%s[%d]", p, list, i)
			w.keys(rp, r)
			rs := asMap(asMap(r)["spec"])
			w.keys(rp+".spec", rs)
			w.keys(rp+".spec.repeat", rs["repeat"])
			w.layout(rp+".spec.layout", rs["layout"])
		}
	}
}
