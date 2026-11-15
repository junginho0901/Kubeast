// What the metrics, log, trace and timeline tools add to their answers with AI_TOOL_RESULT_DETAILS (chart
// ai.toolResultDetails, off by default): why an empty answer may be empty where the answer did not say, how much of a
// cut answer is shown out of how many, and the window read when the call named none. Each comes from what the handler
// already holds; where the total is not in hand the answer says so instead of reading more. Off, the answers are as
// they were.

package main

import (
	"fmt"
	"os"
	"strings"
	"time"
)

var resultDetails = strings.EqualFold(strings.TrimSpace(os.Getenv("AI_TOOL_RESULT_DETAILS")), "true")

const (
	// Prometheus's own default (--query.lookback-delta).
	instantEmptyReason = "An instant query reads each series' newest sample within the store's lookback, 5 minutes by default: " +
		"a series that stopped reporting before that is not in it. range=true with since reads further back."
	targetsNoneReason = "The store lists no scrape target for this cluster: it has no targets API and no up series carries this " +
		"cluster's label, or nothing is scraped here. Without targets prometheus_query has no data from this cluster either."
	targetsFilteredReason = "No target matches the health or job filter; health counts all %d targets."
)

// cutOf is "M of N <unit>" for an answer that lists part of what it holds.
func cutOf(shown, total int, unit string) string {
	return fmt.Sprintf("%d of %d %s", shown, total, unit)
}

// cutUnknown is the same for an answer whose total was not handed over: the store or k8s-service stopped at a limit.
func cutUnknown(shown int, unit, stoppedBy string) string {
	return fmt.Sprintf("%d %s shown; the total is not known (%s)", shown, unit, stoppedBy)
}

// windowDefault says which window a call read when it named none, or a since that is not a duration: the default
// span back from the end. keys are the window arguments of the tool, since first when it has one.
func windowDefault(args map[string]interface{}, span time.Duration, keys ...string) string {
	badSince := false
	for _, k := range keys {
		v := strings.TrimSpace(argString(args, k, ""))
		if v == "" {
			continue
		}
		if k != "since" {
			return ""
		}
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return ""
		}
		badSince = true
	}
	if badSince {
		return fmt.Sprintf("since is not a duration such as 30m or 6h: the last %s was read (the default).", shortSpan(span))
	}
	return fmt.Sprintf("No window was given (%s): the last %s was read (the default).", strings.Join(keys, ", "), shortSpan(span))
}

// shortSpan writes 1h0m0s as 1h, 24h0m0s as 24h and 30m0s as 30m.
func shortSpan(d time.Duration) string {
	s := d.String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	return s
}

// spanText is shortSpan of a duration k8s-service wrote, or the text as it came.
func spanText(s string) string {
	if d, err := time.ParseDuration(s); err == nil {
		return shortSpan(d)
	}
	return s
}

// maxPoints is the most points any series had before thinning.
func maxPoints(series []map[string]interface{}) int {
	most := 0
	for _, s := range series {
		if pts, ok := s["points"].([]interface{}); ok && len(pts) > most {
			most = len(pts)
		}
	}
	return most
}

// seriesCut is the cut of a series answer: the series kept out of the total and the points thinned per series. When
// k8s-service stopped at its limit, the total is the count it answered with (counted, its seriesTotal), or not known
// from a k8s-service that does not answer one.
func seriesCut(total, kept int, storeStopped bool, counted, mostPoints int) string {
	if storeStopped && counted > total {
		total, storeStopped = counted, false
	}
	var parts []string
	switch {
	case storeStopped:
		parts = append(parts, cutUnknown(kept, "series", "k8s-service stops at its limit of series"))
	case kept < total:
		parts = append(parts, cutOf(kept, total, "series"))
	}
	if mostPoints > promPointsCap {
		parts = append(parts, fmt.Sprintf("points thinned to %d per series, of up to %d", promPointsCap, mostPoints))
	}
	return strings.Join(parts, "; ")
}

// addDetails sets the details that are not empty when the switch is on.
func addDetails(result map[string]interface{}, cut, window, emptyReason string) {
	if !resultDetails {
		return
	}
	for k, v := range map[string]string{"cut": cut, "default_window": window, "empty_reason": emptyReason} {
		if v != "" {
			result[k] = v
		}
	}
}
