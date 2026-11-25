package nodecpu

import (
	"fmt"
	"math"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/prometheus/promql/parser"
)

const lastSteps = 27 // the last six minutes of the hour, where a step is two

// busiestScene is the node of one hour's busiest CPU: a batch Job takes CPU 1 of eight in the last six minutes, and the
// services of shop-03 beside it get a sliver of it.
func busiestScene(t *testing.T) *scene {
	t.Helper()
	s := newScene(t)
	s.in.Window = BusiestWindow(testNow)
	job := s.pod("reports", "monthly-report-run-x", "Job/monthly-report-run", "500m", "", s.started(lastSteps))
	s.in.Usage[job] = s.grid(from(lastSteps, 0.97))
	search := s.pod("shop-03", "search-1", "ReplicaSet/search", "20m", "1", longAgo)
	s.in.Usage[search] = s.grid(since(lastSteps, 0.05, 0.03))
	sidecar := Key{"shop-03", "search-1", "proxy"}
	s.in.Usage[sidecar] = s.grid(flat(0.02))
	idle := s.pod("shop-03", "storefront-1", "ReplicaSet/storefront", "10m", "100m", longAgo)
	s.in.Usage[idle] = s.grid(flat(0.004))
	for c := 0; c < 8; c++ {
		if c == 1 {
			s.cpu("1", since(lastSteps, 0.2, 1))
			continue
		}
		s.cpu(string(rune('0'+c)), flat(0.05))
	}
	return s
}

func busiest(s *scene) string {
	return Busiest(BusiestInput{Input: s.in, Nodes: 1}).Line
}

func holds(t *testing.T, line string, words ...string) {
	t.Helper()
	for _, w := range words {
		if !strings.Contains(line, w) {
			t.Errorf("%q is not in %s", w, line)
		}
	}
}

func TestTheBusiestWindowIsAnHourInThirtiethsOfIt(t *testing.T) {
	w := BusiestWindow(testNow)
	if got := len(allSteps(w)); got != FineSteps || w.Step != 2*time.Minute || w.End.Sub(w.BeforeStart()) != time.Hour || w.Step > time.Hour/30 {
		t.Fatalf("%d steps of %s over %s", got, w.Step, w.End.Sub(w.BeforeStart()))
	}
}

func TestTheBusiestLineNamesTheFullCPUAndThePodsOnItsNode(t *testing.T) {
	s := busiestScene(t)
	line := busiest(s)
	w := s.in.Window
	holds(t, line, "over 1 node (30 steps of 2m)", "CPU 1 of Node/n1, 100% busy at its highest", "28% over the hour",
		"90% or more in 3 steps (from "+rfc3339(w.stepStart(lastSteps))+" to "+rfc3339(w.End)+")",
		"the average over that node's 8 CPUs was 17% then, so one full CPU does not show in the node's percentage",
		"reports/monthly-report-run-x (Job/monthly-report-run) 0.97, shop-03/search-1 (ReplicaSet/search) 0.05",
		"over every namespace", "get_node_metrics with node=n1")
	if strings.Contains(line, "storefront-1") || strings.Contains(line, "may not read") || strings.Contains(line, "\n") {
		t.Errorf("%s", line)
	}
	res := Busiest(BusiestInput{Input: s.in, Nodes: 1})
	if res.StepSeconds != 120 || res.Window != (WindowJSON{rfc3339(w.End.Add(-time.Hour)), rfc3339(w.End)}) {
		t.Errorf("%+v", res)
	}
}

// The last of the steps the CPU was that busy in, not the first: the question is about now.
func TestTheBusiestLineIsAboutTheLastStepTheCPUWasThatBusyIn(t *testing.T) {
	s := busiestScene(t)
	s.in.CPUs = nil
	for c := 0; c < 8; c++ {
		s.cpu(string(rune('0'+c)), flat(0.05))
	}
	s.in.CPUs[1] = Series{Labels: map[string]string{"cpu": "1"}}
	for i := range s.grid(flat(0)) {
		v := 0.1
		if i == 3 {
			v = 1 // an earlier burst, of something else
		} else if i >= lastSteps {
			v = 0.99
		}
		s.in.CPUs[1].Points = append(s.in.CPUs[1].Points, [2]float64{float64(s.in.Window.stepStart(i + 1).Unix()), v})
	}
	line := busiest(s)
	holds(t, line, "reports/monthly-report-run-x (Job/monthly-report-run) 0.97", "90% or more in 4 steps")
}

