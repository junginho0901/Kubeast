package variables

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// testdata/grafana-13.3.0-variables.json.gz: Grafana 13.3.0's own code run in
// node — scenes v9.0.0 sceneInterpolator and formatRegistry, @grafana/data's
// escapes, and the Prometheus data source's applyTemplateVariables and
// interpolateQueryExpr — over every template of the variables below, with the
// default format (glob) and as a Prometheus query.
func TestInterpolate_AsGrafana(t *testing.T) {
	f, err := os.Open("testdata/grafana-13.3.0-variables.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		From, To   int64
		Interval   string
		IntervalMs int64 `json:"intervalMs"`
		Variables  []struct {
			Name, Type, AllValue string
			Multi, IncludeAll    bool
			Value, Text          any
			Options              []struct{ Value string }
		}
		Cases []struct{ Template, Glob, Prometheus string }
	}
	if err := json.NewDecoder(z).Decode(&data); err != nil {
		t.Fatal(err)
	}
	strs := func(v any) []string {
		switch x := v.(type) {
		case string:
			return []string{x}
		case []any:
			out := []string{}
			for _, e := range x {
				out = append(out, e.(string))
			}
			return out
		}
		return nil
	}
	s := Scope{From: time.UnixMilli(data.From), To: time.UnixMilli(data.To), Interval: data.Interval, IntervalMs: data.IntervalMs}
	for _, v := range data.Variables {
		vr := Variable{Name: v.Name, Kind: v.Type, Multi: v.Multi, IncludeAll: v.IncludeAll, AllValue: v.AllValue, Value: strs(v.Value), Text: strs(v.Text)}
		for _, o := range v.Options {
			vr.Options = append(vr.Options, o.Value)
		}
		s.Variables = append(s.Variables, vr)
	}
	if len(data.Cases) < 600 {
		t.Fatalf("%d cases", len(data.Cases))
	}
	compared := 0
	for _, c := range data.Cases {
		if strings.Contains(c.Glob, "UNSUPPORTED") {
			continue
		}
		compared++
		if got, _ := Interpolate(c.Template, s); got != c.Glob {
			t.Errorf("Interpolate(%q)\n got  %q\n want %q", c.Template, got, c.Glob)
		}
		if got, _ := Prometheus(c.Template, s); got != c.Prometheus {
			t.Errorf("Prometheus(%q)\n got  %q\n want %q", c.Template, got, c.Prometheus)
		}
	}
	if compared < 600 {
		t.Errorf("%d cases compared", compared)
	}
}

func TestInterpolate_LeavesWhatItCannotWrite(t *testing.T) {
	s := Scope{
		From: time.UnixMilli(0), To: time.UnixMilli(1000),
		Variables: []Variable{
			{Name: "ns", Kind: "query", Value: []string{"web"}, Text: []string{"web"}},
			{Name: "loop", Kind: "constant", Value: []string{"x-$loop"}},
		},
	}
	for _, c := range []struct{ target, want string }{
		{"${ns.key}", "${ns.key}"},                           // a field path
		{"${ns:queryparam}", "${ns:queryparam}"},             // the URL state
		{"${__from:date:YYYY-MM}", "${__from:date:YYYY-MM}"}, // a moment.js pattern
		{"${__from:text}", "${__from:text}"},                 // the dashboard's time zone
		{"$__user $__dashboard ${__url}", "$__user $__dashboard ${__url}"},
		{"$nosuch", "$nosuch"},
	} {
		got, left := Interpolate(c.target, s)
		if got != c.want || len(left) == 0 {
			t.Errorf("Interpolate(%q) = %q, left %v; want it left as %q and listed", c.target, got, left, c.want)
		}
	}
	got, left := Interpolate("$loop", s)
	if !strings.HasPrefix(got, "x-x-") || len(left) != 1 {
		t.Errorf("a constant naming itself: %q, left %v; want it stopped and listed", got, left)
	}
	if got, left := Interpolate("$ns", s); got != "web" || len(left) != 0 {
		t.Errorf("Interpolate($ns) = %q, left %v", got, left)
	}
}
