package eval

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
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
	Answer string  `json:"answer,omitempty"`
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

// clusterLabels: the matcher a store's query must not carry, since Kubeast
// adds the cluster to every query itself.
var clusterLabels = map[string]string{
	model.StorePrometheus: "cluster", model.StoreLoki: "k8s_cluster_name", model.StoreTempo: "resource.k8s.cluster.name",
}

type query struct {
	panel, refID, store string
	raw, expr           string // as written; with the variables put in
	facts               *facts // PromQL
	text                textFacts
}

// declined: an answer that says the data is not there instead of a
// dashboard, {"declined": "<why>"}.
func declined(answer []byte) (string, bool) {
	var probe map[string]json.RawMessage
	if json.Unmarshal(answer, &probe) != nil {
		return "", false
	}
	raw, ok := probe["declined"]
	if !ok || probe["apiVersion"] != nil {
		return "", false
	}
	var why string
	_ = json.Unmarshal(raw, &why)
	return why, true
}

// Grade grades answer for c, running queries on the stores given.
func Grade(ctx context.Context, c Case, answer []byte, s Stores) (r Result) {
	r = Result{Case: c.ID, Live: s.live()}
	defer func() {
		r.Pass = len(r.Failed()) == 0
	}()

	if why, ok := declined(answer); ok {
		if c.Kind == KindDecline {
			r.add("declined with a reason", strings.TrimSpace(why) != "", why)
			if s.Prometheus != nil {
				absent(ctx, &r, c, s.Prometheus)
			}
		} else {
			r.add("answered, not declined", false, "declined: "+why)
		}
		return r
	}
	if c.Kind == KindDecline {
		r.add("declined, not answered", false, "a dashboard for data that is not there: "+strings.Join(c.Forbid, ", "))
		return r
	}

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
	if c.Panels.Min > 0 || c.Panels.Max > 0 {
		r.add("panel count", drawn >= c.Panels.Min && (c.Panels.Max == 0 || drawn <= c.Panels.Max),
			fmt.Sprintf("%d panels with data, want %d to %d", drawn, c.Panels.Min, c.Panels.Max))
	}

	vals := values(c, &d)
	queries := collect(&r, &d, vals)

	for _, e := range c.Expect {
		found := meets(&d, e, queries)
		r.add("asked for: "+e.What, found != "", found)
	}
	if a := c.ExpectAny; a != nil {
		var got, names []string
		for _, e := range a.Of {
			names = append(names, e.What)
			if meets(&d, e, queries) != "" {
				got = append(got, e.What)
			}
		}
		r.add(fmt.Sprintf("asked for %d of: %s", a.Need, strings.Join(names, ", ")), len(got) >= a.Need, strings.Join(got, ", "))
	}

	for _, sc := range c.Scope {
		var outside []string
		for _, qq := range queries {
			if qq.facts == nil {
				continue
			}
			for _, vs := range qq.facts.selectors {
				m := metricOf(vs)
				if hasPrefix(m, sc.Prefixes) && !keepsTo(vs, sc.Label, sc.Value) {
					outside = append(outside, qq.panel+": "+m)
				}
			}
		}
		r.add(fmt.Sprintf("kept to %s=%s", sc.Label, sc.Value), len(outside) == 0, strings.Join(dedupe(outside), ", "))
	}

	for _, name := range c.Variables {
		has := slices.ContainsFunc(d.Spec.Variables, func(v model.Variable) bool { return v.Name == name })
		r.add("has variable: "+name, has, "")
	}

	if len(c.Forbid) > 0 {
		var read []string
		for _, qq := range queries {
			if qq.facts == nil {
				continue
			}
			for m := range qq.facts.metrics {
				if hasPrefix(m, c.Forbid) {
					read = append(read, qq.panel+": "+m)
				}
			}
		}
		r.add("does not read "+strings.Join(c.Forbid, ", "), len(read) == 0, strings.Join(dedupe(read), ", "))
	}

	if c.Kind == KindEdit {
		keep(&r, c, &d)
	}

	if s.live() {
		live(ctx, &r, c, &d, vals, queries, s)
	}
	return r
}

