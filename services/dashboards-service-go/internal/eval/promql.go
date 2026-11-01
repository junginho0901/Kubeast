package eval

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

// Grafana's built-in variables, at the values a five-minute look would use.
var builtins = map[string]string{
	"__rate_interval": "5m", "__interval": "1m", "__interval_ms": "60000",
	"__range": "1h", "__range_s": "3600", "__range_ms": "3600000",
}

// varRef is Grafana's variable syntax: ${name}, ${name:format}, $name, [[name]].
var varRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[A-Za-z]+)?\}|\$([A-Za-z_][A-Za-z0-9_]*)|\[\[([A-Za-z_][A-Za-z0-9_]*)\]\]`)

// values is what each variable stands for while grading: the case's vars
// first, then the dashboard's own current values (All = its allValue or .*).
func values(c Case, d *model.Dashboard) map[string]string {
	out := map[string]string{}
	for k, v := range builtins {
		out[k] = v
	}
	for _, v := range d.Spec.Variables {
		if val, ok := currentValue(v); ok {
			out[v.Name] = val
		}
	}
	for k, v := range c.Vars {
		out[k] = v
	}
	return out
}

func currentValue(v model.Variable) (string, bool) {
	var cur struct {
		Value json.RawMessage `json:"value"`
	}
	var vals []string
	if len(v.Current) > 0 && json.Unmarshal(v.Current, &cur) == nil && len(cur.Value) > 0 {
		var one string
		if json.Unmarshal(cur.Value, &one) == nil {
			vals = []string{one}
		} else {
			_ = json.Unmarshal(cur.Value, &vals)
		}
	}
	if len(vals) == 0 && len(v.Options) > 0 {
		vals = []string{v.Options[0].Value}
	}
	if len(vals) == 0 {
		return "", false
	}
	if len(vals) == 1 && (vals[0] == "$__all" || vals[0] == "All") {
		if v.AllValue != "" {
			return v.AllValue, true
		}
		return ".*", true
	}
	return strings.Join(vals, "|"), true
}

// substitute puts the values in; a variable with no value stays as written.
func substitute(expr string, vals map[string]string) string {
	return varRef.ReplaceAllStringFunc(expr, func(m string) string {
		sub := varRef.FindStringSubmatch(m)
		name := sub[1] + sub[2] + sub[3]
		if v, ok := vals[name]; ok {
			return v
		}
		return m
	})
}

var promParser = parser.NewParser(parser.Options{})

// facts is what a PromQL expression reads and does.
type facts struct {
	metrics   map[string]bool
	functions map[string]bool
	selectors []*parser.VectorSelector
	// counters read without a rate, and histogram_quantile without le
	bareCounters []string
	quantileNoLE bool
}

func metricOf(vs *parser.VectorSelector) string {
	if vs.Name != "" {
		return vs.Name
	}
	for _, m := range vs.LabelMatchers {
		if m.Name == labels.MetricName && m.Type == labels.MatchEqual {
			return m.Value
		}
	}
	return ""
}

// counterLike: the suffixes Prometheus' naming conventions give counters and
// the counter parts of histograms and summaries.
func counterLike(name string) bool {
	for _, s := range []string{"_total", "_count", "_sum", "_bucket"} {
		if strings.HasSuffix(name, s) {
			return true
		}
	}
	return false
}

// readsCounter: the functions and aggregations a counter's raw value may go
// through — a rate of some kind, or counting the series.
var readsCounter = map[string]bool{
	"rate": true, "irate": true, "increase": true, "resets": true, "changes": true,
	"absent": true, "absent_over_time": true, "present_over_time": true, "count_over_time": true,
	"count": true, "count_values": true, "group": true, "timestamp": true,
}

func analyse(expr string) (*facts, error) {
	root, err := promParser.ParseExpr(expr)
	if err != nil {
		return nil, err
	}
	f := &facts{metrics: map[string]bool{}, functions: map[string]bool{}}
	parser.Inspect(root, func(node parser.Node, path []parser.Node) error {
		switch n := node.(type) {
		case *parser.Call:
			f.functions[n.Func.Name] = true
			if n.Func.Name == "histogram_quantile" && len(n.Args) == 2 {
				if agg, ok := unparen(n.Args[1]).(*parser.AggregateExpr); ok && !groupsBy(agg, "le") {
					f.quantileNoLE = true
				}
			}
		case *parser.AggregateExpr:
			f.functions[n.Op.String()] = true
		case *parser.VectorSelector:
			name := metricOf(n)
			f.metrics[name] = true
			f.selectors = append(f.selectors, n)
			if counterLike(name) && !underRate(path) {
				f.bareCounters = append(f.bareCounters, name)
			}
		}
		return nil
	})
	return f, nil
}

func unparen(e parser.Expr) parser.Expr {
	for {
		p, ok := e.(*parser.ParenExpr)
		if !ok {
			return e
		}
		e = p.Expr
	}
}

func groupsBy(a *parser.AggregateExpr, label string) bool {
	has := false
	for _, g := range a.Grouping {
		has = has || g == label
	}
	if a.Without {
		return !has
	}
	return has
}

// underRate: the nearest call or aggregation above the selector reads a
// counter properly.
func underRate(path []parser.Node) bool {
	for i := len(path) - 1; i >= 0; i-- {
		switch n := path[i].(type) {
		case *parser.Call:
			return readsCounter[n.Func.Name]
		case *parser.AggregateExpr:
			return readsCounter[n.Op.String()]
		}
	}
	return false
}

// keepsTo: the selector has a matcher on label that takes value and refuses
// a name no namespace has.
func keepsTo(vs *parser.VectorSelector, label, value string) bool {
	for _, m := range vs.LabelMatchers {
		if m.Name == label && m.Matches(value) && !m.Matches("kubeast-eval-no-such-value") {
			return true
		}
	}
	return false
}
