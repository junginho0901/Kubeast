package schema

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/importer/grafana"
	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

const root = "../../"

func TestCommittedFileIsCurrent(t *testing.T) {
	want, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(root + Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is out of date: run go run ./cmd/schemagen from the module root", Path)
	}
	again, _ := Generate()
	if !bytes.Equal(want, again) {
		t.Fatal("Generate is not deterministic")
	}
}

func TestRuleNamingNoFieldFails(t *testing.T) {
	rules["Panel.colour"] = rule{nonEmpty: true}
	defer delete(rules, "Panel.colour")
	if _, err := Generate(); err == nil || !strings.Contains(err.Error(), "Panel.colour") {
		t.Fatalf("want an error naming Panel.colour, got %v", err)
	}
}

// keywords the test checker below implements; the schema may use no other, so
// nothing in it goes unchecked.
var keywords = map[string]bool{
	"$schema": true, "$id": true, "title": true, "description": true, "$ref": true, "$defs": true,
	"type": true, "properties": true, "required": true, "additionalProperties": true, "items": true,
	"enum": true, "const": true, "pattern": true, "minimum": true, "maximum": true,
	"minLength": true, "minProperties": true, "propertyNames": true,
}

func TestSchemaUsesKnownKeywords(t *testing.T) {
	s := load(t)
	var walk func(path string, s map[string]any)
	walk = func(path string, s map[string]any) {
		for k, v := range s {
			if !keywords[k] {
				t.Errorf("%s: keyword %q is not checked by the test checker", path, k)
			}
			switch k {
			case "properties", "$defs":
				for name, sub := range v.(map[string]any) {
					walk(path+"/"+k+"/"+name, sub.(map[string]any))
				}
			case "items", "additionalProperties", "propertyNames":
				if sub, ok := v.(map[string]any); ok {
					walk(path+"/"+k, sub)
				}
			}
		}
	}
	walk("#", s)
}

func TestExamplesPassBoth(t *testing.T) {
	s := load(t)
	files, _ := filepath.Glob(root + "schema/examples/*.json")
	if len(files) == 0 {
		t.Fatal("no examples")
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if errs := check(s, decode(t, b)); len(errs) != 0 {
			t.Errorf("%s fails the schema:\n%s", f, strings.Join(errs, "\n"))
		}
		d, err := strict(b)
		if err != nil {
			t.Errorf("%s: %v", f, err)
			continue
		}
		if probs := model.Validate(d); len(probs) != 0 {
			t.Errorf("%s fails Validate: %v", f, probs)
		}
	}
}

