package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func neighborRow(rank int, target, role string, extra string) string {
	r := fmt.Sprintf(`{"rank":%d,"target":%q,"owner":"ReplicaSet/some-owner-7d9f8b6c5","cores":%g,"before_cores":0.03,"grew_cores":%g,"peak_cores":0.04,"request":"20m","limit":"none","started_at":"2026-11-23T01:30:00Z"`, rank, target, 1/float64(rank), 1/float64(rank)-0.03)
	if role != "" {
		r += fmt.Sprintf(`,"role":%q`, role)
	}
	return r + extra + "}"
}

func neighborsReply(source string, rows ...string) string {
	return `{"node":{"target":"Node/n1","role":"node_busy","busy_since":"2026-11-25T01:25:00Z","allocatable_cores":8,"cpu_requests":"3 (37%)","cpus":8,"busy_average":0.23,"busy_average_before":0.14,"busy_average_peak":0.23,"busiest_cpu":{"cpu":"1","share":1,"peak_share":1,"before_share":0.3},"waiting":0.7,"waiting_before":0.02,"steal":0,"containers_cores":1.4,"other_cores":0.4,"other_before_cores":0.4},` +
		`"window":{"start":"2026-11-25T01:00:00Z","end":"2026-11-25T01:30:00Z"},"compared_with":{"start":"2026-11-25T00:30:00Z","end":"2026-11-25T01:00:00Z"},"step_seconds":150,"source":"` + source + `",` +
		`"compared":{"steps":2,"from":"2026-11-25T01:25:00Z","to":"2026-11-25T01:30:00Z","with_from":"2026-11-25T00:30:00Z","with_to":"2026-11-25T01:25:00Z","why":"the steps the node was busy, against the steps before it got busy"},` +
		`"reading":["The node was busy from 2026-11-25T01:25:00Z: CPU 1 was busy 100% of the time at its highest step (30% before)."],"containers":[` + strings.Join(rows, ",") + `],"containers_total":46,` +
		`"not_listed":{"containers":34,"cores":4.1},"not_shown":{"namespaces":2,"pods":3,"containers":4,"cores":0.4,"before_cores":0.4,"why":"pods in namespaces you may not read, counted and not named"},` +
		`"not_run":[{"what":"waiting","reason":"no container_pressure_cpu_waiting_seconds_total series of this node"}],"cannot_say":["a burst shorter than a step (2m30s) is averaged over it"],"store_queries":5}`
}

func TestNodeNeighbors_AsksTheNodesWindowAndAnswersATable(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, neighborsReply("prometheus",
			`{"rank":1,"target":"reports/monthly-report-x/main","owner":"Job/monthly-report","role":"suspected_aggressor","cores":0.98,"grew_cores":0.98,"peak_cores":0.98,"new":true,"request":"500m","limit":"none","started_at":"2026-11-25T01:25:00Z"}`,
			`{"rank":2,"target":"shop/search-1/main","role":"suspected_victim","cores":0.02,"before_cores":0.03,"grew_cores":-0.01,"peak_cores":0.03,"request":"20m","limit":"1","started_at":"2026-11-23T01:30:00Z","throttled":0,"throttled_before":0,"waiting":0.6,"waiting_before":0.01}`,
			`{"rank":3,"target":"reports/burst-1/main","cores":0.01,"grew_cores":0.01,"peak_cores":0.01,"new":true,"gone":true}`)
	})
	args := map[string]interface{}{"node": "ip-10-0-0-1.internal", "since_time": "2026-11-25T01:00:00Z", "until_time": "2026-11-25T01:30:00Z"}
	if err := validateToolArgs(args); err != nil {
		t.Fatal(err)
	}
	out, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), args, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	q := r.URL.Query()
	if r.URL.Path != "/api/v1/nodes/ip-10-0-0-1.internal/neighbors" || q.Get("start") != "2026-11-25T01:00:00Z" || q.Get("end") != "2026-11-25T01:30:00Z" || q.Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request %s %s", r.URL.Path, r.URL.RawQuery)
	}
	// the node and the reading first, the rows last
	if !strings.HasPrefix(out, `{"node":{`) || strings.Index(out, `"reading"`) > strings.Index(out, `"containers":[`) || !strings.HasSuffix(out, `]}`) {
		t.Fatalf("order: %s", out)
	}
	m := decode(t, out)
	lines := m["containers"].([]interface{})
	want := []string{
		"1 | reports/monthly-report-x/main (Job/monthly-report) | suspected_aggressor | 0.98 | none | +0.98 | 0.98 | 500m | none | 2026-11-25T01:25:00Z | - | -",
		"2 | shop/search-1/main | suspected_victim | 0.02 | 0.03 | -0.01 | 0.03 | 20m | 1 | 2026-11-23T01:30:00Z | 0 (0) | 0.6 (0.01)",
		"3 | reports/burst-1/main [gone] | - | 0.01 | none | +0.01 | 0.01 | ? | ? | ? | - | -",
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Errorf("row %d: %v\nwant %s", i, lines[i], want[i])
		}
		if strings.Count(want[i], " | ") != strings.Count(nodeWindowColumns, " | ") {
			t.Errorf("row %d does not have the columns", i)
		}
	}
	if m["columns"] != nodeWindowColumns || m["containers_note"] != nil || m["containers_total"] != float64(46) || m["not_shown"] == nil || m["not_run"] == nil || m["cannot_say"] == nil {
		t.Fatalf("%s", out)
	}
}

