package recording

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
)

// ilike matches s against a LIKE pattern the way PostgreSQL reads it with
// ESCAPE '\', ignoring case (ASCII is enough here).
func ilike(s, pattern string) bool {
	var re strings.Builder
	re.WriteString("(?is)^")
	for i := 0; i < len(pattern); i++ {
		switch c := pattern[i]; {
		case c == '\\' && i+1 < len(pattern):
			i++
			re.WriteString(regexp.QuoteMeta(string(pattern[i])))
		case c == '%':
			re.WriteString(".*")
		case c == '_':
			re.WriteString(".")
		default:
			re.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	re.WriteString("$")
	return regexp.MustCompile(re.String()).MatchString(s)
}

// The user filter finds the e-mails that contain the typed text, % _ and \
// included, as the List query builds its pattern.
func TestLikeLiteral_UserFilterIsText(t *testing.T) {
	emails := []string{"a_b@kubeast.local", "axb@kubeast.local", "100%@kubeast.local", "1000@kubeast.local", `back\slash@kubeast.local`, "backslash@kubeast.local", "Ops_Lead@kubeast.local"}
	for _, typed := range []string{"a_b", "_", "0%", "%", `k\s`, "ops_lead", "kubeast.local"} {
		var got, want []string
		for _, e := range emails {
			if ilike(e, "%"+likeLiteral(typed)+"%") {
				got = append(got, e)
			}
			if strings.Contains(strings.ToLower(e), strings.ToLower(typed)) {
				want = append(want, e)
			}
		}
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("filter %q finds %v, want %v", typed, got, want)
		}
	}
}