// Another CPU of the node was full earlier in the hour, for longer: the one that is full now is the answer.
func TestTheBusiestLineIsAboutTheCPUThatIsFullNow(t *testing.T) {
	s := busiestScene(t)
	s.in.CPUs = nil
	s.cpu("0", func(i int) float64 {
		if i < 20 {
			return 1
		}
		return 0.1
	})
	s.cpu("1", since(lastSteps, 0.2, 0.95))
	holds(t, busiest(s), "CPU 1 of Node/n1, 95% busy at its highest", "reports/monthly-report-run-x (Job/monthly-report-run) 0.97")
	// the last step it was full in, though an earlier one was fuller
	s.in.CPUs = nil
	s.cpu("0", flat(0.1))
	s.cpu("1", func(i int) float64 {
		switch {
		case i == 3:
			return 1
		case i >= lastSteps:
			return 0.93
		}
		return 0.2
	})
	holds(t, busiest(s), "CPU 1 of Node/n1, 100% busy at its highest", "reports/monthly-report-run-x (Job/monthly-report-run) 0.97")
	// none is full now: the one that was, for longer
	s.in.CPUs = nil
	s.cpu("0", since(1, 0.2, 0.3))
	s.cpu("1", func(i int) float64 {
		if i == 4 || i == 5 {
			return 1
		}
		return 0.1
	})
	s.cpu("2", func(i int) float64 {
		if i == 7 {
			return 1
		}
		return 0.4
	})
	holds(t, busiest(s), "CPU 1 of Node/n1, 100% busy at its highest", "90% or more in 2 steps", "from "+rfc3339(s.in.Window.stepStart(5))+" to "+rfc3339(s.in.Window.stepStart(6))+", over every namespace, in cores: shop-03/search-1 (ReplicaSet/search) 0.07")
}

// A store's newest step can hold the node's samples and not yet the containers'.
func TestTheBusiestLineTakesTheLastStepTheContainersHave(t *testing.T) {
	s := busiestScene(t)
	for k, g := range s.in.Usage {
		g[len(g)-1] = math.NaN()
		s.in.Usage[k] = g
	}
	holds(t, busiest(s), "reports/monthly-report-run-x (Job/monthly-report-run) 0.97",
		"from "+rfc3339(s.in.Window.stepStart(28))+" to "+rfc3339(s.in.Window.stepStart(29)))
}

func TestNoCPUThatWasReadWasFull(t *testing.T) {
	s := busiestScene(t)
	s.in.CPUs = nil
	for c := 0; c < 4; c++ {
		s.cpu(string(rune('0'+c)), flat(0.3))
	}
	line := busiest(s)
	holds(t, line, "30% busy at its highest", "no CPU that was read was full for a whole step (a shorter burst is averaged over it)", "reports/monthly-report-run-x")
	if strings.Contains(line, "90% or more") {
		t.Errorf("%s", line)
	}
}

func TestPodsInNamespacesTheCallerMayNotListAreCountedNotNamed(t *testing.T) {
	s := busiestScene(t)
	s.in.Pods = s.in.Pods[1:] // the Job's pod is not among the pods the caller may list
	s.in.PodsError = "the pods on the node: forbidden"
	s.in.Readable = func(ns string) bool { return ns == "shop-03" }
	line := busiest(s)
	holds(t, line, "shop-03/search-1", "1 pod in 1 namespace whose pods you may not list, or it was not asked whether you may, used 0.97 together, counted and not named", "; the pods on the node: forbidden.")
	for _, word := range []string{"reports", "monthly"} {
		if strings.Contains(line, word) {
			t.Errorf("%q is in %s", word, line)
		}
	}
	// nowhere readable: totals only
	s.in.Pods, s.in.Readable = nil, func(string) bool { return false }
	line = busiest(s)
	holds(t, line, "no pod that may be named 0.01 cores or more", "3 pods in 2 namespaces whose pods you may not list, or it was not asked whether you may, used 1.02 together")
	for _, word := range []string{"reports", "shop-03", "search"} {
		if strings.Contains(line, word) {
			t.Errorf("%q is in %s", word, line)
		}
	}
}

func TestAPodThatRanThereAndIsGoneIsNamedAsGone(t *testing.T) {
	s := busiestScene(t)
	s.in.Pods = s.in.Pods[1:]
	holds(t, busiest(s), "reports/monthly-report-run-x [gone] 0.97")
}

