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

// Line is one log line with the stream it came from.
type Line struct {
	TS        time.Time `json:"ts"`
	Namespace string    `json:"namespace"`
	Pod       string    `json:"pod"`
	Container string    `json:"container"`
	Line      string    `json:"line"`
	// Service and TraceID come from the stream's labels (Loki returns a line's
	// structured metadata with them) or, for the trace ID, the line text.
	Service string `json:"service,omitempty"`
	TraceID string `json:"traceId,omitempty"`
}

// Result is a page of lines, newest first unless the request was forward.
// Truncated means the store had more in the range: ask again with End (or
// Start, going forward) set to Oldest (Newest).
type Result struct {
	Lines     []Line    `json:"lines"`
	Truncated bool      `json:"truncated"`
	Oldest    time.Time `json:"oldest,omitempty"`
	Newest    time.Time `json:"newest,omitempty"`
	Bytes     int64     `json:"bytes"`
	Query     string    `json:"-"`
	// EffectiveQuery is the LogQL actually sent for a query someone wrote
	// (Searcher.Query): theirs with the cluster and namespace matchers added.
	EffectiveQuery string `json:"effectiveQuery,omitempty"`
	// ResultType is set for a query run with QueryRequest.Metric: "streams"
	// (Lines) or "matrix" (Series, at most MaxSeries, Truncated past it).
	ResultType  string   `json:"resultType,omitempty"`
	Series      []Series `json:"series,omitempty"`
	StepSeconds int64    `json:"stepSeconds,omitempty"`
}

// Series is one series of a metric query, in the shape of a Prometheus range
// result: its labels and [unix seconds, value] points.
type Series struct {
	Metric map[string]string `json:"metric"`
	Points []Point           `json:"points"`
}

// Point is one sample of a Series.
type Point struct {
	T float64 `json:"t"`
	V float64 `json:"v"`
}

// MaxSeries caps a metric query's series.
const MaxSeries = 100

// ErrTimeout marks a search the store did not answer in time.
var ErrTimeout = errors.New("log store did not answer in time")

// ErrNotLogQuery is a query the store answered with samples, not log lines.
var ErrNotLogQuery = errors.New("only log queries are run here, not metric queries")

// StoreError is a non-200 answer from the store.
type StoreError struct {
	Status int
	Body   string
}

func (e *StoreError) Error() string {
	return fmt.Sprintf("log store answered %d: %s", e.Status, e.Body)
}

// loki reads /loki/api/v1/query_range.
type loki struct {
	cfg  Config
	http *http.Client
}

func newLoki(cfg Config) *loki {
	return &loki{cfg: cfg, http: &http.Client{Timeout: cfg.Timeout}}
}

type lokiResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Stream map[string]string `json:"stream"`
			Values [][2]string       `json:"values"`
		} `json:"result"`
		Stats struct {
			Summary struct {
				TotalBytesProcessed int64 `json:"totalBytesProcessed"`
			} `json:"summary"`
		} `json:"stats"`
	} `json:"data"`
}

// get asks store for path with the store's headers.
func (l *loki) get(ctx context.Context, store Store, path string, params url.Values) (*http.Response, error) {
	hreq, err := http.NewRequestWithContext(ctx, http.MethodGet, store.URL+path+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	hreq.Header.Set("Accept", "application/json")
	if store.AuthHeader != "" {
		hreq.Header.Set("Authorization", store.AuthHeader)
	}
	if store.Tenant != "" {
		hreq.Header.Set("X-Scope-OrgID", store.Tenant)
	}
	return l.http.Do(hreq)
}

// healthy asks store for its label names over the last five minutes: a 200
// means the URL, the credentials and the tenant all work.
func (l *loki) healthy(ctx context.Context, store Store) (bool, string) {
	now := time.Now()
	params := url.Values{}
	params.Set("start", strconv.FormatInt(now.Add(-5*time.Minute).UnixNano(), 10))
	params.Set("end", strconv.FormatInt(now.UnixNano(), 10))
	resp, err := l.get(ctx, store, "/loki/api/v1/labels", params)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
			return false, ErrTimeout.Error()
		}
		return false, err.Error()
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusOK {
		return false, (&StoreError{Status: resp.StatusCode, Body: strings.TrimSpace(string(body))}).Error()
	}
	return true, ""
}

