package main

import (
	"errors"
	"net/http"
	"strings"
	"testing"
)

const (
	topNodes     = "n1   1205m   15%   1809Mi   2%\n"
	topNodesJSON = `[{"cpu":"1205m","cpu_percent":"15%","memory":"1809Mi","memory_percent":"2%","name":"n1"}]`
)

func withBusiest(t *testing.T, neighbors, busiest string) {
	t.Helper()
	t.Setenv("NODE_NEIGHBORS_ENABLED", neighbors)
	t.Setenv("NODE_NEIGHBORS_BUSIEST_CPU", busiest)
}

func nodeMetrics(t *testing.T, a map[string]interface{}) string {
	t.Helper()
	fakeKubectl(t, func([]string) (string, error) { return topNodes, nil })
	out, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), a, bearer())
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestBusiestCPU_OffTheNodesUsageIsTheBytesItWas(t *testing.T) {
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, `{"line":"Busiest CPU"}` })
	for _, c := range [][2]string{{"", ""}, {"true", ""}, {"true", "false"}, {"", "true"}, {"false", "true"}, {"0", "1"}} {
		withBusiest(t, c[0], c[1])
		for _, a := range []map[string]interface{}{nil, {}, {"node": " "}, {"since_time": "1h"}} {
			if out := nodeMetrics(t, a); out != topNodesJSON {
				t.Errorf("%v %v: %s", c, a, out)
			}
		}
	}
	if len(*seen) != 0 {
		t.Fatalf("%d requests to k8s-service", len(*seen))
	}
}

func TestBusiestCPU_OnTheLineIsInFrontOfTheNodesUsage(t *testing.T) {
	withBusiest(t, "true", "true")
	seen := fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, `{"line":"Busiest CPU in the last hour: CPU 1 of Node/n1.","window":{},"step_seconds":120,"store_queries":3}`
	})
	out := nodeMetrics(t, map[string]interface{}{})
	if want := `{"busiest_cpu":"Busiest CPU in the last hour: CPU 1 of Node/n1.","nodes":` + topNodesJSON + `}`; out != want {
		t.Fatalf("%s\nwant %s", out, want)
	}
	r := (*seen)[0]
	if len(*seen) != 1 || r.Method != http.MethodGet || r.URL.Path != "/api/v1/metrics/nodes/busiest-cpu" || r.URL.Query().Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("%d requests, %s %s", len(*seen), r.Method, r.URL)
	}
	// with a node it is that node's neighbours, and the line is not read
	seen = fakeK8sService(t, func(*http.Request) (int, string) { return 200, neighborsReply("none") })
	if out := nodeMetrics(t, map[string]interface{}{"node": "n1"}); !strings.HasPrefix(out, `{"node":{`) || len(*seen) != 1 || !strings.HasSuffix((*seen)[0].URL.Path, "/nodes/n1/neighbors") {
		t.Fatalf("%s", out)
	}
}

func TestBusiestCPU_WhereItIsOffInK8sServiceTheAnswerIsTheNodesUsage(t *testing.T) {
	withBusiest(t, "true", "true")
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 404, `{"detail":"the busiest CPU is off (features.nodeNeighbors.busiestCPU)"}`
	})
	if out := nodeMetrics(t, nil); out != topNodesJSON {
		t.Fatalf("%s", out)
	}
}

// The line is beside the nodes' usage, which stands whatever happens to it, and a full CPU that was not looked for is said.
func TestBusiestCPU_ALineThatCouldNotBeReadSaysSoAndTheNodesStand(t *testing.T) {
	withBusiest(t, "true", "true")
	for name, c := range map[string]struct {
		status int
		body   string
		want   string
	}{
		"refused":          {403, `{"detail":"nodes is forbidden: User \"u\" cannot list"}`, "were not read (nodes is forbidden"},
		"failed":           {502, `{"detail":"Prometheus did not answer"}`, "were not read (Prometheus did not answer)"},
		"a long reason":    {502, `{"detail":"` + strings.Repeat("x", 1000) + `"}`, "were not read (" + strings.Repeat("x", 299) + "…)"},
		"no line":          {200, `{}`, "were not read ({})"},
		"not an object":    {200, `[]`, "were not read ([])"},
		"no body to speak": {500, ``, "were not read (k8s-service did not answer)"},
	} {
		fakeK8sService(t, func(*http.Request) (int, string) { return c.status, c.body })
		m := decode(t, nodeMetrics(t, nil))
		line, _ := m["busiest_cpu"].(string)
		if !strings.Contains(line, c.want) || !strings.Contains(line, "one full CPU does not show") || len(m["nodes"].([]interface{})) != 1 {
			t.Errorf("%s: %v", name, m)
		}
	}
	// k8s-service that is not there: its address is not in the answer
	srv := k8sServiceURL
	k8sServiceURL = "http://127.0.0.1:1"
	t.Cleanup(func() { k8sServiceURL = srv })
	out := nodeMetrics(t, nil)
	if !strings.Contains(out, "were not read (k8s-service did not answer)") || strings.Contains(out, "127.0.0.1") {
		t.Errorf("%s", out)
	}
}

// Without the nodes' usage the answer is why, as before: k8s-service is not asked.
func TestBusiestCPU_WithoutMetricsServerTheAnswerIsWhatItWas(t *testing.T) {
	withBusiest(t, "true", "true")
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, `{"line":"x"}` })
	fakeKubectl(t, func([]string) (string, error) {
		return "error: Metrics API not available", errors.New("exit status 1")
	})
	out, err := handleNodeMetricsOrNeighbors(ctxFor("c1"), nil, bearer())
	if m := decode(t, out); err != nil || m["status"] != "unavailable" || len(*seen) != 0 {
		t.Fatalf("%v %s, %d requests", err, out, len(*seen))
	}
}

func TestBusiestCPU_TheLongestLineIsCut(t *testing.T) {
	withBusiest(t, "true", "true")
	fakeK8sService(t, func(*http.Request) (int, string) { return 200, `{"line":"` + strings.Repeat("a", 9000) + `"}` })
	line, _ := decode(t, nodeMetrics(t, nil))["busiest_cpu"].(string)
	if n := len([]rune(line)); n != busiestLineChars {
		t.Fatalf("%d", n)
	}
}
