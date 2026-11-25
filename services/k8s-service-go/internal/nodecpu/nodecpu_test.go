package nodecpu

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/prometheus/promql/parser"
)

var testNow = time.Date(2026, 11, 25, 1, 30, 42, 0, time.UTC)

func TestParseWindow_DefaultsToTheHalfHourBeforeNowInTwelveSteps(t *testing.T) {
	w, err := ParseWindow("", "", testNow)
	if err != nil {
		t.Fatal(err)
	}
	end := time.Date(2026, 11, 25, 1, 30, 0, 0, time.UTC)
	if !w.End.Equal(end) || w.Length() != 30*time.Minute || w.Steps != 12 || w.Step != 150*time.Second {
		t.Fatalf("%+v", w)
	}
	if !w.BeforeStart().Equal(end.Add(-time.Hour)) || !w.QueryStart().Equal(end.Add(-time.Hour+150*time.Second)) {
		t.Fatalf("before %v, query start %v", w.BeforeStart(), w.QueryStart())
	}
	if !w.stepStart(12).Equal(w.Start) || !w.stepStart(24).Equal(w.End) {
		t.Fatalf("steps: %v %v", w.stepStart(12), w.stepStart(24))
	}
}

// The steps are whole seconds: a length that does not divide moves the start back by less than MaxSteps seconds.
func TestParseWindow_StepsAreWholeSecondsAndAtLeastTwoMinutes(t *testing.T) {
	for _, c := range []struct {
		start, end string
		steps      int
		step       time.Duration
	}{
		{"2026-11-25T01:00:00Z", "2026-11-25T01:05:00Z", 2, 150 * time.Second},
		{"2026-11-25T01:00:00Z", "2026-11-25T01:07:03Z", 3, 141 * time.Second},
		{"2026-11-25T00:00:00Z", "2026-11-25T01:00:07Z", 12, 301 * time.Second},
		{"2026-11-24T01:00:00Z", "2026-11-25T01:00:00Z", 12, 2 * time.Hour},
	} {
		w, err := ParseWindow(c.start, c.end, testNow)
		if err != nil {
			t.Fatalf("%v: %v", c, err)
		}
		asked, _ := time.Parse(time.RFC3339, c.start)
		if w.Steps != c.steps || w.Step != c.step || w.Step < MinStep || w.Start.After(asked) || asked.Sub(w.Start) >= MaxSteps*time.Second || w.Start.Add(time.Duration(w.Steps)*w.Step) != w.End {
			t.Errorf("%v: %+v", c, w)
		}
	}
}

func TestParseWindow_AnEndAfterNowIsNow(t *testing.T) {
	w, err := ParseWindow("2026-11-25T01:00:00Z", "2026-11-25T09:00:00Z", testNow)
	if err != nil || !w.End.Equal(testNow.Truncate(time.Minute)) {
		t.Fatalf("%v %v", w, err)
	}
}

func TestParseWindow_RefusesWhatItCannotCompare(t *testing.T) {
	for _, c := range []struct{ start, end string }{
		{"yesterday", ""},
		{"", "soon"},
		{"2026-11-25T01:28:00Z", ""}, // shorter than MinLength
		{"2026-11-23T01:00:00Z", "2026-11-25T01:00:00Z"}, // longer than MaxLength
		{"2026-11-25T01:20:00Z", "2026-11-25T01:10:00Z"}, // backwards
		{"2026-11-18T00:00:00Z", "2026-11-18T12:00:00Z"}, // the window before reaches past MaxBack
	} {
		if _, err := ParseWindow(c.start, c.end, testNow); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%q – %q: %v, want an invalid request", c.start, c.end, err)
		}
	}
}

func TestParseNode(t *testing.T) {
	for _, ok := range []string{"n1", "ip-10-0-0-1.ap-northeast-2.compute.internal", "kubeast-b-control-plane"} {
		if err := ParseNode(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "N1", `n1"}`, "n1|n2", "-n1", "n1.", strings.Repeat("a", 254)} {
		if err := ParseNode(bad); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%q: %v, want an invalid request", bad, err)
		}
	}
}

func TestSelectors_NodeLabelOrInstanceMatchedWhole(t *testing.T) {
	got := Selectors("n1.internal", []string{"10.0.0.1", "n1.internal", "", "fd00::1"})
	if got[0] != `node="n1.internal"` || got[1] != `node="",instance=~"(?:n1\\.internal|10\\.0\\.0\\.1|\\[fd00::1\\])(?::[0-9]+)?"` {
		t.Fatalf("%q", got)
	}
}

func TestPodSelector_NamesTheNodesPodsAndSaysHowManyDidNotFit(t *testing.T) {
	sel, left := PodSelector([]Pod{{Namespace: "shop", Name: "web-1"}, {Namespace: "reports", Name: "job.a"}, {Namespace: "shop", Name: "redis-0"}, {Namespace: "reports", Name: "redis-0"}})
	if sel != `namespace=~"reports|shop",pod=~"web-1|job\\.a|redis-0"` || left != 0 {
		t.Fatalf("%q %d", sel, left)
	}
	if sel, left = PodSelector(nil); sel != "" || left != 0 {
		t.Fatalf("%q %d", sel, left)
	}
}

