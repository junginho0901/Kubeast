package k8s

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/labels"
)

// The AI's find_pods (services/ai-service resolvers._find_pods) matches a pod when every word of the query is in
// its name or in one label's key and value; the pods page's word search (Tokens) does the same on the server. Go
// writes random pods, queries and its own answer here; test_find_pods_cases.py runs the Python matcher over the
// same cases. UPDATE_FIND_PODS_CASES=1 writes the file; otherwise this test fails when the file is not what the
// code gives now.
const findPodsCasesFile = "../../../ai-service/tests/fixtures/find_pods_cases.json"

type findPodsCase struct {
	Name    string            `json:"name"`
	Labels  map[string]string `json:"labels"`
	Query   string            `json:"query"`
	Matches bool              `json:"matches"`
}

func findPodsCases() []findPodsCase {
	rng := rand.New(rand.NewSource(7))
	words := []string{"web", "api", "alarm", "broker", "db", "redis", "worker", "Payment", "svc", "v2", "7bc95", "x"}
	seps := []string{"-", "_", ".", " ", "/", ":"}
	phrase := func(n int) string {
		out := ""
		for i := 0; i < n; i++ {
			if i > 0 {
				out += seps[rng.Intn(len(seps))]
			}
			out += words[rng.Intn(len(words))]
		}
		return out
	}
	var cases []findPodsCase
	for i := 0; i < 400; i++ {
		c := findPodsCase{Name: phrase(1+rng.Intn(4)) + fmt.Sprintf("-%d", rng.Intn(30)), Labels: map[string]string{}}
		for j := rng.Intn(4); j > 0; j-- {
			c.Labels[phrase(1+rng.Intn(2))] = phrase(1 + rng.Intn(2))
		}
		c.Query = phrase(1 + rng.Intn(3))
		if rng.Intn(10) == 0 {
			c.Query = "  " + c.Query + "!!"
		}
		r := &podRow{name: c.Name, labels: podLabelPairs(c.Labels)}
		c.Matches = wordsMatchPod(searchWords(c.Query), r)
		cases = append(cases, c)
	}
	return cases
}

