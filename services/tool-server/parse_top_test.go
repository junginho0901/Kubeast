package main

import (
	"net/http"
	"testing"
)

// kubectl top writes a sentence where it has no pod to list (on the same stream as the table, runKubectl): it is no row.
func TestParseTopPodsReadsNoRowFromKubectlsSentence(t *testing.T) {
	const rows = "web-1   12m   30Mi\nno-resources-found   1m   2Mi\n"
	for _, c := range []struct {
		name, output  string
		allNamespaces bool
		pods          int
	}{
		{"a namespace without a pod", "No resources found in shop namespace.\n", false, 0},
		{"a namespace without a pod, with spaces around the sentence", "\n  No resources found in shop namespace.", false, 0},
		{"the default namespace", "No resources found in default namespace.\n", false, 0},
		{"no namespace has one", "No resources found\n", true, 0},
		{"a namespace's sentence in a read of every one", "No resources found in shop namespace.\n", true, 0},
		{"nothing", "", false, 0},
		{"rows", rows, false, 2},
		{"rows of every namespace", "shop   web-1   12m   30Mi\n", true, 1},
	} {
		got := parseTopPods(c.output, c.allNamespaces)
		if got == nil || len(got) != c.pods {
			t.Errorf("%s: %d rows %v, want %d (an empty list, not null)", c.name, len(got), got, c.pods)
		}
	}
	if got := parseTopPods(rows, false); got[0]["name"] != "web-1" || got[1]["name"] != "no-resources-found" || got[1]["cpu"] != "1m" || got[1]["memory"] != "2Mi" {
		t.Errorf("a pod's row: %v", got)
	}
}

// The tool's whole answer for a namespace without a pod is an empty list, with the result details off.
func TestGetPodMetricsOfANamespaceWithoutAPodIsAnEmptyList(t *testing.T) {
	for _, details := range []string{"", "false"} {
		t.Setenv("AI_TOOL_RESULT_DETAILS", details)
		fakeK8sService(t, func(*http.Request) (int, string) { return 200, "{}" })
		fakeKubectl(t, func([]string) (string, error) { return "No resources found in shop namespace.\n", nil })
		out, err := handleGetPodMetrics(ctxFor("pod-metrics-none"), map[string]interface{}{"namespace": "shop"}, bearer())
		if err != nil || out != "[]" {
			t.Errorf("details %q: %q, %v, want []", details, out, err)
		}
	}
}
