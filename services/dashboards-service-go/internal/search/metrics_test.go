package search

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/importer/grafana"
	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

type mimirAnswer struct {
	Metrics     []string
	ParseErrors int
}

// testdata/mimirtool-3.2.4-metrics.json.gz: what `mimirtool analyze dashboard`
// of Grafana Mimir 3.2.4 (the release binary, checked against its sha256)
// answered for 87 dashboards of one query, structure or variable each
// (`cases`, kept whole) and for the 65 classic dashboards of the importer's
// test data (`corpus`, by their path there).
func mimirData(t *testing.T) (cases map[string]struct {
	Dashboard json.RawMessage
	Answer    *mimirAnswer
}, corpus map[string]*mimirAnswer) {
	t.Helper()
	f, err := os.Open("testdata/mimirtool-3.2.4-metrics.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Cases map[string]struct {
			Dashboard json.RawMessage
			Answer    *mimirAnswer
		}
		Corpus map[string]*mimirAnswer
	}
	if err := json.NewDecoder(z).Decode(&data); err != nil {
		t.Fatal(err)
	}
	if len(data.Cases) != 87 || len(data.Corpus) != 65 {
		t.Fatalf("%d cases, %d corpus files", len(data.Cases), len(data.Corpus))
	}
	return data.Cases, data.Corpus
}

// More than mimirtool reads, on purpose (see Metrics).
var readsMore = map[string][]string{
	"q04":             {"braces_total"},                               // ${__rate_interval}
	"q14":             {"alt_a_total", "alt_b_total"},                 // __name__=~"a|b" of plain names
	"q46":             {"limitk_metric"},                              // an experimental function
	"q47":             {"sbl_metric"},                                 // an experimental function
	"q54":             {"http.server.duration"},                       // a UTF-8 name
	"q58":             {"deriv_metric"},                               // $__interval_ms
	"q60":             {"aot"},                                        // ${__interval}
	"q61":             {"brackets_total"},                             // [[__rate_interval]]
	"q65":             {"info_target", "target_info"},                 // an experimental function; info()'s default
	"s03-annotation":  {"annotation_metric"},                          // an annotation query
	"edge-cases.json": {"kube_deployment_status_observed_generation"}, // an annotation query
	"corpus/grafana-13.3.0-v1-resource/edge-cases.json": {"kube_deployment_status_observed_generation"},
	"library-panels.json":                               {"container_cpu_usage_seconds_total", "container_memory_working_set_bytes"}, // library panels, expanded on import
}

func TestMetrics_AsMimirtool(t *testing.T) {
	cases, corpus := mimirData(t)
	compare := func(name string, d *model.Dashboard, a *mimirAnswer) {
		got, _ := Metrics(d)
		want := slices.Clone(a.Metrics)
		want = append(want, readsMore[strings.TrimPrefix(name, "cases/")]...)
		var missing []string
		for _, m := range want {
			if !slices.Contains(got, m) {
				missing = append(missing, m)
			}
		}
		// What only a cluster variable's query reads is not read here: the
		// variable becomes Kubeast's cluster selector, which runs no query.
		for _, m := range missing {
			if !clusterVariableReads(d, m) {
				t.Errorf("%s: %s not read (mimirtool reads it)", name, m)
			}
		}
		for _, m := range got {
			if !slices.Contains(want, m) {
				t.Errorf("%s: %s read (mimirtool does not)", name, m)
			}
		}
	}
	for name, c := range cases {
		d, _, err := grafana.Import(c.Dashboard)
		if name == "s02-old-rows" { // schemaVersion 14: the importer asks for the file Grafana saves
			if err == nil {
				t.Errorf("%s imported", name)
			}
			continue
		}
		if err != nil || c.Answer == nil {
			t.Fatalf("%s: %v, answer %v", name, err, c.Answer)
		}
		compare("cases/"+name, d, c.Answer)
	}
	compared := 0
	for path, a := range corpus {
		raw, err := os.ReadFile("../importer/grafana/testdata/" + path)
		if err != nil {
			t.Fatal(err)
		}
		d, _, err := grafana.Import(raw)
		switch path {
		case "old-schema.json": // schemaVersion below 16, as above
			if err == nil {
				t.Errorf("%s imported", path)
			}
			continue
		case "convert/variables.json": // mimirtool cannot read it: a tag that is a number
			if a != nil {
				t.Errorf("%s: mimirtool answered", path)
			}
			continue
		}
		if err != nil || a == nil {
			t.Fatalf("%s: %v, answer %v", path, err, a)
		}
		compare(path, d, a)
		if _, unread := Metrics(d); len(unread) != 0 {
			t.Errorf("%s: queries not read: %q", path, unread)
		}
		compared++
	}
	if compared != 63 {
		t.Errorf("%d corpus files compared", compared)
	}
}

