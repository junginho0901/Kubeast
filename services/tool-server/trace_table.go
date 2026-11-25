// traces_get's answer with AI_TRACE_SPAN_TABLE (chart ai.traceSpanTable, off by default): one line per span in call order
// instead of the spans with their attributes, which go past what the model reads of a result (6,000 characters unless its
// config says another) after six or seven of them. Off, the answer is as it was.

package main

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/junginho0901/kubeast/services/pkg/config"
	"github.com/junginho0901/kubeast/services/pkg/redact"
)

// traceSpanTable is AI_TRACE_SPAN_TABLE by the one switch rule (config.SwitchOn), read at each answer.
func traceSpanTable() bool { return config.EnvSwitch("AI_TRACE_SPAN_TABLE") }

const (
	// The lines of a table as the model reads them; with its other fields the answer stays under 6,000 characters.
	traceTableChars = 4200
	// What ai-service's indented JSON puts around a string of a list: four spaces, two quotes, a comma and a line break.
	traceLineFrame = 8
	// The most marks of depth in front of a span's name, and the longest name, status message and status code of a line.
	traceDepthMarks   = 8
	spanNameChars     = 90
	spanMessageChars  = 110
	spanCodeChars     = 40
	traceDepthMark    = "· "
	traceCallsMark    = " → "
	traceNoServerSpan = "none"
	// The longest text of a span that holds personal data, which is not cut: a longer one says its length instead.
	spanPersonalChars = 240

	traceColumns = "start_ms | ms | self_ms | outside_ms | service | kind | span"
	traceLegend  = "Spans in call order, one · per call down. start_ms: after the first span here. self_ms: ms that no child span here " +
		"covers. outside_ms of a CLIENT span: its ms less those of the server span it called (service → the server's), so the network, a " +
		"proxy, the connection or a queue and not the server's own work; negative: the server went on after the client stopped waiting; " +
		"none: no server span for it here (service → the address it called). Other attributes are left out."
	traceAttributesHint = `For attributes: traces_search { trace:id = "%s" } | select(span.http.route), with names from traces_tags.`
)

// peerAttributes name what a span without a server span here called, the first that is set: an address or a name, never a
// URL or a statement, which may hold values.
var peerAttributes = []string{"peer.service", "server.address", "net.peer.name", "messaging.destination.name", "db.system.name", "db.system"}

// codeAttributes say how a failed span failed, the first that is set.
var codeAttributes = []string{"http.response.status_code", "http.status_code", "rpc.grpc.status_code", "error.type", "exception.type"}

// traceSpan is a span of k8s-service's answer and what the table says of it.
type traceSpan struct {
	id, parent               string
	service, namespace, kind string
	name, message            string
	peer, code               string
	failed                   bool
	start                    time.Time
	ms                       float64

	up       *traceSpan
	children []*traceSpan
	depth    int
	self     float64
	outside  float64
	called   string // the service of the server span a client span called
}

// traceSpansOf reads the spans of an answer; ok is false when one is no span.
func traceSpansOf(raw []interface{}) (spans []*traceSpan, ok bool) {
	for _, v := range raw {
		m, isMap := v.(map[string]interface{})
		if !isMap {
			return nil, false
		}
		text := func(key string) string { s, _ := m[key].(string); return s }
		s := &traceSpan{
			id: text("spanId"), parent: text("parentSpanId"), service: text("service"), namespace: text("namespace"), kind: text("kind"),
			name: text("name"), message: text("statusMessage"), failed: text("status") == "ERROR",
		}
		s.ms, _ = m["durationMs"].(float64)
		s.start, _ = time.Parse(time.RFC3339Nano, text("start"))
		attrs, _ := m["attributes"].(map[string]interface{})
		s.peer, s.code = firstSet(attrs, peerAttributes), firstSet(attrs, codeAttributes)
		spans = append(spans, s)
	}
	return spans, len(spans) > 0
}

// firstSet is the first of the attributes that says something: a gRPC status of 0 is OK, on a failed span not its code.
func firstSet(attrs map[string]interface{}, keys []string) string {
	for _, key := range keys {
		if v, _ := attrs[key].(string); v != "" && v != "0" {
			return v
		}
	}
	return ""
}

