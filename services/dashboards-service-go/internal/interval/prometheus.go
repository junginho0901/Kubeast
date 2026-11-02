package interval

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Query is a Prometheus range query as the data source gets it.
type Query struct {
	From, To       time.Time
	MaxDataPoints  int64  // the points the panel draws: its width, or its max data points
	IntervalMs     int64  // what the screen asked for (Screen)
	MinStep        string // the query's min step: a duration, a bare number of seconds, <10m>, or a variable such as $__rate_interval
	IntervalFactor int64  // the old resolution factor; 0 is 1
	ScrapeInterval string // the data source's scrape interval; "" is 15s
	UTCOffsetSec   int64  // the dashboard's offset, which start and end are aligned in
}

const (
	safeResolution    = 11000 // the most points a range query asks for
	defaultResolution = 1500  // max data points when the query has none
	defaultMinStep    = 15 * time.Second
)

// Step is the step the data source sends (CalculatePrometheusInterval): the
// range over the points, at least the min step (the query's, else the screen's
// interval, else the scrape interval), rounded, and coarse enough for 11 000
// points. A min step of $__rate_interval makes the step the rate interval.
func (q Query) Step() (time.Duration, error) {
	minStep := q.MinStep
	if isVariable(minStep) {
		minStep = ""
	}
	low, err := minInterval(q.ScrapeInterval, minStep, q.IntervalMs)
	if err != nil {
		return 0, err
	}
	span := q.To.UnixNano() - q.From.UnixNano()
	resolution := q.MaxDataPoints
	if resolution == 0 {
		resolution = defaultResolution
	}
	step := time.Duration(span / resolution)
	if step < low {
		step = low
	} else {
		step = round(step)
	}
	if safe := round(time.Duration(span / safeResolution)); safe > step {
		step = safe
	}
	if isRate(q.MinStep) {
		return rateInterval(step, q.ScrapeInterval), nil
	}
	factor := q.IntervalFactor
	if factor == 0 {
		factor = 1
	}
	return time.Duration(int64(step) * factor), nil
}

// Interpolate writes the built-in interval and range variables into expr as
// the data source does (InterpolateVariables): $__interval and _ms from the
// step, $__range, _s and _ms from the range, $__rate_interval and _ms from the
// screen's interval and the min step (the step itself when the min step is
// $__rate_interval).
func (q Query) Interpolate(expr string, step time.Duration) string {
	rangeMs := q.To.Sub(q.From).Milliseconds()
	rangeS := int64(math.Round(float64(rangeMs) / 1000.0))
	var rate time.Duration
	switch requested := q.MinStep; requested {
	case "$__rate_interval", "${__rate_interval}":
		rate = step
	default:
		if requested == "$__interval" || requested == "${__interval}" {
			requested = step.String()
		}
		if requested == "" {
			requested = q.ScrapeInterval
		}
		rate = rateInterval(time.Duration(q.IntervalMs)*time.Millisecond, requested)
	}
	for _, r := range []struct{ name, value string }{
		{"__interval_ms", strconv.FormatInt(int64(step/time.Millisecond), 10)},
		{"__interval", format(step)},
		{"__range_ms", strconv.FormatInt(rangeMs, 10)},
		{"__range_s", strconv.FormatInt(rangeS, 10)},
		{"__range", strconv.FormatInt(rangeS, 10) + "s"},
		{"__rate_interval_ms", strconv.FormatInt(int64(rate/time.Millisecond), 10)},
		{"__rate_interval", rate.String()},
	} {
		expr = strings.ReplaceAll(expr, "$"+r.name, r.value)
		expr = strings.ReplaceAll(expr, "${"+r.name+"}", r.value)
	}
	return expr
}

// Range is the query's start and end as the data source sends them: each
// rounded down to a multiple of the step in the dashboard's offset
// (AlignTimeRange, in floating point as there).
func (q Query) Range(step time.Duration) (start, end time.Time) {
	align := func(t time.Time) time.Time {
		offset := float64(q.UTCOffsetSec * 1e9)
		s := float64(step.Nanoseconds())
		return time.Unix(0, int64(math.Floor((float64(t.UnixNano())+offset)/s)*s-offset)).UTC()
	}
	return align(q.From), align(q.To)
}

func isRate(s string) bool {
	switch s {
	case "$__rate_interval", "${__rate_interval}", "$__rate_interval_ms", "${__rate_interval_ms}":
		return true
	}
	return false
}

