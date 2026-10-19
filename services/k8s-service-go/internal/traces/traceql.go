package traces

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"text/scanner"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/prometheus/common/model"
)

// ErrInvalidTraceQL is a query the injector refuses: it could not find every
// spanset filter with certainty, or the query reads spans outside the scope.
var ErrInvalidTraceQL = errors.New("invalid TraceQL")

// MaxTraceQLLength caps a TraceQL query.
const MaxTraceQLLength = 4096

// Matcher is one scope condition: a resource attribute (resource.k8s.cluster.name)
// and the value every matched span must carry.
type Matcher struct {
	Attribute string
	Value     string
}

var scopeAttribute = regexp.MustCompile(`^resource\.[A-Za-z0-9_][A-Za-z0-9_.\-]*$`)

// Token kinds of the Tempo TraceQL lexer (pkg/traceql/lexer.go, v3.1.0) that
// the injector needs to tell apart; everything else is "other".
const (
	tokOther = iota
	tokOpenBrace
	tokCloseBrace
	tokOpenParen
	tokCloseParen
	tokDot
	tokScopeDot // resource. span. parent. event. link. instrumentation.
	tokParentDot
	tokTraceColon
	tokID
	tokForbidden // reads spans outside the scope: the root span, the parent, tree positions
)

// tokens are Tempo's token texts. Only the kinds above matter; the rest are
// listed so that combination tokens (">=", "!>>", "&<<", "resource.") are
// consumed exactly as Tempo consumes them.
var tokens = map[string]int{
	",": tokOther, ".": tokDot, "{": tokOpenBrace, "}": tokCloseBrace, "(": tokOpenParen, ")": tokCloseParen,
	"=": tokOther, "!=": tokOther, "=~": tokOther, "!~": tokOther, ">": tokOther, ">=": tokOther,
	"<": tokOther, "<=": tokOther, "+": tokOther, "-": tokOther, "/": tokOther, "%": tokOther,
	"*": tokOther, "^": tokOther, "true": tokOther, "false": tokOther, "nil": tokOther,
	"ok": tokOther, "error": tokOther, "unset": tokOther, "unspecified": tokOther,
	"internal": tokOther, "server": tokOther, "client": tokOther, "producer": tokOther,
	"consumer": tokOther, "&&": tokOther, "||": tokOther, "!": tokOther, "|": tokOther,
	">>": tokOther, "<<": tokOther, "~": tokOther, "!>": tokOther, "!<": tokOther,
	"!>>": tokOther, "!<<": tokOther, "&~": tokOther, "&>": tokOther, "&<": tokOther,
	"&>>": tokOther, "&<<": tokOther, "duration": tokOther, "childCount": tokOther,
	"name": tokOther, "status": tokOther, "statusMessage": tokOther, "kind": tokOther,
	"rootName": tokForbidden, "rootServiceName": tokForbidden, "rootService": tokForbidden,
	"traceDuration": tokForbidden, "nestedSetLeft": tokForbidden, "nestedSetRight": tokForbidden,
	"nestedSetParent": tokForbidden, "id": tokID, "traceID": tokOther, "spanID": tokOther,
	"parentID": tokOther, "timeSinceStart": tokOther, "version": tokOther, "parent": tokForbidden,
	"parent.": tokParentDot, "resource.": tokScopeDot, "span.": tokScopeDot,
	"trace:": tokTraceColon, "span:": tokOther, "event:": tokOther, "link:": tokOther,
	"instrumentation:": tokOther, "event.": tokScopeDot, "link.": tokScopeDot,
	"instrumentation.": tokScopeDot, "count": tokOther, "avg": tokOther, "max": tokOther,
	"min": tokOther, "sum": tokOther, "by": tokOther, "coalesce": tokOther, "select": tokOther,
	"rate": tokOther, "count_over_time": tokOther, "min_over_time": tokOther,
	"max_over_time": tokOther, "avg_over_time": tokOther, "sum_over_time": tokOther,
	"quantile_over_time": tokOther, "histogram_over_time": tokOther, "compare": tokOther,
	"topk": tokOther, "bottomk": tokOther, "with": tokOther,
}

// startsAttribute: after these Tempo reads an attribute name, rune by rune.
func startsAttribute(kind int) bool {
	return kind == tokDot || kind == tokScopeDot || kind == tokParentDot
}

