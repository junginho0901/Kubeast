package eval

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// Check is one thing graded.
type Check struct {
	Name   string `json:"name"`
	Pass   bool   `json:"pass"`
	Detail string `json:"detail,omitempty"`
}

// Result is a graded answer: it passes when every check does.
type Result struct {
	Case   string  `json:"case"`
	Pass   bool    `json:"pass"`
	Live   bool    `json:"live"`
	Checks []Check `json:"checks"`
}

func (r *Result) add(name string, pass bool, detail string) {
	r.Checks = append(r.Checks, Check{Name: name, Pass: pass, Detail: detail})
}

// Failed lists the checks that did not pass.
func (r *Result) Failed() []Check {
	var out []Check
	for _, c := range r.Checks {
		if !c.Pass {
			out = append(out, c)
		}
	}
	return out
}

type query struct {
	panel, refID string
	expr         string // with the variables put in
	facts        *facts
}

// Grade grades answer (a dashboard document) for c. With q set, every panel
// query and query variable also runs there.
func Grade(ctx context.Context, c Case, answer []byte, q Querier) (r Result) {
	r = Result{Case: c.ID, Live: q != nil}
	defer func() {
		r.Pass = len(r.Failed()) == 0
	}()

	dec := json.NewDecoder(bytes.NewReader(answer))
	dec.DisallowUnknownFields()
	var d model.Dashboard
	if err := dec.Decode(&d); err != nil {
		r.add("document", false, "not a dashboard document: "+err.Error())
		return r
	}
	if probs := model.Validate(&d); len(probs) != 0 {
		r.add("document", false, fmt.Sprintf("%d problems, first %s", len(probs), probs[0]))
	} else {
		r.add("document", true, "")
	}

	drawn := 0
	for _, p := range d.Spec.Panels {
		if p.Kind != "text" {
			drawn++
		}
	}
	r.add("panel count", drawn >= c.Panels.Min && (c.Panels.Max == 0 || drawn <= c.Panels.Max),
		fmt.Sprintf("%d panels with data, want %d to %d", drawn, c.Panels.Min, c.Panels.Max))

	vals := values(c, &d)
	var queries []query
	var parseErrs, noQuery, bare, noLE, clusterM []string
	for _, name := range sortedPanels(d.Spec.Panels) {
		p := d.Spec.Panels[name]
		if p.Kind == "text" {
			continue
		}
		ran := 0
		for _, qq := range p.Queries {
			if qq.Hide || qq.Store == "" || strings.TrimSpace(qq.Expr) == "" {
				continue
			}
			ran++
			if qq.Store != model.StorePrometheus {
				continue
			}
			expr := substitute(qq.Expr, vals)
			f, err := analyse(expr)
			if err != nil {
				parseErrs = append(parseErrs, fmt.Sprintf("%s/%s: %v", name, qq.RefID, err))
				continue
			}
			queries = append(queries, query{panel: name, refID: qq.RefID, expr: expr, facts: f})
			for _, m := range f.bareCounters {
				bare = append(bare, name+": "+m)
			}
			if f.quantileNoLE {
				noLE = append(noLE, name)
			}
			for _, vs := range f.selectors {
				for _, lm := range vs.LabelMatchers {
					if lm.Name == "cluster" {
						clusterM = append(clusterM, name)
					}
				}
			}
		}
		if ran == 0 {
			noQuery = append(noQuery, name)
		}
	}
	r.add("PromQL parses", len(parseErrs) == 0, strings.Join(parseErrs, "; "))
	r.add("every panel has a query", len(noQuery) == 0, strings.Join(noQuery, ", "))
	r.add("counters read as rates", len(bare) == 0, strings.Join(dedupe(bare), ", "))
	r.add("histogram_quantile keeps le", len(noLE) == 0, strings.Join(noLE, ", "))
	r.add("no cluster matcher (the server adds it)", len(clusterM) == 0, strings.Join(dedupe(clusterM), ", "))

	for _, e := range c.Expect {
		var found string
		for _, name := range sortedPanels(d.Spec.Panels) {
			if panelMeets(d.Spec.Panels[name], name, e, queries) {
				found = name
				break
			}
		}
		r.add("asked for: "+e.What, found != "", found)
	}

	for _, s := range c.Scope {
		var outside []string
		for _, qq := range queries {
			for _, vs := range qq.facts.selectors {
				m := metricOf(vs)
				if hasPrefix(m, s.Prefixes) && !keepsTo(vs, s.Label, s.Value) {
					outside = append(outside, qq.panel+": "+m)
				}
			}
		}
		r.add(fmt.Sprintf("kept to %s=%s", s.Label, s.Value), len(outside) == 0, strings.Join(dedupe(outside), ", "))
	}

	if q != nil {
		live(ctx, &r, &d, vals, queries, q)
	}
	return r
}

