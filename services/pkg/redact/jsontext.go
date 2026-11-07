package redact

import (
	"bytes"
	"encoding/json"
	"strings"
)

// JSON redacts text that is one JSON object or array, optionally after lines kubectl printed before it (warnings). The
// rules of Text see each string decoded, so a YAML document or a log line inside a string is masked as it would be
// alone, and the rules on object keys see each member. Only what the rules change is rewritten: other numbers, key order
// and spacing stay as they came. ok is false when s is not such text; the caller then uses Text.
func JSON(s string, o Options) (out string, st Stats, ok bool) {
	start := jsonStart(s)
	if start < 0 || !json.Valid([]byte(s[start:])) {
		return s, st, false
	}
	head, headStats := Text(s[:start], o)
	st.merge(headStats)
	// PII runs once over the whole text below: one address keeps one placeholder across strings.
	each := o
	each.PII = false
	w := jsonRewriter{src: s, opts: each, st: &st}
	w.value(start, jsonValueEnd(s, start), false)
	w.out.WriteString(s[w.pos:])
	return head + redactPII(w.out.String()[start:], o, &st), st, true
}

func (s *Stats) merge(other Stats) {
	for k, n := range other.Kinds {
		s.add(k, n)
	}
}

// jsonStart is where the JSON part of s starts, or -1: the first character, or the start of the first line that opens
// an object or an array.
func jsonStart(s string) int {
	first := len(s) - len(strings.TrimLeft(s, " \t\r\n"))
	if first < len(s) && (s[first] == '{' || s[first] == '[') {
		return first
	}
	for i := 0; i < len(s)-1; i++ {
		if s[i] == '\n' && (s[i+1] == '{' || s[i+1] == '[') {
			return i + 1
		}
	}
	return -1
}

// jsonRewriter copies src to out, replacing the strings the rules change; src[:pos] has been copied. It runs on text
// json.Valid has accepted, so every value ends where jsonValueEnd says.
type jsonRewriter struct {
	src  string
	out  strings.Builder
	pos  int
	opts Options
	st   *Stats
}

func (w *jsonRewriter) replace(start, end int, text string) {
	w.out.WriteString(w.src[w.pos:start])
	w.out.WriteString(text)
	w.pos = end
}

func (w *jsonRewriter) skipSpace(i int) int {
	for i < len(w.src) && isJSONSpace(w.src[i]) {
		i++
	}
	return i
}

func (w *jsonRewriter) value(start, end int, secret bool) {
	switch w.src[start] {
	case '{':
		w.object(start, end, secret)
	case '[':
		for _, e := range w.elements(start, end) {
			w.value(e[0], e[1], secret)
		}
	case '"':
		w.text(start, end)
	}
}

type jsonMember struct {
	key                string
	keyStart, keyEnd   int
	valueStart, valEnd int
}

func (w *jsonRewriter) members(start, end int) []jsonMember {
	var ms []jsonMember
	i := w.skipSpace(start + 1)
	for i < end-1 {
		m := jsonMember{keyStart: i, keyEnd: jsonValueEnd(w.src, i)}
		m.key = decodeJSONString(w.src[m.keyStart:m.keyEnd])
		i = w.skipSpace(m.keyEnd)
		m.valueStart = w.skipSpace(i + 1) // past the colon
		m.valEnd = jsonValueEnd(w.src, m.valueStart)
		ms = append(ms, m)
		i = w.skipSpace(m.valEnd)
		if i < end-1 && w.src[i] == ',' {
			i = w.skipSpace(i + 1)
		}
	}
	return ms
}

func (w *jsonRewriter) elements(start, end int) [][2]int {
	var es [][2]int
	i := w.skipSpace(start + 1)
	for i < end-1 {
		e := jsonValueEnd(w.src, i)
		es = append(es, [2]int{i, e})
		i = w.skipSpace(e)
		if i < end-1 && w.src[i] == ',' {
			i = w.skipSpace(i + 1)
		}
	}
	return es
}