func TestTheBusiestLineSaysWhatWasNotRead(t *testing.T) {
	s := busiestScene(t)
	in := BusiestInput{Input: s.in, Nodes: 3, Why: "no Prometheus reaches this cluster"}
	holds(t, Busiest(in).Line, "were not read (no Prometheus reaches this cluster)", "one full CPU does not show")

	in.Why, in.CPUs = "", nil
	holds(t, Busiest(in).Line, NoCPUsOfNodes)

	in = BusiestInput{Input: s.in, Nodes: 3, UsageWhy: "Prometheus did not answer in time"}
	in.Usage = nil
	holds(t, Busiest(in).Line, "CPU 1 of Node/n1", "Which pods used it was not read (Prometheus did not answer in time)")

	in.UsageWhy = ""
	holds(t, Busiest(in).Line, "Which pods used it was not read ("+NoUsage+")")

	in.PodsError = "the pods on the node did not answer in time"
	holds(t, Busiest(in).Line, "Which pods used it was not read ("+NoUsage+"; the pods on the node did not answer in time)")
}

func TestLoadOutsideTheContainersIsInTheBusiestLine(t *testing.T) {
	s := busiestScene(t)
	delete(s.in.Usage, Key{"reports", "monthly-report-run-x", "main"})
	holds(t, busiest(s), "1.3 outside the containers")
}

func TestSeriesPickedByPodNameCountOnlyForTheNodesPodsInTheLine(t *testing.T) {
	s := busiestScene(t)
	s.in.Usage[Key{"shop-03", "elsewhere-1", "main"}] = s.grid(flat(3))
	s.in.ByPods = true
	if line := busiest(s); strings.Contains(line, "elsewhere-1") {
		t.Errorf("%s", line)
	}
}

func TestTheBusiestNodeIsOneOfTheClustersNodes(t *testing.T) {
	nodes := []Node{{Name: "n1", Addresses: []string{"10.0.0.1"}}, {Name: "n2", Addresses: []string{"10.0.0.2", "fd00::2"}}, {Name: "n3", Addresses: []string{"10.0.0.3"}}}
	w := BusiestWindow(testNow)
	// in is of one step's value, of the last of them.
	in := func(step int, v float64) [2]float64 { return [2]float64{float64(w.stepStart(step + 1).Unix()), v} }
	at := func(v float64, kv ...string) Series {
		s := Series{Labels: map[string]string{"cpu": "1"}, Points: [][2]float64{in(29, v)}}
		for i := 0; i < len(kv); i += 2 {
			s.Labels[kv[i]] = kv[i+1]
		}
		return s
	}
	for name, c := range map[string]struct {
		series []Series
		want   string
	}{
		"by its node label":               {[]Series{at(0.9, "node", "n1", "instance", "10.0.0.2:9100"), at(0.4, "node", "n2")}, "n1"},
		"by its instance":                 {[]Series{at(0.4, "instance", "10.0.0.1:9100"), at(0.9, "instance", "10.0.0.2:9100")}, "n2"},
		"by its instance, a name":         {[]Series{at(0.9, "instance", "n3")}, "n3"},
		"by its instance, an IPv6":        {[]Series{at(0.9, "instance", "[fd00::2]:9100")}, "n2"},
		"by hostmetrics' node":            {[]Series{at(0.9, "k8s_node_name", "n3"), at(0.8, "node", "n1")}, "n3"},
		"not another cluster's node":      {[]Series{at(1, "node", "other-1", "instance", "10.0.0.2:9100"), at(0.2, "node", "n1")}, "n1"},
		"not a host that is none":         {[]Series{at(1, "instance", "10.9.9.9:9100"), at(0.2, "instance", "10.0.0.3:9100")}, "n3"},
		"not one without a value":         {[]Series{at(math.NaN(), "node", "n1"), at(0.2, "node", "n2"), {Labels: map[string]string{"node": "n3"}}}, "n2"},
		"of two as busy, the first named": {[]Series{at(1, "node", "n2"), at(1, "node", "n1")}, "n1"},
		"none":                            {[]Series{at(1, "node", "other-1")}, ""},
		"none with a value":               {[]Series{at(math.NaN(), "node", "n1"), {Labels: map[string]string{"node": "n3"}}}, ""},
		"no series":                       {nil, ""},
		"not a point between the steps":   {[]Series{{Labels: map[string]string{"node": "n1"}, Points: [][2]float64{{float64(w.End.Unix() - 30), 1}}}, at(0.1, "node", "n2")}, "n2"},
		// full now before full for longer, earlier in the hour; then for longer; then higher
		"full now":        {[]Series{{Labels: map[string]string{"node": "n1"}, Points: [][2]float64{in(3, 1), in(4, 1), in(5, 1)}}, at(0.91, "node", "n2")}, "n2"},
		"full for longer": {[]Series{at(1, "node", "n1"), {Labels: map[string]string{"node": "n3"}, Points: [][2]float64{in(20, 0.95), in(26, 0.95)}}}, "n3"},
		"never full":      {[]Series{at(0.5, "node", "n1"), {Labels: map[string]string{"node": "n3"}, Points: [][2]float64{in(2, 0.8)}}}, "n3"},
	} {
		node, ok := BusiestNode(w, c.series, nodes)
		if node.Name != c.want || ok != (c.want != "") {
			t.Errorf("%s: %q %v, want %q", name, node.Name, ok, c.want)
		}
	}
}