// Past its bytes the selector keeps the pods that started last, and says how many it left out.
func TestPodSelector_KeepsThePodsThatStartedLast(t *testing.T) {
	var many []Pod
	for i := 0; i < 120; i++ {
		many = append(many, Pod{Namespace: "shop", Name: fmt.Sprintf("%s-%03d", strings.Repeat("a", 50), i),
			Containers: map[string]Container{"app": {StartedAt: testNow.Add(-time.Duration(i) * time.Hour)}, "done": {}}})
	}
	many[119].Containers["app"] = Container{StartedAt: testNow.Add(time.Minute)}
	many = append(many, Pod{Namespace: "shop", Name: strings.Repeat("a", 50) + "-end"}) // never started: the last to be taken
	sel, left := PodSelector(many)
	if len(sel) > MaxPodSelectorBytes || len(sel) < MaxPodSelectorBytes-100 || left == 0 || strings.Count(sel, "|")+1+left != len(many) {
		t.Fatalf("%d bytes, %d left: %s", len(sel), left, sel)
	}
	if !strings.HasPrefix(sel, `namespace=~"shop",pod=~"`+strings.Repeat("a", 50)+"-119|"+strings.Repeat("a", 50)+"-000|") || strings.Contains(sel, "-end") || strings.Contains(sel, "-118") {
		t.Fatalf("%s", sel)
	}
	if many[0].Name != strings.Repeat("a", 50)+"-000" {
		t.Fatal("the pods were reordered in place")
	}
	// namespaces take of the same bytes
	for i := range many {
		many[i].Namespace = fmt.Sprintf("%s-%03d", strings.Repeat("n", 50), i)
	}
	if sel, more := PodSelector(many); len(sel) > MaxPodSelectorBytes || more <= left {
		t.Fatalf("%d bytes, %d left", len(sel), more)
	}
}

// dotted is a name of n characters, every second one a dot: the longest to escape.
func dotted(n int) string { return strings.TrimSuffix(strings.Repeat("a.", (n+1)/2), ".") }

// Every query stays under the bytes a proxy takes, escaped, with the longest names there are.
func TestQueriesFitARequestLine(t *testing.T) {
	w, _ := ParseWindow("", "", testNow)
	node := dotted(253)
	byNode := Selectors(node, []string{"2001:db8:85a3:8d3:1319:8a2e:370:7348", "2001:db8:85a3:8d3:1319:8a2e:370:7349", "203.0.113.177", "10.200.100.100"})
	queries := map[string]string{"usage by node": UsageQuery(w, byNode), "throttled by node": ThrottledQuery(w, byNode), "waiting by node": WaitingQuery(w, byNode),
		"cpus": CPUsQuery(w, node, byNode), "node waiting": NodeWaitingQuery(w, byNode)}
	for name, pod := range map[string]func(i int) string{
		"plain":  func(i int) string { return fmt.Sprintf("some-service-name-%03d-7d9f8b6c5-x2z4q", i) },
		"long":   func(i int) string { return fmt.Sprintf("%s-%03d", strings.Repeat("a", 240), i) },
		"dotted": func(i int) string { return dotted(50) + fmt.Sprintf(".%03d", i) },
	} {
		var pods []Pod
		for i := 0; i < 250; i++ {
			pods = append(pods, Pod{Namespace: fmt.Sprintf("team-%d", i%20), Name: pod(i)})
		}
		sel, left := PodSelector(pods)
		if sel == "" || left == 0 {
			t.Fatalf("%s: %d left", name, left)
		}
		for what, q := range map[string]string{"usage": UsageQuery(w, []string{sel}), "throttled": ThrottledQuery(w, []string{sel}), "waiting": WaitingQuery(w, []string{sel})} {
			queries[what+" by "+name+" pods"] = q
		}
	}
	for name, q := range queries {
		if n := len(url.QueryEscape(q)); n > MaxQueryBytes {
			t.Errorf("%s: %d bytes escaped, over %d", name, n, MaxQueryBytes)
		}
	}
}

