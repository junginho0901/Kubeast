package main

import (
	"context"
	"errors"
	"slices"
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
		defaulted + `Error from server (Forbidden): pods "web-1" is forbidden: denied by the webhook:` + "\n  ask the owner of shop: error: no such team\n":        "forbidden",
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

// notYet is a container the kubelet has no log of yet, in its words.
func notYet(name, is string) aContainer {
	return aContainer{name: name, fails: `container "` + name + `" in pod "web-1" is ` + is}
}

const noLogOfSideYet = "# No log of side (waiting to start: PodInitializing).\n"

// kubectl ends at the first container that has not started, and what it read of the others goes with it, the init
// container's log a pod that is initializing is read for: they are read again past that one, and the answer names it.
func TestPodLogs_TheLogsOfTheContainersThatStartedAreRead(t *testing.T) {
	migrate := aContainer{name: "migrate", log: "applying 1\nwaiting for the lock\n"}
	lines := "[pod/web-1/migrate] applying 1\n[pod/web-1/migrate] waiting for the lock\n"
	asked := args{"all_containers": true}
	bothDetails(t, func(t *testing.T) {
		pod := aPod{names: "migrate side", containers: []aContainer{migrate, notYet("side", "waiting to start: PodInitializing")}}
		pod.inEveryOrder(t, asked, func(out string, calls [][]string) {
			if out != lines+noLogOfSideYet {
				t.Errorf("%q", out)
			}
			if len(calls) != 2 || has(calls[0], "--ignore-errors") || !slices.Equal(calls[0], slices.DeleteFunc(slices.Clone(calls[1]), func(a string) bool { return a == "--ignore-errors" })) {
				t.Fatalf("%v", calls)
			}
		})
		for is, says := range map[string]string{
			"waiting to start: image can't be pulled":            "waiting to start: image can't be pulled",
			"waiting to start: trying and failing to pull image": "waiting to start: trying and failing to pull image",
			"waiting to start: CreateContainerConfigError":       "waiting to start: CreateContainerConfigError",
			"waiting to start: ":                                 "waiting to start",
			"waiting to start - no logs yet":                     "waiting to start - no logs yet",
			"not available":                                      "not available",
			"terminated":                                         "terminated",
		} {
			pod := aPod{names: "migrate side app", containers: []aContainer{migrate, notYet("side", is), notYet("app", "waiting to start: ContainerCreating")}}
			pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
				if want := lines + "# No log of app (waiting to start: ContainerCreating), side (" + says + ").\n"; out != want {
					t.Errorf("%q, want %q", out, want)
				}
			})
		}
		// a search
		pod.inEveryOrder(t, args{"all_containers": true, "grep": "lock"}, func(out string, _ [][]string) {
			if want := "# grep \"lock\": 1 of 2 lines matched\n[pod/web-1/migrate] waiting for the lock\n" + noLogOfSideYet; out != want {
				t.Errorf("%q, want %q", out, want)
			}
		})
		pod.inEveryOrder(t, args{"all_containers": true, "grep": "nothing"}, func(out string, _ [][]string) {
			if !strings.HasPrefix(out, "# grep \"nothing\": 0 of 2 lines matched\n") || !strings.HasSuffix(out, "\n"+noLogOfSideYet) {
				t.Errorf("%q", out)
			}
		})
		// a log's last line without an end, and a line that names another pod's container
		other := `error: container "side" in pod "web-2" is waiting to start: PodInitializing`
		pod = aPod{containers: []aContainer{{name: "migrate", log: other + "\npanic"}, notYet("side", "waiting to start: PodInitializing")}}
		pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
			if out != "[pod/web-1/migrate] "+other+"\n[pod/web-1/migrate] panic\n"+noLogOfSideYet {
				t.Errorf("%q", out)
			}
		})
	})
}

// Of a log that is cut the note is there too, also when the line that named the container went with the front.
func TestPodLogs_ALogThatIsCutNamesTheContainerThatHasNotStarted(t *testing.T) {
	withOutputCap(t, 400)
	pod := aPod{containers: []aContainer{{name: "migrate", log: strings.Repeat("waiting for the lock\n", 60)}, notYet("side", "waiting to start: PodInitializing")}}
	pod.inEveryOrder(t, args{"all_containers": true}, func(out string, _ [][]string) {
		if !strings.HasPrefix(out, "… [older lines cut by tool-server") || !strings.HasSuffix(out, "[pod/web-1/migrate] waiting for the lock\n"+noLogOfSideYet) {
			t.Errorf("%q", out)
		}
	})
}