func TestNodeNeighbors_CurrentValuesHaveNoColumnsTheyCannotFill(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, neighborsReply("metrics_api", `{"rank":1,"target":"reports/monthly-report-x/main","owner":"Job/monthly-report","cores":0.98,"request":"500m","limit":"none","started_at":"2026-11-25T01:25:00Z"}`)
	})
	out, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["columns"] != nodeCurrentColumns || m["containers"].([]interface{})[0] != "1 | reports/monthly-report-x/main (Job/monthly-report) | 0.98 | 500m | none | 2026-11-25T01:25:00Z" {
		t.Fatalf("%s", out)
	}
}

func TestNodeNeighbors_NoContainersAreAnEmptyListAndNoTable(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, neighborsReply("none") })
	out, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); len(m["containers"].([]interface{})) != 0 || m["columns"] != nil {
		t.Fatalf("%s", out)
	}
}

// since_time 2h counts back from the minute k8s-service ends a window it is not given; no time asks its default.
func TestNodeNeighbors_ARelativeStartCountsBackFromTheMinute(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, neighborsReply("none") })
	if _, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n1", "since_time": "2h"}, bearer()); err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	start, err := time.Parse(time.RFC3339, q.Get("start"))
	if err != nil || start.Second() != 0 || q.Get("end") != "" {
		t.Fatalf("start %q end %q", q.Get("start"), q.Get("end"))
	}
	if d := time.Now().Truncate(time.Minute).Sub(start); d < 2*time.Hour-time.Minute || d > 2*time.Hour+time.Minute {
		t.Fatalf("start %s is %s back", start, d)
	}
	if _, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer()); err != nil {
		t.Fatal(err)
	}
	if q := (*seen)[1].URL.Query(); q.Get("start") != "" || q.Get("end") != "" {
		t.Fatalf("no window asked, one sent: %s", (*seen)[1].URL.RawQuery)
	}
}

func TestNodeNeighbors_RefusesWhatItCannotAsk(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, neighborsReply("none") })
	for _, args := range []map[string]interface{}{
		{"node": "n1", "until_time": "now"},
		{"node": "n1", "since_time": "yesterday"},
	} {
		if _, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), args, bearer()); !errors.Is(err, errBadRequest) {
			t.Errorf("%v: %v, want a bad request", args, err)
		}
	}
	if len(*seen) != 0 {
		t.Fatalf("%d requests for bad arguments", len(*seen))
	}
	if err := validateToolArgs(map[string]interface{}{"node": "../../secrets"}); err == nil {
		t.Error("a path passes as a node name")
	}
}

