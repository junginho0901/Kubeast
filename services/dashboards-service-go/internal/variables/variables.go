// Package variables writes a dashboard's variables into its queries, titles
// and links the way Grafana 13.3.0 does: its scenes (v9.0.0, Apache-2.0)
// sceneInterpolator with the formats of formatRegistry, and for a Prometheus
// query the data source's applyTemplateVariables and interpolateQueryExpr
// (grafana-prometheus-datasource v13.2.4, which Grafana 13.3.0 bundles; the
// same in v13.2.5). The rules are read and written anew; the tests hold them
// to Grafana's own code run in node.
//
// A reference is left as it is, and listed, where Grafana needs what this
// package does not have: a field path (${var.key}), a date pattern other than
// ms, seconds or iso, the queryparam format (the URL state), and the built-in
// variables of the screen (__user, __org, __dashboard, __url, __timezone,
// __value, __data, __series, __field, __all_variables, __url_time_range).
// Grafana leaves an unknown variable the same way.
package variables

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// All is the value of the All option.
const All = "$__all"

// Variable is a dashboard variable at its current value.
type Variable struct {
	Name       string
	Kind       string   // "constant" and "textbox" hold one plain value; a constant's own references are written in
	Multi      bool     // several values may be chosen: the value is a list
	IncludeAll bool     // it has the All option
	AllValue   string   // the custom all value, written raw (its own references written in)
	Value      []string // the chosen values: one unless Multi; [All] for All
	Text       []string // their texts
	Options    []string // the option values, which All stands for without a custom all value
}

// Scope is what a target is interpolated with.
type Scope struct {
	Variables  []Variable
	From, To   time.Time // $__from and $__to, in milliseconds
	Interval   string    // $__interval: the screen's interval (interval.Screen)
	IntervalMs int64     // $__interval_ms
}

// Interpolate writes the variables into target with Grafana's default format
// (glob): a title, a link, or a query of a data source that takes them so. It
// returns the references it left as they are.
func Interpolate(target string, s Scope) (string, []string) {
	in := newInterp(s, map[string]string{"__interval": s.Interval, "__interval_ms": strconv.FormatInt(s.IntervalMs, 10)}, nil)
	out := in.run(target, 0)
	return out, in.left
}

// Prometheus is a Prometheus query as the data source sends it
// (applyTemplateVariables without ad hoc filters): each variable without a
// format written by interpolateQueryExpr — one value escaped for a quoted
// string, several or All escaped for a regex and joined as (a|b) — and the
// whole done twice, as there, so a value that names a variable is written in
// too. $__interval and $__interval_ms stay for the data source
// (interval.Query.Interpolate).
func Prometheus(expr string, s Scope) (string, []string) {
	in := newInterp(s, map[string]string{"__interval": "$__interval", "__interval_ms": "$__interval_ms"}, prometheusFormat)
	once := in.run(expr, 0)
	in.left = nil
	return in.run(once, 0), in.left
}

// reference is Grafana's variable syntax (scenes VARIABLE_REGEX): $var,
// [[var]], [[var:format]], ${var}, ${var:format} and ${var<field path>}.
var reference = regexp.MustCompile(`\$(\w+)|\[\[(\w+?)(?::(\w+))?\]\]|\$\{(\w+)((?:\.[^:^{}\[\]]+|\["[^"]*"\]|\['[^']*'\]|\[[^\]"']*\])*)(?::([^}]+))?\}`)

// value is a variable's value as the formats get it: one string or a list,
// or a custom all value, which is written raw.
type value struct {
	list   bool
	items  []string
	custom *string
}

func one(s string) value { return value{items: []string{s}} }

// str is JavaScript's String(value): a list joined by commas.
func (v value) str() string { return strings.Join(v.items, ",") }

// formatter is a default format given as a function: it gets the value and
// whether the variable is multi-valued or has All.
type formatter func(v value, multi, includeAll bool) string

