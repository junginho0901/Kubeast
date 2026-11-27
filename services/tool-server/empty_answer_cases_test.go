package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
)

// An investigation's verdict reads whether an answer read and whether it holds anything (ai-service
// investigation/answers.py), by what tool-server writes. Go writes the answers here with what each is;
// test_investigation_answers.py reads them. UPDATE_EMPTY_ANSWER_CASES=1 writes the file; otherwise this test fails when
// the file is not what the code answers now.
const emptyAnswerCasesFile = "../ai-service/tests/fixtures/empty_answers.json"

type emptyAnswerCase struct {
	Name    string `json:"name"`
	Tool    string `json:"tool"`
	Details bool   `json:"details"`        // AI_TOOL_RESULT_DETAILS
	Past    bool   `json:"past,omitempty"` // AI_PAST_HINTS
	Answer  string `json:"answer"`
	Holds   string `json:"holds"` // something, nothing (it read and found none) or unread (it did not read)
}

func emptyAnswerCaseSet(t *testing.T) []emptyAnswerCase {
	t.Helper()
	withOutputCap(t, 1000)
	app := `{"apiVersion":"argoproj.io/v1alpha1","kind":"List","items":[{"kind":"Application","metadata":{"name":"web","namespace":"argocd"},` +
		`"spec":{"project":"shop","destination":{"namespace":"shop"}},"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}}]}`
	noApps := `{"apiVersion":"v1","kind":"List","items":[]}`
	long := strings.Repeat("line of a log\n", 100)
	table := func(rows string) func([]string) (string, error) {
		return kubectlSays("NAMESPACE   NAME\n" + rows)
	}
	web := args{"pod_name": "web-1", "namespace": "shop"}
	grepped := args{"pod_name": "web-1", "namespace": "shop", "grep": "web-1"}
	every := args{"pod_name": "web-1", "namespace": "shop", "all_containers": true}
	everyPrevious := args{"pod_name": "web-1", "namespace": "shop", "all_containers": true, "previous": true}
	everyPreviousGrepped := args{"pod_name": "web-1", "namespace": "shop", "all_containers": true, "previous": true, "grep": "refused"}
	of := func(names string, containers ...aContainer) func([]string) (string, error) {
		return aPod{names: names, says: defaulted, containers: containers}.kubectl
	}
	appEmpty, sideEmpty := aContainer{name: "app"}, aContainer{name: "side"}
	appWrote, appGone := aContainer{name: "app", log: "stopped\n"}, aContainer{name: "app", words: goneText}
	sideGone, sideNever := aContainer{name: "side", words: goneFile}, aContainer{name: "side", never: true}
	sideWaits := notYet("side", "waiting to start: PodInitializing")
	everyGrepped := args{"pod_name": "web-1", "namespace": "shop", "all_containers": true, "grep": "refused"}
	names := args{"resource_type": "configmaps", "namespace": "shop", "output": "name"}
	file := args{"namespace": "shop", "pod_name": "web-1", "path": "/var/log/web-1.log"}
	type given struct {
		name    string
		tool    string
		args    args
		kubectl func([]string) (string, error)
		status  int
		body    string
		holds   string
	}
	out := []emptyAnswerCase{}
	for _, c := range []given{
		{name: "a table of no pod", tool: "k8s_tabular_query", args: args{"resource_type": "pods", "namespace": "shop"}, kubectl: table(""), holds: "nothing"},
		{name: "a table kubectl printed nothing of", tool: "k8s_tabular_query", args: args{"resource_type": "pods", "namespace": "shop"}, kubectl: kubectlSays(""), holds: "nothing"},
		{name: "a table of a pod", tool: "k8s_tabular_query", args: args{"resource_type": "pods", "namespace": "shop"}, kubectl: table("shop   web-1\n"), holds: "something"},
		{name: "a table whose first row was cut off", tool: "k8s_tabular_query", args: args{"resource_type": "pods", "namespace": "shop"},
			kubectl: table("shop   " + strings.Repeat("x", 1200)), holds: "something"},
		{name: "a log", tool: "k8s_get_pod_logs", args: web, kubectl: kubectlSays("ready\n"), holds: "something"},
		{name: "an empty log", tool: "k8s_get_pod_logs", args: web, kubectl: kubectlSays(""), holds: "nothing"},
		{name: "a search of a log without a match", tool: "k8s_get_pod_logs", args: grepped, kubectl: kubectlSays("ready\n"), holds: "nothing"},
		{name: "a search of a cut log without a match", tool: "k8s_get_pod_logs", args: grepped, kubectl: kubectlSays(long), holds: "nothing"},
		{name: "a search of a cut log with a match", tool: "k8s_get_pod_logs", args: grepped, kubectl: kubectlSays(long + "web-1 stopped\n"), holds: "something"},
		{name: "a cut log", tool: "k8s_get_pod_logs", args: web, kubectl: kubectlSays(long), holds: "something"},
		{name: "a log whose container is gone", tool: "k8s_get_pod_logs", args: args{"pod_name": "web-1", "namespace": "shop", "container": "app", "previous": true}, kubectl: kubectlSays(goneText), holds: "unread"},
		{name: "a log whose file is gone", tool: "k8s_get_pod_logs", args: web, kubectl: kubectlSays(defaulted + goneFile), holds: "unread"},
		{name: "a search of a log whose container is gone", tool: "k8s_get_pod_logs", args: grepped, kubectl: kubectlSays(goneText), holds: "unread"},
		{name: "logs whose containers are gone", tool: "k8s_get_pod_logs", args: every, kubectl: of("app side", appGone, sideGone), holds: "unread"},
		{name: "a log beside one whose container is gone", tool: "k8s_get_pod_logs", args: every, kubectl: kubectlSays("[pod/web-1/app] " + goneText + "[pod/web-1/side] ready\n"), holds: "something"},
		{name: "a line of a log with the words of one that is gone", tool: "k8s_get_pod_logs", args: web, kubectl: kubectlSays(goneText + "\n"), holds: "something"},
		{name: "a line of a log with those words and no end", tool: "k8s_get_pod_logs", args: web, kubectl: of("app", aContainer{name: "app", log: goneText}), holds: "something"},
		{name: "a search of an empty log", tool: "k8s_get_pod_logs", args: grepped, kubectl: kubectlSays(""), holds: "nothing"},
		{name: "an empty log of the container kubectl picked", tool: "k8s_get_pod_logs", args: web, kubectl: of("app side", appEmpty, sideEmpty), holds: "nothing"},
		{name: "a search of it for a word of kubectl's line", tool: "k8s_get_pod_logs", args: args{"pod_name": "web-1", "namespace": "shop", "grep": "Defaulted"}, kubectl: of("app side", appEmpty, sideEmpty), holds: "nothing"},
		{name: "an empty log beside one whose container is gone", tool: "k8s_get_pod_logs", args: every, kubectl: of("app side", appGone, sideEmpty), holds: "nothing"},
		{name: "previous logs past a container that has not restarted", tool: "k8s_get_pod_logs", args: everyPrevious, kubectl: of("app side", sideNever, appWrote), holds: "something"},
		{name: "a search of those without a match", tool: "k8s_get_pod_logs", args: everyPreviousGrepped, kubectl: of("app side", sideNever, appWrote), holds: "nothing"},
		{name: "a previous log without a line past a container that has not restarted", tool: "k8s_get_pod_logs", args: everyPrevious, kubectl: of("app side", sideNever, appEmpty), holds: "nothing"},
		{name: "a previous log that is gone past a container that has not restarted", tool: "k8s_get_pod_logs", args: everyPrevious, kubectl: of("app side", sideNever, appGone), holds: "unread"},
		{name: "previous logs of containers that have not restarted", tool: "k8s_get_pod_logs", args: everyPrevious, kubectl: of("side", sideNever), holds: "unread"},
		{name: "logs past a container that has not started", tool: "k8s_get_pod_logs", args: every, kubectl: of("app side", sideWaits, appWrote), holds: "something"},
		{name: "a search of logs past a container that has not started", tool: "k8s_get_pod_logs", args: everyGrepped, kubectl: of("app side", sideWaits, appWrote), holds: "nothing"},
		{name: "a log without a line past a container that has not started", tool: "k8s_get_pod_logs", args: every, kubectl: of("app side", sideWaits, appEmpty), holds: "nothing"},
		{name: "a log that is gone past a container that has not started", tool: "k8s_get_pod_logs", args: every, kubectl: of("app side", sideWaits, appGone), holds: "unread"},
		{name: "an empty log of a window", tool: "k8s_get_pod_logs", args: args{"pod_name": "web-1", "namespace": "shop", "since": "10m"}, kubectl: func(a []string) (string, error) {
			if has(a, "--timestamps") {
				return "2026-11-25T04:28:58.000000000Z ready", nil
			}
			return "", nil
		}, holds: "nothing"},
		{name: "a search without a match, of lines with times", tool: "k8s_get_pod_logs", args: grepped, kubectl: func(a []string) (string, error) {
			if has(a, "--timestamps") {
				return "2026-11-25T04:28:58.000000000Z ready", nil
			}
			return "ready\n", nil
		}, holds: "nothing"},
		{name: "no event", tool: "k8s_get_events", args: args{"namespace": "shop"}, status: 200, body: noEvents, holds: "nothing"},
		{name: "an admission policy's events alone", tool: "k8s_get_events", args: args{"namespace": "shop"}, status: 200, body: eventsReply(policyEvent), holds: "something"},
		{name: "a list of no name", tool: "k8s_get_resources", args: names, kubectl: kubectlSays(""), holds: "nothing"},
		{name: "a list of no event's name", tool: "k8s_get_resources", args: args{"resource_type": "events", "all_namespaces": true, "output": "name"}, kubectl: kubectlSays(""), holds: "nothing"},
		{name: "a list of a name", tool: "k8s_get_resources", args: names, kubectl: kubectlSays("configmap/web\n"), holds: "something"},
		{name: "a table of no object", tool: "k8s_get_resources", args: args{"resource_type": "configmaps", "namespace": "shop"}, kubectl: kubectlSays(noPodsTable), holds: "nothing"},
		{name: "a file's lines", tool: "logfiles", args: file, status: 200, body: `{"path":"/var/log/web-1.log","content":"ready\n"}`, holds: "something"},
		{name: "an empty file", tool: "logfiles", args: file, status: 200, body: `{"path":"/var/log/web-1.log","content":""}`, holds: "nothing"},
		{name: "a file the command could not read", tool: "logfiles", args: file, status: 422, body: `{"detail":"tail: cannot open '/var/log/web-1.log'","reason":"read"}`, holds: "unread"},
		{name: "a file that is not there", tool: "logfiles", args: file, status: 404, body: `{"detail":"container not found"}`, holds: "unread"},
		{name: "every application healthy", tool: "gitops_status", args: args{"only_problems": true}, kubectl: kubectlSays(app), holds: "something"},
		{name: "every application of a namespace healthy", tool: "gitops_status", args: args{"destination_namespace": "shop", "only_problems": true}, kubectl: kubectlSays(app), holds: "something"},
		{name: "the applications", tool: "gitops_status", args: args{}, kubectl: kubectlSays(app), holds: "something"},
		{name: "no application of the project", tool: "gitops_status", args: args{"project": "other", "only_problems": true}, kubectl: kubectlSays(app), holds: "nothing"},
		{name: "no application", tool: "gitops_status", args: args{"only_problems": true}, kubectl: kubectlSays(noApps), holds: "nothing"},
	} {
		for _, details := range []bool{false, true} {
			withDetails(t, details)
			t.Setenv("AI_PAST_HINTS", "")
			fakeK8sService(t, func(*http.Request) (int, string) {
				if c.body == "" {
					return 200, noEvents
				}
				return c.status, c.body
			})
			fakeKubectl(t, func(a []string) (string, error) {
				if has(a, "api-resources") {
					return "", nil
				}
				return c.kubectl(a)
			})
			answer := runTool(t, ctxFor("empty-answers"), c.tool, c.args)
			masked, _ := redactToolOutput(answer)
			out = append(out, emptyAnswerCase{Name: c.name, Tool: c.tool, Details: details, Answer: masked, Holds: c.holds})
			// the tools AI_PAST_HINTS adds to
			if c.tool != "k8s_get_pod_logs" && c.tool != "k8s_get_events" && c.tool != "k8s_get_resources" {
				continue
			}
			t.Setenv("AI_PAST_HINTS", "true")
			masked, _ = redactToolOutput(runTool(t, ctxFor("empty-answers"), c.tool, c.args))
			out = append(out, emptyAnswerCase{Name: c.name, Tool: c.tool, Details: details, Past: true, Answer: masked, Holds: c.holds})
		}
	}
	return out
}

func TestEmptyAnswerCases(t *testing.T) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(emptyAnswerCaseSet(t)); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_EMPTY_ANSWER_CASES") == "1" {
		if err := os.WriteFile(emptyAnswerCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(emptyAnswerCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_EMPTY_ANSWER_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("empty_answers.json is not what the tools answer now: rerun with UPDATE_EMPTY_ANSWER_CASES=1 and run the ai-service test")
	}
}
