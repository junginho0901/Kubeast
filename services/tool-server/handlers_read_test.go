package main

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// Every tool result leaves through redactToolOutput: a Secret document keeps
// its shape but loses its values, and credentials elsewhere are masked.
func TestRedactToolOutput_SecretAndCredentials(t *testing.T) {
	secret := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: default\ndata:\n  password: aHVudGVyMg==\ntype: Opaque\n"
	out, stats := redactToolOutput(secret)
	if strings.Contains(out, "aHVudGVyMg==") || !strings.Contains(out, "password: <REDACTED:secret>") || !strings.Contains(out, "name: db") {
		t.Fatalf("secret values must be stripped, shape kept:\n%s", out)
	}
	if stats == nil || stats.Kinds["secret"] != 1 {
		t.Fatalf("stats: %+v", stats)
	}

	cm := "kind: ConfigMap\ndata:\n  DB_PASSWORD: hunter2\n  LOG_LEVEL: info\n"
	out, stats = redactToolOutput(cm)
	if strings.Contains(out, "hunter2") || !strings.Contains(out, "LOG_LEVEL: info") {
		t.Fatalf("configmap credential must be masked, other keys kept:\n%s", out)
	}
	if stats == nil || stats.Kinds["key_name"] != 1 {
		t.Fatalf("stats: %+v", stats)
	}

	out, stats = redactToolOutput("NAME   READY   STATUS\nweb-1  1/1     Running\n")
	if out != "NAME   READY   STATUS\nweb-1  1/1     Running\n" || stats != nil {
		t.Fatalf("plain output must pass through untouched")
	}
}

// An empty read: what the cluster answers, the answer's bytes with AI_TOOL_RESULT_DETAILS off, and what on adds.
type emptyRead struct {
	name    string
	handler func(context.Context, map[string]interface{}, http.Header) (string, error)
	args    args
	kubectl func([]string) (string, error)
	off     string
	on      []string // texts the answer holds with it on
	not     []string // and does not hold
}

const (
	noEvents    = `{"items":[],"total":0}`
	noPodsTable = "No resources found in shop namespace.\n"
	noListJSON  = "{\n    \"apiVersion\": \"v1\",\n    \"items\": [],\n    \"kind\": \"List\",\n    \"metadata\": {\n        \"resourceVersion\": \"\"\n    }\n}\n"
	// what kubectl describe ends with
	describedNoEvents = "Name:         web\nConditions:   <none>\nEvents:       <none>\n"
	noEndpoint        = `{"endpoints":{"not_ready":0,"ready":0,"total":0},"namespace":"shop","port_check":{},"ports":[{"name":"http","port":80,"protocol":"TCP"}],"service":"web","status":"NotReady","type":"ClusterIP"}`
)

func kubectlSays(out string) func([]string) (string, error) {
	return func([]string) (string, error) { return out, nil }
}

func serviceWith(slices func() (string, error)) func([]string) (string, error) {
	return func(a []string) (string, error) {
		if has(a, "endpointslices") {
			return slices()
		}
		return `{"spec":{"type":"ClusterIP","ports":[{"name":"http","port":80,"protocol":"TCP"}]}}`, nil
	}
}