func panelMeets(p model.Panel, name string, e Expect, queries []query) bool {
	if len(e.Kinds) > 0 && !slices.Contains(e.Kinds, p.Kind) {
		return false
	}
	if len(e.Units) > 0 && !slices.Contains(e.Units, p.FieldDefaults.Unit) {
		return false
	}
	for _, qq := range queries {
		if qq.panel != name {
			continue
		}
		metric := false
		for _, m := range e.Metrics {
			metric = metric || qq.facts.metrics[m]
		}
		fn := len(e.Functions) == 0
		for _, f := range e.Functions {
			fn = fn || qq.facts.functions[f]
		}
		if metric && fn {
			return true
		}
	}
	return false
}

// live runs every query and query variable: an error or an empty answer
// fails, with the literal matchers that match nothing named.
func live(ctx context.Context, r *Result, d *model.Dashboard, vals map[string]string, queries []query, q Querier) {
	for _, qq := range queries {
		n, err := q.Query(ctx, qq.expr)
		name := fmt.Sprintf("returns data: %s/%s", qq.panel, qq.refID)
		switch {
		case err != nil:
			r.add(name, false, "query error: "+err.Error())
		case n == 0:
			r.add(name, false, "empty"+missingValues(ctx, qq, q))
		default:
			r.add(name, true, fmt.Sprintf("%d series", n))
		}
	}
	for _, v := range d.Spec.Variables {
		if v.Kind != model.VarQuery || v.Query == nil || v.Store != model.StorePrometheus {
			continue
		}
		name := "variable has values: " + v.Name
		var n int
		var err error
		switch v.Query.Fn {
		case "label_values":
			n, err = q.LabelValues(ctx, v.Query.Label, substitute(v.Query.Expr, vals))
		case "query_result":
			n, err = q.Query(ctx, substitute(v.Query.Expr, vals))
		default:
			continue
		}
		switch {
		case err != nil:
			r.add(name, false, "query error: "+err.Error())
		case n == 0:
			r.add(name, false, "no values")
		default:
			r.add(name, true, fmt.Sprintf("%d values", n))
		}
	}
}

// missingValues names each label = value of an empty query that no series of
// its metric has — values the answer did not ground in the store.
func missingValues(ctx context.Context, qq query, q Querier) string {
	var missing []string
	for _, vs := range qq.facts.selectors {
		metric := metricOf(vs)
		for _, lm := range vs.LabelMatchers {
			if lm.Name == "__name__" || lm.Type.String() != "=" || lm.Value == "" {
				continue
			}
			sel := fmt.Sprintf("count(%s{%s=%q})", metric, lm.Name, lm.Value)
			if n, err := q.Query(ctx, sel); err == nil && n == 0 {
				missing = append(missing, fmt.Sprintf("%s{%s=%q}", metric, lm.Name, lm.Value))
			}
		}
	}
	if len(missing) == 0 {
		return ""
	}
	return ": nothing has " + strings.Join(dedupe(missing), ", ")
}

func sortedPanels(m map[string]model.Panel) []string {
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	slices.Sort(names)
	return names
}

func hasPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

func dedupe(s []string) []string {
	slices.Sort(s)
	return slices.Compact(s)
}