type interp struct {
	scope  Scope
	vars   map[string]*Variable
	scoped map[string]string
	def    formatter
	left   []string
}

func newInterp(s Scope, scoped map[string]string, def formatter) *interp {
	in := &interp{scope: s, vars: map[string]*Variable{}, scoped: scoped, def: def}
	for i := range s.Variables {
		in.vars[s.Variables[i].Name] = &s.Variables[i]
	}
	return in
}

const maxDepth = 8 // a constant or custom all value naming itself stops here

func (in *interp) run(target string, depth int) string {
	var b strings.Builder
	last := 0
	for _, m := range reference.FindAllStringSubmatchIndex(target, -1) {
		b.WriteString(target[last:m[0]])
		last = m[1]
		group := func(i int) string {
			if m[2*i] < 0 {
				return ""
			}
			return target[m[2*i]:m[2*i+1]]
		}
		match := target[m[0]:m[1]]
		name := group(1) + group(2) + group(4)
		format := group(3) + group(6)
		b.WriteString(in.reference(match, name, format, group(5), depth))
	}
	b.WriteString(target[last:])
	return b.String()
}

func (in *interp) leave(match string) string {
	in.left = append(in.left, match)
	return match
}

func (in *interp) reference(match, name, format, fieldPath string, depth int) string {
	if fieldPath != "" || depth > maxDepth {
		return in.leave(match)
	}
	var v value
	var multi, includeAll bool
	var texts func() string
	if s, ok := in.scoped[name]; ok {
		v = one(s)
	} else if vr, ok := in.vars[name]; ok {
		multi, includeAll = vr.Multi, vr.IncludeAll
		v, texts = in.valueOf(vr, depth)
	} else if name == "__from" || name == "__to" {
		t := in.scope.From
		if name == "__to" {
			t = in.scope.To
		}
		if format == "text" {
			return in.leave(match) // Grafana writes the date in the dashboard's time zone
		}
		v = one(strconv.FormatInt(t.UnixMilli(), 10))
	} else {
		return in.leave(match)
	}
	if v.custom != nil {
		raw := *v.custom
		switch format {
		case "text":
			raw = "All"
		case "percentencode":
			raw = encodeURIComponent(raw)
		case "queryparam":
			return in.leave(match)
		}
		sub := newInterp(in.scope, in.scoped, nil)
		out := sub.run(raw, depth+1)
		in.left = append(in.left, sub.left...)
		return out
	}
	if format == "" && in.def != nil {
		return in.def(v, multi, includeAll)
	}
	out, ok := formatValue(v, format, name, texts)
	if !ok {
		return in.leave(match)
	}
	return out
}

// valueOf is the variable's value (getValue) and, for text, its text
// (getValueText).
func (in *interp) valueOf(vr *Variable, depth int) (value, func() string) {
	if vr.Kind == "constant" || vr.Kind == "textbox" {
		s := ""
		if len(vr.Value) > 0 {
			s = vr.Value[0]
		}
		if vr.Kind == "constant" {
			sub := newInterp(in.scope, in.scoped, nil)
			s = sub.run(s, depth+1)
			in.left = append(in.left, sub.left...)
		}
		return one(s), nil // no text of its own: the text format writes the value
	}
	all := len(vr.Value) > 0 && vr.Value[0] == All
	texts := func() string {
		if all {
			return "All"
		}
		if vr.Multi {
			return strings.Join(vr.Text, " + ")
		}
		if len(vr.Text) > 0 {
			return vr.Text[0]
		}
		return ""
	}
	if all {
		if vr.AllValue != "" {
			s := vr.AllValue
			return value{custom: &s}, texts
		}
		return value{list: true, items: append([]string(nil), vr.Options...)}, texts
	}
	if vr.Multi {
		return value{list: true, items: append([]string{}, vr.Value...)}, texts
	}
	if len(vr.Value) == 0 {
		return one(""), texts
	}
	return one(vr.Value[0]), texts
}
