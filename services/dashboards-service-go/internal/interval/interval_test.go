package interval

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"
)

func readGzipJSON(t *testing.T, path string, v any) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(z).Decode(v); err != nil {
		t.Fatal(err)
	}
}

// testdata/grafana-13.3.0-prometheus-step.json.gz: Grafana 13.3.0 (its bundled
// Prometheus data source, 13.2.4) answered POST /api/ds/query for every case,
// and a stand-in Prometheus recorded the query_range it sent — step, start,
// end and the query with the built-in variables written in.
func TestPrometheus_AsGrafana(t *testing.T) {
	var data struct {
		Expr  string `json:"expr"`
		Cases []struct {
			From, To       int64
			MaxDataPoints  int64  `json:"maxDataPoints"`
			IntervalMs     int64  `json:"intervalMs"`
			MinStep        string `json:"minStep"`
			ScrapeInterval string `json:"scrapeInterval"`
			IntervalFactor int64  `json:"intervalFactor"`
			UTCOffsetSec   int64  `json:"utcOffsetSec"`
			Step, Start    string
			End, Expr      string
			Error          string
		} `json:"cases"`
	}
	readGzipJSON(t, "testdata/grafana-13.3.0-prometheus-step.json.gz", &data)
	if len(data.Cases) < 3000 {
		t.Fatalf("%d cases", len(data.Cases))
	}
	failed := 0
	for i, c := range data.Cases {
		q := Query{From: time.UnixMilli(c.From), To: time.UnixMilli(c.To), MaxDataPoints: c.MaxDataPoints, IntervalMs: c.IntervalMs,
			MinStep: c.MinStep, IntervalFactor: c.IntervalFactor, ScrapeInterval: c.ScrapeInterval, UTCOffsetSec: c.UTCOffsetSec}
		step, err := q.Step()
		if c.Error != "" {
			if err == nil {
				t.Errorf("case %d (min step %q): Grafana refused it (%s), Step gave %s", i, c.MinStep, c.Error, step)
			}
			continue
		}
		start, end := q.Range(step)
		got := []string{seconds(step), unixSeconds(start), unixSeconds(end), q.Interpolate(data.Expr, step)}
		want := []string{c.Step, c.Start, c.End, c.Expr}
		for k, name := range []string{"step", "start", "end", "query"} {
			if got[k] != want[k] && failed < 20 {
				failed++
				t.Errorf("case %d %+v: %s %q, Grafana sent %q", i, q, name, got[k], want[k])
			}
		}
	}
}

// seconds and unixSeconds are how the data source writes step, start and end
// (strconv.FormatFloat, client.go).
func seconds(d time.Duration) string { return strconv.FormatFloat(d.Seconds(), 'f', -1, 64) }

func unixSeconds(t time.Time) string {
	return strconv.FormatFloat(float64(t.Unix())+float64(t.Nanosecond())/1e9, 'f', -1, 64)
}

// testdata/grafana-13.3.0-screen-interval.json.gz: Grafana 13.3.0's own
// rangeutil.calculateInterval (packages/grafana-data, Apache-2.0), run in node
// with its types taken out, for every range, resolution and low limit.
func TestScreen_AsGrafana(t *testing.T) {
	var data struct {
		Cases []struct {
			RangeMs    int64   `json:"rangeMs"`
			Resolution int64   `json:"resolution"`
			LowLimit   string  `json:"lowLimit"`
			IntervalMs float64 `json:"intervalMs"`
			Interval   string  `json:"interval"`
		} `json:"cases"`
	}
	readGzipJSON(t, "testdata/grafana-13.3.0-screen-interval.json.gz", &data)
	if len(data.Cases) < 1000 {
		t.Fatalf("%d cases", len(data.Cases))
	}
	for _, c := range data.Cases {
		ms, text, err := Screen(c.RangeMs, c.Resolution, c.LowLimit)
		if err != nil || float64(ms) != c.IntervalMs || text != c.Interval {
			t.Errorf("Screen(%d, %d, %q) = %d %q %v, Grafana %v %q", c.RangeMs, c.Resolution, c.LowLimit, ms, text, err, c.IntervalMs, c.Interval)
		}
	}
}

// One readable case of each: a one-hour panel 1 500 points wide on a data
// source scraped every 15 s.
func TestPrometheus_OneHourPanel(t *testing.T) {
	to := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	ms, text, _ := Screen(3600000, 1500, "15s")
	if ms != 15000 || text != "15s" {
		t.Fatalf("screen interval %d %q, want 15000 15s", ms, text)
	}
	q := Query{From: to.Add(-time.Hour), To: to, MaxDataPoints: 1500, IntervalMs: ms, ScrapeInterval: "15s"}
	step, err := q.Step()
	if err != nil || step != 15*time.Second {
		t.Fatalf("step %s %v, want 15s", step, err)
	}
	if got := q.Interpolate("rate(x[$__rate_interval]) $__interval $__range", step); got != "rate(x[1m0s]) 15s 3600s" {
		t.Errorf("interpolated %q", got)
	}
	q.MinStep = "$__rate_interval"
	if step, _ := q.Step(); step != time.Minute {
		t.Errorf("step with min step $__rate_interval %s, want 1m (15s + 15s, at least 4 × 15s)", step)
	}
}

func TestPrometheus_BadMinStep(t *testing.T) {
	q := Query{From: time.Unix(0, 0), To: time.Unix(3600, 0), MaxDataPoints: 500, MinStep: "abc"}
	if _, err := q.Step(); err == nil {
		t.Error("a min step that is no duration should be refused, as Grafana does")
	}
	if _, _, err := Screen(3600000, 500, "abc"); err == nil {
		t.Error("a low limit that is no interval should be refused, as rangeutil throws")
	}
}