func TestNodesFromRows(t *testing.T) {
	nodes, cpus := NodesFromRows([]map[string]interface{}{
		{"name": "n1", "internal_ip": "10.0.0.1", "external_ip": "", "capacity": map[string]string{"cpu": "8"}},
		{"name": "n2", "internal_ip": "10.0.0.2", "external_ip": "203.0.113.2", "capacity": map[string]string{"cpu": "3920m"}},
		{"name": ""},
	})
	if cpus != 11.92 || !reflect.DeepEqual(nodes, []Node{{"n1", []string{"10.0.0.1"}, 8}, {"n2", []string{"10.0.0.2", "203.0.113.2"}, 3.92}}) {
		t.Fatalf("%v %v", cpus, nodes)
	}
}

// The query is of the nodes alone: it matches every series nodeOf takes and no other host's, which takes no place among the
// busiest and is not read.
func TestTheBusiestQueryIsOfTheNodesAlone(t *testing.T) {
	nodes := []Node{{Name: "n1.example", Addresses: []string{"10.0.0.1"}}, {Name: "n2.example", Addresses: []string{"10.0.0.2", "fd00::2", "203.0.113.2"}}}
	q, fits := BusiestQuery(BusiestWindow(testNow), nodes)
	if !fits {
		t.Fatal(q)
	}
	expr, err := parser.NewParser(parser.Options{}).ParseExpr(q)
	if err != nil {
		t.Fatalf("%v: %s", err, q)
	}
	holds(t, q, "topk(20, sum by (node, instance, cpu) (", "or sum by (k8s_node_name, cpu) (", "[120s]")
	selectors := parser.ExtractSelectors(expr)
	if len(selectors) != 3 {
		t.Fatalf("%d selectors: %s", len(selectors), q)
	}
	for _, c := range []struct {
		metric string
		labels map[string]string
		want   bool
	}{
		{"node_cpu_seconds_total", map[string]string{"node": "n1.example", "instance": "10.9.9.9:9100"}, true},
		{"node_cpu_seconds_total", map[string]string{"instance": "10.0.0.1:9100"}, true},
		{"node_cpu_seconds_total", map[string]string{"instance": "10.0.0.2"}, true},
		{"node_cpu_seconds_total", map[string]string{"instance": "203.0.113.2:9100"}, true},
		{"node_cpu_seconds_total", map[string]string{"instance": "[fd00::2]:9100"}, true},
		{"node_cpu_seconds_total", map[string]string{"instance": "n2.example:9100"}, true},
		{"system_cpu_time_seconds_total", map[string]string{"k8s_node_name": "n2.example"}, true},
		{"node_cpu_seconds_total", map[string]string{"node": "other-1", "instance": "10.0.0.1:9100"}, false},
		{"node_cpu_seconds_total", map[string]string{"node": "n1.example.other"}, false},
		{"node_cpu_seconds_total", map[string]string{"instance": "203.0.113.9:9100"}, false},
		{"node_cpu_seconds_total", map[string]string{"instance": "10.0.0.11:9100"}, false},
		{"system_cpu_time_seconds_total", map[string]string{"k8s_node_name": "n3.example"}, false},
	} {
		matched := false
		for _, ms := range selectors {
			all := true
			for _, m := range ms {
				value := c.labels[m.Name]
				if m.Name == "__name__" {
					value = c.metric
				}
				all = all && m.Matches(value)
			}
			matched = matched || all
		}
		_, taken := nodeOf(c.labels, nodes)
		if matched != c.want || taken != c.want {
			t.Errorf("%s%v: matched %v, taken %v, want %v", c.metric, c.labels, matched, taken, c.want)
		}
	}
}

