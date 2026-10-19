package traces

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ErrTimeout marks a read the store did not answer in time; ErrNotServed a
// path the store does not offer (404); ErrNotFound a trace ID it does not hold.
var (
	ErrTimeout   = errors.New("trace store did not answer in time")
	ErrNotServed = errors.New("not served by this trace store")
	ErrNotFound  = errors.New("trace not found")
)

// StoreError is a non-200 answer from the store.
type StoreError struct {
	Status int
	Body   string
}

func (e *StoreError) Error() string {
	return fmt.Sprintf("trace store answered %d: %s", e.Status, e.Body)
}

// Caps on what one read returns.
const (
	MaxSeries     = 100
	MaxTraceSpans = 300
	MaxTagValues  = 200
	maxBody       = 32 << 20
)

type tempo struct {
	cfg  Config
	http *http.Client
}

func newTempo(cfg Config) *tempo { return &tempo{cfg: cfg, http: &http.Client{Timeout: cfg.Timeout}} }

// get asks the store for path and returns a 200 answer's body.
func (t *tempo) get(ctx context.Context, path string, params url.Values) ([]byte, error) {
	target := t.cfg.URL + path
	if len(params) > 0 {
		target += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if t.cfg.AuthHeader != "" {
		req.Header.Set("Authorization", t.cfg.AuthHeader)
	}
	if t.cfg.Tenant != "" {
		req.Header.Set("X-Scope-OrgID", t.cfg.Tenant)
	}
	resp, err := t.http.Do(req)
	if err != nil {
		var te interface{ Timeout() bool }
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &te) && te.Timeout()) {
			return nil, ErrTimeout
		}
		return nil, fmt.Errorf("trace store: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, fmt.Errorf("trace store: %w", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		return body, ErrNotServed
	}
	if resp.StatusCode != http.StatusOK {
		msg := strings.TrimSpace(string(body))
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, &StoreError{Status: resp.StatusCode, Body: msg}
	}
	return body, nil
}

func window(params url.Values, start, end time.Time) {
	params.Set("start", strconv.FormatInt(start.Unix(), 10))
	params.Set("end", strconv.FormatInt(end.Unix(), 10))
}

// keyValue is an OTLP attribute as Tempo's JSON writes it.
type keyValue struct {
	Key   string `json:"key"`
	Value struct {
		StringValue *string          `json:"stringValue"`
		IntValue    *json.RawMessage `json:"intValue"`
		DoubleValue *float64         `json:"doubleValue"`
		BoolValue   *bool            `json:"boolValue"`
	} `json:"value"`
}

func (kv keyValue) text() string {
	switch v := kv.Value; {
	case v.StringValue != nil:
		return *v.StringValue
	case v.IntValue != nil:
		return strings.Trim(string(*v.IntValue), `"`)
	case v.DoubleValue != nil:
		return strconv.FormatFloat(*v.DoubleValue, 'g', -1, 64)
	case v.BoolValue != nil:
		return strconv.FormatBool(*v.BoolValue)
	}
	return ""
}

func attrMap(kvs []keyValue) map[string]string {
	m := make(map[string]string, len(kvs))
	for _, kv := range kvs {
		m[kv.Key] = kv.text()
	}
	return m
}

// number reads a JSON number that protobuf JSON may have written as a string.
func number(raw json.RawMessage) float64 {
	f, _ := strconv.ParseFloat(strings.Trim(string(raw), `"`), 64)
	return f
}

// integer reads an int64 the same way: Unix nanoseconds lose digits as float64.
func integer(raw json.RawMessage) int64 {
	s := strings.Trim(string(raw), `"`)
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n
	}
	return int64(number(raw))
}