func (w *jsonRewriter) stringOf(start, end int) (string, bool) {
	if w.src[start] != '"' {
		return "", false
	}
	return decodeJSONString(w.src[start:end]), true
}

func (w *jsonRewriter) object(start, end int, secret bool) {
	ms := w.members(start, end)
	envSecret := ""
	for _, m := range ms {
		value, isString := w.stringOf(m.valueStart, m.valEnd)
		if m.key == "kind" && isString && value == "Secret" {
			secret = true
		}
		if m.key == "name" && isString && w.opts.on("key_name") && keyIsSensitive(value) {
			envSecret = value // a container env entry: the key is "value", so the name decides
		}
	}
	for _, m := range ms {
		w.text(m.keyStart, m.keyEnd)
		value, isString := w.stringOf(m.valueStart, m.valEnd)
		isNumber := startsNumber(w.src[m.valueStart])
		switch {
		case secret && secretValueFields[m.key]:
			w.secretField(m.valueStart, m.valEnd)
		case secret && m.key == lastAppliedName && !isPlaceholderValue(value):
			w.replace(m.valueStart, m.valEnd, `"`+secretPlaceholder+`"`)
			w.st.add("secret", 1)
		case w.opts.on("key_name") && holdsCredential(m.key, value, isString, isNumber):
			w.replace(m.valueStart, m.valEnd, jsonString("<REDACTED:"+m.key+">"))
			w.st.add("key_name", 1)
		case m.key == "value" && envSecret != "" && holdsCredential(envSecret, value, isString, isNumber):
			w.replace(m.valueStart, m.valEnd, jsonString("<REDACTED:"+envSecret+">"))
			w.st.add("key_name", 1)
		case w.opts.on("key_name") && w.src[m.valueStart] == '[' && keyIsSensitive(m.key):
			w.credentialList(m.key, m.valueStart, m.valEnd, secret)
		default:
			w.value(m.valueStart, m.valEnd, secret)
		}
	}
}

func startsNumber(c byte) bool { return c == '-' || (c >= '0' && c <= '9') }

// credentialList masks each item of a list under a credential's key. A mapping in it has its own keys.
func (w *jsonRewriter) credentialList(key string, start, end int, secret bool) {
	for _, e := range w.elements(start, end) {
		value, isString := w.stringOf(e[0], e[1])
		if holdsCredential(key, value, isString, startsNumber(w.src[e[0]])) {
			w.replace(e[0], e[1], jsonString("<REDACTED:"+key+">"))
			w.st.add("key_name", 1)
			continue
		}
		w.value(e[0], e[1], secret)
	}
}

// secretField masks one field holding a Secret's values: each value of an object, keys kept; anything else whole.
func (w *jsonRewriter) secretField(start, end int) {
	switch raw := w.src[start:end]; {
	case raw == "null" || raw == `""`:
	case raw[0] == '{':
		for _, m := range w.members(start, end) {
			w.text(m.keyStart, m.keyEnd)
			if value, isString := w.stringOf(m.valueStart, m.valEnd); isString && isPlaceholderValue(value) {
				continue
			}
			w.replace(m.valueStart, m.valEnd, `"`+secretPlaceholder+`"`)
			w.st.add("secret", 1)
		}
	default:
		w.replace(start, end, `"`+secretPlaceholder+`"`)
		w.st.add("secret", 1)
	}
}

func isPlaceholderValue(v string) bool { return strings.HasPrefix(v, "<REDACTED") }

// text runs the rules of Text on one string and rewrites it if they change it.
func (w *jsonRewriter) text(start, end int) {
	s := decodeJSONString(w.src[start:end])
	out, st := Text(s, w.opts)
	if out != s {
		w.replace(start, end, jsonString(out))
	}
	w.st.merge(st)
}

func decodeJSONString(lit string) string {
	if !strings.Contains(lit, `\`) {
		return lit[1 : len(lit)-1]
	}
	var s string
	_ = json.Unmarshal([]byte(lit), &s)
	return s
}

// jsonString encodes s as a JSON string, leaving < and > as they are: the placeholders stay readable.
func jsonString(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimSuffix(b.String(), "\n")
}
