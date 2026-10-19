package logsearch

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// MaxLogQLLength caps a LogQL query written by hand or by the AI.
const MaxLogQLLength = 4096

// ErrInvalidLogQL is a query the injector could not rewrite safely.
var ErrInvalidLogQL = errors.New("invalid LogQL")

// Matcher is one equality matcher added to every stream selector.
type Matcher struct {
	Name  string
	Value string
}

// InjectMatchers adds matchers to every stream selector of a LogQL query, so a
// query written by hand cannot reach past the cluster and namespace it is run
// for. It does not parse LogQL: it scans the query with Loki's lexical rules
// for what is not a selector — "…" strings with Go escapes, `…` raw strings,
// '…' char literals, # and // line comments and /* */ block comments
// (pkg/logql/syntax/lex.go on text/scanner's GoTokens) — and treats every
// other "{" as the start of a selector, up to its "}". What the lexer skips
// cannot hide a selector from Loki either, and anything else is left for Loki
// to judge: a query this rewrite misunderstands fails there instead of
// reaching further. Matchers already in a selector stay (Loki ANDs them), so
// a user's own cluster or namespace matcher cannot widen the scope.
func InjectMatchers(query string, matchers []Matcher) (string, error) {
	if len(query) > MaxLogQLLength {
		return "", fmt.Errorf("%w: longer than %d bytes", ErrInvalidLogQL, MaxLogQLLength)
	}
	if !utf8.ValidString(query) || strings.ContainsRune(query, 0) {
		return "", fmt.Errorf("%w: not valid UTF-8", ErrInvalidLogQL)
	}
	if strings.TrimSpace(query) == "" {
		return "", fmt.Errorf("%w: empty query", ErrInvalidLogQL)
	}
	var added []byte
	for i, m := range matchers {
		if i > 0 {
			added = append(added, ", "...)
		}
		added = append(added, m.Name...)
		added = append(added, '=')
		added = strconv.AppendQuote(added, m.Value)
	}

	out := make([]byte, 0, len(query)+len(matchers)*48)
	selectors := 0
	inSelector := false
	bodyStart := 0 // where the current selector's body starts in out
	for i := 0; i < len(query); {
		c := query[i]
		switch {
		case c == '#' || (c == '/' && i+1 < len(query) && query[i+1] == '/'):
			// a line comment, copied through up to (not including) the newline
			end := strings.IndexByte(query[i:], '\n')
			if end < 0 {
				end = len(query) - i
			}
			out = append(out, query[i:i+end]...)
			i += end
		case c == '/' && i+1 < len(query) && query[i+1] == '*':
			end := strings.Index(query[i+2:], "*/")
			if end < 0 {
				return "", fmt.Errorf("%w: unterminated comment", ErrInvalidLogQL)
			}
			out = append(out, query[i:i+2+end+2]...)
			i += 2 + end + 2
		case c == '"' || c == '\'' || c == '`':
			n, err := literalLen(query[i:])
			if err != nil {
				return "", err
			}
			out = append(out, query[i:i+n]...)
			i += n
		case c == '{':
			if inSelector {
				return "", fmt.Errorf("%w: a selector inside a selector", ErrInvalidLogQL)
			}
			inSelector = true
			out = append(out, '{')
			out = append(out, added...)
			bodyStart = len(out)
			i++
		case c == '}':
			if !inSelector {
				return "", fmt.Errorf("%w: unexpected }", ErrInvalidLogQL)
			}
			// copied: the body is cut off out and written back after the
			// separator, as it was (a trailing line comment must keep its
			// newline before the brace)
			body := append([]byte(nil), out[bodyStart:]...)
			out = out[:bodyStart]
			if len(bytes.TrimSpace(body)) > 0 {
				if len(added) > 0 {
					out = append(out, ", "...)
				}
				out = append(out, body...)
			}
			out = append(out, '}')
			inSelector = false
			selectors++
			i++
		default:
			out = append(out, c)
			i++
		}
	}
	if inSelector {
		return "", fmt.Errorf("%w: unterminated stream selector", ErrInvalidLogQL)
	}
	if selectors == 0 {
		return "", fmt.Errorf("%w: no stream selector", ErrInvalidLogQL)
	}
	return string(out), nil
}

// literalLen is the length of the string, raw string or char literal that
// starts s (its opening quote included), the way text/scanner reads them: a
// backslash escapes the next byte in "…" and '…', nothing does in `…`, and
// only a raw string may hold a newline.
func literalLen(s string) (int, error) {
	quote := s[0]
	for i := 1; i < len(s); i++ {
		switch {
		case s[i] == quote:
			return i + 1, nil
		case s[i] == '\\' && quote != '`':
			i++
		case s[i] == '\n' && quote != '`':
			return 0, fmt.Errorf("%w: newline in a %c literal", ErrInvalidLogQL, quote)
		}
	}
	return 0, fmt.Errorf("%w: unterminated %c literal", ErrInvalidLogQL, quote)
}

// CountSelectors is the number of stream selectors InjectMatchers rewrites in
// query, -1 when it refuses the query.
func CountSelectors(query string) int {
	out, err := InjectMatchers(query, []Matcher{{Name: "__kubeast_count__", Value: "1"}})
	if err != nil {
		return -1
	}
	return strings.Count(out, `__kubeast_count__="1"`)
}