// MatchedSpan is a span a search matched.
type MatchedSpan struct {
	SpanID     string            `json:"spanId"`
	Name       string            `json:"name,omitempty"`
	Start      time.Time         `json:"start"`
	DurationMs float64           `json:"durationMs"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

// FoundTrace is one trace of a search: its ID and the spans that matched.
// Trace-level fields Tempo adds (root service, root span name, whole-trace
// duration) are left out: the root may be outside the caller's scope.
type FoundTrace struct {
	TraceID string        `json:"traceId"`
	Matched int           `json:"matched"`
	Spans   []MatchedSpan `json:"spans"`
}

// SearchResult is a page of traces, newest first as Tempo returns them.
type SearchResult struct {
	Traces         []FoundTrace `json:"traces"`
	EffectiveQuery string       `json:"effectiveQuery"`
}

type searchResponse struct {
	Traces []struct {
		TraceID  string `json:"traceID"`
		SpanSets []struct {
			Matched int `json:"matched"`
			Spans   []struct {
				SpanID            string          `json:"spanID"`
				Name              string          `json:"name"`
				StartTimeUnixNano json.RawMessage `json:"startTimeUnixNano"`
				DurationNanos     json.RawMessage `json:"durationNanos"`
				Attributes        []keyValue      `json:"attributes"`
			} `json:"spans"`
		} `json:"spanSets"`
	} `json:"traces"`
}

func (t *tempo) search(ctx context.Context, query string, start, end time.Time, limit, spss int) (SearchResult, error) {
	params := url.Values{"q": {query}, "limit": {strconv.Itoa(limit)}, "spss": {strconv.Itoa(spss)}}
	window(params, start, end)
	body, err := t.get(ctx, "/api/search", params)
	if err != nil {
		return SearchResult{EffectiveQuery: query}, err
	}
	var sr searchResponse
	if err := json.Unmarshal(body, &sr); err != nil {
		return SearchResult{EffectiveQuery: query}, fmt.Errorf("trace store: unreadable answer: %w", err)
	}
	res := SearchResult{Traces: []FoundTrace{}, EffectiveQuery: query}
	for _, tr := range sr.Traces {
		ft := FoundTrace{TraceID: padHex(tr.TraceID, 32), Spans: []MatchedSpan{}}
		for _, set := range tr.SpanSets {
			ft.Matched += set.Matched
			for _, s := range set.Spans {
				ft.Spans = append(ft.Spans, MatchedSpan{
					SpanID: padHex(s.SpanID, 16), Name: s.Name,
					Start:      time.Unix(0, integer(s.StartTimeUnixNano)).UTC(),
					DurationMs: float64(integer(s.DurationNanos)) / 1e6, Attributes: attrMap(s.Attributes),
				})
			}
		}
		res.Traces = append(res.Traces, ft)
	}
	return res, nil
}

// Point is one sample of a Series; Series one TraceQL metrics series, in the
// shape of a Prometheus range result.
type Point struct {
	T float64 `json:"t"`
	V float64 `json:"v"`
}

type Series struct {
	Metric map[string]string `json:"metric"`
	Points []Point           `json:"points"`
}

// MetricsResult is a TraceQL metrics range answer.
type MetricsResult struct {
	Series         []Series `json:"series"`
	Truncated      bool     `json:"truncated"`
	StepSeconds    int64    `json:"stepSeconds"`
	EffectiveQuery string   `json:"effectiveQuery"`
}

type metricsResponse struct {
	Series []struct {
		Labels  []keyValue `json:"labels"`
		Samples []struct {
			TimestampMs json.RawMessage `json:"timestampMs"`
			Value       float64         `json:"value"`
		} `json:"samples"`
	} `json:"series"`
}

func (t *tempo) metrics(ctx context.Context, query string, start, end time.Time, step time.Duration) (MetricsResult, error) {
	params := url.Values{"q": {query}, "step": {strconv.FormatInt(int64(step/time.Second), 10) + "s"}}
	window(params, start, end)
	res := MetricsResult{Series: []Series{}, StepSeconds: int64(step / time.Second), EffectiveQuery: query}
	body, err := t.get(ctx, "/api/metrics/query_range", params)
	if err != nil {
		return res, err
	}
	var mr metricsResponse
	if err := json.Unmarshal(body, &mr); err != nil {
		return res, fmt.Errorf("trace store: unreadable answer: %w", err)
	}
	for _, s := range mr.Series {
		if len(res.Series) == MaxSeries {
			res.Truncated = true
			break
		}
		series := Series{Metric: attrMap(s.Labels), Points: make([]Point, 0, len(s.Samples))}
		for _, p := range s.Samples {
			series.Points = append(series.Points, Point{T: float64(integer(p.TimestampMs)) / 1000, V: p.Value})
		}
		sort.Slice(series.Points, func(i, j int) bool { return series.Points[i].T < series.Points[j].T })
		res.Series = append(res.Series, series)
	}
	return res, nil
}

// Span is one span of a trace read by ID.
type Span struct {
	SpanID       string            `json:"spanId"`
	ParentSpanID string            `json:"parentSpanId,omitempty"`
	Service      string            `json:"service,omitempty"`
	Namespace    string            `json:"namespace,omitempty"`
	Name         string            `json:"name"`
	Kind         string            `json:"kind,omitempty"`
	Start        time.Time         `json:"start"`
	DurationMs   float64           `json:"durationMs"`
	Status       string            `json:"status,omitempty"`
	Message      string            `json:"statusMessage,omitempty"`
	Attributes   map[string]string `json:"attributes,omitempty"`
}

// TraceResult is the caller's part of a trace: the spans whose resource
// carries the scope, errors first then by start, at most MaxTraceSpans.
// Hidden counts the spans of the trace outside the scope.
type TraceResult struct {
	TraceID   string `json:"traceId"`
	Spans     []Span `json:"spans"`
	Total     int    `json:"total"`
	Hidden    int    `json:"hidden"`
	Errors    int    `json:"errors"`
	Truncated bool   `json:"truncated"`
}

type traceResponse struct {
	Trace *struct {
		ResourceSpans []resourceSpans `json:"resourceSpans"`
	} `json:"trace"`
	ResourceSpans []resourceSpans `json:"resourceSpans"`
	Batches       []resourceSpans `json:"batches"`
}

type resourceSpans struct {
	Resource struct {
		Attributes []keyValue `json:"attributes"`
	} `json:"resource"`
	ScopeSpans []struct {
		Spans []otlpSpan `json:"spans"`
	} `json:"scopeSpans"`
}

type otlpSpan struct {
	SpanID            string          `json:"spanId"`
	ParentSpanID      string          `json:"parentSpanId"`
	Name              string          `json:"name"`
	Kind              string          `json:"kind"`
	StartTimeUnixNano json.RawMessage `json:"startTimeUnixNano"`
	EndTimeUnixNano   json.RawMessage `json:"endTimeUnixNano"`
	Attributes        []keyValue      `json:"attributes"`
	Status            struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"status"`
}