// isAttributeRune is Tempo's: an attribute name runs until one of these.
func isAttributeRune(r rune) bool {
	if unicode.IsSpace(r) {
		return false
	}
	switch r {
	case scanner.EOF, '{', '}', '(', ')', '=', '~', '!', '<', '>', '&', '|', '^', ',':
		return false
	}
	return true
}

func isDurationRune(r rune) bool {
	switch r {
	case 'n', 's', 'u', 'm', 'h', 'µ', 'd', 'w', 'y':
		return true
	}
	return false
}

// mark is a brace or parenthesis token and its byte offset.
type mark struct {
	kind   int
	offset int
}

// braceLexer walks a query the way Tempo's TraceQL lexer does and keeps the
// offsets of the spanset braces; it refuses what Tempo would read beyond the
// scope.
type braceLexer struct {
	scanner.Scanner
	parsingAttribute bool
	scopeParent      bool
	marks            []mark // the braces and parentheses Tempo reads, in order
	err              error
}

func (l *braceLexer) fail(format string, args ...interface{}) {
	if l.err == nil {
		l.err = fmt.Errorf("%w: "+format, append([]interface{}{ErrInvalidTraceQL}, args...)...)
	}
}

// run lexes the whole query.
func (l *braceLexer) run(q string) {
	l.Init(strings.NewReader(q))
	l.Error = func(_ *scanner.Scanner, msg string) { l.fail("%s", msg) }
	prev := tokOther
	for l.err == nil {
		if l.parsingAttribute {
			if !isAttributeRune(l.Peek()) {
				l.parsingAttribute = false
				continue
			}
			if l.scopeParent && l.tryParentScope() {
				continue
			}
			l.readAttribute()
			continue
		}
		r := l.Scan()
		offset := l.Position.Offset
		switch r {
		case scanner.EOF:
			return
		case scanner.String, scanner.RawString:
			if _, err := strconv.Unquote(l.TokenText()); err != nil {
				l.fail("%v", err)
			}
			prev = tokOther
			continue
		case scanner.Int, scanner.Float:
			l.skipDuration(l.TokenText())
			prev = tokOther
			continue
		}
		kind, found := tokOther, false
		text := l.TokenText()
		for {
			next := text + string(l.Peek())
			k, ok := tokens[next]
			if !ok {
				break
			}
			text, kind, found = next, k, true
			l.Next()
		}
		if !found {
			kind = tokens[text] // unknown text is an identifier: tokOther
		}
		switch kind {
		case tokForbidden:
			l.fail("%q reads spans outside your scope (the root span, the parent or tree positions)", text)
		case tokParentDot:
			l.fail("parent. reads the parent span, which may be outside your scope")
		case tokOpenBrace, tokCloseBrace, tokOpenParen, tokCloseParen:
			l.marks = append(l.marks, mark{kind, offset})
		}
		if prev == tokTraceColon && kind != tokID {
			l.fail("trace:%s reads the whole trace, which may reach outside your scope (trace:id is allowed)", text)
		}
		if kind == tokTraceColon || kind == tokScopeDot || kind == tokParentDot {
			l.scopeParent = kind == tokParentDot
		}
		l.parsingAttribute = startsAttribute(kind)
		prev = kind
	}
}

// tryParentScope is Tempo's tryScopeAttribute: after "parent." a "span." or
// "resource." scope may follow. Refused anyway (parent. is forbidden), kept
// so the offsets stay Tempo's.
func (l *braceLexer) tryParentScope() bool {
	s := l.Scanner
	str := ""
	for s.Peek() != scanner.EOF {
		r := s.Peek()
		if r == '.' {
			str += string(s.Next())
			break
		}
		if !isAttributeRune(r) || len(str) > 9 {
			break
		}
		str += string(s.Next())
	}
	if str == "span." || str == "resource." {
		for range str {
			l.Next()
		}
		return true
	}
	return false
}

// readAttribute is Tempo's parseAttribute: attribute runes, with quoted parts
// that only know the escapes \" and \\.
func (l *braceLexer) readAttribute() {
	for r := l.Peek(); ; r = l.Peek() {
		switch {
		case r == '"':
			l.Next()
			for {
				c := l.Peek()
				if c == scanner.EOF {
					l.fail(`unexpected EOF, expecting "`)
					return
				}
				l.Next()
				if c == '"' {
					break
				}
				if c == '\\' {
					if e := l.Peek(); e != '"' && e != '\\' {
						l.fail("invalid escape sequence")
						return
					}
					l.Next()
				}
			}
		case isAttributeRune(r):
			l.Next()
		default:
			return
		}
	}
}