// What the importer writes is what the server stores, so it must pass too.
func TestImportedPassesSchema(t *testing.T) {
	s := load(t)
	b, err := os.ReadFile("../importer/grafana/testdata/edge-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	d, _, err := grafana.Import(b)
	if err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	if errs := check(s, decode(t, out)); len(errs) != 0 {
		t.Fatalf("imported dashboard fails the schema:\n%s", strings.Join(errs, "\n"))
	}
}

// The published dashboards in the importer's corpus pass the schema once imported.
func TestImportedCorpusPassesSchema(t *testing.T) {
	s := load(t)
	files, _ := filepath.Glob("../importer/grafana/testdata/corpus/*/*.json")
	if len(files) == 0 {
		t.Fatal("no corpus")
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		d, _, err := grafana.Import(b)
		if err != nil {
			t.Errorf("%s: %v", f, err)
			continue
		}
		out, _ := json.Marshal(d)
		if errs := check(s, decode(t, out)); len(errs) != 0 {
			t.Errorf("%s fails the schema:\n%s", f, strings.Join(errs, "\n"))
		}
	}
}

// Each broken example must fail the schema and the server alike: the server
// decodes strictly (unknown fields are an error) and then runs Validate.
func TestBrokenFailsBoth(t *testing.T) {
	s := load(t)
	base, err := os.ReadFile(root + "schema/examples/web-red.json")
	if err != nil {
		t.Fatal(err)
	}
	// A missing key whose zero value is valid: the server reads it as zero, and
	// the schema asks writers to send it, as the server itself always does.
	schemaOnly := map[string]bool{"no y": true, "no annotation enable": true}
	cases := []struct {
		name string
		edit func(d map[string]any)
	}{
		{"unknown top field", func(d map[string]any) { d["colour"] = "red" }},
		{"unknown panel field", func(d map[string]any) { panel(d, "latency")["colour"] = "red" }},
		{"wrong apiVersion", func(d map[string]any) { d["apiVersion"] = "v1" }},
		{"wrong kind", func(d map[string]any) { d["kind"] = "Board" }},
		{"bad name", func(d map[string]any) { obj(d, "metadata")["name"] = "Web RED" }},
		{"no title", func(d map[string]any) { delete(obj(d, "metadata"), "title") }},
		{"empty title", func(d map[string]any) { obj(d, "metadata")["title"] = "" }},
		{"no cluster", func(d map[string]any) { obj(d, "metadata", "scope")["cluster"] = "" }},
		{"bad namespace", func(d map[string]any) { obj(d, "metadata", "scope")["namespaces"] = []any{"Web_NS"} }},
		{"no time", func(d map[string]any) { delete(obj(d, "spec"), "time") }},
		{"bad refresh", func(d map[string]any) { obj(d, "spec")["refresh"] = "fast" }},
		{"bad cursorSync", func(d map[string]any) { obj(d, "spec")["cursorSync"] = "all" }},
		{"no panels", func(d map[string]any) { obj(d, "spec")["panels"] = map[string]any{} }},
		{"bad panel name", func(d map[string]any) {
			p := obj(d, "spec", "panels")
			p["req rate"] = p["req-rate"]
			delete(p, "req-rate")
		}},
		{"bad panel kind", func(d map[string]any) { panel(d, "latency")["kind"] = "graph" }},
		{"bad store", func(d map[string]any) { query(d, "latency")["store"] = "elasticsearch" }},
		{"no refId", func(d map[string]any) { delete(query(d, "latency"), "refId") }},
		{"bad colour token", func(d map[string]any) { obj(panel(d, "latency"), "fieldDefaults", "color")["token"] = "#ff0000" }},
		{"bad threshold mode", func(d map[string]any) { obj(panel(d, "error-ratio"), "fieldDefaults", "thresholds")["mode"] = "ratio" }},
		{"bad step colour", func(d map[string]any) {
			steps := obj(panel(d, "error-ratio"), "fieldDefaults", "thresholds")["steps"].([]any)
			steps[1].(map[string]any)["color"] = "orange"
		}},
		{"bad matcher", func(d map[string]any) {
			panel(d, "latency")["overrides"].([]any)[0].(map[string]any)["matcher"].(map[string]any)["kind"] = "byColour"
		}},
		{"bad variable name", func(d map[string]any) { variable(d, 1)["name"] = "1ns" }},
		{"bad variable kind", func(d map[string]any) { variable(d, 1)["kind"] = "datasource" }},
		{"bad variable refresh", func(d map[string]any) { variable(d, 1)["refresh"] = "always" }},
		{"w too wide", func(d map[string]any) { item(d, 2)["w"] = 30 }},
		{"negative x", func(d map[string]any) { item(d, 0)["x"] = -1 }},
		{"zero h", func(d map[string]any) { item(d, 0)["h"] = 0 }},
		{"no y", func(d map[string]any) { delete(item(d, 0), "y") }},
		{"string w", func(d map[string]any) { item(d, 0)["w"] = "6" }},
		{"fraction w", func(d map[string]any) { item(d, 0)["w"] = 6.5 }},
		{"bad annotation colour", func(d map[string]any) {
			obj(d, "spec")["annotations"].([]any)[0].(map[string]any)["color"] = "blue"
		}},
		{"no annotation enable", func(d map[string]any) {
			delete(obj(d, "spec")["annotations"].([]any)[0].(map[string]any), "enable")
		}},
		{"bad source kind", func(d map[string]any) { d["source"] = map[string]any{"kind": "grafana-v2"} }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := decode(t, base).(map[string]any)
			c.edit(d)
			b, _ := json.Marshal(d)
			if errs := check(s, decode(t, b)); len(errs) == 0 {
				t.Error("schema accepted it")
			}
			switch accepted := serverAccepts(b); {
			case schemaOnly[c.name] && !accepted:
				t.Error("server now rejects it too: take it out of schemaOnly")
			case !schemaOnly[c.name] && accepted:
				t.Error("server accepted it, so the schema is stricter than the code")
			}
		})
	}
}

// serverAccepts is the server's check: strict decode (unknown fields are an
// error), then Validate.
func serverAccepts(b []byte) bool {
	d, err := strict(b)
	return err == nil && len(model.Validate(d)) == 0
}

func strict(b []byte) (*model.Dashboard, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var d model.Dashboard
	if err := dec.Decode(&d); err != nil {
		return nil, err
	}
	return &d, nil
}

func load(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile(root + Path)
	if err != nil {
		t.Fatal(err)
	}
	return decode(t, b).(map[string]any)
}

