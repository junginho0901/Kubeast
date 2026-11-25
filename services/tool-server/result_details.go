// What the metrics, log, trace and timeline tools add to their answers with AI_TOOL_RESULT_DETAILS (chart
// ai.toolResultDetails, off by default): why an empty answer may be empty where the answer did not say, how much of a
// cut answer is shown out of how many, and the window read when the call named none. Each comes from what the handler
// already holds; where the total is not in hand the answer says so instead of reading more. An empty answer of the
// kubectl read tools says why it may be empty too, and k8s_find_resource is the one that reads more: the namespaces,
// by name (handlers_find.go). Off, the answers are as they were.

package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/config"
)

// resultDetails is AI_TOOL_RESULT_DETAILS by the one switch rule (config.SwitchOn), read at each answer.
func resultDetails() bool { return config.EnvSwitch("AI_TOOL_RESULT_DETAILS") }

const (
	// Prometheus's own default (--query.lookback-delta).
	instantEmptyReason = "An instant query reads each series' newest sample within the store's lookback, 5 minutes by default: " +
		"a series that stopped reporting before that is not in it. range=true with since reads further back."
	targetsNoneReason = "The store lists no scrape target for this cluster: it has no targets API and no up series carries this " +
		"cluster's label, or nothing is scraped here. Without targets prometheus_query has no data from this cluster either."
	targetsFilteredReason = "No target matches the health or job filter; health counts all %d targets."

	// kube-apiserver's own default (--event-ttl).
	eventsEmptyReason = "No event matched. The API server keeps an event for about an hour by default, so this does not say that " +
		"nothing happened before: read the logs (k8s_get_pod_logs, or a log store's tools where offered) and the replica and " +
		"restart metrics over a longer window (prometheus_query with range=true and since, where offered)."
	eventsNarrowedReason = " The call was narrowed by kind, name or field_selector: what happened to a workload's pods or ReplicaSets " +
		"is recorded under their own names."
	describeNoEventsReason = "# Events are kept about an hour by default, so none here does not say that nothing happened before: logs and metrics reach further back."
	noSuchNamespaceReason  = " A namespace that does not exist answers the same."

	listEmptyReason = "Nothing of this kind exists now in what was read. An object deleted earlier is not listed: events, logs and " +
		"metrics of that time may still name it."
	listOneNamespaceReason = " k8s_find_resource looks for a name in every namespace the user may read."
	listNoNamespaceReason  = " No namespace was given: of a kind that lives in namespaces only the default one was read (all_namespaces=true reads every one)."

	podMetricsEmptyReason = "metrics-server lists no pod here. It holds only each running pod's newest sample, so a pod that is gone or " +
		"has just started has none; prometheus_query (where offered) has the use over time."

	endpointsNoneReason = "No endpoint address is behind this Service: its selector may match no pod (compare it with the pods' labels), " +
		"the pods may be scaled to zero or gone, or it has no selector."
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
	if !resultDetails() {
		return
	}
	for k, v := range map[string]string{"cut": cut, "default_window": window, "empty_reason": emptyReason} {
		if v != "" {
			result[k] = v
		}
	}
}

// eventsEmpty is why k8s_get_events may have found none.
func eventsEmpty(namespace string, narrowed bool) string {
	reason := eventsEmptyReason
	if narrowed {
		reason += eventsNarrowedReason
	}
	if namespace != "" {
		reason += noSuchNamespaceReason
	}
	return reason
}

// listEmpty is why a kubectl list of one kind may hold nothing.
func listEmpty(kind, namespace string, allNamespaces bool) string {
	reason, otherNamespaces := listEmptyReason, listOneNamespaceReason
	if isEventsKind(kind) {
		reason, otherNamespaces = eventsEmptyReason, ""
	}
	switch {
	case allNamespaces:
		return reason
	case namespace != "":
		return reason + noSuchNamespaceReason + otherNamespaces
	}
	return reason + listNoNamespaceReason
}

func isEventsKind(kind string) bool {
	name, _, _ := strings.Cut(strings.ToLower(strings.TrimSpace(kind)), ".")
	return name == "events" || name == "event" || name == "ev"
}

// reNoEvents is the line kubectl describe ends with for an object no event is kept of.
var reNoEvents = regexp.MustCompile(`(?m)^Events:[ \t]+<none>[ \t]*$`)

func withEventsReason(out string) string {
	return reNoEvents.ReplaceAllString(out, "${0}\n"+describeNoEventsReason)
}

// noneInTable: kubectl's own sentence for a table without a row, after its warnings if any (it prints nothing for -o name).
func noneInTable(out string) bool {
	text := strings.TrimSpace(out)
	return text == "" || strings.HasPrefix(text[strings.LastIndexByte(text, '\n')+1:], noResourcesFound)
}

// emptyListBytes is more than kubectl writes for a JSON list without items.
const emptyListBytes = 1 << 10

// withListReason adds reason to a kubectl list that holds nothing: the line after a table or names, the first key of a
// JSON list. An answer that holds something is out as it came.
func withListReason(out, reason string) string {
	if noneInTable(out) {
		return out + reason + "\n"
	}
	text := strings.TrimSpace(out)
	if len(text) > emptyListBytes || !strings.HasPrefix(text, "{") {
		return out
	}
	var list struct {
		Kind  string             `json:"kind"`
		Items *[]json.RawMessage `json:"items"`
	}
	if json.Unmarshal([]byte(text), &list) != nil || !strings.HasSuffix(list.Kind, "List") || list.Items == nil || len(*list.Items) > 0 {
		return out
	}
	quoted, err := json.Marshal(reason)
	if err != nil {
		return out
	}
	return `{"empty_reason":` + string(quoted) + "," + strings.TrimPrefix(text, "{") + "\n"
}

// logEmpty is the line for a pod log read that held nothing, and logNoMatch the one for a grep without a match.
func logEmpty(lines int, since string, previous, allContainers bool) string {
	return fmt.Sprintf("# No line was read: the newest %d lines%s were asked for.%s\n", lines, sinceText(since), emptyLogNote(previous, allContainers))
}

func emptyLogNote(previous, allContainers bool) string {
	return " An empty log does not say that nothing failed: " + logElsewhere(previous, allContainers) + "."
}

func logNoMatch(since string, previous, allContainers bool) string {
	return fmt.Sprintf("\n# grep is a plain substring of the newest %d lines%s: the same thing in other words, or an older line, is not matched; %s.",
		maxLogTailLines, sinceText(since), logElsewhere(previous, allContainers))
}

func sinceText(since string) string {
	if since == "" {
		return ""
	}
	return " within since=" + since
}

// logElsewhere says where else a pod's lines may be, leaving out what the call already asked for.
func logElsewhere(previous, allContainers bool) string {
	var parts []string
	if !previous {
		parts = append(parts, "previous=true reads the run before a restart")
	}
	if !allContainers {
		parts = append(parts, "all_containers=true the pod's other containers")
	}
	return strings.Join(append(parts, "a log store's tools (where offered) older lines and pods that are gone"), ", ")
}