// Names as long as Kubernetes lets them be, in every row and sentence: the answer is short all the same, the first row
// stays, a row keeps all its figures and a name its tail.
func TestNodeNeighbors_LongNamesDoNotMakeTheAnswerLong(t *testing.T) {
	long := strings.Repeat("a-long-name-", 21)[:250]
	var rows []string
	for i := 1; i <= 12; i++ {
		rows = append(rows, strings.Replace(neighborRow(i, fmt.Sprintf("%s/%s-%02d/%s", long[:63], long, i, long[:63]), "suspected_victim",
			`,"throttled":0.012,"throttled_before":0.011,"waiting":0.612,"waiting_before":0.021`), "ReplicaSet/some-owner-7d9f8b6c5", "ReplicaSet/"+long, 1))
	}
	sentences := make([]string, 10)
	reasons := make([]string, 14)
	for i := range sentences {
		sentences[i] = fmt.Sprintf("%q", fmt.Sprintf("sentence %d %s", i, strings.Repeat(long+", ", 10)))
	}
	for i := range reasons {
		reasons[i] = fmt.Sprintf(`{"what":"current_usage","reason":%q}`, "Prometheus: "+strings.Repeat(long+" ", 10))
	}
	body := neighborsReply("prometheus", rows...)
	body = strings.Replace(body, `"reading":["The node was busy from 2026-11-25T01:25:00Z: CPU 1 was busy 100% of the time at its highest step (30% before)."]`, `"reading":[`+strings.Join(sentences, ",")+`]`, 1)
	body = strings.Replace(body, `"not_run":[{"what":"waiting","reason":"no container_pressure_cpu_waiting_seconds_total series of this node"}]`, `"not_run":[`+strings.Join(reasons, ",")+`]`, 1)
	body = strings.Replace(body, `"Node/n1"`, `"Node/`+long+`"`, 1)
	for _, want := range []string{"sentence 9", `"what":"current_usage"`, "Node/a-long-name"} {
		if !strings.Contains(body, want) {
			t.Fatalf("the reply is not the one meant: no %s", want)
		}
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if n := shownLength(out); n > nodeNeighborsChars {
		t.Fatalf("%d characters as shown", n)
	}
	m := decode(t, out)
	lines := m["containers"].([]interface{})
	if len(lines) == 0 || !strings.HasPrefix(lines[0].(string), "1 | ") || len(m["reading"].([]interface{})) != 10 || len(m["not_run"].([]interface{})) != 14 {
		t.Fatalf("%s", out)
	}
	for _, l := range lines {
		line := l.(string)
		if strings.Count(line, " | ") != strings.Count(nodeWindowColumns, " | ") || !strings.Contains(line, "…") || !strings.HasSuffix(line, "0.612 (0.021)") || len(line) > 260 {
			t.Errorf("%s", line)
		}
	}
	if len(lines) < 12 && !strings.Contains(fmt.Sprint(m["containers_note"]), fmt.Sprintf("%d more rows", 12-len(lines))) {
		t.Fatalf("%d rows, %v", len(lines), m["containers_note"])
	}
}

// With ordinary sentences, long names alone are cut in the middle and every row with a role stays.
func TestNodeNeighbors_RowsWithARoleStayWithTheirNamesCut(t *testing.T) {
	long := strings.Repeat("a-long-name-", 21)[:250]
	var rows []string
	for i := 1; i <= 12; i++ {
		rows = append(rows, neighborRow(i, fmt.Sprintf("%s/%s-%02d/main", long[:63], long, i), "suspected_victim", `,"waiting":0.612`))
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, neighborsReply("prometheus", rows...) })
	out, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	lines := m["containers"].([]interface{})
	if shownLength(out) > nodeNeighborsChars || len(lines) != 12 || m["containers_note"] != nil || !strings.Contains(lines[11].(string), "-12/main") {
		t.Fatalf("%d characters, %d rows: %s", shownLength(out), len(lines), out)
	}
}

// A row left out before the names were cut is back once they are, and nothing says it is left out.
func TestNodeNeighbors_ARowThatFitsWithNamesCutIsNotLeftOut(t *testing.T) {
	long := strings.Repeat("a-long-name-", 21)[:250]
	var rows []string
	for i := 1; i <= 9; i++ {
		role := "suspected_victim"
		if i == 9 {
			role = ""
		}
		rows = append(rows, neighborRow(i, fmt.Sprintf("%s/%s-%02d/main", long[:63], long, i), role, `,"waiting":0.612`))
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, neighborsReply("prometheus", rows...) })
	out, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	lines := m["containers"].([]interface{})
	if len(lines) != 9 || m["containers_note"] != nil || !strings.Contains(lines[0].(string), "…") {
		t.Fatalf("%d rows, %v", len(lines), m["containers_note"])
	}
}

