package variables

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// formatValue is one of Grafana's formats (scenes formatRegistry); an unknown
// one is glob, as there. ok is false where this package leaves the
// reference: queryparam, a date pattern.
func formatValue(v value, format, name string, texts func() string) (string, bool) {
	args := []string{}
	if parts := strings.Split(format, ":"); len(parts) > 1 {
		format, args = parts[0], parts[1:]
	}
	arg := func(i int) (string, bool) {
		if i < len(args) {
			return args[i], true
		}
		return "", false
	}
	items, list := v.items, v.list
	s := v.str()
	switch format {
	case "lucene":
		if !list {
			return luceneEscape(s), true
		}
		if len(items) == 0 {
			return "__empty__", true
		}
		return "(" + each(items, " OR ", func(x string) string { return `"` + luceneEscape(x) + `"` }) + ")", true
	case "raw":
		return s, true
	case "regex":
		if !list {
			return escapeRegex(s), true
		}
		if len(items) == 1 {
			return escapeRegex(items[0]), true
		}
		return "(" + each(items, "|", escapeRegex) + ")", true
	case "pipe":
		if list {
			return strings.Join(items, "|"), true
		}
		return s, true
	case "distributed":
		if !list {
			return s, true
		}
		out := make([]string, len(items))
		for i, x := range items {
			out[i] = x
			if i > 0 {
				out[i] = name + "=" + x
			}
		}
		return strings.Join(out, ","), true
	case "csv":
		return s, true
	case "html":
		if list {
			return escapeHTML(strings.Join(items, ", ")), true
		}
		return escapeHTML(s), true
	case "json":
		if list {
			return "[" + each(items, ",", jsonString) + "]", true
		}
		return s, true
	case "percentencode":
		if list {
			return encodeURIComponent("{" + s + "}"), true
		}
		return encodeURIComponent(s), true
	case "singlequote":
		if list {
			return each(items, ",", func(x string) string { return "'" + strings.ReplaceAll(x, "'", `\'`) + "'" }), true
		}
		return "'" + strings.ReplaceAll(s, "'", `\'`) + "'", true
	case "doublequote":
		if list {
			return each(items, ",", func(x string) string { return `"` + strings.ReplaceAll(x, `"`, `\"`) + `"` }), true
		}
		return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`, true
	case "sqlstring":
		quote := func(x string) string {
			return "'" + strings.NewReplacer("'", "''", `"`, `\"`).Replace(x) + "'"
		}
		if list {
			return each(items, ",", quote), true
		}
		return quote(s), true
	case "join":
		if !list {
			return s, true
		}
		sep, ok := arg(0)
		if !ok {
			sep = ","
		}
		return strings.Join(items, sep), true
	case "date":
		return date(v, args)
	case "text":
		if texts != nil {
			return texts(), true
		}
		return s, true
	case "customqueryparam":
		n, _ := arg(0)
		if n == "" {
			n = name
		}
		prefix, _ := arg(1)
		param := func(x string) string {
			return encodeURIComponent(n) + "=" + encodeURIComponent(prefix) + encodeURIComponent(x)
		}
		if list {
			return each(items, "&", param), true
		}
		return param(s), true
	case "uriencode":
		if list {
			return encodeURI("{" + s + "}"), true
		}
		return encodeURI(s), true
	case "queryparam":
		return "", false
	default: // glob, and any format Grafana does not know
		if list && len(items) > 1 {
			return "{" + s + "}", true
		}
		return s, true
	}
}

// date is the date format: the value as milliseconds since 1970 written as
// ms, seconds or (the default) an ISO time in UTC; anything that is no number
// writes NaN.
func date(v value, args []string) (string, bool) {
	if v.list {
		return "NaN", true // a list is no number
	}
	n, ok := parseInt(v.str())
	if !ok {
		return "NaN", true
	}
	pattern := "iso"
	if len(args) > 0 {
		pattern = args[0]
	}
	switch {
	case pattern == "ms":
		return v.str(), true
	case pattern == "seconds":
		return strconv.FormatInt(int64(math.Round(float64(n)/1000)), 10), true
	case pattern == "iso" && len(args) <= 1:
		return time.UnixMilli(n).UTC().Format("2006-01-02T15:04:05.000Z"), true
	}
	return "", false // a moment.js pattern
}