// inCallOrder ties the spans to their parents and returns them a caller before what it called, brothers by start.
func inCallOrder(spans []*traceSpan) []*traceSpan {
	byID := map[string]*traceSpan{}
	for _, s := range spans {
		if _, taken := byID[s.id]; s.id != "" && !taken {
			byID[s.id] = s
		}
	}
	var roots []*traceSpan
	for _, s := range spans {
		if p := byID[s.parent]; s.parent != "" && p != nil && p != s {
			s.up = p
			p.children = append(p.children, s)
		} else {
			roots = append(roots, s)
		}
	}
	byStart := func(list []*traceSpan) {
		sort.SliceStable(list, func(i, j int) bool { return list[i].start.Before(list[j].start) })
	}
	order := make([]*traceSpan, 0, len(spans))
	seen := map[*traceSpan]bool{}
	var walk func(s *traceSpan, depth int)
	walk = func(s *traceSpan, depth int) {
		seen[s] = true
		s.depth = depth
		order = append(order, s)
		byStart(s.children)
		for _, c := range s.children {
			if !seen[c] {
				walk(c, depth+1)
			}
		}
	}
	byStart(roots)
	for _, s := range roots {
		walk(s, 0)
	}
	for _, s := range spans { // spans that name each other as parent hang on no root
		if !seen[s] {
			s.up = nil
			walk(s, 0)
		}
	}
	return order
}

// measure gives a span its own time and, of a client span, the time outside the server it called.
func (s *traceSpan) measure() {
	s.self = math.Max(0, s.ms-s.covered())
	if s.kind != "CLIENT" {
		return
	}
	server := 0.0
	for _, c := range s.children {
		if c.kind != "SERVER" {
			continue
		}
		server += c.ms
		if s.called == "" {
			s.called = c.service
		}
	}
	if s.called != "" {
		s.outside = s.ms - server
	}
}

// covered is how many ms of a span its children cover, each clipped to the span and what two cover counted once.
func (s *traceSpan) covered() float64 {
	type part struct{ from, to float64 }
	var parts []part
	for _, c := range s.children {
		from := float64(c.start.Sub(s.start)) / 1e6
		parts = append(parts, part{math.Max(from, 0), math.Min(from+c.ms, s.ms)})
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].from < parts[j].from })
	covered, end := 0.0, 0.0
	for _, p := range parts {
		if from := math.Max(p.from, end); p.to > from {
			covered += p.to - from
			end = p.to
		}
	}
	return covered
}

// weight is what a span adds to the request's time: its own, or that outside the server it called.
func (s *traceSpan) weight() float64 { return math.Max(s.self, math.Abs(s.outside)) }

// tableLine is a span's line and what was masked in it.
type tableLine struct {
	text   string
	masked redact.Stats
}