var labelValuesOf = regexp.MustCompile(`(?s)^\s*label_values\((.*),\s*\w+\s*\)\s*$`)

// clusterVariableReads says whether a cluster variable's own query, as the
// importer keeps it, reads metric.
func clusterVariableReads(d *model.Dashboard, metric string) bool {
	for _, v := range d.Spec.Variables {
		var q string
		if v.Kind != model.VarCluster || json.Unmarshal(v.Ext["clusterQuery"], &q) != nil {
			continue
		}
		if m := labelValuesOf.FindStringSubmatch(q); m != nil {
			q = m[1]
		}
		set := map[string]bool{}
		if metricsOf(q, set) && set[metric] {
			return true
		}
	}
	return false
}

func TestMetrics_Unread(t *testing.T) {
	cases, _ := mimirData(t)
	for name, c := range cases {
		if name == "s02-old-rows" {
			continue
		}
		d, _, err := grafana.Import(c.Dashboard)
		if err != nil {
			t.Fatal(err)
		}
		_, unread := Metrics(d)
		want := map[string]string{
			"q23": "${metric}_total",                               // a variable for the name
			"q51": `name_and_matcher{__name__="name_and_matcher"}`, // the name twice: Prometheus refuses it
		}[name]
		if (want == "" && len(unread) != 0) || (want != "" && !slices.Equal(unread, []string{want})) {
			t.Errorf("%s: unread %q, want %q", name, unread, want)
		}
	}
}

func TestMetrics_VariablesByPosition(t *testing.T) {
	for _, c := range []struct{ expr, want string }{
		{`rate(x[$__rate_interval])`, `rate(x[5m])`},
		{`x offset $__interval`, `x offset 5m`},
		{`x OFFSET -${__interval}`, `x OFFSET -5m`},
		{`x[$__range:$__interval]`, `x[5m:5m]`},
		{`x[[[__interval]]]`, `x[5m]`},
		{`x * $__interval_ms`, `x * 1`},
		{`topk($k, x)`, `topk(1, x)`},
		{`x{a="$v", b='${v:regex}', c=~` + "`[[v]]`" + `}`, `x{a="$v", b='${v:regex}', c=~` + "`[[v]]`" + `}`},
		{`x{a="q\"$v"} > $t`, `x{a="q\"$v"} > 1`},
		{"# don't $x\nx[$y]", "# don't $x\nx[5m]"},
		{`${metric}_total`, `1_total`},
	} {
		if got := fillVariables(c.expr); got != c.want {
			t.Errorf("fillVariables(%q) = %q, want %q", c.expr, got, c.want)
		}
	}
}

func TestSearch_ByMetrics(t *testing.T) {
	dash := func(name string, exprs ...string) *model.Dashboard {
		p := model.Panel{Kind: "timeseries"}
		for _, e := range exprs {
			p.Queries = append(p.Queries, model.Query{RefID: "A", Store: model.StorePrometheus, Expr: e})
		}
		return &model.Dashboard{Metadata: model.Metadata{Name: name, Title: name}, Spec: model.Spec{Panels: map[string]model.Panel{"p": p}}}
	}
	loki := dash("loki")
	loki.Spec.Panels["p"] = model.Panel{Kind: "logs", Queries: []model.Query{{RefID: "A", Store: model.StoreLoki, Expr: `sum(rate({app="up"}[5m]))`}}}
	ds := []*model.Dashboard{dash("a", "up", "rate(x_total[5m])"), dash("b", "up"), dash("c", "rate(x_total[5m])"), loki}
	for _, c := range []struct {
		metrics []string
		want    []string
	}{
		{[]string{"up"}, []string{"a", "b"}},
		{[]string{"up", "x_total"}, []string{"a"}},
		{[]string{"UP"}, nil},
		{[]string{"x"}, nil},
		{nil, []string{"a", "b", "c", "loki"}},
	} {
		var got []string
		for _, d := range Search(ds, Query{Metrics: c.metrics}) {
			got = append(got, d.Metadata.Name)
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("Metrics %v: got %v, want %v", c.metrics, got, c.want)
		}
	}
}