// parseInt is JavaScript's parseInt(s, 10): optional space and sign, then the
// leading digits.
func parseInt(s string) (int64, bool) {
	s = strings.TrimLeft(s, " \t\n\r\v\f")
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	j := i
	for j < len(s) && s[j] >= '0' && s[j] <= '9' {
		j++
	}
	if j == i {
		return 0, false
	}
	n, err := strconv.ParseInt(s[:j], 10, 64)
	return n, err == nil
}

func each(items []string, sep string, f func(string) string) string {
	out := make([]string, len(items))
	for i, x := range items {
		out[i] = f(x)
	}
	return strings.Join(out, sep)
}

// escapeRegex is @grafana/data escapeRegex.
func escapeRegex(s string) string {
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune(`\^$*+?.()|[]{}/`, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// escapeHTML is @grafana/data textUtil.escapeHtml.
func escapeHTML(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "'", "&#39;", `"`, "&quot;").Replace(s)
}

// luceneEscape leaves a value JavaScript reads as a number and escapes
// Lucene's special characters and white space in any other.
func luceneEscape(s string) string {
	if jsNumber(s) {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune(`!*+-=<>&|()[]{}^~?:\/"`, r) || jsSpace(r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// jsSpace is a character of JavaScript's \s.
func jsSpace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\v', '\f', '\r', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// jsNumber says whether JavaScript's +s is a number (not NaN): white space
// around a decimal, a 0x, 0o or 0b literal, Infinity, or nothing at all.
func jsNumber(s string) bool {
	t := strings.TrimFunc(s, jsSpace)
	if t == "" {
		return true
	}
	if len(t) > 2 && t[0] == '0' {
		digits := map[byte]string{'x': "0123456789abcdefABCDEF", 'X': "0123456789abcdefABCDEF", 'o': "01234567", 'O': "01234567", 'b': "01", 'B': "01"}[t[1]]
		if digits != "" {
			for i := 2; i < len(t); i++ {
				if !strings.ContainsRune(digits, rune(t[i])) {
					return false
				}
			}
			return true
		}
	}
	u := strings.TrimLeft(t, "+-")
	if len(t)-len(u) > 1 {
		return false
	}
	if u == "Infinity" {
		return true
	}
	mantissa, exp, hasExp := strings.Cut(strings.ToLower(u), "e")
	if hasExp {
		e := strings.TrimLeft(exp, "+-")
		if len(exp)-len(e) > 1 || !digitsOnly(e) || e == "" {
			return false
		}
	}
	whole, frac, _ := strings.Cut(mantissa, ".")
	return (whole != "" || frac != "") && digitsOnly(whole) && digitsOnly(frac) && strings.Count(mantissa, ".") <= 1
}

func digitsOnly(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// jsonString is JSON.stringify of a string.
func jsonString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// encodeURIComponent is the formats' encodeURIComponentStrict: RFC 3986,
// every byte but letters, digits and -_.~ written as %XX.
func encodeURIComponent(s string) string { return percent(s, "-_.~") }

// encodeURI is encodeURIStrict: encodeURI, which also keeps ;/?:@&=+$,#, with
// !'()* written as %XX.
func encodeURI(s string) string { return percent(s, "-_.~;/?:@&=+$,#") }

func percent(s, keep string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < utf8.RuneSelf && (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(keep, c) >= 0) {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// prometheusFormat is the Prometheus data source's interpolateQueryExpr with
// Grafana 13.3.0's default (the prometheusSpecialCharsInLabelValues feature
// off): one value of a variable that is neither multi-valued nor has All gets
// backslashes and single quotes escaped; otherwise each value is escaped for a
// regex and several are joined as (a|b).
func prometheusFormat(v value, multi, includeAll bool) string {
	if !multi && !includeAll {
		if v.list {
			return v.str() // not a string: left as it is
		}
		return strings.NewReplacer(`\`, `\\`, `'`, `\\'`).Replace(v.str())
	}
	if !v.list {
		return promRegexEscape(v.str())
	}
	if len(v.items) == 1 {
		return promRegexEscape(v.items[0])
	}
	return "(" + each(v.items, "|", promRegexEscape) + ")"
}

func promRegexEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\\':
			b.WriteString(`\\\\`)
		case strings.ContainsRune(`$^*{}[]+?.()|`, r):
			b.WriteString(`\\`)
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
