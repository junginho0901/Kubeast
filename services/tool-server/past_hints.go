// What the read tools add with AI_PAST_HINTS (chart ai.pastHints, off by default) for a question about something that is
// over: an event read that holds nothing, or nothing but PolicyViolation events, names the reads that reach further back;
// a pod log read without a line says from when to when the lines that exist run (two or three more reads of the log, a
// line's time each); issues lists the PolicyViolation findings last. Off, the answers are as they were.

package main

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/config"
)

// pastHints is AI_PAST_HINTS by the one switch rule (config.SwitchOn), read at each answer.
func pastHints() bool { return config.EnvSwitch("AI_PAST_HINTS") }

// policyViolation is the reason an admission policy (Kyverno) writes in the events of an object that breaks it.
const policyViolation = "PolicyViolation"

const (
	onlyPolicyEvents = "Only PolicyViolation events matched, an admission policy's warnings about objects as they are: they do not say " +
		"that anything failed, or that nothing did. The API server keeps an event for about an hour by default, so what happened before " +
		"that is not here."
	policyFindingsLast = "%d of these findings are PolicyViolation, an admission policy's warnings about objects as they are: they are listed after the others."
	policyFindingsOnly = "All of these findings are PolicyViolation, an admission policy's warnings about objects as they are: nothing else is failing in " +
		"the checked scope right now. What ended earlier is not here: the logs and metrics of that time have it."
)

// pastReads names the reads that reach further back than the events of namespace ("" for every namespace).
func pastReads(namespace string) string {
	logs, series := `{k8s_namespace_name=~".+"}`, ""
	if dns1123LabelRe.MatchString(namespace) {
		logs, series = `{k8s_namespace_name="`+namespace+`"}`, `{namespace="`+namespace+`"}`
	}
	return " What reaches further back, over a window that holds that time: loki_query (where offered) " + logs +
		` |~ "(?i)error|refused|timeout" (loki_labels has the label names); prometheus_query (where offered) with range=true, kube_deployment_spec_replicas` +
		series + " and kube_statefulset_replicas" + series + ", whose fall to 0 is a scale down that leaves no failing object, and kube_pod_container_status_restarts_total" +
		series + "."
}

// onlyPolicyViolations: every one of events, and there is one, is an admission policy's warning.
func onlyPolicyViolations(events []map[string]interface{}) bool {
	return len(events) > 0 && !slices.ContainsFunc(events, func(e map[string]interface{}) bool { return e["reason"] != policyViolation })
}

// policyEventsHint is the line of an event read that holds nothing else.
func policyEventsHint(namespace string, narrowed bool) string {
	hint := onlyPolicyEvents + pastReads(namespace)
	if narrowed {
		hint += eventsNarrowedReason
	}
	return hint
}

// policyViolationsLast moves the PolicyViolation findings behind the others, each in the order they came, and says so
// ("" where there is none).
func policyViolationsLast(issues []map[string]interface{}, everyListRead bool) (ordered []map[string]interface{}, note string) {
	ordered = make([]map[string]interface{}, 0, len(issues))
	var policy []map[string]interface{}
	for _, issue := range issues {
		if issue["reason"] == policyViolation {
			policy = append(policy, issue)
			continue
		}
		ordered = append(ordered, issue)
	}
	switch {
	case len(policy) == 0:
	case len(ordered) == 0 && everyListRead:
		note = policyFindingsOnly
	default:
		note = fmt.Sprintf(policyFindingsLast, len(policy))
	}
	return append(ordered, policy...), note
}

// logSource is the log a k8s_get_pod_logs call reads, as kubectl logs arguments without its window.
func logSource(podName, namespace, container string, allContainers, previous bool) []string {
	args := []string{"logs", podName, "-n", namespace}
	if allContainers {
		args = append(args, "--all-containers=true")
	} else if container != "" {
		args = append(args, "-c", container)
	}
	if previous {
		args = append(args, "--previous")
	}
	return args
}

// logTimes is the time kubectl logs --timestamps puts in front of a line, and logTimeBytes holds it and no line after it.
var logTimes = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`)

const logTimeBytes = 36

// firstTimes are the times of the first line a read of the log with window gives, one for each container that has a line.
// ok is false for a read that failed or whose lines have no time.
func firstTimes(ctx context.Context, headers http.Header, source []string, window ...string) (times []time.Time, ok bool) {
	args := append(slices.Clone(source), "--timestamps", "--limit-bytes", strconv.Itoa(logTimeBytes))
	out, err := runKubectl(ctx, headers, append(args, window...)...)
	if err != nil {
		return nil, false
	}
	for _, text := range logTimes.FindAllString(out, -1) {
		if t, err := time.Parse(time.RFC3339Nano, text); err == nil {
			times = append(times, t.UTC().Truncate(time.Second))
		}
	}
	return times, len(times) > 0 || strings.TrimSpace(out) == ""
}

func earliest(times []time.Time) time.Time { return slices.MinFunc(times, time.Time.Compare) }
func latest(times []time.Time) time.Time   { return slices.MaxFunc(times, time.Time.Compare) }

const logHoldsNone = "# This log holds no line.\n"

// logHeldLine says from when to when the lines run of a log whose read since since held none, "" when that was not read.
func logHeldLine(ctx context.Context, headers http.Header, source []string, since string) string {
	if since == "" {
		return logHoldsNone
	}
	first, ok := firstTimes(ctx, headers, source)
	if !ok {
		return ""
	}
	if len(first) == 0 {
		return logHoldsNone
	}
	last, ok := firstTimes(ctx, headers, source, "--tail", "1")
	if !ok || len(last) == 0 {
		return ""
	}
	return fmt.Sprintf("# The lines this log holds run from %s to %s: none is within since=%s.\n",
		earliest(first).Format(time.RFC3339), latest(last).Format(time.RFC3339), since)
}

// logSearchedLine says from when to when the lines run that a grep without a match searched, and whether the log goes
// further back, "" when that was not read. Of several containers the searched lines start where the last of them starts.
func logSearchedLine(ctx context.Context, headers http.Header, source []string, since string) string {
	window := []string{"--tail", strconv.Itoa(maxLogTailLines)}
	if since != "" {
		window = append(window, "--since="+since)
	}
	first, ok := firstTimes(ctx, headers, source)
	if !ok || len(first) == 0 {
		return ""
	}
	from, ok := firstTimes(ctx, headers, source, window...)
	if !ok || len(from) == 0 {
		return ""
	}
	last, ok := firstTimes(ctx, headers, source, "--tail", "1")
	if !ok || len(last) == 0 {
		return ""
	}
	searched := fmt.Sprintf("\n# The lines searched run from %s to %s", latest(from).Format(time.RFC3339), latest(last).Format(time.RFC3339))
	if slices.EqualFunc(first, from, time.Time.Equal) {
		return searched + ", from the first line this log holds; a log store's tools (loki_query, logsearch, where offered) may have older ones."
	}
	before := "what came before was not searched"
	if len(first) > 1 {
		before = "not all of what came before was searched"
	}
	return searched + "; the log goes back to " + earliest(first).Format(time.RFC3339) + ", and " + before +
		": a log store's tools (loki_query, logsearch, where offered) read it by time."
}