func isVariable(s string) bool {
	switch s {
	case "$__interval", "${__interval}", "$__interval_ms", "${__interval_ms}":
		return true
	}
	return isRate(s)
}

// rateInterval is the rate interval for a step (calculateRateInterval): the
// step plus one scrape interval, at least four scrape intervals. A scrape
// interval that does not parse gives 0, as there.
func rateInterval(step time.Duration, scrape string) time.Duration {
	if scrape == "" {
		scrape = "15s"
	}
	d, err := parseInterval(scrape)
	if err != nil {
		return 0
	}
	if r := step + d; r > 4*d {
		return r
	}
	return 4 * d
}

// minInterval is gtime.GetIntervalFrom: the query's min step ("0s" is none),
// else the screen's interval, else the data source's, else 15s.
func minInterval(scrape, minStep string, intervalMs int64) (time.Duration, error) {
	if minStep == "0s" {
		minStep = ""
	}
	if minStep == "" && intervalMs != 0 {
		return time.Duration(intervalMs) * time.Millisecond, nil
	}
	if minStep == "" {
		minStep = scrape
	}
	if minStep == "" {
		return defaultMinStep, nil
	}
	return parseInterval(minStep)
}

// parseInterval is gtime.ParseIntervalStringToTimeDuration: <10m> as 10m, a
// bare number as seconds, else a duration with Grafana's d, w, M and y.
func parseInterval(s string) (time.Duration, error) {
	if s == "" {
		return 0, fmt.Errorf("invalid interval")
	}
	s = strings.TrimSuffix(strings.TrimPrefix(s, "<"), ">")
	if allDigits(s) {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return 0, err
		}
		return time.Duration(n) * time.Second, nil
	}
	return parseDuration(s)
}

var dateUnit = regexp.MustCompile(`^(\d+)([dwMy])$`)

// parseDuration is gtime.ParseDuration: d, w, M and y of fixed length (a year
// of 365.25 days, a month a twelfth of it), anything else time.ParseDuration.
func parseDuration(s string) (time.Duration, error) {
	m := dateUnit.FindStringSubmatch(s)
	if m == nil {
		return time.ParseDuration(s)
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, err
	}
	const day = 24 * time.Hour
	year := time.Duration(float64(day) * 365.25)
	unit := map[string]time.Duration{"d": day, "w": 7 * day, "M": time.Duration(float64(year) / 12), "y": year}[m[2]]
	return time.Duration(n) * unit, nil
}

func allDigits(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return s != ""
}

// format is gtime.FormatInterval: the largest whole unit only (a year of 365
// days here).
func format(d time.Duration) string {
	for _, u := range []struct {
		d    time.Duration
		name string
	}{{365 * 24 * time.Hour, "y"}, {24 * time.Hour, "d"}, {time.Hour, "h"}, {time.Minute, "m"}, {time.Second, "s"}, {time.Millisecond, "ms"}} {
		if d >= u.d {
			return strconv.FormatInt(int64(d/u.d), 10) + u.name
		}
	}
	return "1ms"
}

// round is gtime.RoundInterval: a familiar length at or below the interval.
func round(d time.Duration) time.Duration {
	for _, s := range roundSteps {
		upTo := time.Duration(s.upTo) * time.Millisecond
		if (s.inclusive && d <= upTo) || (!s.inclusive && d < upTo) {
			return time.Duration(s.to) * time.Millisecond
		}
	}
	return 31536000000 * time.Millisecond // 1y
}

var roundSteps = []struct {
	upTo, to  int64
	inclusive bool
}{
	{10, 1, true}, {15, 10, true}, {35, 20, true}, {75, 50, true}, {150, 100, true}, {350, 200, true},
	{750, 500, true}, {1500, 1000, true}, {3500, 2000, true}, {7500, 5000, true}, {12500, 10000, true},
	{17500, 15000, true}, {25000, 20000, true}, {45000, 30000, true}, {90000, 60000, true},
	{210000, 120000, true}, {450000, 300000, true}, {750000, 600000, true}, {1050000, 900000, true},
	{1500000, 1200000, true}, {2700000, 1800000, true}, {5400000, 3600000, true}, {9000000, 7200000, true},
	{16200000, 10800000, true}, {32400000, 21600000, true}, {86400000, 43200000, true},
	{172800000, 86400000, true}, {604800000, 86400000, true}, {1814400000, 604800000, true},
	{63072000000, 2592000000, false},
}
