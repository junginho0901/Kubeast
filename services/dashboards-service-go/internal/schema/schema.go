// Package schema builds the public JSON Schema (draft 2020-12) of the
// dashboard document from the Go model, so the published schema cannot drift
// from what the code reads: field names and required-ness come from the json
// tags (a field without omitempty is required), and the enums and patterns
// come from the same lists and expressions model.Validate checks. The rules
// below add what a Go type cannot say; Generate fails on a rule that names no
// field, so a renamed field cannot silently drop its rule. The schema checks
// shape only: rules across fields (x + w within the grid, every panel placed
// once, unique names, refresh at least 10s, steps going up) stay in Validate.
package schema

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// ID is where the schema is published: the file in this repository.
const ID = "https://raw.githubusercontent.com/junginho0901/Kubeast/main/services/dashboards-service-go/schema/dashboard.v1alpha1.json"

// Path is the committed schema file, relative to the module root.
const Path = "schema/dashboard.v1alpha1.json"

type rule struct {
	enum        model.Enum
	konst       string
	pattern     string
	keyPattern  string // propertyNames of a map
	itemPattern string // items of a string list
	min, max    *int
	nonEmpty    bool // minLength 1
	minProps    int  // minProperties of a map
	nullable    bool // Go writes an empty required list or map as null
}

func n(v int) *int { return &v }

// rules keyed by "<Go type>.<json name>".
var rules = map[string]rule{
	"Dashboard.apiVersion": {konst: model.APIVersion},
	"Dashboard.kind":       {konst: model.Kind},
	"Metadata.name":        {pattern: model.SlugPattern},
	"Metadata.title":       {nonEmpty: true},
	"Scope.cluster":        {nonEmpty: true},
	"TimeRange.from":       {nonEmpty: true},
	"TimeRange.to":         {nonEmpty: true},
	"Scope.namespaces":     {itemPattern: model.NamespacePattern},
	"Spec.refresh":         {pattern: model.RefreshPattern},
	"Spec.cursorSync":      {enum: model.EnumCursorSync},
	"Spec.panels":          {keyPattern: model.PanelNamePattern, minProps: 1},
	"Panel.kind":           {enum: model.EnumPanelKind},
	"Query.refId":          {nonEmpty: true},
	"Query.store":          {enum: model.EnumStore},
	"Color.token":          {enum: model.EnumColorToken},
	"Thresholds.mode":      {enum: model.EnumThresholdMode},
	"Thresholds.steps":     {nullable: true},
	"ThresholdStep.color":  {enum: model.EnumColorToken},
	"Override.set":         {nullable: true},
	"Matcher.kind":         {enum: model.EnumMatcherKind},
	"Transform.id":         {nonEmpty: true},
	"Repeat.variable":      {nonEmpty: true},
	"Repeat.direction":     {enum: model.EnumRepeatDir},
	"Variable.name":        {pattern: model.VariableNamePattern},
	"Variable.kind":        {enum: model.EnumVariableKind},
	"Variable.store":       {enum: model.EnumStore},
	"Variable.refresh":     {enum: model.EnumRefreshPoint},
	"LayoutItem.panel":     {pattern: model.PanelNamePattern},
	"LayoutItem.x":         {min: n(0), max: n(model.GridColumns - 1)},
	"LayoutItem.y":         {min: n(0)},
	"LayoutItem.w":         {min: n(1), max: n(model.GridColumns)},
	"LayoutItem.h":         {min: n(1)},
	"LayoutRow.y":          {min: n(0)},
	"Link.url":             {nonEmpty: true},
	"Annotation.name":      {nonEmpty: true},
	"Annotation.store":     {enum: model.EnumStore},
	"Annotation.color":     {enum: model.EnumColorToken},
	"Source.kind":          {konst: model.SourceGrafanaV1},
}

var rawMessage = reflect.TypeOf(json.RawMessage{})

// Generate returns the schema file's bytes: indented JSON, keys in order, a
// trailing newline — the same bytes on every run.
func Generate() ([]byte, error) {
	g := &generator{defs: map[string]any{}, used: map[string]bool{}}
	g.of(reflect.TypeOf(model.Dashboard{}))
	var unused []string
	for k := range rules {
		if !g.used[k] {
			unused = append(unused, k)
		}
	}
	if len(unused) > 0 {
		sort.Strings(unused)
		return nil, fmt.Errorf("schema rules name no field: %s", strings.Join(unused, ", "))
	}
	doc := map[string]any{
		"$schema":     "https://json-schema.org/draft/2020-12/schema",
		"$id":         ID,
		"title":       "Kubeast dashboard",
		"description": "A Kubeast dashboard document (" + model.APIVersion + "). Generated from services/dashboards-service-go/internal/model; values the model has no field for go in the ext map of their object.",
		"$ref":        "#/$defs/Dashboard",
		"$defs":       g.defs,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

type generator struct {
	defs map[string]any
	used map[string]bool
}

func (g *generator) of(t reflect.Type) map[string]any {
	if t == rawMessage {
		return map[string]any{} // any JSON value
	}
	switch t.Kind() {
	case reflect.Pointer:
		return g.of(t.Elem())
	case reflect.Struct:
		if _, done := g.defs[t.Name()]; !done {
			g.defs[t.Name()] = nil // placeholder against recursion
			g.defs[t.Name()] = g.object(t)
		}
		return map[string]any{"$ref": "#/$defs/" + t.Name()}
	case reflect.Slice:
		return map[string]any{"type": "array", "items": g.of(t.Elem())}
	case reflect.Map:
		return map[string]any{"type": "object", "additionalProperties": g.of(t.Elem())}
	case reflect.String:
		return map[string]any{"type": "string"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return map[string]any{"type": "integer"}
	case reflect.Float32, reflect.Float64:
		return map[string]any{"type": "number"}
	case reflect.Bool:
		return map[string]any{"type": "boolean"}
	}
	panic("schema: unsupported type " + t.String())
}

func (g *generator) object(t reflect.Type) map[string]any {
	props := map[string]any{}
	var required []string
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if !f.IsExported() || tag == "-" {
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		if name == "" {
			name = f.Name
		}
		s := g.of(f.Type)
		if r, ok := rules[t.Name()+"."+name]; ok {
			g.used[t.Name()+"."+name] = true
			s = apply(s, r)
		}
		props[name] = s
		if !strings.Contains(opts, "omitempty") {
			required = append(required, name)
		}
	}
	out := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		sort.Strings(required)
		out["required"] = required
	}
	return out
}

func apply(s map[string]any, r rule) map[string]any {
	switch {
	case r.konst != "":
		s["const"] = r.konst
	case r.enum != "":
		s["enum"] = model.Values(r.enum)
	}
	if r.pattern != "" {
		s["pattern"] = r.pattern
	}
	if r.keyPattern != "" {
		s["propertyNames"] = map[string]any{"pattern": r.keyPattern}
	}
	if r.itemPattern != "" {
		items, _ := s["items"].(map[string]any)
		items["pattern"] = r.itemPattern
	}
	if r.min != nil {
		s["minimum"] = *r.min
	}
	if r.max != nil {
		s["maximum"] = *r.max
	}
	if r.nonEmpty {
		s["minLength"] = 1
	}
	if r.minProps > 0 {
		s["minProperties"] = r.minProps
	}
	if r.nullable {
		s["type"] = []string{s["type"].(string), "null"}
	}
	return s
}