// A hundred and fifty nodes of a cloud's names fit the query (what they share is written once), and one that does not fit
// says so.
func TestTheBusiestQuerysNamesFitOneQuery(t *testing.T) {
	cloud := func(n int) []Node {
		var out []Node
		for i := range n {
			ip := fmt.Sprintf("10.80.%d.%d", i/200, 10+i%200)
			out = append(out, Node{Name: "ip-" + strings.ReplaceAll(ip, ".", "-") + ".ap-northeast-2.compute.internal", Addresses: []string{ip}})
		}
		return out
	}
	for n, want := range map[int]bool{0: false, 1: true, 3: true, 150: true, 1500: false} {
		q, fits := BusiestQuery(BusiestWindow(testNow), cloud(n))
		if fits != want || (fits && len(url.QueryEscape(q)) > MaxQueryBytes) {
			t.Errorf("%d nodes: %v, %d bytes", n, fits, len(url.QueryEscape(q)))
		}
		if _, err := parser.NewParser(parser.Options{}).ParseExpr(q); n > 0 && err != nil {
			t.Errorf("%d nodes: %v", n, err)
		}
	}
	for want, names := range map[string][]string{
		"n(?:1|2)": {"n1", "n2"}, "a(?:)": {"a"}, "node(?:|-1)": {"node", "node-1"}, "(?:a|b)": {"a", "b"}, "ip-(?:1|2).x": {"ip-1.x", "ip-2.x"},
		"aa(?:|a)": {"aa", "aaa"}, `\[fd00::(?:1|2)\]`: {"[fd00::1]", "[fd00::2]"},
	} {
		if got := oneOf(names); got != want {
			t.Errorf("%v: %s, want %s", names, got, want)
		}
		re := regexp.MustCompile("^(?:" + oneOf(names) + ")$")
		for _, n := range names {
			if !re.MatchString(n) {
				t.Errorf("%s does not match %s", re, n)
			}
		}
	}
}

// Two hours in which one CPU was full for the last six minutes: steps of ten minutes average it into a CPU that was not.
func TestAFineWindowSeesTheCPUThatWasFullForAFewMinutesOfTwoHours(t *testing.T) {
	start := testNow.Truncate(time.Minute).Add(-2 * time.Hour).Format(time.RFC3339)
	full := testNow.Truncate(time.Minute).Add(-6 * time.Minute)
	analyzed := func(parse func(start, end string, now time.Time) (Window, error)) Result {
		w, err := parse(start, "", testNow)
		if err != nil {
			t.Fatal(err)
		}
		in := Input{Node: "n1", Window: w, Allocatable: 8, Usage: map[Key]Grid{}, Readable: func(string) bool { return true }}
		job := w.Grid(nil)
		var points [][2]float64
		for i := range job {
			from, to := w.stepStart(i), w.stepStart(i+1)
			share := math.Max(0, to.Sub(full).Seconds()) / w.Step.Seconds()
			if from.After(full) {
				share = 1
			}
			share = math.Min(1, share)
			if share > 0 {
				job[i] = 0.97 * share
			}
			points = append(points, [2]float64{float64(to.Unix()), 0.1 + 0.9*share})
		}
		in.Usage[Key{"reports", "run-x", "main"}] = job
		in.CPUs = []Series{{Labels: map[string]string{"cpu": "1"}, Points: points}}
		return Analyze(in)
	}
	coarse, fine := analyzed(ParseWindow), analyzed(ParseFineWindow)
	if coarse.StepSeconds != 600 || coarse.Node.Role != NodeNotBusy {
		t.Errorf("the coarse window: %s", dump(coarse))
	}
	if fine.StepSeconds != 240 || fine.Node.Role != NodeBusy || rowOf(t, fine, "reports/run-x/main").Role != RoleAggressor {
		t.Errorf("the fine window: %s", dump(fine))
	}
}

func TestParseFineWindow_AStepIsAtMostAThirtiethOfAWindowOfAnHourOrMore(t *testing.T) {
	for _, length := range []time.Duration{5 * time.Minute, 30 * time.Minute, time.Hour, 2 * time.Hour, 6*time.Hour + 7*time.Minute, 24 * time.Hour} {
		start := testNow.Truncate(time.Minute).Add(-length).Format(time.RFC3339)
		w, err := ParseFineWindow(start, "", testNow)
		if err != nil {
			t.Fatal(err)
		}
		if w.Step < MinStep || w.Step%time.Second != 0 || w.End.Sub(w.Start) != time.Duration(w.Steps)*w.Step {
			t.Errorf("%s: %d steps of %s", length, w.Steps, w.Step)
		}
		if length >= time.Hour && (w.Steps != FineSteps || w.Step > (length+FineSteps*time.Second)/FineSteps) {
			t.Errorf("%s: %d steps of %s", length, w.Steps, w.Step)
		}
	}
	// the default half hour
	if w, err := ParseFineWindow("", "", testNow); err != nil || w.Steps != 15 || w.Step != MinStep {
		t.Errorf("%+v %v", w, err)
	}
}