func TestFindPodsCasesFixture(t *testing.T) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	cases := findPodsCases()
	if err := enc.Encode(cases); err != nil {
		t.Fatal(err)
	}
	matched := 0
	for _, c := range cases {
		if c.Matches {
			matched++
		}
	}
	if matched < 40 || matched > len(cases)-40 {
		t.Fatalf("%d of %d cases match: the cases do not test both answers", matched, len(cases))
	}
	if os.Getenv("UPDATE_FIND_PODS_CASES") == "1" {
		if err := os.WriteFile(findPodsCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(findPodsCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_FIND_PODS_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("find_pods_cases.json is not what the word search gives now: rerun with UPDATE_FIND_PODS_CASES=1 and run the ai-service test")
	}
}

// The word search on the page: names and labels as find_pods matches, ranked as it ranks (running and ready first,
// then fewer restarts); the counts per namespace and node of what it matched.
func TestPodPage_WordSearchFindRankAndGroups(t *testing.T) {
	rows := []*podRow{
		row("shop", "service-alarm-broker-1", func(r *podRow) { r.restarts, r.node = 3, "n1" }),
		row("shop", "service-alarm-broker-2", func(r *podRow) { r.status, r.ready, r.node = "CrashLoopBackOff", 0, "n1" }),
		row("shop", "service-alarm-broker-3", func(r *podRow) { r.node = "n2" }),
		row("ops", "worker-1", func(r *podRow) {
			r.labels, r.node = podLabelPairs(map[string]string{"app.kubernetes.io/name": "alarm-broker"}), "n2"
		}),
		row("ops", "worker-2", func(r *podRow) { r.node = "n2" }),
	}
	page := buildPodPage(rows, PodPageQuery{Search: "Alarm broker", Tokens: true, Sort: "find", Limit: 50, Groups: true}, time.Now())
	want := []string{"ops/worker-1", "shop/service-alarm-broker-3", "shop/service-alarm-broker-1", "shop/service-alarm-broker-2"}
	if !reflect.DeepEqual(names(page), want) {
		t.Fatalf("word search = %v, want %v", names(page), want)
	}
	// the groups count what the search matched
	if !reflect.DeepEqual(page.ByNamespace, []PodGroupCount{{"shop", 3}, {"ops", 1}}) || !reflect.DeepEqual(page.ByNode, []PodGroupCount{{"n1", 2}, {"n2", 2}}) {
		t.Fatalf("groups = %+v %+v", page.ByNamespace, page.ByNode)
	}
	// the plain search stays a substring of the name, namespace, node or IP
	if got := names(buildPodPage(rows, PodPageQuery{Search: "alarm broker", Limit: 50}, time.Now())); len(got) != 0 {
		t.Fatalf("the plain search took words: %v", got)
	}
}

// A label selector on the page reads the row's label string as Kubernetes reads a pod's labels: the same selectors,
// drawn at random, select the same pods from the row as from labels.Set.
func TestPodPage_LabelSelectorAsLabelsSet(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	keys := []string{"app", "tier", "app.kubernetes.io/name", "pod-template-hash", "env"}
	values := []string{"web", "db", "web-2", "prod", ""}
	ops := []string{"%s=%s", "%s!=%s", "%s in (%s,x)", "%s notin (%s)", "%s", "!%s"}
	agree, selected := 0, 0
	for i := 0; i < 2000; i++ {
		set := labels.Set{}
		for j := rng.Intn(4); j > 0; j-- {
			set[keys[rng.Intn(len(keys))]] = values[rng.Intn(len(values))]
		}
		var parts []string
		for j := 1 + rng.Intn(2); j > 0; j-- {
			op := ops[rng.Intn(len(ops))]
			k, v := keys[rng.Intn(len(keys))], values[rng.Intn(len(values)-1)]
			if strings.Count(op, "%s") == 1 {
				parts = append(parts, fmt.Sprintf(op, k))
			} else {
				parts = append(parts, fmt.Sprintf(op, k, v))
			}
		}
		sel, err := labels.Parse(strings.Join(parts, ","))
		if err != nil {
			t.Fatalf("%q: %v", strings.Join(parts, ","), err)
		}
		want := sel.Matches(set)
		if got := sel.Matches(rowLabels(podLabelPairs(set))); got != want {
			t.Fatalf("%s on %v: row says %v, labels.Set %v", sel, set, got, want)
		}
		agree++
		if want {
			selected++
		}
	}
	if selected < 200 || selected > agree-200 {
		t.Fatalf("%d of %d selected: the cases do not test both answers", selected, agree)
	}
	rows := []*podRow{
		row("a", "web-1", func(r *podRow) { r.labels = podLabelPairs(map[string]string{"app": "web"}) }),
		row("a", "hook-1", func(r *podRow) { r.labels = podLabelPairs(map[string]string{"app": "webhook"}) }),
		row("b", "db-0", nil),
	}
	page := buildPodPage(rows, PodPageQuery{LabelSelector: labels.SelectorFromSet(labels.Set{"app": "web"}), Limit: 50}, time.Now())
	if got := names(page); !reflect.DeepEqual(got, []string{"a/web-1"}) || page.Stats.Total != 3 {
		t.Fatalf("app=web = %v (summary over %d)", got, page.Stats.Total)
	}
}

// group_top keeps that many groups and sums the rest; by_phase counts the phases.
func TestPodPage_GroupTopAndPhases(t *testing.T) {
	var rows []*podRow
	for i := 0; i < 30; i++ {
		ns := fmt.Sprintf("ns-%02d", i%6)
		rows = append(rows, row(ns, fmt.Sprintf("p-%d", i), func(r *podRow) {
			if i%3 == 0 {
				r.phase = "Pending"
			}
		}))
	}
	page := buildPodPage(rows, PodPageQuery{Groups: true, GroupTop: 2, Limit: 1}, time.Now())
	if !reflect.DeepEqual(page.ByNamespace, []PodGroupCount{{"ns-00", 5}, {"ns-01", 5}, {"(other)", 20}}) {
		t.Fatalf("by_namespace = %+v", page.ByNamespace)
	}
	if !reflect.DeepEqual(page.ByPhase, []PodGroupCount{{"Running", 20}, {"Pending", 10}}) {
		t.Fatalf("by_phase = %+v", page.ByPhase)
	}
}