// words is a span's text in a line: credentials masked in the whole text first, since a rule may go by where a line starts
// and a table's line starts elsewhere, then on one line and at most limit characters long.
func (l *tableLine) words(s string, limit int) string {
	credentials := redactOpts
	credentials.PII = false // numbered over the whole answer, after this
	masked, stats := redact.Text(s, credentials)
	mergeStats(&l.masked, stats)
	masked = strings.Join(strings.FieldsFunc(masked, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	if utf8.RuneCountInString(masked) <= limit {
		return masked
	}
	// cut in the middle, a value the personal-data rules know may no longer be one they know
	if redactOpts.PII {
		if _, personal := redact.Text(masked, redactOpts); personal.Count > 0 {
			if n := utf8.RuneCountInString(masked); n > spanPersonalChars {
				return fmt.Sprintf("(%d characters, personal data)", n)
			}
			return masked
		}
	}
	return string([]rune(masked)[:limit-1]) + "…"
}

// lineOf is one span of the table.
func lineOf(s *traceSpan, first time.Time, manyNamespaces bool) tableLine {
	var l tableLine
	service, outside := l.words(s.service, spanNameChars), ""
	if manyNamespaces && s.namespace != "" {
		service = l.words(s.namespace, spanNameChars) + "/" + service
	}
	switch {
	case s.called != "":
		outside = fmt.Sprintf("%.1f", s.outside)
		service += traceCallsMark + l.words(s.called, spanNameChars)
	case s.kind == "CLIENT" || s.kind == "PRODUCER":
		if s.kind == "CLIENT" {
			outside = traceNoServerSpan
		}
		if s.peer != "" {
			service += traceCallsMark + l.words(s.peer, spanNameChars)
		}
	}
	at := 0.0
	if !s.start.IsZero() {
		at = float64(s.start.Sub(first)) / 1e6
	}
	l.text = fmt.Sprintf("%.1f | %.1f | %.1f | %s | %s | %s | %s%s", at, s.ms, s.self, outside, service, s.kind,
		strings.Repeat(traceDepthMark, min(s.depth, traceDepthMarks)), l.words(s.name, spanNameChars))
	if s.failed {
		l.text += " [ERROR"
		if s.code != "" {
			l.text += " " + l.words(s.code, spanCodeChars)
		}
		if s.message != "" {
			l.text += ": " + l.words(s.message, spanMessageChars)
		}
		l.text += "]"
	}
	return l
}

// chars is how many characters of the model's result the line takes, as a string of an indented JSON list.
func (l tableLine) chars() int {
	return utf8.RuneCountInString(l.text) + strings.Count(l.text, `"`) + strings.Count(l.text, `\`) + traceLineFrame
}

// spanTable is the spans that fit the budget, in call order, with their lines. When not all do, the spans that failed and
// then those that took the most time, their own or outside the server they called, are kept, each with the spans above it
// where those fit too; a span whose line no longer fits is passed over for the next.
func spanTable(order []*traceSpan, first time.Time, budget int) (kept []*traceSpan, lines []tableLine) {
	namespaces := map[string]bool{}
	for _, s := range order {
		namespaces[s.namespace] = true
	}
	made := map[*traceSpan]tableLine{}
	for _, s := range order {
		made[s] = lineOf(s, first, len(namespaces) > 1)
	}
	ranked := append([]*traceSpan{}, order...)
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].failed != ranked[j].failed {
			return ranked[i].failed
		}
		return ranked[i].weight() > ranked[j].weight()
	})
	in := map[*traceSpan]bool{}
	for _, s := range ranked {
		if in[s] {
			continue
		}
		path, room := []*traceSpan{s}, made[s].chars()
		if room > budget {
			continue
		}
		for up := s.up; up != nil && !in[up]; up = up.up {
			path = append(path, up)
			room += made[up].chars()
		}
		if room > budget {
			path, room = path[:1], made[s].chars()
		}
		for _, p := range path {
			in[p] = true
		}
		budget -= room
	}
	for _, s := range order {
		if in[s] {
			kept, lines = append(kept, s), append(lines, made[s])
		}
	}
	return kept, lines
}

// traceTable is traces_get's answer with the table in place of the spans. cut says the answer k8s-service gave was cut.
func traceTable(ctx context.Context, traceID, namespace string, spans []*traceSpan, total, hidden, errors int, cut bool) (string, error) {
	var first, last time.Time
	for _, s := range spans {
		if !s.start.IsZero() && (first.IsZero() || s.start.Before(first)) {
			first = s.start
		}
		if end := s.start.Add(time.Duration(s.ms * 1e6)); end.After(last) {
			last = end
		}
	}
	order := inCallOrder(spans)
	for _, s := range order {
		s.measure()
	}
	kept, lines := spanTable(order, first, traceTableChars)
	table := make([]string, len(lines))
	for i, l := range lines {
		table[i] = l.text
		countReadStats(ctx, l.masked)
	}
	result := map[string]interface{}{
		"trace_id": traceID, "namespace": namespaceOrAll(namespace), "errors": errors, "shown": len(table),
		"columns": traceColumns, "table": table, "legend": traceLegend, "attributes": fmt.Sprintf(traceAttributesHint, traceID),
	}
	if names := spanNamespaces(order); namespace == "" && len(names) == 1 {
		result["namespaces"] = names // of more, each line's service is <namespace>/<service>
	}
	if !first.IsZero() {
		result["start"] = first.UTC().Format(time.RFC3339Nano)
		result["trace_ms"] = math.Round(float64(last.Sub(first))/1e5) / 10
	}
	if hidden > 0 {
		result["hidden"] = hidden
		result["note"] = fmt.Sprintf("%s (%d of %d): the time in them is in the self_ms of the spans that called them.", traceScopeNote, hidden, total)
	}
	if left := len(order) - len(kept); left > 0 || cut {
		result["truncated"] = true
		result["hint"] = tableHint(order, kept, cut)
		addDetails(result, cutOf(len(table), total-hidden, "spans in your scope"), "", "")
	}
	return marshalOrdered(result, []string{"trace_id", "namespace", "namespaces", "start", "trace_ms", "errors", "shown", "truncated", "hint", "cut",
		"hidden", "note", "columns", "table"}, []string{"legend", "attributes"})
}

func spanNamespaces(spans []*traceSpan) []string {
	var names []string
	seen := map[string]bool{"": true}
	for _, s := range spans {
		if !seen[s.namespace] {
			seen[s.namespace] = true
			names = append(names, s.namespace)
		}
	}
	return names
}

// tableHint says what the table leaves out.
func tableHint(order, kept []*traceSpan, cut bool) string {
	var parts []string
	if left := len(order) - len(kept); left > 0 {
		shown := map[*traceSpan]bool{}
		for _, s := range kept {
			shown[s] = true
		}
		most := 0.0
		for _, s := range order {
			if !shown[s] {
				most = math.Max(most, s.weight())
			}
		}
		parts = append(parts, fmt.Sprintf("%d spans are left out of the table, none with more than %.1f ms of self_ms or outside_ms.", left, most))
	}
	if cut {
		parts = append(parts, "The trace was cut before that: errors come first, then the earliest, so later spans are missing and self_ms of the spans that called them is too long.")
	}
	return strings.Join(parts, " ")
}