// hexID turns an OTLP JSON ID (base64, or already hex) into hex.
func hexID(id string) string {
	if id == "" {
		return ""
	}
	if _, err := hex.DecodeString(id); err == nil && (len(id) == 16 || len(id) == 32) {
		return strings.ToLower(id)
	}
	if b, err := base64.StdEncoding.DecodeString(id); err == nil {
		return hex.EncodeToString(b)
	}
	return id
}

// trace reads a trace by ID and keeps the spans whose resource has every
// scope attribute at its value.
func (t *tempo) trace(ctx context.Context, traceID string, start, end time.Time, scope map[string]string) (TraceResult, error) {
	params := url.Values{}
	if !start.IsZero() {
		window(params, start, end) // no window: everything the store holds
	}
	res := TraceResult{TraceID: traceID, Spans: []Span{}}
	body, err := t.get(ctx, "/api/v2/traces/"+url.PathEscape(traceID), params)
	if errors.Is(err, ErrNotServed) {
		return res, ErrNotFound // Tempo answers 404 for an ID it does not hold
	}
	if err != nil {
		return res, err
	}
	var tr traceResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return res, fmt.Errorf("trace store: unreadable answer: %w", err)
	}
	batches := tr.ResourceSpans
	if tr.Trace != nil {
		batches = tr.Trace.ResourceSpans
	}
	if len(batches) == 0 {
		batches = tr.Batches
	}
	for _, rs := range batches {
		resAttrs := attrMap(rs.Resource.Attributes)
		in := true
		for k, v := range scope {
			if resAttrs[k] != v {
				in = false
			}
		}
		for _, ss := range rs.ScopeSpans {
			for _, s := range ss.Spans {
				res.Total++
				if !in {
					res.Hidden++
					continue
				}
				startNs, endNs := integer(s.StartTimeUnixNano), integer(s.EndTimeUnixNano)
				span := Span{
					SpanID: hexID(s.SpanID), ParentSpanID: hexID(s.ParentSpanID), Name: s.Name,
					Service: resAttrs["service.name"], Namespace: resAttrs[t.cfg.NamespaceAttribute],
					Kind: strings.TrimPrefix(s.Kind, "SPAN_KIND_"), Start: time.Unix(0, startNs).UTC(),
					DurationMs: float64(endNs-startNs) / 1e6, Status: strings.TrimPrefix(s.Status.Code, "STATUS_CODE_"),
					Message: s.Status.Message, Attributes: attrMap(s.Attributes),
				}
				if span.Status == "ERROR" {
					res.Errors++
				}
				res.Spans = append(res.Spans, span)
			}
		}
	}
	if res.Total == 0 {
		return res, ErrNotFound
	}
	sort.SliceStable(res.Spans, func(i, j int) bool {
		ei, ej := res.Spans[i].Status == "ERROR", res.Spans[j].Status == "ERROR"
		if ei != ej {
			return ei
		}
		return res.Spans[i].Start.Before(res.Spans[j].Start)
	})
	if len(res.Spans) > MaxTraceSpans {
		res.Spans, res.Truncated = res.Spans[:MaxTraceSpans], true
	}
	return res, nil
}

