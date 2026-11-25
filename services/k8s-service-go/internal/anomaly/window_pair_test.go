package anomaly

import (
	"strings"
	"testing"
	"time"

	"github.com/prometheus/prometheus/promql/parser"
)

// A metric query reads both windows: the same expression once as it is and once offset by the window's length, each
// series with the label that says which window it is of.
func TestAMetricQueryReadsBothWindows(t *testing.T) {
	for _, q := range Queries("shop", nil, time.Hour) {
		expr, err := parser.NewParser(parser.Options{}).ParseExpr(q.Expr)
		if err != nil {
			t.Fatalf("%s: %v", q.Expr, err)
		}
		or, ok := expr.(*parser.BinaryExpr)
		if !ok || or.Op != parser.LOR {
			t.Fatalf("%s: not one window or the other: %s", q.Check, q.Expr)
		}
		side := func(e parser.Expr, window string, offset time.Duration) string {
			call, ok := e.(*parser.Call)
			if !ok || call.Func.Name != "label_replace" || call.Args[1].String() != `"`+WindowLabel+`"` || call.Args[2].String() != `"`+window+`"` {
				t.Fatalf("%s: %s is not labelled %s", q.Check, e, window)
			}
			selectors := 0
			parser.Inspect(call.Args[0], func(node parser.Node, _ []parser.Node) error {
				if vs, ok := node.(*parser.VectorSelector); ok {
					selectors++
					if vs.OriginalOffset != offset {
						t.Errorf("%s: %s is offset by %s, want %s", q.Check, vs, vs.OriginalOffset, offset)
					}
				}
				return nil
			})
			if selectors == 0 {
				t.Errorf("%s: no selector in %s", q.Check, e)
			}
			return strings.ReplaceAll(call.Args[0].String(), " offset 1h", "")
		}
		if a, b := side(or.LHS, "now", 0), side(or.RHS, "before", time.Hour); a != b {
			t.Errorf("%s: the windows are read by different expressions:\n%s\n%s", q.Check, a, b)
		}
	}
	row := func(window string) Sample {
		return Sample{Labels: map[string]string{"pod": "web", WindowLabel: window}, Value: 1}
	}
	inNow, inBefore := SplitWindows([]Sample{row("now"), row("before"), row("before"), {Labels: map[string]string{"pod": "web"}}})
	if len(inNow) != 1 || len(inBefore) != 2 {
		t.Fatalf("%d now, %d before", len(inNow), len(inBefore))
	}
}