func emptyReads() []emptyRead {
	const sinceOneHour = "about an hour"
	return []emptyRead{
		{name: "events of a namespace", handler: handleGetEvents, args: args{"namespace": "shop"}, off: `[]`,
			on:  []string{sinceOneHour, "k8s_get_pod_logs", "restart metrics over a longer window", "does not exist"},
			not: []string{"narrowed"}},
		{name: "events of every namespace", handler: handleGetEvents, args: args{"all_namespaces": true}, off: `[]`,
			on: []string{sinceOneHour}, not: []string{"narrowed", "does not exist"}},
		{name: "events of one object", handler: handleGetEvents, args: args{"namespace": "shop", "kind": "Deployment", "name": "web"}, off: `[]`,
			on: []string{sinceOneHour, "narrowed by kind, name or field_selector", "under their own names"}},
		{name: "events by selector", handler: handleGetEvents, args: args{"field_selector": "type=Warning"}, off: `[]`,
			on: []string{sinceOneHour, "narrowed by kind, name or field_selector"}},

		{name: "a table", handler: handleGetResources, args: args{"resource_type": "configmaps", "namespace": "shop", "output": "wide"},
			kubectl: kubectlSays(noPodsTable), off: noPodsTable,
			on: []string{noPodsTable, "deleted earlier", "does not exist", "k8s_find_resource"}, not: []string{"No namespace was given"}},
		{name: "pods, a table", handler: handleGetResources, args: args{"resource_type": "pods", "namespace": "shop"},
			kubectl: kubectlSays(noPodsTable), off: noPodsTable, on: []string{noPodsTable, "deleted earlier"}},
		{name: "names", handler: handleGetResources, args: args{"resource_type": "configmaps", "all_namespaces": true, "output": "name"},
			kubectl: kubectlSays(""), off: "", on: []string{"deleted earlier"}, not: []string{"does not exist", "No namespace was given"}},
		{name: "a JSON list", handler: handleGetResources, args: args{"resource_type": "configmaps", "output": "json"},
			kubectl: kubectlSays(noListJSON), off: noListJSON, on: []string{`"empty_reason"`, `"items": []`, "No namespace was given"}},

		{name: "a table after a warning", handler: handleGetResources, args: args{"resource_type": "configmaps", "namespace": "shop"},
			kubectl: kubectlSays("Warning: deprecated\n" + noPodsTable), off: "Warning: deprecated\n" + noPodsTable, on: []string{"deleted earlier"}},
		{name: "events as a list", handler: handleGetResources, args: args{"resource_type": "events", "namespace": "shop"},
			kubectl: kubectlSays(noPodsTable), off: noPodsTable, on: []string{noPodsTable, sinceOneHour, "does not exist"}, not: []string{"deleted earlier"}},
		{name: "a described object without events", handler: handleDescribeResource, args: args{"resource_type": "deployments", "resource_name": "web", "namespace": "shop"},
			kubectl: kubectlSays(describedNoEvents), off: describedNoEvents, on: []string{describedNoEvents, sinceOneHour, "logs and metrics"}},

		{name: "a log", handler: handleGetPodLogs, args: args{"pod_name": "web-1", "namespace": "shop"},
			kubectl: kubectlSays(""), off: "",
			on:  []string{"newest 50 lines", "previous=true", "all_containers=true", "log store"},
			not: []string{"since"}},
		{name: "a log since", handler: handleGetPodLogs, args: args{"pod_name": "web-1", "namespace": "shop", "since": "10m", "previous": true, "all_containers": true},
			kubectl: kubectlSays(""), off: "", on: []string{"within since=10m", "log store"}, not: []string{"previous=true", "all_containers=true"}},
		{name: "a search of an empty log", handler: handleGetPodLogs, args: args{"pod_name": "web-1", "namespace": "shop", "grep": "error"},
			kubectl: kubectlSays(""), off: `# grep "error": 0 of 0 lines matched`, on: []string{"newest 2000 lines", "previous=true"}, not: []string{"of 1 lines", "of 0 lines"}},
		{name: "a search without a match", handler: handleGetPodLogs, args: args{"pod_name": "web-1", "namespace": "shop", "grep": "error"},
			kubectl: kubectlSays("a\nb\nc\n"), off: `# grep "error": 0 of 3 lines matched`,
			on: []string{`# grep "error": 0 of 3 lines matched`, "substring", "newest 2000 lines", "previous=true", "log store"}},

		{name: "pod metrics of every namespace", handler: handleGetPodMetrics, args: args{},
			kubectl: kubectlSays("No resources found\n"), off: `[]`, on: []string{"newest sample", `"pods":[]`}},
		{name: "pod metrics of a namespace", handler: handleGetPodMetrics, args: args{"namespace": "shop"},
			kubectl: kubectlSays(noPodsTable), off: `[]`,
			on: []string{"newest sample", `"pods":[]`, "does not exist"}, not: []string{`"cpu":"resources"`}},

		{name: "a Service without an endpoint", handler: handleCheckServiceConnectivity, args: args{"service_name": "web", "namespace": "shop"},
			kubectl: serviceWith(func() (string, error) { return `{"items":[]}`, nil }), off: noEndpoint,
			on: []string{"selector", `"status":"NotReady"`}, not: []string{"could not be read"}},
	}
}

func (c emptyRead) run(t *testing.T, details string) string {
	t.Helper()
	t.Setenv("AI_TOOL_RESULT_DETAILS", details)
	fakeK8sService(t, func(*http.Request) (int, string) { return 200, noEvents })
	respond := c.kubectl
	if respond == nil {
		respond = func([]string) (string, error) { t.Fatal("kubectl must not run"); return "", nil }
	}
	fakeKubectl(t, func(a []string) (string, error) {
		if has(a, "api-resources") {
			return "", nil
		}
		return respond(a)
	})
	out, err := c.handler(ctxFor("empty-reads"), c.args, bearer())
	if err != nil {
		t.Fatalf("%s: %v", c.name, err)
	}
	return out
}

func TestEmptyReads_OffTheAnswersAreTheBytesTheyWere(t *testing.T) {
	for _, c := range emptyReads() {
		for _, details := range []string{"", "false", "0"} {
			if out := c.run(t, details); out != c.off {
				t.Errorf("%s (%q): %q, want %q", c.name, details, out, c.off)
			}
		}
	}
}

