package handler

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/callgraph"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
)

// fixedCalls is fakeCalls that also reads at a fixed time, as *k8s.Service does, and keeps the times it was asked.
type fixedCalls struct {
	*fakeCalls
	mu      sync.Mutex
	at      []time.Time
	between [][2]time.Time
	plain   int
}

func (f *fixedCalls) PrometheusQuery(ctx context.Context, q string) ([]k8s.PrometheusQueryResult, error) {
	f.mu.Lock()
	f.plain++
	f.mu.Unlock()
	return f.fakeCalls.PrometheusQuery(ctx, q)
}

func (f *fixedCalls) PrometheusLabels(ctx context.Context, label, selector string, since time.Duration, limit int) ([]string, error) {
	f.mu.Lock()
	f.plain++
	f.mu.Unlock()
	return f.fakeCalls.PrometheusLabels(ctx, label, selector, since, limit)
}

func (f *fixedCalls) PrometheusQueryAt(ctx context.Context, q string, at time.Time) ([]k8s.PrometheusQueryResult, error) {
	f.mu.Lock()
	f.at = append(f.at, at)
	f.mu.Unlock()
	return f.fakeCalls.PrometheusQuery(ctx, q)
}

func (f *fixedCalls) PrometheusLabelsBetween(ctx context.Context, label, selector string, start, end time.Time, limit int) ([]string, error) {
	f.mu.Lock()
	f.between = append(f.between, [2]time.Time{start, end})
	f.mu.Unlock()
	return f.fakeCalls.PrometheusLabels(ctx, label, selector, end.Sub(start), limit)
}

func TestCallWindowOf(t *testing.T) {
	now := time.Date(2026, 11, 15, 1, 30, 0, 0, time.UTC)
	at := func(s string) time.Time { v, _ := time.Parse(time.RFC3339, s); return v }
	for _, c := range []struct {
		rng, start, end string
		want            promWindow
	}{
		{"", "", "", promWindow{Range: time.Hour}},
		{"30m", "", "", promWindow{Range: 30 * time.Minute}},
		{"", "2026-11-15T00:30:00Z", "2026-11-15T01:00:00Z", promWindow{Range: 30 * time.Minute, End: at("2026-11-15T01:00:00Z")}},
		// an end past now is now; a start alone ends now
		{"", "2026-11-15T01:00:00Z", "2026-11-15T03:00:00Z", promWindow{Range: 30 * time.Minute, End: now}},
		{"", "2026-11-15T00:00:00Z", "", promWindow{Range: 90 * time.Minute, End: now}},
		// an end with a range: the range back from that end
		{"15m", "", "2026-11-15T01:00:00Z", promWindow{Range: 15 * time.Minute, End: at("2026-11-15T01:00:00Z")}},
	} {
		got, err := callWindowOf(c.rng, c.start, c.end, now)
		if err != nil || got != c.want {
			t.Fatalf("%q %q %q: %+v %v, want %+v", c.rng, c.start, c.end, got, err, c.want)
		}
	}
	for _, c := range [][3]string{
		{"30m", "2026-11-15T00:30:00Z", ""},                  // range or start
		{"", "yesterday", ""},                                // not RFC3339
		{"", "", "soon"},                                     // not RFC3339
		{"", "2026-11-15T01:00:00Z", "2026-11-15T00:30:00Z"}, // start after end
		{"", "2026-11-15T01:29:30Z", ""},                     // under a minute
		{"", "2026-11-14T00:00:00Z", "2026-11-15T01:00:00Z"}, // over a day
		{"3d", "", "2026-11-15T01:00:00Z"},                   // the range's own bounds
	} {
		if _, err := callWindowOf(c[0], c[1], c[2], now); err == nil {
			t.Fatalf("%q accepted", c)
		}
	}
}

// A fixed window reads every series at its end and the label names over it; the answer says the window.
func TestResourceGraphCallsReadAFixedWindowAtItsEnd(t *testing.T) {
	src := &fixedCalls{fakeCalls: callsSource()}
	h := &Handler{netdropsSrc: src, cfg: config.Config{CallGraphEnabled: true}}
	end := time.Date(2026, 11, 15, 1, 0, 0, 0, time.UTC)
	req := logSearchRequestAs("/api/v1/namespaces/shop/resource-graph?include=calls&start=2026-11-15T00:30:00Z&end=2026-11-15T01:00:00Z", "self", "shop", flowReader)
	res, err := h.callsIn(req, "shop", callsGraph, promWindow{Range: 30 * time.Minute, End: end}, src, true)
	if err != nil || !res.Available || res.Range != "30m0s" || res.Window == nil || res.Window.Start != "2026-11-15T00:30:00Z" || res.Window.End != "2026-11-15T01:00:00Z" {
		t.Fatalf("%+v %v", res, err)
	}
	if src.plain != 0 || len(src.at) != len(src.queries) || len(src.at) == 0 {
		t.Fatalf("reads not at the window's end: plain %d at %v queries %v", src.plain, src.at, src.queries)
	}
	for _, a := range src.at {
		if !a.Equal(end) {
			t.Fatalf("read at %s", a)
		}
	}
	for _, b := range src.between {
		if !b[0].Equal(end.Add(-30*time.Minute)) || !b[1].Equal(end) {
			t.Fatalf("labels over %v", b)
		}
	}
	for _, q := range src.queries {
		if !strings.Contains(q, "[1800s]") {
			t.Fatalf("range: %s", q)
		}
	}
	if len(res.Suspects) != 2 || res.Suspects[0].ID != "Deployment/shop/api" || src.count(callgraph.ServerSeconds) != 1 {
		t.Fatalf("suspects %+v queries %v", res.Suspects, src.queries)
	}

	// without a window the reads end now, as before: the answer has no window
	src = &fixedCalls{fakeCalls: callsSource()}
	h.netdropsSrc = src
	res, err = h.resourceGraphCalls(logSearchRequestAs("/api/v1/namespaces/shop/resource-graph?include=calls", "self", "shop", flowReader), "shop", callsGraph, "")
	if err != nil || res.Window != nil || len(src.at) != 0 || len(src.between) != 0 || src.plain == 0 {
		t.Fatalf("%+v %v at %v between %v", res, err, src.at, src.between)
	}
}

// A source that cannot read at a fixed time is not read for a fixed window: both sources say why.
func TestResourceGraphCallsFixedWindowNeedsASourceThatReadsAtATime(t *testing.T) {
	src := callsSource()
	h := &Handler{netdropsSrc: src, cfg: config.Config{CallGraphEnabled: true}}
	res, err := h.callsIn(logSearchRequestAs("/", "self", "shop", flowReader), "shop", callsGraph,
		promWindow{Range: time.Hour, End: time.Date(2026, 11, 15, 1, 0, 0, 0, time.UTC)}, src, true)
	if err != nil || len(src.queries) != 0 {
		t.Fatalf("%v queries %v", err, src.queries)
	}
	for _, st := range res.Sources {
		if st.Read || st.Reason != callgraph.ReasonFailed || !strings.Contains(st.Detail, errNoFixedWindow.Error()) {
			t.Fatalf("source %+v", st)
		}
	}
	if !errors.Is(errNoFixedWindow, errNoFixedWindow) {
		t.Fatal("sentinel")
	}
}
