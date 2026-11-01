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
