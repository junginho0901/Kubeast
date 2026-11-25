package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// logsFail reads the pod's logs and gives the answer, the error and how many times kubectl ran.
func logsFail(t *testing.T, kubectl func([]string) (string, error), with args) (string, error, int) {
	t.Helper()
	calls := fakeKubectl(t, kubectl)
	given := args{"pod_name": "web-1", "namespace": "shop"}
	for k, v := range with {
		given[k] = v
	}
	out, err := handleGetPodLogs(context.Background(), given, nil)
	return out, err, len(*calls)
}

// linesOfFailures are lines a container may write that read as a failure of kubectl's.
var linesOfFailures = []string{
	`Error from server (Forbidden): pods is forbidden: User "x" cannot list resource "pods"`,
	`Error from server (NotFound): pods "other" not found`,
	`scaling on custom.metrics.k8s.io`,
	`error: a container name must be specified for pod web-1, choose one of: [a b]`,
	`error: the server doesn't have a resource type "widgets"`,
	`previous terminated container "app" in pod "web-1" not found`,
}

// kubectl prints the logs of the containers it read before it fails: what it failed with is what it says last, and no line
// of a log is.
func TestPodLogs_AFailureIsWhatKubectlSaysAndNoLineOfALog(t *testing.T) {
	broken := `Internal error occurred: the kubelet did not answer`
	for _, line := range linesOfFailures {
		for _, log := range []string{line + "\n", "starting\n" + line + "\nready\n", line, "ready\n" + line} {
			app, side := aContainer{name: "app", log: log}, aContainer{name: "side", fails: broken}
			for _, read := range [][]aContainer{{app, side}, {side, app}} {
				for _, with := range []args{{"all_containers": true}, {"all_containers": true, "previous": true}} {
					out, err, n := logsFail(t, aPod{names: "app side", containers: read}.kubectl, with)
					if err == nil || out != "" || n != 1 || !strings.HasPrefix(err.Error(), "kubectl failed: ") || !strings.HasSuffix(err.Error(), "Error from server (BadRequest): "+broken) {
						t.Errorf("%q, %v: %q %v, kubectl ran %d times", log, with, out, err, n)
					}
				}
			}
		}
		// a read of one container that ends in the middle, or is stopped there: what was read is in the error as it was
		for _, text := range []string{
			"starting\n" + line + "\nready\nerror: unexpected EOF\n",
			"starting\n" + line + "error: unexpected EOF\n",
			"starting\n" + line + "\nError from server: etcdserver: request timed out\n",
			line + "\nerror: unexpected EOF\n",
			"starting\n" + line + "\nready\n",
			"starting\n" + line + "\nready",
		} {
			for _, with := range []args{{"container": "app"}, {}} {
				out, err, n := logsFail(t, func([]string) (string, error) { return text, errors.New("exit status 1") }, with)
				if err == nil || out != "" || n != 1 || err.Error() != "kubectl failed: "+strings.TrimSpace(text) {
					t.Errorf("%q, %v: %q %v, kubectl ran %d times", text, with, out, err, n)
				}
			}
		}
	}
}

// What kubectl fails with is read as it was: before any log, after its own line, after the lines of a log, and in several
// lines.
func TestPodLogs_AFailureOfKubectlsIsReadAsItWas(t *testing.T) {
	defaulted := "Defaulted container \"app\" out of: app, side\n"
	lines := "[pod/web-1/app] starting\n[pod/web-1/app] ready\n"
	for text, status := range map[string]string{
		`Error from server (Forbidden): pods "web-1" is forbidden: User "x" cannot get resource "pods/log" in API group "" in the namespace "shop"` + "\n":         "forbidden",
		`Error from server (Forbidden): pods "web-1" is forbidden: User "x" cannot get resource "pods/log": denied:` + "\n  error: ask the owner\n  of shop\n":     "forbidden",
		`Error from server (Forbidden): pods "web-1" is forbidden: denied by the webhook: error: no such team` + "\n":                                              "forbidden",
		defaulted + `Error from server (Forbidden): pods "web-1" is forbidden: User "x" cannot get resource "pods/log"` + "\n":                                     "forbidden",
		lines + `Error from server (Forbidden): pods "web-1" is forbidden: User "x" cannot get resource "pods/log"` + "\n":                                         "forbidden",
		`error: error from server (NotFound): pods "web-1" not found in namespace "shop"` + "\n":                                                                   "not_found",
		`Error from server (NotFound): pods "web-1" not found` + "\n":                                                                                              "not_found",
		`error: a container name must be specified for pod web-1, choose one of: [app side] or one of the init containers: [migrate]` + "\n":                       "container_required",
		`Error from server (BadRequest): previous terminated container "app" in pod "web-1" not found` + "\n":                                                      "no_previous",
		lines + `Error from server (BadRequest): previous terminated container "side" in pod "web-1" not found` + "\n":                                             "no_previous",
		"[pod/web-1/app] starting\n[pod/web-1/app] panic" + `Error from server (BadRequest): previous terminated container "side" in pod "web-1" not found` + "\n": "no_previous",
	} {
		for _, with := range []args{{}, {"all_containers": true}} {
			kubectl := func(a []string) (string, error) {
				if verb(a)[0] == "logs" {
					return kubectlErr(text)
				}
				return "", nil
			}
			out, err, _ := logsFail(t, kubectl, with)
			if err != nil || decode(t, out)["status"] != status {
				t.Errorf("%q, %v: %q %v, want %s", text, with, out, err, status)
			}
		}
	}
	// a failure before kubectl ran is not kubectl's
	if err := errors.New(`the pod's cluster is not known: Error from server (Forbidden): no`); logFailure(err) != err {
		t.Error("an error that is not kubectl's was read")
	}
}

// Of a long read only the end is kept, with what kubectl failed with.
func TestPodLogs_AFailureAfterALongLogIsWhatKubectlSays(t *testing.T) {
	withOutputCap(t, 400)
	for _, line := range linesOfFailures {
		log := strings.Repeat("retrying the connection\n", 60) + line + "\n"
		broken := aPod{containers: []aContainer{{name: "app", log: log}, {name: "side", fails: "Internal error occurred: no answer"}}}
		if out, err, _ := logsFail(t, broken.kubectl, args{"all_containers": true}); err == nil || out != "" {
			t.Errorf("%q: %q %v", line, out, err)
		}
		never := aPod{containers: []aContainer{{name: "app", log: log}, {name: "side", never: true}}}
		kubectl := func(a []string) (string, error) {
			if has(a, "--ignore-errors") {
				return kubectlErr("Error from server: etcdserver: request timed out")
			}
			return never.kubectl(a)
		}
		if out, err, _ := logsFail(t, kubectl, args{"all_containers": true, "previous": true}); err != nil || decode(t, out)["status"] != "no_previous" || decode(t, out)["container"] != "side" {
			t.Errorf("%q: %q %v", line, out, err)
		}
	}
}
