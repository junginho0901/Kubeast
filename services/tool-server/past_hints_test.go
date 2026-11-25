package main

import (
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The state of the tools' answers before AI_PAST_HINTS is its off state, whatever is written in the variable.
var pastHintsOff = []string{"", "false", "0", "no"}

func withPastHints(t *testing.T, value string) {
	t.Helper()
	t.Setenv("AI_PAST_HINTS", value)
}

const (
	policyEvent   = `{"namespace":"shop","type":"Warning","reason":"PolicyViolation","message":"policy require-labels/ fail","count":1,"first_timestamp":"2026-11-25T04:28:58Z","last_timestamp":"2026-11-25T04:28:58Z","involved_object":{"kind":"Deployment","name":"payments"}}`
	backOffEvent  = `{"namespace":"shop","type":"Warning","reason":"BackOff","message":"m","count":3,"first_timestamp":"","last_timestamp":"","involved_object":{"kind":"Pod","name":"web-1"}}`
	policyFinding = `{"id":"Deployment/shop/payments","kind":"Deployment","last_seen":"2026-11-25T05:07:46Z","message":"policy require-labels/ fail","name":"payments","namespace":"shop","reason":"PolicyViolation","severity":"warning"}`
	restarted     = `{"id":"Pod/shop/web-2","kind":"Pod","name":"web-2","namespace":"shop","reason":"Restarted: Error","severity":"info"}`
)

func eventsReply(events ...string) string {
	return fmt.Sprintf(`{"items":[%s],"total":%d}`, strings.Join(events, ","), len(events))
}

// What the answers say of where to read further back, of one namespace and of every namespace.
var (
	pastReadsOfShop = []string{`loki_query (where offered) {k8s_namespace_name="shop"} |~ `, `kube_deployment_spec_replicas{namespace="shop"}`,
		`kube_statefulset_replicas{namespace="shop"}`, `kube_pod_container_status_restarts_total{namespace="shop"}`, "range=true"}
	pastReadsOfAll = []string{`{k8s_namespace_name=~".+"} |~ `, "kube_deployment_spec_replicas and "}
)

type pastEventCase struct {
	name     string
	tool     string
	args     args
	kubectl  string // what kubectl answers, for a tool that runs it
	body     string // what the events API answers
	off      string
	on       []string
	notOn    []string
	noReason bool // the answer holds events, so it is not an empty one
}

func pastEventCases() []pastEventCase {
	one := `[{"count":1,"first_timestamp":"2026-11-25T04:28:58Z","last_timestamp":"2026-11-25T04:28:58Z","message":"policy require-labels/ fail","namespace":"shop","object":{"kind":"Deployment","name":"payments"},"reason":"PolicyViolation","type":"Warning"}]`
	return []pastEventCase{
		{name: "no event of a namespace", tool: "k8s_get_events", args: args{"namespace": "shop"}, body: noEvents, off: `[]`,
			on: append([]string{`"empty_reason"`, "about an hour", "does not exist"}, jsonTexts(pastReadsOfShop)...)},
		{name: "no event of an object", tool: "k8s_get_events", args: args{"namespace": "shop", "kind": "Pod", "name": "web-1"}, body: noEvents, off: `[]`,
			on: append([]string{"under their own names"}, jsonTexts(pastReadsOfShop)...)},
		{name: "no event of any namespace", tool: "k8s_get_events", args: args{"all_namespaces": true}, body: noEvents, off: `[]`,
			on: jsonTexts(pastReadsOfAll), notOn: []string{"does not exist", `{namespace=`}},
		{name: "PolicyViolation alone", tool: "k8s_get_events", args: args{"namespace": "shop"}, body: eventsReply(policyEvent), off: one,
			on: append([]string{`{"past_hint":"Only PolicyViolation events matched`, `,"events":` + one + `}`}, jsonTexts(pastReadsOfShop)...), notOn: []string{"empty_reason", "narrowed"}, noReason: true},
		{name: "PolicyViolation alone, narrowed", tool: "k8s_get_events", args: args{"namespace": "shop", "field_selector": "type=Warning"}, body: eventsReply(policyEvent), off: one,
			on: []string{"Only PolicyViolation events matched", "narrowed by kind, name or field_selector"}, noReason: true},
		{name: "a list of no event", tool: "k8s_get_resources", args: args{"resource_type": "events", "namespace": "shop"}, kubectl: noPodsTable, off: noPodsTable,
			on: append([]string{noPodsTable, "about an hour"}, pastReadsOfShop...)},
		{name: "a list of no event of any namespace", tool: "k8s_get_resources", args: args{"resource_type": "events", "all_namespaces": true, "namespace": "shop"}, kubectl: "No resources found\n", off: "No resources found\n",
			on: pastReadsOfAll, notOn: []string{"shop"}},
		{name: "a described object without events", tool: "k8s_describe_resource", args: args{"resource_type": "deployments", "resource_name": "web", "namespace": "shop"}, kubectl: describedNoEvents, off: describedNoEvents,
			on: append([]string{describedNoEvents, "about an hour"}, pastReadsOfShop...)},
	}
}

// jsonTexts are texts as a JSON string holds them.
func jsonTexts(texts []string) []string {
	out := make([]string, len(texts))
	for i, s := range texts {
		quoted, _ := marshalJSON(s)
		out[i] = strings.Trim(quoted, `"`)
	}
	return out
}

func (c pastEventCase) run(t *testing.T) string {
	t.Helper()
	fakeK8sService(t, func(*http.Request) (int, string) { return 200, c.body })
	fakeKubectl(t, func(a []string) (string, error) {
		if has(a, "api-resources") {
			return "", nil
		}
		return c.kubectl, nil
	})
	return runTool(t, ctxFor("past-hints"), c.tool, c.args)
}

func TestPastHints_OffTheEventReadsAreTheBytesTheyWere(t *testing.T) {
	t.Setenv("AI_TOOL_RESULT_DETAILS", "")
	for _, c := range pastEventCases() {
		for _, off := range pastHintsOff {
			withPastHints(t, off)
			if out := c.run(t); out != c.off {
				t.Errorf("%s (%q): %s\nwant %s", c.name, off, out, c.off)
			}
		}
	}
}

// Off, what AI_TOOL_RESULT_DETAILS adds to an event read is what it was: nothing of the further reads is in it.
func TestPastHints_OffTheResultDetailsAreWhatTheyWere(t *testing.T) {
	t.Setenv("AI_TOOL_RESULT_DETAILS", "true")
	withPastHints(t, "")
	for _, c := range pastEventCases() {
		out := c.run(t)
		for _, not := range []string{"kube_deployment_spec_replicas", "k8s_namespace_name", "past_hint"} {
			if strings.Contains(out, not) {
				t.Errorf("%s: %q is in %s", c.name, not, out)
			}
		}
	}
	if got := decode(t, pastEventCases()[0].run(t))["empty_reason"]; got != eventsEmptyReason+noSuchNamespaceReason {
		t.Errorf("%v", got)
	}
}

func TestPastHints_OnAnEventReadNamesTheReadsThatReachFurtherBack(t *testing.T) {
	for _, details := range []string{"", "true"} {
		t.Setenv("AI_TOOL_RESULT_DETAILS", details)
		for _, c := range pastEventCases() {
			withPastHints(t, "true")
			out := c.run(t)
			for _, want := range c.on {
				if !strings.Contains(out, want) {
					t.Errorf("%s (details %q): %q is not in %s", c.name, details, want, out)
				}
			}
			for _, not := range c.notOn {
				if strings.Contains(out, not) {
					t.Errorf("%s (details %q): %q is in %s", c.name, details, not, out)
				}
			}
			if masked, _ := redactToolOutput(out); masked != out {
				t.Errorf("%s: masked %s, was %s", c.name, masked, out)
			}
			if strings.HasPrefix(out, "{") {
				if _, empty := decode(t, out)["empty_reason"]; empty == c.noReason {
					t.Errorf("%s: %s", c.name, out)
				}
			}
		}
	}
}

// An event of another reason is an answer, and one past the limit may be cut off it: both are as they were.
func TestPastHints_AnEventReadThatHoldsAnotherEventIsTheSame(t *testing.T) {
	t.Setenv("AI_TOOL_RESULT_DETAILS", "")
	for name, body := range map[string]string{
		"beside another event":  eventsReply(policyEvent, backOffEvent),
		"an event of a pod":     eventsReply(backOffEvent),
		"more than were listed": strings.Replace(eventsReply(policyEvent), `"total":1`, `"total":9`, 1),
	} {
		c := pastEventCase{tool: "k8s_get_events", args: args{"namespace": "shop"}, body: body}
		withPastHints(t, "")
		off := c.run(t)
		withPastHints(t, "true")
		if on := c.run(t); on != off {
			t.Errorf("%s: on %s\noff %s", name, on, off)
		}
	}
}

func TestPastHints_OffByDefaultAndReadByTheSwitchRule(t *testing.T) {
	for v, want := range map[string]bool{"": false, "false": false, "0": false, "t": false, "true": true, " Yes ": true, "1": true, "ON": true} {
		withPastHints(t, v)
		if got := pastHints(); got != want {
			t.Errorf("AI_PAST_HINTS=%q: %v, want %v", v, got, want)
		}
	}
}

// timedLog is a pod's log, a line each minute from start in each of its containers, answered as the kubelet does.
type timedLog struct {
	now        time.Time
	containers [][]time.Time
	refuse     bool // the reads of the lines' times
}

func minutes(from time.Time, n int) []time.Time {
	out := make([]time.Time, n)
	for i := range out {
		out[i] = from.Add(time.Duration(i) * time.Minute)
	}
	return out
}

func (l timedLog) answer(t *testing.T) *[][]string {
	t.Helper()
	return fakeKubectl(t, func(a []string) (string, error) {
		v := verb(a)
		value := func(flag string) string {
			if i := slices.Index(v, flag); i >= 0 && i+1 < len(v) {
				return v[i+1]
			}
			return ""
		}
		timed := has(v, "--timestamps")
		if timed && l.refuse {
			return kubectlErr("Error from server (BadRequest): container \"main\" in pod \"web-1\" is waiting to start")
		}
		out := ""
		for _, lines := range l.containers {
			for _, arg := range v {
				if since, ok := strings.CutPrefix(arg, "--since="); ok {
					d, err := time.ParseDuration(since)
					if err != nil {
						return kubectlErr("bad since")
					}
					lines = slices.DeleteFunc(slices.Clone(lines), func(at time.Time) bool { return at.Before(l.now.Add(-d)) })
				}
			}
			if n, err := strconv.Atoi(value("--tail")); err == nil && n < len(lines) {
				lines = lines[len(lines)-n:]
			}
			text := ""
			for _, at := range lines {
				if timed {
					text += at.In(time.FixedZone("", 9*3600)).Format("2006-01-02T15:04:05.000000000Z07:00") + " "
				}
				text += "ts=2020-01-01T00:00:00Z request served\n"
			}
			if n, err := strconv.Atoi(value("--limit-bytes")); err == nil && n < len(text) {
				text = text[:n]
			}
			out += text
		}
		return out, nil
	})
}

var (
	logNow   = time.Date(2026, 11, 25, 5, 54, 0, 0, time.UTC)
	logStart = time.Date(2026, 11, 25, 4, 28, 58, 0, time.UTC)
)

func podLog(t *testing.T, a args) string {
	t.Helper()
	full := args{"pod_name": "web-1", "namespace": "shop"}
	for k, v := range a {
		full[k] = v
	}
	out, err := handleGetPodLogs(ctxFor("past-hints"), full, bearer())
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPastHints_OnAnEmptyLogReadSaysFromWhenToWhenItsLinesRun(t *testing.T) {
	t.Setenv("AI_TOOL_RESULT_DETAILS", "")
	withPastHints(t, "true")
	hour := timedLog{now: logNow, containers: [][]time.Time{minutes(logStart, 60)}}
	for _, c := range []struct {
		name string
		log  timedLog
		args args
		want string
		not  string
	}{
		{"a window after the last line", hour, args{"since": "10m"},
			"# The lines this log holds run from 2026-11-25T04:28:58Z to 2026-11-25T05:27:58Z: none is within since=10m.\n", ""},
		{"of several containers", timedLog{now: logNow, containers: [][]time.Time{minutes(logStart, 5), minutes(logStart.Add(20*time.Minute), 10)}}, args{"since": "10m", "all_containers": true},
			"run from 2026-11-25T04:28:58Z to 2026-11-25T04:57:58Z", ""},
		{"a log without a line", timedLog{now: logNow, containers: [][]time.Time{nil}}, args{}, logHoldsNone, "run from"},
		{"a log without a line, with a window", timedLog{now: logNow, containers: [][]time.Time{nil}}, args{"since": "10m"}, logHoldsNone, "run from"},
		{"times that could not be read", timedLog{now: logNow, containers: hour.containers, refuse: true}, args{"since": "10m"}, "within since=10m", "log holds"},
	} {
		c.log.answer(t)
		out := podLog(t, c.args)
		if !strings.HasPrefix(out, "# No line was read: ") || !strings.Contains(out, c.want) || (c.not != "" && strings.Contains(out, c.not)) {
			t.Errorf("%s: %s", c.name, out)
		}
		for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
			if !strings.HasPrefix(line, "# ") {
				t.Errorf("%s: a line that is not a comment: %q", c.name, line)
			}
		}
		if strings.Contains(out, "2020-01-01") {
			t.Errorf("%s: a line of the log: %s", c.name, out)
		}
	}
}

func TestPastHints_OnASearchWithoutAMatchSaysFromWhenToWhenItSearched(t *testing.T) {
	t.Setenv("AI_TOOL_RESULT_DETAILS", "")
	withPastHints(t, "true")
	long := minutes(logStart, 2100)
	end := long[len(long)-1]
	for _, c := range []struct {
		name string
		log  timedLog
		args args
		want string
	}{
		{"past the newest 2000 lines", timedLog{now: end, containers: [][]time.Time{long}}, args{"grep": "error"},
			"# grep \"error\": 0 of 2000 lines matched\n# The lines searched run from " + long[100].Format(time.RFC3339) + " to " + end.Format(time.RFC3339) +
				"; the log goes back to 2026-11-25T04:28:58Z, and what came before was not searched: a log store's tools (loki_query, logsearch, where offered) read it by time."},
		{"the whole log", timedLog{now: logNow, containers: [][]time.Time{minutes(logStart, 60)}}, args{"grep": "error"},
			"# grep \"error\": 0 of 60 lines matched\n# The lines searched run from 2026-11-25T04:28:58Z to 2026-11-25T05:27:58Z, from the first line this log holds; a log store's tools (loki_query, logsearch, where offered) may have older ones."},
		{"a window of it", timedLog{now: logNow, containers: [][]time.Time{minutes(logStart, 60)}}, args{"grep": "error", "since": "40m"},
			"# The lines searched run from 2026-11-25T05:14:58Z to 2026-11-25T05:27:58Z; the log goes back to 2026-11-25T04:28:58Z, and what came before was not searched"},
		{"of several containers", timedLog{now: end, containers: [][]time.Time{minutes(logStart, 3), long}}, args{"grep": "error", "all_containers": true},
			"# The lines searched run from " + long[100].Format(time.RFC3339) + " to " + end.Format(time.RFC3339) + "; the log goes back to 2026-11-25T04:28:58Z, and not all of what came before was searched"},
	} {
		c.log.answer(t)
		if out := podLog(t, c.args); !strings.Contains(out, c.want) || strings.Contains(out, "2020-01-01") {
			t.Errorf("%s: %s\nwant %s", c.name, out, c.want)
		}
	}
	// times that could not be read, and a read that was cut before it was searched, say nothing of them
	timedLog{now: logNow, containers: [][]time.Time{minutes(logStart, 60)}, refuse: true}.answer(t)
	if out := podLog(t, args{"grep": "error"}); out != `# grep "error": 0 of 60 lines matched` {
		t.Errorf("%s", out)
	}
	withOutputCap(t, 500)
	timedLog{now: logNow, containers: [][]time.Time{minutes(logStart, 60)}}.answer(t)
	if out := podLog(t, args{"grep": "error"}); !strings.Contains(out, "older lines cut") || strings.Contains(out, "run from") {
		t.Errorf("%s", out)
	}
}

// Off, or where the read held something, a log read is the bytes and the one kubectl run it was.
func TestPastHints_ALogReadThatHoldsALineOrIsOffIsTheOneReadItWas(t *testing.T) {
	log := timedLog{now: logNow, containers: [][]time.Time{minutes(logStart, 60)}}
	for _, details := range []string{"", "true"} {
		t.Setenv("AI_TOOL_RESULT_DETAILS", details)
		for _, a := range []args{{}, {"grep": "error"}, {"since": "10m"}, {"since": "10m", "grep": "error"}, {"grep": "served", "tail_lines": 2}, {"all_containers": true, "previous": true}, {"container": "main"}} {
			withPastHints(t, "")
			calls := log.answer(t)
			off, offRuns := podLog(t, a), fmt.Sprint(*calls)
			for _, value := range pastHintsOff {
				withPastHints(t, value)
				calls = log.answer(t)
				if out := podLog(t, a); out != off || fmt.Sprint(*calls) != offRuns || len(*calls) != 1 {
					t.Errorf("%v (%q, details %q): %s\n%s", a, value, details, out, off)
				}
			}
			if strings.Contains(off, "0 of") || strings.Contains(off, "No line was read") || off == "" {
				continue
			}
			withPastHints(t, "true")
			calls = log.answer(t)
			if out := podLog(t, a); out != off || fmt.Sprint(*calls) != offRuns {
				t.Errorf("%v: on %s\noff %s", a, out, off)
			}
		}
	}
}

// The reads of the lines' times are of the same log, as the same person, a time's bytes each, and their flags go before kubectl's.
func TestPastHints_TheTimesAreReadOfTheSameLog(t *testing.T) {
	t.Setenv("AI_TOOL_RESULT_DETAILS", "")
	withPastHints(t, "true")
	calls := timedLog{now: logNow, containers: [][]time.Time{minutes(logStart, 60)}}.answer(t)
	podLog(t, args{"grep": "error", "container": "main", "previous": true, "since": "2h"})
	var runs []string
	for _, c := range (*calls)[1:] {
		runs = append(runs, strings.Join(verb(c), " "))
	}
	want := []string{
		"logs web-1 -n shop -c main --previous --timestamps --limit-bytes 36",
		"logs web-1 -n shop -c main --previous --timestamps --limit-bytes 36 --tail 2000 --since=2h",
		"logs web-1 -n shop -c main --previous --timestamps --limit-bytes 36 --tail 1",
	}
	if !slices.Equal(runs, want) {
		t.Fatalf("%s", strings.Join(runs, "\n"))
	}
}

func TestPastHints_OnIssuesListsThePolicyViolationsLast(t *testing.T) {
	names := func(out string) []string {
		var got []string
		for _, row := range decode(t, out)["issues"].([]interface{}) {
			got = append(got, row.(map[string]interface{})["name"].(string))
		}
		return got
	}
	rows := []string{policyFinding, failingWeb, strings.ReplaceAll(policyFinding, "payments", "catalog"), restarted}
	withPastHints(t, "true")
	out := issuesOf(t, ctxFor("c1"), args{}, rows...)
	if got := names(out); !slices.Equal(got, []string{"web-1", "web-2", "payments", "catalog"}) {
		t.Errorf("%v", got)
	}
	if !strings.HasPrefix(out, `{"listed_last":"2 of these findings are PolicyViolation`) || decode(t, out)["total"] != float64(4) {
		t.Errorf("%s", out)
	}
	// behind a list that was refused, which is in front, and in front of the cut
	out = issuesOf(t, ctxFor("c1"), args{"namespace": "shop"}, policyFinding, failingWeb, unreadDeploys)
	if !strings.HasPrefix(out, `{"not_read":`) || !strings.Contains(out, `"listed_last":"1 of these`) || !slices.Equal(names(out), []string{"web-1", "payments"}) {
		t.Errorf("%s", out)
	}
	var many []string
	for i := 0; i < issuesCap; i++ {
		many = append(many, strings.ReplaceAll(policyFinding, "payments", "p"+strconv.Itoa(i)))
	}
	out = issuesOf(t, ctxFor("c1"), args{}, append(many, restarted)...)
	if got := names(out); len(got) != issuesCap || got[0] != "web-2" || decode(t, out)["truncated"] != true {
		t.Errorf("%v", got)
	}

	// nothing else: said only where every list was read, of every severity
	for _, c := range []struct {
		name string
		args args
		rows []string
		only bool
	}{
		{"every list read", args{"namespace": "shop"}, []string{policyFinding}, true},
		{"one severity", args{"namespace": "shop", "severity": "warning"}, []string{policyFinding}, false},
		{"a list refused", args{"namespace": "shop"}, []string{policyFinding, unreadDeploys}, false},
	} {
		out := issuesOf(t, ctxFor("c1"), c.args, c.rows...)
		if strings.Contains(out, "nothing else is failing") != c.only || !strings.Contains(out, `"listed_last":`) {
			t.Errorf("%s: %s", c.name, out)
		}
	}
	// a row of another reason that only holds the word is no finding of a policy
	out = issuesOf(t, ctxFor("c1"), args{}, strings.Replace(failingWeb, `"reason":"CrashLoopBackOff"`, `"message":"PolicyViolation: m","reason":"CrashLoopBackOff"`, 1))
	if strings.Contains(out, "listed_last") {
		t.Errorf("%s", out)
	}
}

func TestPastHints_OffIssuesIsTheBytesItWas(t *testing.T) {
	withPastHints(t, "true")
	on := issuesOf(t, ctxFor("c1"), args{}, failingWeb, restarted) // no finding of a policy: the same on
	for _, off := range pastHintsOff {
		withPastHints(t, off)
		if out := issuesOf(t, ctxFor("c1"), args{}, failingWeb, restarted); out != on {
			t.Errorf("%q: %s\n%s", off, out, on)
		}
		want := `{"counts":{"critical":1,"info":0,"warning":1},"generated_at":"2026-10-15T00:00:00Z","issues":[` + policyFinding + `,` + failingWeb + `],"namespace":"all namespaces","total":2,"window_minutes":30}`
		if out := issuesOf(t, ctxFor("c1"), args{}, policyFinding, failingWeb); out != want {
			t.Errorf("%q: %s\nwant %s", off, out, want)
		}
	}
}
