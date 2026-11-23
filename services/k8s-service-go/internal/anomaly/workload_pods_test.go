package anomaly

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// quotedAfter is the string quoted right after marker in s.
func quotedAfter(t *testing.T, s, marker string) string {
	t.Helper()
	i := strings.Index(s, marker)
	if i < 0 {
		t.Fatalf("no %q in %s", marker, s)
	}
	q, err := strconv.QuotedPrefix(s[i+len(marker):])
	if err != nil {
		t.Fatalf("%s: %v", s, err)
	}
	v, err := strconv.Unquote(q)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// podRegexps are w's pods as each store reads them: Prometheus and Loki match the whole value, the TraceQL expression is
// read as written, since a Tempo may not anchor it.
func podRegexps(t *testing.T, w *Workload) map[string]*regexp.Regexp {
	t.Helper()
	l := LogLabels{Pod: "k8s_pod_name", Container: "k8s_container_name"}
	return map[string]*regexp.Regexp{
		"promql":  regexp.MustCompile("^(?:" + quotedAfter(t, w.podMatcher(), "pod=~") + ")$"),
		"logql":   regexp.MustCompile("^(?:" + quotedAfter(t, LogSelector(l, w), "=~") + ")$"),
		"traceql": regexp.MustCompile(quotedAfter(t, TraceQueries(w)[0].Query, "resource.k8s.pod.name =~ ")),
	}
}

// Deployment/cart and Deployment/cart-api, CronJob/report and CronJob/report-hourly side by side: neither the owner
// check nor the queries count the other's pods.
func TestWorkloadLeavesOutASiblingWhoseNameStartsWithItsOwn(t *testing.T) {
	cart := &Workload{Kind: "Deployment", Name: "cart"}
	if !cart.OwnsPod(owners("ReplicaSet", "cart-6d4b9c")) || cart.OwnsPod(owners("ReplicaSet", "cart-api-6d4b9c")) {
		t.Errorf("Deployment/cart owns ReplicaSet/cart-6d4b9c %v, ReplicaSet/cart-api-6d4b9c %v; query %s",
			cart.OwnsPod(owners("ReplicaSet", "cart-6d4b9c")), cart.OwnsPod(owners("ReplicaSet", "cart-api-6d4b9c")), cart.podMatcher())
	}
	report := &Workload{Kind: "CronJob", Name: "report"}
	if !report.OwnsPod(owners("Job", "report-29123")) || !report.OwnsPod(owners("Job", "report-manual-1763880000")) ||
		report.OwnsPod(owners("Job", "report-hourly-29123")) {
		t.Error("CronJob/report: its scheduled and triggered Jobs, not report-hourly's")
	}
	for _, c := range []struct {
		w            *Workload
		own, sibling []string
	}{
		{cart, []string{"cart-6d4b9c-x7k2p"}, []string{"cart-api-6d4b9c-x7k2p", "cart-api-0"}},
		{report, []string{"report-29123456-x7k2p", "report-manual-1763880000-x7k2p", "report-29123456-3-x7k2p"},
			[]string{"report-hourly-29123456-x7k2p", "report-hourly-manual-1763880000-x7k2p", "report-2-29123456-x7k2p"}},
		{&Workload{Kind: "StatefulSet", Name: "db"}, []string{"db-0", "db-12"}, []string{"db-replica-0", "db-2-0"}},
		{&Workload{Kind: "DaemonSet", Name: "agent"}, []string{"agent-x7k2p"}, []string{"agent-gpu-x7k2p"}},
		{&Workload{Kind: "ReplicaSet", Name: "web-6d4b9c"}, []string{"web-6d4b9c-x7k2p"}, []string{"web-6d4b9c-canary-x7k2p"}},
		{&Workload{Kind: "Job", Name: "migrate"}, []string{"migrate-x7k2p", "migrate-4-x7k2p"}, []string{"migrate-db-x7k2p", "migrate-29123456-x7k2p"}},
	} {
		for store, re := range podRegexps(t, c.w) {
			for _, pod := range c.own {
				if !re.MatchString(pod) {
					t.Errorf("%s/%s %s leaves out its pod %s: %s", c.w.Kind, c.w.Name, store, pod, re)
				}
			}
			for _, pod := range c.sibling {
				if re.MatchString(pod) {
					t.Errorf("%s/%s %s counts %s: %s", c.w.Kind, c.w.Name, store, pod, re)
				}
			}
		}
	}
}

// generated is a pod name the API server makes from a generateName base: the base cut to 58 bytes, then 5 letters
// (apiserver names.SimpleNameGenerator).
func generated(base string) string {
	if len(base) > 58 {
		base = base[:58]
	}
	return base + "x7k2p"
}

// indexedPod is the name of an indexed Job's pod: the Job's name cut so <job>-<index>- stays within 58 bytes (the job
// controller's podGenerateNameWithIndex), then 5 letters.
func indexedPod(job, index string) string {
	base := job + "-" + index + "-"
	if len(base) > 58 {
		base = job[:58-len(index)-2] + "-" + index + "-"
	}
	return base + "x7k2p"
}

// A long name is cut before the API server adds its letters, and the pods it names are still the workload's.
func TestWorkloadPodsOfLongNamesAreCutAsTheAPIServerCutsThem(t *testing.T) {
	name := func(n int) string { return strings.Repeat("a", n) }
	type pods struct {
		w    *Workload
		pods []string
	}
	var cases []pods
	for _, n := range []int{10, 46, 47, 50, 55, 56, 57, 58, 70} {
		c := pods{w: &Workload{Kind: "Deployment", Name: name(n)}}
		for _, hash := range []string{"b", "6d4b9c", "bcdfghjkl", "bcdfghjklm"} {
			c.pods = append(c.pods, generated(name(n)+"-"+hash+"-"))
		}
		cases = append(cases, c)
	}
	for _, n := range []int{10, 40, 46, 48, 52} {
		job := name(n) + "-29123456"
		cases = append(cases, pods{&Workload{Kind: "CronJob", Name: name(n)}, []string{generated(job + "-"),
			generated(name(n) + "-manual-1763880000-"), indexedPod(job, "3"), indexedPod(job, "12345")}})
	}
	for _, n := range []int{10, 52, 57, 60, 63} {
		cases = append(cases, pods{&Workload{Kind: "Job", Name: name(n)}, []string{generated(name(n) + "-"), indexedPod(name(n), "7"), indexedPod(name(n), "123456")}})
	}
	for _, n := range []int{10, 57, 58, 63} {
		for _, kind := range []string{"DaemonSet", "ReplicaSet"} {
			cases = append(cases, pods{&Workload{Kind: kind, Name: name(n)}, []string{generated(name(n) + "-")}})
		}
	}
	for _, c := range cases {
		for store, re := range podRegexps(t, c.w) {
			for _, pod := range c.pods {
				if !re.MatchString(pod) {
					t.Errorf("%s of %d letters, %s leaves out its pod %s: %s", c.w.Kind, len(c.w.Name), store, pod, re)
				}
			}
		}
	}
}
