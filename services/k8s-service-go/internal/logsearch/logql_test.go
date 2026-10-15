package logsearch

import (
	"errors"
	"strings"
	"testing"
)

var scope = []Matcher{{Name: "k8s_cluster_name", Value: "kubeast"}, {Name: "k8s_namespace_name", Value: "apps"}}

const scopeText = `k8s_cluster_name="kubeast", k8s_namespace_name="apps"`

func TestInjectMatchersRewritesEverySelector(t *testing.T) {
	cases := map[string]string{
		`{app="web"}`:                       `{` + scopeText + `, app="web"}`,
		`{ app="web" , tier="x" } |= "err"`: `{` + scopeText + `,  app="web" , tier="x" } |= "err"`,
		`{}`:                                `{` + scopeText + `}`,
		`{ }`:                               `{` + scopeText + `}`,
		`sum(rate({app="web"}[5m])) by (pod) / sum(rate({app="api"}[5m]))`: `sum(rate({` + scopeText + `, app="web"}[5m])) by (pod) / sum(rate({` + scopeText + `, app="api"}[5m]))`,
		`{app="web"} | json | line_format "{{.msg}}"`:                      `{` + scopeText + `, app="web"} | json | line_format "{{.msg}}"`,
		`{app="web"} |~ "\\{.*\\}"`:                                        `{` + scopeText + `, app="web"} |~ "\\{.*\\}"`,
		"{app=\"web\"} |= `{raw}`":                                         "{" + scopeText + ", app=\"web\"} |= `{raw}`",
		`{app="web"} # {ignored="x"}`:                                      `{` + scopeText + `, app="web"} # {ignored="x"}`,
		"{app=\"web\"} // {a=\"b\"}\n| json":                               "{" + scopeText + ", app=\"web\"} // {a=\"b\"}\n| json",
		`{app="web"} /* {a="b"} */ | json`:                                 `{` + scopeText + `, app="web"} /* {a="b"} */ | json`,
		`{app="web", k8s_cluster_name="other"}`:                            `{` + scopeText + `, app="web", k8s_cluster_name="other"}`,
		`{k8s_cluster_name!="kubeast", k8s_namespace_name=~".+"}`:          `{` + scopeText + `, k8s_cluster_name!="kubeast", k8s_namespace_name=~".+"}`,
		`{app="}"}`:            `{` + scopeText + `, app="}"}`,
		`{app="a\"}"}`:         `{` + scopeText + `, app="a\"}"}`,
		"{app=`}`}":            "{" + scopeText + ", app=`}`}",
		`{app="web" /* } */ }`: `{` + scopeText + `, app="web" /* } */ }`,
		"{app=\"web\" # }\n}":  "{" + scopeText + ", app=\"web\" # }\n}",
		`  {app="web"}  `:      `  {` + scopeText + `, app="web"}  `,
	}
	for in, want := range cases {
		got, err := InjectMatchers(in, scope)
		if err != nil {
			t.Errorf("%q: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("%q:\n got %q\nwant %q", in, got, want)
		}
	}
}

func TestInjectMatchersRefusesWhatItCannotRewrite(t *testing.T) {
	cases := map[string]string{
		"":                          "empty",
		"   ":                       "empty",
		`|= "x"`:                    "no stream selector",
		`{app="web"`:                "unterminated stream selector",
		`{app="web"} }`:             "unexpected }",
		`{app="web"} {}}`:           "unexpected }",
		`{app="x" {b="c"}}`:         "a selector inside a selector",
		`{app="web"} |= "x`:         "unterminated \" literal",
		"{app=\"web\"} |= `x":       "unterminated ` literal",
		`{app="web"} |= '`:          "unterminated ' literal",
		"{app=\"a\nb\"}":            "newline in a \" literal",
		`{app="web"} /* x`:          "unterminated comment",
		"{app=\"web\"} |= \"\x00\"": "not valid UTF-8",
		"{app=\"web\"} |= \"\xff\"": "not valid UTF-8",
		`{app="web"}` + strings.Repeat(" ", MaxLogQLLength): "longer than",
	}
	for in, msg := range cases {
		_, err := InjectMatchers(in, scope)
		if err == nil || !errors.Is(err, ErrInvalidLogQL) || !strings.Contains(err.Error(), msg) {
			t.Errorf("%q: want %q, got %v", in, msg, err)
		}
	}
}

// Every way to make the rewrite overlook a selector that Loki would still see:
// braces and quotes inside the three literal kinds, inside the three comment
// kinds, a quote in a comment that could pair with a later one, a selector
// after a comment. Each selector Loki sees must come out with the matchers,
// or the query must be refused.
func TestInjectMatchersBypassAttempts(t *testing.T) {
	attempts := []string{
		`{app="web"} |= "}{" {b="c"}`,                             // a brace pair inside a string, then a real selector
		"{app=\"web\"} |= `}{` {b=\"c\"}",                         // the same in a raw string
		`{app="web"} |= "\"}{" {b="c"}`,                           // an escaped quote before the braces
		`{app="web"} |= '}' {b="c"}`,                              // a char literal
		`{app="web"} /* " */ {b="c"} /* " */`,                     // quotes in comments that could read as one string
		"{app=\"web\"} # \"\n{b=\"c\"}",                           // a quote in a line comment, a selector on the next line
		"{app=\"web\"} // \"\n{b=\"c\"} // \"",                    // the same with //
		`{app="web" /* " */} {b="c"} /* " */`,                     // a quote in a comment inside the first selector
		"{app=\"web\" # \"\n} {b=\"c\"}",                          // a line comment inside the first selector
		`{a="x" /* } */ , b="y"} |= "z" {c="d"}`,                  // a brace in a comment inside a selector
		`sum(rate({app="web"}[5m])) + sum(rate({app="api"}[5m]))`, // two selectors in a metric query
		`{app="web"} |= "x" or {b="c"}`,                           // a second selector where Loki expects none
		`{k8s_cluster_name="other"} |= "x"`,                       // the user's own scope matcher
		"{app=\"web\"}\n\n{b=\"c\"}",                              // two selectors on two lines
	}
	for _, q := range attempts {
		got, err := InjectMatchers(q, scope)
		if err != nil {
			continue // refused: Loki never sees it
		}
		// Every "{" outside the literals and comments of the rewritten query starts with the scope.
		n := CountSelectors(q)
		if n < 1 {
			t.Fatalf("%q: counted %d selectors", q, n)
		}
		if strings.Count(got, "{"+scopeText) != n {
			t.Errorf("%q: %d selectors, %d carry the scope:\n%s", q, n, strings.Count(got, "{"+scopeText), got)
		}
		if strings.Contains(got, "{b=") || strings.Contains(got, "{c=") {
			t.Errorf("%q: a selector came out without the scope:\n%s", q, got)
		}
	}
}

func TestCountSelectors(t *testing.T) {
	for q, n := range map[string]int{`{a="b"}`: 1, `sum(rate({a="b"}[1m])) / sum(rate({c="d"}[1m]))`: 2, `{a="b"} |= "{}"`: 1, `{a="b"`: -1, `x`: -1} {
		if got := CountSelectors(q); got != n {
			t.Errorf("%q: %d, want %d", q, got, n)
		}
	}
}

func TestInjectMatchersWithoutMatchersIsTheIdentityUpToSpacing(t *testing.T) {
	for _, q := range []string{`{app="web"} |= "x"`, `{ app="web" }`, `sum(rate({a="b"}[1m]))`} {
		got, err := InjectMatchers(q, nil)
		if err != nil {
			t.Fatal(err)
		}
		if strings.ReplaceAll(got, " ", "") != strings.ReplaceAll(q, " ", "") {
			t.Errorf("%q → %q", q, got)
		}
	}
}

// The rewrite is consistent with itself: rescanning its output finds the same
// number of selectors, each of which starts with the matchers, and refusing is
// stable.
func FuzzInjectMatchers(f *testing.F) {
	for _, s := range []string{`{app="web"} |= "err"`, `sum(rate({a="b"}[5m]))`, `{a="}"} /* " */ {b="c"}`, "{a=`}`} # \"\n{b=\"c\"}", `{a="x"} |= '}' {b="c"}`} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, q string) {
		got, err := InjectMatchers(q, scope)
		if err != nil {
			if _, again := InjectMatchers(q, scope); again == nil {
				t.Fatalf("%q: refused once, accepted twice", q)
			}
			return
		}
		n := CountSelectors(q)
		if n < 1 || strings.Count(got, "{"+scopeText) != n {
			t.Fatalf("%q: %d selectors, output %q", q, n, got)
		}
		if again, err := InjectMatchers(got, nil); err != nil || CountSelectors(again) != n {
			t.Fatalf("%q: the output does not rescan to %d selectors: %v %q", q, n, err, again)
		}
	})
}