// collect reads every query that runs and adds the checks on how each is
// written.
func collect(r *Result, d *model.Dashboard, vals map[string]string) []query {
	var queries []query
	var parseErrs, noQuery, bare, noLE, clusterM, noSelector, wrongShape []string
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
			q := query{panel: name, refID: qq.RefID, store: qq.Store, raw: qq.Expr, expr: substitute(qq.Expr, vals)}
			switch qq.Store {
			case model.StorePrometheus:
				f, err := analyse(q.expr)
				if err != nil {
					parseErrs = append(parseErrs, fmt.Sprintf("%s/%s: %v", name, qq.RefID, err))
					continue
				}
				q.facts = f
				for _, m := range f.bareCounters {
					bare = append(bare, name+": "+m)
				}
				if f.quantileNoLE {
					noLE = append(noLE, name)
				}
				for _, vs := range f.selectors {
					for _, lm := range vs.LabelMatchers {
						if lm.Name == clusterLabels[model.StorePrometheus] {
							clusterM = append(clusterM, name)
						}
					}
				}
			case model.StoreLoki, model.StoreTempo:
				if qq.Store == model.StoreLoki {
					q.text = analyseLog(q.expr)
				} else {
					q.text = analyseTrace(q.expr)
				}
				if q.text.selectors == 0 {
					noSelector = append(noSelector, name)
				}
				if q.text.labels[clusterLabels[qq.Store]] {
					clusterM = append(clusterM, name)
				}
				// log lines and traces go in a logs or traces panel; anything
				// else draws numbers, which needs a metric query
				listed := (qq.Store == model.StoreLoki && p.Kind == "logs") || (qq.Store == model.StoreTempo && (p.Kind == "traces" || p.Kind == "table"))
				if !listed && !q.text.metric || (p.Kind == "logs" || p.Kind == "traces") && q.text.metric {
					wrongShape = append(wrongShape, fmt.Sprintf("%s (%s, %s query)", name, p.Kind, shape(q.text.metric)))
				}
			}
			queries = append(queries, q)
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
	r.add("LogQL and TraceQL have a selector", len(noSelector) == 0, strings.Join(noSelector, ", "))
	r.add("query fits its panel", len(wrongShape) == 0, strings.Join(wrongShape, ", "))
	return queries
}

func shape(metric bool) string {
	if metric {
		return "metric"
	}
	return "listing"
}

// meets names the first panel with a query that meets e.
func meets(d *model.Dashboard, e Expect, queries []query) string {
	if all := meetsAll(d, e, queries); len(all) > 0 {
		return all[0].panel
	}
	return ""
}

// meetsAll lists the queries that meet e, in panel order.
func meetsAll(d *model.Dashboard, e Expect, queries []query) []*query {
	store := e.Store
	if store == "" {
		store = model.StorePrometheus
	}
	var out []*query
	for _, name := range sortedPanels(d.Spec.Panels) {
		p := d.Spec.Panels[name]
		if len(e.Kinds) > 0 && !slices.Contains(e.Kinds, p.Kind) {
			continue
		}
		if len(e.Units) > 0 && !slices.Contains(e.Units, p.FieldDefaults.Unit) {
			continue
		}
		for i := range queries {
			qq := &queries[i]
			if qq.panel == name && qq.store == store && queryMeets(qq, e) {
				out = append(out, qq)
			}
		}
	}
	return out
}

func queryMeets(qq *query, e Expect) bool {
	metrics, functions, labels := map[string]bool{}, qq.text.functions, qq.text.labels
	if qq.facts != nil {
		metrics, functions = qq.facts.metrics, qq.facts.functions
	}
	anyOf := func(want []string, have map[string]bool) bool {
		if len(want) == 0 {
			return true
		}
		for _, w := range want {
			if have[w] {
				return true
			}
		}
		return false
	}
	if !anyOf(e.Metrics, metrics) || !anyOf(e.Functions, functions) {
		return false
	}
	for _, l := range e.Labels {
		if !labels[l] {
			return false
		}
	}
	lower := strings.ToLower(qq.raw)
	for _, group := range e.Contains {
		if !slices.ContainsFunc(group, func(s string) bool { return strings.Contains(lower, strings.ToLower(s)) }) {
			return false
		}
	}
	if v := e.UsesVar; v != "" && !strings.Contains(qq.raw, "$"+v) && !strings.Contains(qq.raw, "${"+v) && !strings.Contains(qq.raw, "[["+v) {
		return false
	}
	return true
}

// keep: the panels an edit was not asked to touch are as they were in base.
func keep(r *Result, c Case, d *model.Dashboard) {
	var base model.Dashboard
	if err := json.Unmarshal(c.Base, &base); err != nil {
		r.add("base.json", false, err.Error())
		return
	}
	for _, name := range c.Keep {
		was, ok := base.Spec.Panels[name]
		now, here := d.Spec.Panels[name]
		same := ok && here && was.Kind == now.Kind && slices.EqualFunc(was.Queries, now.Queries, func(a, b model.Query) bool {
			return a.Store == b.Store && a.Expr == b.Expr
		})
		r.add("kept as it was: "+name, same, "")
	}
}

