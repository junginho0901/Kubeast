// Package interval works out the interval of a panel's query the way Grafana
// does: the interval the screen asks for, and the step, built-in variables and
// aligned range the Prometheus data source makes of it.
//
// The rules are read from Grafana and written anew: the screen's from
// @grafana/data rangeutil (Apache-2.0, v13.3.0), the data source's from
// grafana-prometheus-datasource promlib (v13.2.4, which Grafana 13.3.0
// bundles; the same in v13.2.5) and the plugin SDK's gtime (Apache-2.0,
// v0.297.0; the same in v0.298.0). The tests hold both to what Grafana 13.3.0
// answers.
package interval

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Screen is the interval a panel's query asks for (rangeutil.calculateInterval):
// the range over the points the panel draws, rounded to a familiar length, and
// never below lowLimit — the panel's min interval, else the data source's
// scrape interval. Grafana sends it as intervalMs, and as text for $__interval
// on the screen.
func Screen(rangeMs, maxDataPoints int64, lowLimit string) (int64, string, error) {
	low := 1.0
	if lowLimit != "" {
		ms, err := screenMs(lowLimit)
		if err != nil {
			return 0, "", err
		}
		low = ms
	}
	ms := screenRound(float64(rangeMs) / float64(maxDataPoints))
	if low > ms {
		ms = low
	}
	return int64(ms), secondsToHms(ms / 1000), nil
}

// screenMs is rangeutil.intervalToMs: a plain number is seconds (its whole
// part, as parseInt reads it); otherwise the leading number's whole part in
// its unit, whatever follows.
func screenMs(s string) (float64, error) {
	if screenNumber.MatchString(s) {
		if n, _ := strconv.ParseFloat(strings.TrimSpace(s), 64); n != 0 {
			return 1000 * float64(int64(n)), nil
		}
	}
	m := screenUnit.FindStringSubmatch(s)
	if m == nil {
		return 0, fmt.Errorf("invalid interval %q: a number with a unit (ms, s, m, h, d, w, M, y) or a bare number of seconds", s)
	}
	count, _ := strconv.ParseInt(strings.SplitN(m[1], ".", 2)[0], 10, 64)
	return screenUnits[m[2]] * 1000 * float64(count), nil
}

var (
	screenNumber = regexp.MustCompile(`^\s*[-+]?\d+(\.\d*)?\s*$`)
	screenUnit   = regexp.MustCompile(`^(-?\d+(?:\.\d+)?)(ms|[Mwdhmsy])`)
)

var screenUnits = map[string]float64{"y": 31536000, "M": 2592000, "w": 604800, "d": 86400, "h": 3600, "m": 60, "s": 1, "ms": 0.001}

// screenRound is rangeutil.roundInterval (milliseconds).
func screenRound(ms float64) float64 {
	for _, s := range screenSteps {
		if ms < s.below {
			return s.to
		}
	}
	return 31536000000 // 1y
}

var screenSteps = []struct{ below, to float64 }{
	{10, 1}, {15, 10}, {35, 20}, {75, 50}, {150, 100}, {350, 200}, {750, 500}, {1500, 1000}, {3500, 2000},
	{7500, 5000}, {12500, 10000}, {17500, 15000}, {25000, 20000}, {45000, 30000}, {90000, 60000},
	{210000, 120000}, {450000, 300000}, {750000, 600000}, {1050000, 900000}, {1500000, 1200000},
	{2700000, 1800000}, {5400000, 3600000}, {9000000, 7200000}, {16200000, 10800000}, {32400000, 21600000},
	{86400000, 43200000}, {604800000, 86400000}, {1814400000, 604800000}, {3628800000, 2592000000},
}

// secondsToHms is rangeutil.secondsToHms: the largest whole unit only.
func secondsToHms(seconds float64) string {
	inYear := math.Mod(seconds, 31536000)
	inDay := math.Mod(inYear, 86400)
	inHour := math.Mod(inDay, 3600)
	for _, u := range []struct {
		n    float64
		name string
	}{
		{math.Floor(seconds / 31536000), "y"},
		{math.Floor(inYear / 86400), "d"},
		{math.Floor(inDay / 3600), "h"},
		{math.Floor(inHour / 60), "m"},
		{math.Floor(math.Mod(inHour, 60)), "s"},
		{math.Floor(seconds * 1000.0), "ms"},
	} {
		if u.n != 0 {
			return strconv.FormatFloat(u.n, 'f', -1, 64) + u.name
		}
	}
	return "less than a millisecond"
}