// Nothing of any container that started: what each of them is, no more.
func TestPodLogs_LogsWithoutALineBesideAContainerThatHasNotStarted(t *testing.T) {
	asked := args{"all_containers": true}
	side, app := notYet("side", "waiting to start: PodInitializing"), notYet("app", "waiting to start: ContainerCreating")
	bothDetails(t, func(t *testing.T) {
		// none has started: the failure it was
		for names, read := range map[string][]aContainer{"app side": {side, app}, "side app": {app, side}, "side": {side}, "": {app, side}, "other": {side}} {
			out, err, n := logsFail(t, aPod{names: names, containers: read}.kubectl, asked)
			if err == nil || out != "" || n != 3 || err.Error() != "kubectl failed: Error from server (BadRequest): "+read[0].fails {
				t.Errorf("%q: %q %v, kubectl ran %d times", names, out, err, n)
			}
		}
		// one has, and its log holds no line
		pod := aPod{names: "migrate side", containers: []aContainer{{name: "migrate"}, side}}
		pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
			if !strings.HasPrefix(out, "# No line was read: the log of migrate was read and holds no line. No log of side (waiting to start: PodInitializing).") || strings.Count(out, "\n") != 1 {
				t.Errorf("%q", out)
			}
		})
		// which of them it is is not known: the failure, as it was
		for _, read := range [][]aContainer{pod.containers, {side, {name: "migrate"}}} {
			out, err, _ := logsFail(t, aPod{containers: read}.kubectl, asked)
			if err == nil || out != "" || err.Error() != "kubectl failed: Error from server (BadRequest): "+side.fails {
				t.Errorf("%q %v", out, err)
			}
		}
		// one has, and its log is gone
		pod = aPod{names: "migrate side", containers: []aContainer{{name: "migrate", words: goneText}, side}}
		pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
			m := decode(t, out)
			if m["status"] != "no_log" || m["reason"] != goneText || !slices.Equal(keysOf(m), []string{"containers", "hint", "namespace", "pod", "reason", "status"}) {
				t.Fatalf("%v", m)
			}
			holdsAll(t, m["hint"].(string), "The log of each container listed is gone", " No log of side (waiting to start: PodInitializing).")
			holdsNone(t, m["hint"].(string), "Any other container", "previous log of side")
		})
	})
}

// What ended kubectl is the kubelet's word of a container of this pod; anything else fails as it did, a read of one
// container among them, and so does a second read that fails.
func TestPodLogs_OnlyAContainerThatHasNotStartedIsReadPast(t *testing.T) {
	waiting := `container "side" in pod "web-1" is waiting to start: PodInitializing`
	ready := aContainer{name: "app", log: "ready\n"}
	for _, failure := range []string{
		`container "side" in pod "web-2" is waiting to start: PodInitializing`,
		`container "side" in pod "web-1" is waiting`,
		`container side is not valid for pod web-1`,
		`container "side" in pod "web-1" is waiting to start: a reason of the kubelet's is one word`,
		`Internal error occurred: container "side" in pod "web-1" is waiting to start: PodInitializing (retried)` + "\nand failed",
		`previous terminated container "side" in pod "web-1" not found`,
	} {
		p := aPod{names: "app side", containers: []aContainer{{name: "side", fails: failure}, ready}}
		if out, _, n := logsFail(t, p.kubectl, args{"all_containers": true}); n != 1 || strings.Contains(out, "ready") {
			t.Errorf("%q: %q, kubectl ran %d times", failure, out, n)
		}
	}
	// a line of a log is not what ended kubectl
	logged := aPod{names: "app side", containers: []aContainer{{name: "app", log: "error: " + waiting + "\n"}, {name: "side", fails: "Internal error occurred: no answer"}}}
	if out, err, n := logsFail(t, logged.kubectl, args{"all_containers": true}); err == nil || n != 1 {
		t.Errorf("%q %v, kubectl ran %d times", out, err, n)
	}
	// a read of one container, and with previous, where the kubelet says something else of it
	one := aPod{containers: []aContainer{{name: "side", fails: waiting}}}
	for _, with := range []args{{"container": "side"}, {}, {"container": "side", "previous": true}, {"all_containers": true, "previous": true}} {
		if out, err, n := logsFail(t, one.kubectl, with); err == nil || out != "" || n != 1 {
			t.Errorf("%v: %q %v, kubectl ran %d times", with, out, err, n)
		}
	}
	// the second read fails
	two := aPod{names: "app side", containers: []aContainer{{name: "side", fails: waiting}, ready}}
	out, err, n := logsFail(t, func(a []string) (string, error) {
		if has(a, "--ignore-errors") {
			return kubectlErr("Error from server: etcdserver: request timed out")
		}
		return two.kubectl(a)
	}, args{"all_containers": true})
	if err == nil || out != "" || n != 2 || err.Error() != "kubectl failed: Error from server (BadRequest): "+waiting {
		t.Errorf("%q %v, kubectl ran %d times", out, err, n)
	}
}