// skipDuration is Tempo's tryScanDuration: a number followed by duration runes
// (and dots) up to a space is one duration token when it parses as one.
func (l *braceLexer) skipDuration(number string) {
	s := l.Scanner
	var sb strings.Builder
	sb.WriteString(number)
	consumed := 0
	for r := s.Peek(); r != scanner.EOF && !unicode.IsSpace(r); r = s.Peek() {
		if !unicode.IsNumber(r) && !isDurationRune(r) && r != '.' {
			break
		}
		sb.WriteRune(r)
		s.Next()
		consumed++
	}
	if consumed == 0 {
		return
	}
	if _, err := model.ParseDuration(sb.String()); err != nil {
		if _, err := time.ParseDuration(sb.String()); err != nil {
			return
		}
	}
	for i := 0; i < consumed; i++ {
		l.Next()
	}
}

// InjectScope adds the scope matchers to every spanset filter of query:
// { cond } becomes { (cond) && resource.a = "x" && resource.b = "y" } and {}
// becomes { resource.a = "x" && … }. Spanset filters are found the way Tempo's
// lexer finds them (strings, raw strings, comments and attribute names read as
// Tempo reads them), so whatever the query says, every filter Tempo runs also
// requires the scope. Refused: no filter, an unbalanced or nested brace, an
// unterminated literal or comment, and anything that reads spans outside the
// scope (parent., the root span, trace-level duration, tree positions).
func InjectScope(query string, scope []Matcher) (string, error) {
	if len(query) > MaxTraceQLLength {
		return "", fmt.Errorf("%w: longer than %d bytes", ErrInvalidTraceQL, MaxTraceQLLength)
	}
	if !utf8.ValidString(query) || strings.ContainsRune(query, 0) {
		return "", fmt.Errorf("%w: not UTF-8 text", ErrInvalidTraceQL)
	}
	if len(scope) == 0 {
		return "", fmt.Errorf("%w: no scope to add", ErrInvalidTraceQL)
	}
	conds := make([]string, 0, len(scope))
	for _, m := range scope {
		if !scopeAttribute.MatchString(m.Attribute) {
			return "", fmt.Errorf("%w: scope attribute %q", ErrInvalidTraceQL, m.Attribute)
		}
		conds = append(conds, m.Attribute+" = "+strconv.Quote(m.Value))
	}
	cond := strings.Join(conds, " && ")

	var l braceLexer
	l.run(query)
	if l.err != nil {
		return "", l.err
	}
	// Each filter is a "{" … "}" pair with no brace between and balanced
	// parentheses inside, so "(cond)" holds the whole condition: a ")" that
	// closed it early would leave the rest without the scope.
	var pairs [][2]int
	open, depth := -1, 0
	for _, m := range l.marks {
		switch m.kind {
		case tokOpenBrace:
			if open >= 0 {
				return "", fmt.Errorf("%w: nested braces", ErrInvalidTraceQL)
			}
			open, depth = m.offset, 0
		case tokCloseBrace:
			if open < 0 || depth != 0 {
				return "", fmt.Errorf("%w: unbalanced braces or parentheses", ErrInvalidTraceQL)
			}
			pairs = append(pairs, [2]int{open, m.offset})
			open = -1
		case tokOpenParen:
			if open >= 0 {
				depth++
			}
		case tokCloseParen:
			if open >= 0 {
				if depth--; depth < 0 {
					return "", fmt.Errorf("%w: unbalanced parentheses in a filter", ErrInvalidTraceQL)
				}
			}
		}
	}
	if open >= 0 {
		return "", fmt.Errorf("%w: unbalanced braces", ErrInvalidTraceQL)
	}
	if len(pairs) == 0 {
		return "", fmt.Errorf("%w: no spanset filter ({ … })", ErrInvalidTraceQL)
	}
	var b strings.Builder
	last := 0
	for _, p := range pairs {
		open, close := p[0], p[1]
		inner := query[open+1 : close]
		b.WriteString(query[last:open])
		if strings.TrimSpace(inner) == "" {
			b.WriteString("{ " + cond + " }")
		} else {
			b.WriteString("{ (" + inner + ") && " + cond + " }")
		}
		last = close + 1
	}
	b.WriteString(query[last:])
	return b.String(), nil
}