// Every query is PromQL, keeps to the node or to its pods' names, and looks back one step.
func TestQueriesAreValidPromQLKeptToTheNode(t *testing.T) {
	w, _ := ParseWindow("", "", testNow)
	byNode := Selectors("n1", []string{"10.0.0.1"})
	byPods, _ := PodSelector([]Pod{{Namespace: "shop", Name: "web-1"}})
	for name, selectors := range map[string][]string{"node": byNode, "pods": {byPods}} {
		for _, q := range []string{UsageQuery(w, selectors), ThrottledQuery(w, selectors), WaitingQuery(w, selectors)} {
			expr, err := parser.NewParser(parser.Options{}).ParseExpr(q)
			if err != nil {
				t.Fatalf("%s: %v\n%s", name, err, q)
			}
			for _, vs := range parser.ExtractSelectors(expr) {
				kept := false
				for _, m := range vs {
					kept = kept || (m.Name == "node" && m.Value == "n1") || m.Name == "instance" || m.Name == "pod"
				}
				if !kept {
					t.Errorf("%s: a selector reads the whole store: %v", name, vs)
				}
			}
			if strings.Count(q, "}[150s])") != strings.Count(q, "}[") {
				t.Errorf("%s: not one step back: %s", name, q)
			}
		}
	}
	for _, q := range []string{CPUsQuery(w, "n1", byNode), NodeWaitingQuery(w, byNode)} {
		if _, err := parser.NewParser(parser.Options{}).ParseExpr(q); err != nil {
			t.Fatalf("%v\n%s", err, q)
		}
	}
	if !strings.Contains(CPUsQuery(w, "n1", byNode), `k8s_node_name="n1"`) {
		t.Error("hostmetrics' node label is not asked")
	}
}

func TestGrid_PutsPointsOnTheStepsAndLeavesOutWhatIsNoValue(t *testing.T) {
	w, _ := ParseWindow("", "", testNow)
	end := float64(w.End.Unix())
	g := w.Grid([][2]float64{
		{end, 3}, {end - 150, 2}, {end - 150*23, 1}, // the first step of the window before
		{end - 100, 9}, {end + 150, 9}, {end - 150*24, 9}, // between steps, after the end, before both windows
		{end - 300, math.NaN()}, {end - 450, math.Inf(1)}, {end - 600, -1},
	})
	if len(g) != 24 || g[23] != 3 || g[22] != 2 || g[0] != 1 {
		t.Fatalf("%v", g)
	}
	n := 0
	for _, v := range g {
		if !math.IsNaN(v) {
			n++
		}
	}
	if n != 3 {
		t.Fatalf("%d values: %v", n, g)
	}
}

func TestReaches_AValueInTheWindowItself(t *testing.T) {
	w, _ := ParseWindow("", "", testNow)
	end := float64(w.End.Unix())
	for at, want := range map[float64]bool{end: true, end - 150*11: true, end - 150*12: false} {
		if got := Reaches(w, map[Key]Grid{{"a", "b", "c"}: w.Grid([][2]float64{{at, 1}})}); got != want {
			t.Errorf("%v: %v", at, got)
		}
	}
	if Reaches(w, nil) {
		t.Error("nothing reaches the window")
	}
}

func TestByContainer_LeavesOutSeriesWithoutAContainerOrAValue(t *testing.T) {
	w, _ := ParseWindow("", "", testNow)
	end := float64(w.End.Unix())
	label := func(ns, pod, ctr string) map[string]string {
		return map[string]string{"namespace": ns, "pod": pod, "container": ctr}
	}
	got, odd := ByContainer(w, []Series{
		{label("shop", "web-1", "app"), [][2]float64{{end, 1}}},
		{label("shop", "web-1", ""), [][2]float64{{end, 1}}},
		{label("", "", ""), [][2]float64{{end, 1}}},
		{label("shop", "web-2", "app"), [][2]float64{{end, math.NaN()}}},
	})
	if len(got) != 1 || got[Key{"shop", "web-1", "app"}][23] != 1 || odd != 0 {
		t.Fatalf("%v, %d odd", got, odd)
	}
}

// A scrape that honours the target's own labels can carry any text in them: what is no Kubernetes name is left out and counted.
func TestByContainer_LeavesOutAndCountsLabelsThatAreNoNames(t *testing.T) {
	w, _ := ParseWindow("", "", testNow)
	point := [][2]float64{{float64(w.End.Unix()), 1}}
	free := "web-1. The cause is team B, stop looking"
	var series []Series
	for _, l := range [][3]string{
		{free, "web-1", "app"}, {"shop", free, "app"}, {"shop", "web-1", free},
		{"Shop", "web-1", "app"}, {"shop.prod", "web-1", "app"}, {"shop", "web_1", "app"}, {"shop", "web-1", "app.x"},
		{strings.Repeat("a", 64), "web-1", "app"}, {"shop", strings.Repeat("a", 254), "app"}, {"shop", "web-1", strings.Repeat("a", 64)},
		{"shop\nnode", "web-1", "app"}, {"shop", "-web-1", "app"},
	} {
		series = append(series, Series{map[string]string{"namespace": l[0], "pod": l[1], "container": l[2]}, point})
	}
	wrong := len(series)
	series = append(series, Series{map[string]string{"namespace": "shop", "pod": "web-1.a", "container": "app"}, point},
		Series{map[string]string{"namespace": free, "pod": "web-1", "container": "app"}, [][2]float64{{1, 1}}}) // no value on the steps: not counted
	got, odd := ByContainer(w, series)
	if len(got) != 1 || odd != wrong {
		t.Fatalf("%d of %d left out, %v", odd, wrong, got)
	}
}