func TestNodeNeighbors_CutsKeepTheHeadOfASentenceAndTheEndsOfAName(t *testing.T) {
	if got := headOf("abcdef", 4); got != "abc…" || headOf("abcd", 4) != "abcd" || headOf("가나다라마", 3) != "가나…" {
		t.Fatalf("%q", got)
	}
	if got := middleCut("abcdefghij", 5); got != "ab…ij" || middleCut("abcde", 5) != "abcde" || middleCut("abcdefghij", 0) != "abcdefghij" {
		t.Fatalf("%q", got)
	}
}

// With no node the tool is what it was: kubectl top nodes, and nothing of k8s-service is asked.
func TestNodeMetricsWithoutANodeIsTheToolAsItWas(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, neighborsReply("none") })
	for _, args := range []map[string]interface{}{{}, nil, {"node": ""}, {"node": "  "}, {"since_time": "1h"}} {
		calls := fakeKubectl(t, func([]string) (string, error) { return "n1   250m   6%   1200Mi   15%\n", nil })
		got, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), args, nil)
		if err != nil {
			t.Fatal(err)
		}
		want, err := handleGetNodeMetrics(ctxFor("c1"), args, nil)
		if err != nil || got != want {
			t.Errorf("%v: %s, want %s (%v)", args, got, want, err)
		}
		if len(*calls) != 2 || strings.Join(verb((*calls)[0]), " ") != "top nodes --no-headers" {
			t.Errorf("%v: %v", args, *calls)
		}
	}
	if len(*seen) != 0 {
		t.Fatalf("%d requests to k8s-service", len(*seen))
	}
}

func TestNodeNeighbors_OffIsUnavailableAndAMissingNodeIsNotFound(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 404, `{"detail":"node neighbors is off (features.nodeNeighbors.enabled)"}`
	})
	out, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if m := decode(t, out); err != nil || m["status"] != "unavailable" || !strings.Contains(fmt.Sprint(m["alternative"]), "get_node_metrics without node") {
		t.Fatalf("%v %s", err, out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 404, `{"detail":"nodes \"n9\" not found"}` })
	out, err = handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n9"}, bearer())
	if m := decode(t, out); err != nil || m["status"] != "not_found" {
		t.Fatalf("%v %s", err, out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 403, `{"detail":"nodes \"n1\" is forbidden"}` })
	out, err = handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if m := decode(t, out); err != nil || m["status"] != "forbidden" {
		t.Fatalf("%v %s", err, out)
	}
}

// The answer stays short as the model is shown it: the smallest rows without a role go, the ones with a role stay.
func TestNodeNeighbors_KeepsTheAnswerShortAndTheRowsWithARole(t *testing.T) {
	var rows []string
	for i := 1; i <= 12; i++ {
		role := ""
		if i == 1 {
			role = "suspected_aggressor"
		}
		if i >= 10 {
			role = "suspected_victim"
		}
		rows = append(rows, neighborRow(i, fmt.Sprintf("a-rather-long-namespace/%s-7d9f8b6c5-x%02d/main-container", strings.Repeat("long-name-", 15), i), role,
			`,"throttled":0.012,"throttled_before":0.011,"waiting":0.612,"waiting_before":0.021`))
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, neighborsReply("prometheus", rows...) })
	out, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if n := shownLength(out); n > nodeNeighborsChars || n < nodeNeighborsChars/2 {
		t.Fatalf("%d characters as shown", n)
	}
	m := decode(t, out)
	lines := m["containers"].([]interface{})
	roles := 0
	for _, l := range lines {
		if strings.Contains(l.(string), "suspected_") {
			roles++
		}
	}
	if len(lines) >= 12 || roles != 4 || !strings.Contains(fmt.Sprint(m["containers_note"]), fmt.Sprintf("%d more rows", 12-len(lines))) {
		t.Fatalf("%d rows, %d roles, %v", len(lines), roles, m["containers_note"])
	}
	if !strings.HasPrefix(lines[0].(string), "1 | ") {
		t.Fatalf("the first row is not the first: %v", lines[0])
	}
}