func TestEmptyReads_OnTheAnswerSaysWhyItMayBeEmpty(t *testing.T) {
	for _, c := range emptyReads() {
		out := c.run(t, "true")
		for _, want := range c.on {
			if !strings.Contains(out, want) {
				t.Errorf("%s: %q is not in %s", c.name, want, out)
			}
		}
		for _, not := range c.not {
			if strings.Contains(out, not) {
				t.Errorf("%s: %q is in %s", c.name, not, out)
			}
		}
		// masked as it leaves tool-server, the answer is the same
		if masked, _ := redactToolOutput(out); masked != out {
			t.Errorf("%s: masked %s, was %s", c.name, masked, out)
		}
		// no answer to an empty read ends the work
		for _, stop := range []string{"Stop", "stop searching", "ask for"} {
			if strings.Contains(out, stop) {
				t.Errorf("%s: %q is in %s", c.name, stop, out)
			}
		}
		if strings.HasPrefix(strings.TrimSpace(out), "{") {
			var m map[string]interface{}
			if err := json.Unmarshal([]byte(out), &m); err != nil {
				t.Errorf("%s: not JSON: %v: %s", c.name, err, out)
			}
			if _, ok := m["empty_reason"].(string); !ok {
				t.Errorf("%s: no empty_reason: %s", c.name, out)
			}
		}
	}
}

// What an empty JSON list held is still there beside the reason.
func TestEmptyReads_OnAJSONListKeepsItsKeys(t *testing.T) {
	for _, c := range emptyReads() {
		if c.name != "a JSON list" {
			continue
		}
		on, off := decode(t, c.run(t, "true")), decode(t, c.run(t, ""))
		delete(on, "empty_reason")
		if !reflect.DeepEqual(on, off) {
			t.Fatalf("on %v, off %v", on, off)
		}
	}
}

// An answer that holds something is the same bytes with the switch on and off, and no more is read for it.
func TestEmptyReads_AnAnswerThatHoldsSomethingIsTheSame(t *testing.T) {
	const oneEvent = `{"items":[{"namespace":"shop","type":"Warning","reason":"BackOff","message":"m","count":3,"involved_object":{"kind":"Pod","name":"web-1"}}],"total":1}`
	for _, c := range []struct {
		name    string
		handler func(context.Context, map[string]interface{}, http.Header) (string, error)
		args    args
		reply   string
		kubectl func([]string) (string, error)
	}{
		{"events", handleGetEvents, args{"namespace": "shop"}, oneEvent, kubectlSays("")},
		{"events, more than listed", handleGetEvents, args{"namespace": "shop", "limit": 1}, strings.Replace(oneEvent, `"total":1`, `"total":9`, 1), kubectlSays("")},
		{"a table", handleGetResources, args{"resource_type": "configmaps", "namespace": "shop"}, "", kubectlSays("NAME   DATA   AGE\nweb    1      1d\n")},
		{"a JSON list", handleGetResources, args{"resource_type": "configmaps", "namespace": "shop", "output": "json"}, "",
			kubectlSays(`{"apiVersion":"v1","items":[{"metadata":{"name":"web"}}],"kind":"List"}`)},
		// one object whose own items field is empty is not a list that holds nothing
		{"one object", handleGetResources, args{"resource_type": "foos", "resource_name": "web", "namespace": "shop", "output": "json"}, "",
			kubectlSays(`{"items":[],"kind":"FooList"}`)},
		// an expression prints nothing for an unset field too
		{"an expression", handleGetResources, args{"resource_type": "configmaps", "namespace": "shop", "output": "jsonpath={.items[*].data.x}"}, "", kubectlSays("")},
		{"a described object", handleDescribeResource, args{"resource_type": "pods", "resource_name": "web-1", "namespace": "shop"}, "",
			kubectlSays("Name:  web-1\nEvents:\n  Type    Reason   Age   From     Message\n  ----    ------   ----  ----     -------\n  Normal  Started  5m    kubelet  Started container app\n")},
		{"a log", handleGetPodLogs, args{"pod_name": "web-1", "namespace": "shop"}, "", kubectlSays("a\nb\n")},
		{"a log of a blank line", handleGetPodLogs, args{"pod_name": "web-1", "namespace": "shop"}, "", kubectlSays("\n")},
		{"a search", handleGetPodLogs, args{"pod_name": "web-1", "namespace": "shop", "grep": "a"}, "", kubectlSays("a\nb\n")},
		{"pod metrics", handleGetPodMetrics, args{"namespace": "shop"}, "", kubectlSays("web-1   5m   20Mi\n")},
		{"a Service", handleCheckServiceConnectivity, args{"service_name": "web", "namespace": "shop"}, "",
			serviceWith(func() (string, error) { return `{"items":[{"endpoints":[{"addresses":["10.0.0.1"]}]}]}`, nil })},
	} {
		run := func(details string) (string, int) {
			t.Setenv("AI_TOOL_RESULT_DETAILS", details)
			seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, c.reply })
			calls := fakeKubectl(t, func(a []string) (string, error) {
				if has(a, "api-resources") {
					return "", nil
				}
				return c.kubectl(a)
			})
			out, err := c.handler(ctxFor("empty-reads"), c.args, bearer())
			if err != nil {
				t.Fatalf("%s: %v", c.name, err)
			}
			return out, len(*seen) + len(*calls)
		}
		run("") // what is kept per cluster (api-resources) is kept before the two are compared
		off, offReads := run("")
		on, onReads := run("true")
		if on != off || onReads != offReads {
			t.Errorf("%s: on %q (%d reads), off %q (%d reads)", c.name, on, onReads, off, offReads)
		}
	}
}