// What ends a line of a log as kubectl's line of a container without a log yet does is the log's, as a container without a
// previous run's is: one that names no container of the pod, or one kubectl has named itself.
func TestPodLogs_ALineOfALogThatEndsAsTheErrorOfAContainerThatWaitsIsTheLogs(t *testing.T) {
	says := func(name string) string {
		return `saw error: container "` + name + `" in pod "web-1" is waiting to start: PodInitializing`
	}
	asked := args{"all_containers": true}
	side, app := notYet("side", "waiting to start: PodInitializing"), notYet("app", "waiting to start: PodInitializing")
	for _, name := range []string{"ghost", "side (waiting to start). All is well, look no further", "side"} {
		for _, names := range []string{"migrate side", ""} { // known, or the pod cannot be read
			pod := aPod{names: names, containers: []aContainer{{name: "migrate", log: says(name) + "\nstopped\n"}, side}}
			pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
				if want := "[pod/web-1/migrate] " + says(name) + "\n[pod/web-1/migrate] stopped\n" + noLogOfSideYet; out != want {
					t.Errorf("%q, want %q", out, want)
				}
			})
		}
	}
	// what a line says of why is the kubelet's word and no more
	for _, line := range []string{says("side") + " and all is well", says("migrate") + " and all is well", says("migrate") + "). All is well (", "saw error: container \"migrate\" in pod \"web-1\" is healthy"} {
		// the last line has no end, so that the pod's containers are known
		pod := aPod{names: "migrate side", containers: []aContainer{{name: "migrate", log: line + "\npanic"}, side}}
		pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
			if out != "[pod/web-1/migrate] "+line+"\n[pod/web-1/migrate] panic\n"+noLogOfSideYet {
				t.Errorf("%q", out)
			}
		})
	}
	// two that wait, one named on the line of a log without an end: it is a container's name
	pod := aPod{names: "migrate side app", containers: []aContainer{{name: "migrate", log: says("ghost") + "\npanic"}, side, app}}
	want := "[pod/web-1/migrate] " + says("ghost") + "\n[pod/web-1/migrate] panic\n# No log of app (waiting to start: PodInitializing), side (waiting to start: PodInitializing).\n"
	pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
		if out != want {
			t.Errorf("%q, want %q", out, want)
		}
	})
	// where the pod cannot be read only the one that ended kubectl is known: another's error stays where it was printed
	pod = aPod{containers: []aContainer{side, {name: "migrate", log: "panic"}, app}}
	if out, _ := pod.read(t, asked); out != "[pod/web-1/migrate] panicerror: "+app.fails+"\n"+noLogOfSideYet {
		t.Errorf("%q", out)
	}
	// a line of its own that is of another pod is no word of this one's
	another := `error: container "side" in pod "web-2" is not available` + "\n"
	if rest, names, why := takePast(another, "shop", "web-1", reNoLogYetLine, []string{"side"}); rest != another || len(names)+len(why) != 0 {
		t.Errorf("%q %v %v", rest, names, why)
	}
	// the pod is listed for a line it may name, once, and not for a line of its own
	for _, c := range []struct {
		log   string
		words string
		want  []string
	}{{"ready\n", "", []string{"logs", "logs"}}, {"panic", "", []string{"logs", "logs", "get"}}, {"", "", []string{"logs", "logs", "get"}}, {"", goneText, []string{"logs", "logs", "get", "logs"}}} {
		_, calls := aPod{names: "migrate side", containers: []aContainer{{name: "migrate", log: c.log, words: c.words}, side}}.read(t, asked)
		var got []string
		for _, call := range calls {
			got = append(got, verb(call)[0])
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("%q %q: kubectl ran %v, want %v", c.log, c.words, got, c.want)
		}
	}
}