func decode(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func obj(d map[string]any, keys ...string) map[string]any {
	for _, k := range keys {
		d = d[k].(map[string]any)
	}
	return d
}

func panel(d map[string]any, name string) map[string]any { return obj(d, "spec", "panels", name) }

func query(d map[string]any, name string) map[string]any {
	return panel(d, name)["queries"].([]any)[0].(map[string]any)
}

func variable(d map[string]any, i int) map[string]any {
	return obj(d, "spec")["variables"].([]any)[i].(map[string]any)
}

func item(d map[string]any, i int) map[string]any {
	return obj(d, "spec", "layout")["items"].([]any)[i].(map[string]any)
}

// check validates v against the draft 2020-12 subset in keywords and lists
// every failure with its JSON path.
func check(root map[string]any, v any) []string {
	c := &checker{root: root}
	c.at("#", root, v)
	sort.Strings(c.errs)
	return c.errs
}

type checker struct {
	root map[string]any
	errs []string
}

func (c *checker) fail(path, format string, args ...any) {
	c.errs = append(c.errs, path+": "+fmt.Sprintf(format, args...))
}

func (c *checker) at(path string, s map[string]any, v any) {
	if ref, ok := s["$ref"].(string); ok {
		name := strings.TrimPrefix(ref, "#/$defs/")
		c.at(path, c.root["$defs"].(map[string]any)[name].(map[string]any), v)
	}
	if typ, ok := s["type"]; ok && !c.typeOK(typ, v) {
		c.fail(path, "want type %v, got %T", typ, v)
		return
	}
	if k, ok := s["const"]; ok && !reflect.DeepEqual(k, v) {
		c.fail(path, "want %v", k)
	}
	if e, ok := s["enum"].([]any); ok {
		found := false
		for _, x := range e {
			found = found || reflect.DeepEqual(x, v)
		}
		if !found {
			c.fail(path, "%v is not one of %v", v, e)
		}
	}
	switch x := v.(type) {
	case string:
		if p, ok := s["pattern"].(string); ok && !regexp.MustCompile(p).MatchString(x) {
			c.fail(path, "%q does not match %s", x, p)
		}
		if m, ok := s["minLength"].(float64); ok && float64(utf8.RuneCountInString(x)) < m {
			c.fail(path, "shorter than %v", m)
		}
	case float64:
		if m, ok := s["minimum"].(float64); ok && x < m {
			c.fail(path, "%v is below %v", x, m)
		}
		if m, ok := s["maximum"].(float64); ok && x > m {
			c.fail(path, "%v is above %v", x, m)
		}
	case []any:
		if items, ok := s["items"].(map[string]any); ok {
			for i, it := range x {
				c.at(fmt.Sprintf("%s[%d]", path, i), items, it)
			}
		}
	case map[string]any:
		c.object(path, s, x)
	}
}

func (c *checker) object(path string, s map[string]any, x map[string]any) {
	if m, ok := s["minProperties"].(float64); ok && float64(len(x)) < m {
		c.fail(path, "needs at least %v properties", m)
	}
	for _, r := range asList(s["required"]) {
		if _, ok := x[r.(string)]; !ok {
			c.fail(path, "missing %q", r)
		}
	}
	props, _ := s["properties"].(map[string]any)
	names, _ := s["propertyNames"].(map[string]any)
	for k, val := range x {
		if names != nil {
			c.at(path+"{"+k+"}", names, k)
		}
		if sub, ok := props[k].(map[string]any); ok {
			c.at(path+"."+k, sub, val)
			continue
		}
		switch ap := s["additionalProperties"].(type) {
		case bool:
			if !ap {
				c.fail(path, "unknown property %q", k)
			}
		case map[string]any:
			c.at(path+"."+k, ap, val)
		}
	}
}

func (c *checker) typeOK(typ, v any) bool {
	for _, t := range asList(typ) {
		switch t {
		case "object":
			if _, ok := v.(map[string]any); ok {
				return true
			}
		case "array":
			if _, ok := v.([]any); ok {
				return true
			}
		case "string":
			if _, ok := v.(string); ok {
				return true
			}
		case "number":
			if _, ok := v.(float64); ok {
				return true
			}
		case "integer":
			if f, ok := v.(float64); ok && f == math.Trunc(f) {
				return true
			}
		case "boolean":
			if _, ok := v.(bool); ok {
				return true
			}
		case "null":
			if v == nil {
				return true
			}
		}
	}
	return false
}

func asList(v any) []any {
	switch x := v.(type) {
	case []any:
		return x
	case nil:
		return nil
	default:
		return []any{x}
	}
}
