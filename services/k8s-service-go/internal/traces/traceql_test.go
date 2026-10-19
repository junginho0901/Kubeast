package traces

import (
	"errors"
	"strings"
	"testing"
)

var cluster = []Matcher{{Attribute: "resource.k8s.cluster.name", Value: "alpha"}}
var clusterNS = []Matcher{{Attribute: "resource.k8s.cluster.name", Value: "alpha"}, {Attribute: "resource.k8s.namespace.name", Value: "shop"}}

const cs = `resource.k8s.cluster.name = "alpha"`

func TestInjectScopeEveryFilter(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{}`, `{ ` + cs + ` }`},
		{`{ status = error }`, `{ ( status = error ) && ` + cs + ` }`},
		{`{ .a = 1 || .b = 2 }`, `{ ( .a = 1 || .b = 2 ) && ` + cs + ` }`},
		{`{ .a = 1 } >> { .b = 2 }`, `{ ( .a = 1 ) && ` + cs + ` } >> { ( .b = 2 ) && ` + cs + ` }`},
		{`{ duration > 1s } | rate() by (resource.service.name)`, `{ ( duration > 1s ) && ` + cs + ` } | rate() by (resource.service.name)`},
		{`compare({ status = error })`, `compare({ ( status = error ) && ` + cs + ` })`},
		// braces in strings, raw strings and comments are not filters, as for Tempo
		{`{ name = "GET /api/{id}" }`, `{ ( name = "GET /api/{id}" ) && ` + cs + ` }`},
		{"{ .a = `}{` }", "{ ( .a = `}{` ) && " + cs + " }"},
		{"{ .a = 1 // }\n || .b = 2 }", "{ ( .a = 1 // }\n || .b = 2 ) && " + cs + " }"},
		// an attribute name runs until a space or an operator, as for Tempo: /* ` ' are part of it
		{"{ span.a/* = 1 } || { span.b*/ = 2 }", "{ ( span.a/* = 1 ) && " + cs + " } || { ( span.b*/ = 2 ) && " + cs + " }"},
		{"{ span.a` = 1 } || { span.b` = 2 }", "{ ( span.a` = 1 ) && " + cs + " } || { ( span.b` = 2 ) && " + cs + " }"},
		{`{ span."a}b" = 1 }`, `{ ( span."a}b" = 1 ) && ` + cs + ` }`},
		{`{ trace:id = "abc" }`, `{ ( trace:id = "abc" ) && ` + cs + ` }`},
	}
	for _, c := range cases {
		got, err := InjectScope(c.in, cluster)
		if err != nil || got != c.want {
			t.Errorf("%q\n got %q (%v)\nwant %q", c.in, got, err, c.want)
		}
	}
	got, err := InjectScope(`{ .a = 1 }`, clusterNS)
	if err != nil || got != `{ ( .a = 1 ) && resource.k8s.cluster.name = "alpha" && resource.k8s.namespace.name = "shop" }` {
		t.Fatalf("namespace scope: %q %v", got, err)
	}
	// a value is a quoted literal whatever it holds
	got, err = InjectScope(`{}`, []Matcher{{Attribute: "resource.k8s.cluster.name", Value: "a\" } || { true"}})
	if err != nil || got != `{ resource.k8s.cluster.name = "a\" } || { true" }` {
		t.Fatalf("value quoting: %q %v", got, err)
	}
}

func TestInjectScopeRefusals(t *testing.T) {
	cases := map[string]string{
		"no filter":                `| count() > 2`,
		"unbalanced":               `{ .a = 1`,
		"stray close":              `}{ .a = 1 }`,
		"nested":                   `{{ .a = 1 }}`,
		"parenthesis closes early": `{ .a = 1 ) || ( .b = 2 }`,
		"parenthesis left open":    `{ ( .a = 1 }`,
		"unterminated string":      `{ .a = "x }`,
		"unterminated comment":     `{ .a = 1 } /* `,
		"unterminated attribute":   `{ span."a = 1 }`,
		"bad attribute escape":     `{ span."a\q" = 1 }`,
		"parent attribute":         `{ parent.span.a = 1 }`,
		"parent intrinsic":         `{ parent = nil }`,
		"root service":             `{ rootServiceName = "gateway" }`,
		"root name":                `{ rootName = "GET /" }`,
		"trace duration":           `{ traceDuration > 2s }`,
		"scoped trace duration":    `{ trace:duration > 2s }`,
		"scoped root service":      `{ trace:rootService = "x" }`,
		"tree position":            `{ nestedSetParent = 1 }`,
		"too long":                 `{ .a = "` + strings.Repeat("x", MaxTraceQLLength) + `" }`,
		"not UTF-8":                "{ .a = \"\xff\" }",
		"NUL":                      "{ .a = 1 }\x00",
	}
	for name, q := range cases {
		if got, err := InjectScope(q, cluster); !errors.Is(err, ErrInvalidTraceQL) {
			t.Errorf("%s: %q accepted as %q (%v)", name, q, got, err)
		}
	}
	if _, err := InjectScope(`{}`, nil); !errors.Is(err, ErrInvalidTraceQL) {
		t.Error("no scope accepted")
	}
	if _, err := InjectScope(`{}`, []Matcher{{Attribute: `resource.a" || true`, Value: "x"}}); !errors.Is(err, ErrInvalidTraceQL) {
		t.Error("a scope attribute that is not a name accepted")
	}
}

// FuzzInjectScope: whatever is accepted keeps every filter and gets the scope
// in each, and the result lexes to the same number of filters (Tempo's own
// parser is the oracle for this, run outside the repo — kubeast records 23 PR-4).
func FuzzInjectScope(f *testing.F) {
	for _, s := range []string{`{}`, `{ .a = 1 } >> { .b = "}" }`, "{ span.a` = 1 }", `{ .a = 1 /* } */ }`, `compare({ status = error })`} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, q string) {
		out, err := InjectScope(q, cluster)
		if err != nil {
			return
		}
		var in, res braceLexer
		in.run(q)
		res.run(out)
		if res.err != nil {
			t.Fatalf("%q -> %q does not lex: %v", q, out, res.err)
		}
		count := func(l braceLexer) int {
			n := 0
			for _, m := range l.marks {
				if m.kind == tokOpenBrace {
					n++
				}
			}
			return n
		}
		if count(in) != count(res) || strings.Count(out, cs) != count(in) {
			t.Fatalf("%q -> %q: %d filters in, %d out, %d scopes", q, out, count(in), count(res), strings.Count(out, cs))
		}
	})
}
