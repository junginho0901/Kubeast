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
}

// ErrTimeout marks a search the store did not answer in time.
var ErrTimeout = errors.New("log store did not answer in time")

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

func (l *loki) search(ctx context.Context, req Request, clusterValue string) (Result, error) {
	query := l.cfg.LogQL(req, clusterValue)
	params := url.Values{}
	params.Set("query", query)
	params.Set("start", strconv.FormatInt(req.Start.UnixNano(), 10))
	params.Set("end", strconv.FormatInt(req.End.UnixNano(), 10))
	params.Set("limit", strconv.Itoa(req.Limit))
	direction := "backward"
	if req.Forward {
		direction = "forward"
	}
	params.Set("direction", direction)

	hreq, err := http.NewRequestWithContext(ctx, http.MethodGet, l.cfg.URL+"/loki/api/v1/query_range?"+params.Encode(), nil)
	if err != nil {
		return Result{Query: query}, err
	}
	hreq.Header.Set("Accept", "application/json")
	if l.cfg.AuthHeader != "" {
		hreq.Header.Set("Authorization", l.cfg.AuthHeader)
	}
	if l.cfg.Tenant != "" {
		hreq.Header.Set("X-Scope-OrgID", l.cfg.Tenant)
	}
	resp, err := l.http.Do(hreq)
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
	var lr lokiResponse
	if err := json.Unmarshal(body, &lr); err != nil {
		return Result{Query: query}, fmt.Errorf("log store: unreadable answer: %w", err)
	}
	if lr.Data.ResultType != "streams" {
		return Result{Query: query}, fmt.Errorf("log store: expected streams, got %q", lr.Data.ResultType)
	}

	res := Result{Query: query, Bytes: lr.Data.Stats.Summary.TotalBytesProcessed, Lines: []Line{}}
	for _, s := range lr.Data.Result {
		for _, v := range s.Values {
			ns, err := strconv.ParseInt(v[0], 10, 64)
			if err != nil {
				continue
			}
			res.Lines = append(res.Lines, Line{
				TS:        time.Unix(0, ns).UTC(),
				Namespace: s.Stream[l.cfg.Labels.Namespace],
				Pod:       s.Stream[l.cfg.Labels.Pod],
				Container: s.Stream[l.cfg.Labels.Container],
				Line:      v[1],
			})
		}
	}
	// Loki applies the limit across streams but returns them stream by stream.
	sort.SliceStable(res.Lines, func(i, j int) bool {
		if req.Forward {
			return res.Lines[i].TS.Before(res.Lines[j].TS)
		}
		return res.Lines[i].TS.After(res.Lines[j].TS)
	})
	if len(res.Lines) > req.Limit {
		res.Lines = res.Lines[:req.Limit]
	}
	res.Truncated = len(res.Lines) == req.Limit
	if n := len(res.Lines); n > 0 {
		first, last := res.Lines[0].TS, res.Lines[n-1].TS
		if req.Forward {
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
