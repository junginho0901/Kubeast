package search

import (
	"regexp"
	"sort"
	"strings"

	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// Metrics is the Prometheus metric names a dashboard's queries read, sorted,
// and the queries it could not read. The rules follow Grafana Mimir 3.2.4's
// `mimirtool analyze dashboard` (read and written anew; the tests hold them to
// what it answers): every panel query, query variable and, here also, every
// annotation on the Prometheus store, read with Prometheus's own parser; a
// selector's name, or its __name__ matcher.
//
// Where they differ on purpose: Grafana's variables are put in by position, so
// each of their forms reads ($x, ${x}, ${x:format}, [[x]], the _ms and _s
// macros); experimental functions read; a __name__ matcher counts when it
// selects names exactly (=, or =~ of plain names joined by |), whatever the
// characters; info() without a name reads target_info; and the queries of
// Loki, Tempo and Alertmanager, which are no PromQL, are not read.
func Metrics(d *model.Dashboard) (names, unread []string) {
	set := map[string]bool{}
	read := func(expr string) {
		if strings.TrimSpace(expr) == "" {
			return
		}
		if !metricsOf(expr, set) {
			unread = append(unread, expr)
		}
	}
	panels := make([]string, 0, len(d.Spec.Panels))
	for name := range d.Spec.Panels {
		panels = append(panels, name)
	}
	sort.Strings(panels)
	for _, name := range panels {
		for _, q := range d.Spec.Panels[name].Queries {
			if q.Store == model.StorePrometheus || q.Store == "" {
				read(q.Expr)
			}
		}
	}
	for _, v := range d.Spec.Variables {
		if v.Kind != model.VarQuery || v.Store != model.StorePrometheus || v.Query == nil {
			continue
		}
		switch v.Query.Fn {
		case "label_values", "label_names", "query_result", "raw":
			read(v.Query.Expr)
		}
	}
	for _, a := range d.Spec.Annotations {
		if a.Store == model.StorePrometheus {
			read(a.Expr)
		}
	}
	for n := range set {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, unread
}

var promql = parser.NewParser(parser.Options{EnableExperimentalFunctions: true, ExperimentalDurationExpr: true})

// metricsOf adds the names expr reads to set, or says it could not read it.
func metricsOf(expr string, set map[string]bool) bool {
	e, err := promql.ParseExpr(fillVariables(expr))
	if err != nil {
		return false
	}
	parser.Inspect(e, func(n parser.Node, _ []parser.Node) error {
		switch n := n.(type) {
		case *parser.VectorSelector:
			for _, name := range selectedNames(n) {
				set[name] = true
			}
		case *parser.Call:
			if n.Func.Name == "info" && (len(n.Args) < 2 || !hasNameMatcher(n.Args[1])) {
				set["target_info"] = true // info()'s default info metric
			}
		}
		return nil
	})
	return true
}

func selectedNames(s *parser.VectorSelector) []string {
	if s.Name != "" {
		return []string{s.Name}
	}
	for _, m := range s.LabelMatchers {
		if m.Name != labels.MetricName {
			continue
		}
		switch m.Type {
		case labels.MatchEqual:
			return []string{m.Value}
		case labels.MatchRegexp:
			if names := strings.Split(m.Value, "|"); !strings.ContainsAny(m.Value, `\.*+?()[]{}^$`) {
				return names
			}
		}
	}
	return nil
}

func hasNameMatcher(e parser.Expr) bool {
	s, ok := e.(*parser.VectorSelector)
	if !ok {
		return false
	}
	for _, m := range s.LabelMatchers {
		if m.Name == labels.MetricName && (m.Type == labels.MatchEqual || m.Type == labels.MatchRegexp) {
			return true
		}
	}
	return false
}

// reference is Grafana's variable syntax, as in package variables.
var reference = regexp.MustCompile(`\$(\w+)|\[\[(\w+?)(?::(\w+))?\]\]|\$\{(\w+)((?:\.[^:^{}\[\]]+|\["[^"]*"\]|\['[^']*'\]|\[[^\]"']*\])*)(?::([^}]+))?\}`)

// fillVariables puts a value in each variable outside the query's strings so
// the parser reads it: a duration inside [ ] and after offset, a number
// elsewhere. A variable that stands for a name, as in ${metric}_total, still
// fails, and the query is not read.
func fillVariables(expr string) string {
	refs := reference.FindAllStringIndex(expr, -1)
	if len(refs) == 0 {
		return expr
	}
	var b strings.Builder
	var quote byte
	depth, next := 0, 0
	for i := 0; i < len(expr); {
		if next < len(refs) && refs[next][0] == i && quote == 0 {
			if depth > 0 || afterOffset(b.String()) {
				b.WriteString("5m")
			} else {
				b.WriteString("1")
			}
			i = refs[next][1]
			next++
			continue
		}
		for next < len(refs) && refs[next][0] < i {
			next++
		}
		c := expr[i]
		switch {
		case quote != 0:
			if c == '\\' && quote != '`' && i+1 < len(expr) {
				b.WriteByte(c)
				i++
				c = expr[i]
			} else if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'' || c == '`':
			quote = c
		case c == '#':
			end := strings.IndexByte(expr[i:], '\n')
			if end < 0 {
				end = len(expr) - i
			}
			b.WriteString(expr[i : i+end])
			i += end
			continue
		case c == '[':
			depth++
		case c == ']' && depth > 0:
			depth--
		}
		b.WriteByte(c)
		i++
	}
	return b.String()
}

// afterOffset says whether the query so far ends in the offset keyword, with
// or without a minus sign after it.
func afterOffset(s string) bool {
	s = strings.TrimRight(s, " \t\r\n")
	s = strings.TrimRight(strings.TrimSuffix(s, "-"), " \t\r\n")
	return len(s) >= 6 && strings.EqualFold(s[len(s)-6:], "offset")
}