// TagsResult lists attribute names by scope (resource, span, intrinsic …),
// or one attribute's values.
type TagsResult struct {
	Scopes    map[string][]string `json:"scopes,omitempty"`
	Tag       string              `json:"tag,omitempty"`
	Values    []string            `json:"values,omitempty"`
	Truncated bool                `json:"truncated"`
}

func (t *tempo) tags(ctx context.Context, scopeName, query string, start, end time.Time) (TagsResult, error) {
	params := url.Values{"q": {query}}
	if scopeName != "" {
		params.Set("scope", scopeName)
	}
	window(params, start, end)
	body, err := t.get(ctx, "/api/v2/search/tags", params)
	if err != nil {
		return TagsResult{}, err
	}
	var tr struct {
		Scopes []struct {
			Name string   `json:"name"`
			Tags []string `json:"tags"`
		} `json:"scopes"`
	}
	if err := json.Unmarshal(body, &tr); err != nil {
		return TagsResult{}, fmt.Errorf("trace store: unreadable answer: %w", err)
	}
	res := TagsResult{Scopes: map[string][]string{}}
	for _, s := range tr.Scopes {
		tags := append([]string{}, s.Tags...)
		sort.Strings(tags)
		if len(tags) > MaxTagValues {
			tags, res.Truncated = tags[:MaxTagValues], true
		}
		res.Scopes[s.Name] = tags
	}
	return res, nil
}

func (t *tempo) tagValues(ctx context.Context, tag, query string, start, end time.Time) (TagsResult, error) {
	params := url.Values{"q": {query}}
	window(params, start, end)
	body, err := t.get(ctx, "/api/v2/search/tag/"+url.PathEscape(tag)+"/values", params)
	if err != nil {
		return TagsResult{}, err
	}
	var vr struct {
		TagValues []struct {
			Value string `json:"value"`
		} `json:"tagValues"`
	}
	if err := json.Unmarshal(body, &vr); err != nil {
		return TagsResult{}, fmt.Errorf("trace store: unreadable answer: %w", err)
	}
	res := TagsResult{Tag: tag, Values: []string{}}
	for _, v := range vr.TagValues {
		res.Values = append(res.Values, v.Value)
	}
	sort.Strings(res.Values)
	if len(res.Values) > MaxTagValues {
		res.Values, res.Truncated = res.Values[:MaxTagValues], true
	}
	return res, nil
}