// search runs a structured request: the query is built from its filters.
func (l *loki) search(ctx context.Context, req Request, store Store, clusterValue string) (Result, error) {
	return l.run(ctx, store, l.cfg.LogQL(req, clusterValue), req.Start, req.End, req.Limit, req.Forward)
}

// run sends query to store's query_range and reads the streams back.
func (l *loki) run(ctx context.Context, store Store, query string, start, end time.Time, limit int, forward bool) (Result, error) {
	return l.rangeQuery(ctx, store, query, start, end, limit, forward, 0, false)
}

// rangeQuery is run that, with metric, also reads a metric query's samples
// (at step, when set) instead of refusing them.
func (l *loki) rangeQuery(ctx context.Context, store Store, query string, start, end time.Time, limit int, forward bool, step time.Duration, metric bool) (Result, error) {
	params := url.Values{}
	params.Set("query", query)
	params.Set("start", strconv.FormatInt(start.UnixNano(), 10))
	params.Set("end", strconv.FormatInt(end.UnixNano(), 10))
	params.Set("limit", strconv.Itoa(limit))
	direction := "backward"
	if forward {
		direction = "forward"
	}
	params.Set("direction", direction)
	if step > 0 {
		params.Set("step", strconv.FormatInt(int64(step/time.Second), 10))
	}

	resp, err := l.get(ctx, store, "/loki/api/v1/query_range", params)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
			return Result{Query: query}, ErrTimeout
		}
		return Result{Query: query}, fmt.Errorf("log store: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return Result{Query: query}, fmt.Errorf("log store: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		msg := strings.TrimSpace(string(body))
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return Result{Query: query}, &StoreError{Status: resp.StatusCode, Body: msg}
	}
	// the kind first: a metric query's samples are [number, string] pairs,
	// which the streams shape would not read
	var kind struct {
		Data struct {
			ResultType string `json:"resultType"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &kind); err != nil {
		return Result{Query: query}, fmt.Errorf("log store: unreadable answer: %w", err)
	}
	if metric && kind.Data.ResultType == "matrix" {
		return readMatrix(body, query, step)
	}
	if kind.Data.ResultType != "streams" {
		return Result{Query: query}, fmt.Errorf("%w (the store answered with %q)", ErrNotLogQuery, kind.Data.ResultType)
	}
	var lr lokiResponse
	if err := json.Unmarshal(body, &lr); err != nil {
		return Result{Query: query}, fmt.Errorf("log store: unreadable answer: %w", err)
	}

	res := Result{Query: query, Bytes: lr.Data.Stats.Summary.TotalBytesProcessed, Lines: []Line{}}
	if metric {
		res.ResultType = "streams"
	}
	for _, s := range lr.Data.Result {
		for _, v := range s.Values {
			ns, err := strconv.ParseInt(v[0], 10, 64)
			if err != nil {
				continue
			}
			line := Line{
				TS:        time.Unix(0, ns).UTC(),
				Namespace: s.Stream[l.cfg.Labels.Namespace],
				Pod:       s.Stream[l.cfg.Labels.Pod],
				Container: s.Stream[l.cfg.Labels.Container],
				Line:      v[1],
			}
			if l.cfg.Labels.Service != "" {
				line.Service = s.Stream[l.cfg.Labels.Service]
			}
			if l.cfg.TraceID != nil {
				line.TraceID = l.cfg.TraceID(s.Stream, v[1])
			}
			res.Lines = append(res.Lines, line)
		}
	}
	// Loki applies the limit across streams but returns them stream by stream.
	sort.SliceStable(res.Lines, func(i, j int) bool {
		if forward {
			return res.Lines[i].TS.Before(res.Lines[j].TS)
		}
		return res.Lines[i].TS.After(res.Lines[j].TS)
	})
	if len(res.Lines) > limit {
		res.Lines = res.Lines[:limit]
	}
	res.Truncated = len(res.Lines) == limit
	if n := len(res.Lines); n > 0 {
		first, last := res.Lines[0].TS, res.Lines[n-1].TS
		if forward {
			res.Oldest, res.Newest = first, last
		} else {
			res.Oldest, res.Newest = last, first
		}
	}
	return res, nil
}

func isTimeout(err error) bool {
	var t interface{ Timeout() bool }
	return errors.As(err, &t) && t.Timeout()
}
