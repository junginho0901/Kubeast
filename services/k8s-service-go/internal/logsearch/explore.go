package logsearch

import (
	"context"
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

// ErrNotServed is a store that does not offer the API asked for (Loki's
// patterns without pattern_ingester.enabled answer 404).
var ErrNotServed = errors.New("not served by this log store")

// MaxLabelValues caps a label value list; MaxPatterns the patterns returned.
const (
	MaxLabelValues = 200
	MaxPatterns    = 50
	maxPatternText = 500
)

// LabelsResult is a list of label names (Label empty) or of one label's values.
type LabelsResult struct {
	Label     string   `json:"label,omitempty"`
	Values    []string `json:"values"`
	Truncated bool     `json:"truncated"`
	Selector  string   `json:"selector"`
}

// Pattern is one log pattern Loki's pattern ingester found: the line shape
// (variable parts as <_>), how many lines had it and when it was first and
// last seen in the range.
type Pattern struct {
	Pattern string    `json:"pattern"`
	Count   int64     `json:"count"`
	First   time.Time `json:"first"`
	Last    time.Time `json:"last"`
	Level   string    `json:"level,omitempty"`
}

// PatternsResult is the most frequent patterns, most lines first.
type PatternsResult struct {
	Patterns       []Pattern `json:"patterns"`
	Total          int       `json:"total"`
	Truncated      bool      `json:"truncated"`
	EffectiveQuery string    `json:"effectiveQuery"`
}

type matrixResponse struct {
	Data struct {
		Result []struct {
			Metric map[string]string    `json:"metric"`
			Values [][2]json.RawMessage `json:"values"`
		} `json:"result"`
	} `json:"data"`
}

// readMatrix reads a metric query's answer: at most MaxSeries series, the
// rest counted as Truncated. A step with no sample has no point.
func readMatrix(body []byte, query string, step time.Duration) (Result, error) {
	var mr matrixResponse
	if err := json.Unmarshal(body, &mr); err != nil {
		return Result{Query: query}, fmt.Errorf("log store: unreadable answer: %w", err)
	}
	res := Result{Query: query, ResultType: "matrix", Lines: []Line{}, Series: []Series{}, StepSeconds: int64(step / time.Second)}
	for _, s := range mr.Data.Result {
		if len(res.Series) == MaxSeries {
			res.Truncated = true
			break
		}
		series := Series{Metric: s.Metric, Points: make([]Point, 0, len(s.Values))}
		for _, v := range s.Values {
			var t float64
			var raw string
			if json.Unmarshal(v[0], &t) != nil || json.Unmarshal(v[1], &raw) != nil {
				continue
			}
			f, err := strconv.ParseFloat(raw, 64)
			if err != nil {
				continue
			}
			series.Points = append(series.Points, Point{T: t, V: f})
		}
		res.Series = append(res.Series, series)
	}
	return res, nil
}

// getJSON asks store for path and reads a 200 answer's body; 404 is ErrNotServed.
func (l *loki) getJSON(ctx context.Context, store Store, path string, params url.Values) ([]byte, error) {
	resp, err := l.get(ctx, store, path, params)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
			return nil, ErrTimeout
		}
		return nil, fmt.Errorf("log store: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("log store: %w", err)
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, ErrNotServed
	case resp.StatusCode != http.StatusOK:
		msg := strings.TrimSpace(string(body))
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, &StoreError{Status: resp.StatusCode, Body: msg}
	}
	return body, nil
}

// labels lists label names (name empty) or name's values on the streams
// selector matches in [start, end].
func (l *loki) labels(ctx context.Context, store Store, name, selector string, start, end time.Time) (LabelsResult, error) {
	params := url.Values{}
	params.Set("query", selector)
	params.Set("start", strconv.FormatInt(start.UnixNano(), 10))
	params.Set("end", strconv.FormatInt(end.UnixNano(), 10))
	path := "/loki/api/v1/labels"
	if name != "" {
		path = "/loki/api/v1/label/" + url.PathEscape(name) + "/values"
	}
	body, err := l.getJSON(ctx, store, path, params)
	if err != nil {
		return LabelsResult{}, err
	}
	var lr struct {
		Data []string `json:"data"`
	}
	if err := json.Unmarshal(body, &lr); err != nil {
		return LabelsResult{}, fmt.Errorf("log store: unreadable answer: %w", err)
	}
	res := LabelsResult{Label: name, Values: []string{}, Selector: selector}
	for _, v := range lr.Data {
		if name == "" && strings.HasPrefix(v, "__") {
			continue // Loki's own (__stream_shard__ …), not a label anyone queries
		}
		res.Values = append(res.Values, v)
	}
	sort.Strings(res.Values)
	if len(res.Values) > MaxLabelValues {
		res.Values, res.Truncated = res.Values[:MaxLabelValues], true
	}
	return res, nil
}

// patterns asks store's pattern ingester for the patterns of query's streams
// in [start, end], most lines first.
func (l *loki) patterns(ctx context.Context, store Store, query string, start, end time.Time) (PatternsResult, error) {
	params := url.Values{}
	params.Set("query", query)
	params.Set("start", strconv.FormatInt(start.UnixNano(), 10))
	params.Set("end", strconv.FormatInt(end.UnixNano(), 10))
	body, err := l.getJSON(ctx, store, "/loki/api/v1/patterns", params)
	if err != nil {
		return PatternsResult{}, err
	}
	var pr struct {
		Data []struct {
			Pattern string           `json:"pattern"`
			Level   string           `json:"level"`
			Samples [][2]json.Number `json:"samples"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &pr); err != nil {
		return PatternsResult{}, fmt.Errorf("log store: unreadable answer: %w", err)
	}
	res := PatternsResult{Patterns: []Pattern{}, Total: len(pr.Data), EffectiveQuery: query}
	for _, d := range pr.Data {
		p := Pattern{Pattern: d.Pattern, Level: d.Level}
		if r := []rune(p.Pattern); len(r) > maxPatternText {
			p.Pattern = string(r[:maxPatternText]) + "…"
		}
		for _, s := range d.Samples {
			ts, err1 := s[0].Int64()
			n, err2 := s[1].Int64()
			if err1 != nil || err2 != nil {
				continue
			}
			t := time.Unix(ts, 0).UTC()
			if p.First.IsZero() || t.Before(p.First) {
				p.First = t
			}
			if t.After(p.Last) {
				p.Last = t
			}
			p.Count += n
		}
		res.Patterns = append(res.Patterns, p)
	}
	sort.SliceStable(res.Patterns, func(i, j int) bool { return res.Patterns[i].Count > res.Patterns[j].Count })
	if len(res.Patterns) > MaxPatterns {
		res.Patterns, res.Truncated = res.Patterns[:MaxPatterns], true
	}
	return res, nil
}