// live runs every query and query variable on the stores given: an error or
// an empty answer fails; and the numbers asked for must match the reference.
func live(ctx context.Context, r *Result, c Case, d *model.Dashboard, vals map[string]string, queries []query, s Stores) {
	var lokiLabels []string
	for _, qq := range queries {
		name := fmt.Sprintf("returns data: %s/%s", qq.panel, qq.refID)
		var n int
		var err error
		switch {
		case qq.store == model.StorePrometheus && s.Prometheus != nil && qq.facts != nil:
			n, err = s.Prometheus.Query(ctx, qq.expr)
		case qq.store == model.StoreLoki && s.Loki != nil:
			n, err = s.Loki.Query(ctx, qq.expr, qq.text.metric)
		case qq.store == model.StoreTempo && s.Tempo != nil:
			n, err = s.Tempo.Query(ctx, qq.expr, qq.text.metric)
		default:
			continue
		}
		switch {
		case err != nil:
			r.add(name, false, "query error: "+err.Error())
		case n == 0 && qq.facts != nil && readsAny(qq.facts, c.MayBeEmpty):
			r.add(name, true, "empty, which "+strings.Join(c.MayBeEmpty, ", ")+" may be")
		case n == 0 && qq.store == model.StorePrometheus:
			if all, ok := unfiltered(qq.expr); ok {
				if m, err := s.Prometheus.Query(ctx, all); err == nil && m > 0 {
					r.add(name, true, fmt.Sprintf("empty now: none of its %d series passes the comparison", m))
					continue
				}
			}
			r.add(name, false, "empty"+missingValues(ctx, qq, s.Prometheus))
		case n == 0:
			detail := "empty"
			if qq.store == model.StoreLoki {
				if lokiLabels == nil {
					lokiLabels, _ = s.Loki.Labels(ctx)
				}
				var unknown []string
				for l := range qq.text.labels {
					if !slices.Contains(lokiLabels, l) {
						unknown = append(unknown, l)
					}
				}
				if len(unknown) > 0 {
					detail += ": Loki has no label " + strings.Join(dedupe(unknown), ", ")
				}
			}
			r.add(name, false, detail)
		default:
			r.add(name, true, fmt.Sprintf("%d", n))
		}
	}
	if s.Prometheus != nil {
		variables(ctx, r, d, vals, s.Prometheus)
		sameAs(ctx, r, c, d, queries, s.Prometheus)
	}
}

func variables(ctx context.Context, r *Result, d *model.Dashboard, vals map[string]string, q Querier) {
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

// sameAs: a query that meets an expectation with same_as sums to what the
// reference panel's query does, within its tolerance — any of them, since an
// answer may show the number next to others (a total beside a difference).
func sameAs(ctx context.Context, r *Result, c Case, d *model.Dashboard, queries []query, q Querier) {
	var ref model.Dashboard
	refOK := json.Unmarshal(c.Reference, &ref) == nil
	for _, e := range c.Expect {
		if e.SameAs == nil {
			continue
		}
		name := "same number as the reference: " + e.What
		mine := meetsAll(d, e, queries)
		var refExpr string
		if refOK {
			for _, rq := range ref.Spec.Panels[e.SameAs.Panel].Queries {
				if rq.RefID == e.SameAs.Ref {
					refExpr = substitute(rq.Expr, values(c, &ref))
				}
			}
		}
		if len(mine) == 0 || refExpr == "" {
			r.add(name, false, "no panel to compare")
			continue
		}
		want, _, err := q.Sum(ctx, refExpr)
		if err != nil {
			r.add(name, false, "the reference query: "+err.Error())
			continue
		}
		tol := e.SameAs.Tolerance
		if tol == 0 {
			tol = 0.1
		}
		var seen []string
		ok := false
		for _, m := range mine {
			got, _, err := q.Sum(ctx, m.expr)
			if err != nil {
				seen = append(seen, fmt.Sprintf("%s/%s: %v", m.panel, m.refID, err))
				continue
			}
			seen = append(seen, fmt.Sprintf("%s/%s %.4g", m.panel, m.refID, got))
			ok = ok || math.Abs(got-want) <= tol*math.Max(math.Abs(want), 1e-9)
		}
		r.add(name, ok, fmt.Sprintf("reference %.4g; %s", want, strings.Join(seen, ", ")))
	}
}

// absent: the store has no series of what a decline case says is not there,
// so the case still holds on it.
func absent(ctx context.Context, r *Result, c Case, q Querier) {
	for _, p := range c.Forbid {
		n, err := q.Query(ctx, fmt.Sprintf(`count by (__name__) ({__name__=~"%s.*"})`, p))
		switch {
		case err != nil:
			r.add("the store has none of: "+p, false, "query error: "+err.Error())
		default:
			r.add("the store has none of: "+p, n == 0, fmt.Sprintf("%d metrics", n))
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

func readsAny(f *facts, metrics []string) bool {
	for _, m := range metrics {
		if f.metrics[m] {
			return true
		}
	}
	return false
}
