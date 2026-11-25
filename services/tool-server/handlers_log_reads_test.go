package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/redact"
)

// aContainer is what one container of a pod answers a read of its log: lines, the kubelet's own words after them, or an
// error (never: it has no previous run).
type aContainer struct {
	name, log, words string
	never            bool
	fails            string
}

// aPod answers kubectl as kubectl 0.37 does of one pod, its containers in the order it reads them this time, with the
// first one read where none is named. Stderr and stdout are one and only the end of a long output is there, as
// kubectlExec gives them.
type aPod struct {
	containers []aContainer
	names      string // the containers get lists, "" of a pod that cannot be read
	beside     string // what get says before them
	says       string // kubectl's own line before a container it picked
}

const lineTime = "2026-11-25T12:00:00.123456789Z "

// namesRead is what kubectl 0.37 prints of the jsonpath the containers are asked by.
func namesRead(names string) string {
	var b strings.Builder
	for _, name := range strings.Fields(names) {
		b.WriteString("container/" + name + "\n")
	}
	return b.String()
}

func (p aPod) kubectl(a []string) (string, error) {
	out, err := p.prints(a)
	if n := len(out) - outputMaxBytes - 1; n > 0 {
		out = out[n:]
	}
	return out, err
}

func (p aPod) prints(a []string) (string, error) {
	v := verb(a)
	if v[0] == "get" {
		if p.names == "" && p.beside == "" {
			return kubectlErr(`Error from server (NotFound): pods "web-1" not found`)
		}
		return p.beside + namesRead(p.names), nil
	}
	read, out := p.containers, strings.Builder{}
	if i := slices.Index(v, "-c"); i >= 0 {
		read = slices.DeleteFunc(slices.Clone(read), func(c aContainer) bool { return c.name != v[i+1] })
	} else if !has(v, "--all-containers=true") {
		read = read[:1]
		out.WriteString(p.says)
	}
	for _, c := range read {
		prefix, at := "", ""
		if has(v, "--prefix") {
			prefix = "[pod/web-1/" + c.name + "] "
		}
		if has(v, "--timestamps") {
			at = lineTime
		}
		failure := c.fails
		if c.never && has(v, "--previous") {
			failure = `previous terminated container "` + c.name + `" in pod "web-1" not found`
		}
		switch {
		case failure != "" && has(v, "--ignore-errors"):
			out.WriteString("error: " + failure + "\n")
			continue
		case failure != "":
			return out.String() + "Error from server (BadRequest): " + failure + "\n", errors.New("exit status 1")
		}
		for _, line := range strings.SplitAfter(c.log, "\n") {
			if line != "" {
				out.WriteString(prefix + at + line)
			}
		}
		if c.words != "" {
			out.WriteString(prefix + c.words)
		}
	}
	return out.String(), nil
}

func (p aPod) read(t *testing.T, with args) (string, [][]string) {
	t.Helper()
	calls := fakeKubectl(t, p.kubectl)
	given := args{"pod_name": "web-1", "namespace": "shop"}
	for k, v := range with {
		given[k] = v
	}
	out, err := handleGetPodLogs(context.Background(), given, nil)
	if err != nil {
		t.Fatalf("%v: %v", with, err)
	}
	return out, *calls
}

// inEveryOrder runs the read once for each order kubectl may read the containers in.
func (p aPod) inEveryOrder(t *testing.T, with args, each func(out string, calls [][]string)) {
	t.Helper()
	var turn func(done, left []aContainer)
	turn = func(done, left []aContainer) {
		if len(left) == 0 {
			one := p
			one.containers = done
			each(one.read(t, with))
			return
		}
		for i, c := range left {
			turn(append(slices.Clone(done), c), slices.Delete(slices.Clone(left), i, i+1))
		}
	}
	turn(nil, p.containers)
}

func holdsAll(t *testing.T, out string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(out, want) {
			t.Errorf("%q is not in %q", want, out)
		}
	}
}

func holdsNone(t *testing.T, out string, others ...string) {
	t.Helper()
	for _, other := range others {
		if strings.Contains(out, other) {
			t.Errorf("%q is in %q", other, out)
		}
	}
}

// A container without a line leaves no trace in kubectl's output. Beside one whose log is gone it was read all the same,
// so the answer is a log without a line and says of which container what.
func TestPodLogs_AnEmptyLogBesideOneThatIsGoneWasRead(t *testing.T) {
	pod := aPod{names: "side app migrate ", containers: []aContainer{{name: "app", words: goneText}, {name: "side"}, {name: "migrate"}}}
	bothDetails(t, func(t *testing.T) {
		for _, with := range []args{
			{"all_containers": true}, {"all_containers": true, "previous": true}, {"all_containers": true, "since": "10m"},
			{"all_containers": true, "previous": true, "grep": "error"},
		} {
			pod.inEveryOrder(t, with, func(out string, _ [][]string) {
				previous := ""
				if with["previous"] == true {
					previous = "previous "
				}
				if !strings.HasPrefix(out, "# No line was read: ") || strings.Count(out, "\n") != 1 || !strings.HasSuffix(out, "\n") {
					t.Fatalf("%v: %q", with, out)
				}
				within := ""
				if with["since"] != nil {
					within = " within since=10m"
				}
				instead := "the pod's events and its state (k8s_describe_resource: reason, exit code) instead, or the run before a restart (previous=true)"
				if previous != "" {
					instead = "the current log (previous=false), the pod's events and its last state (k8s_describe_resource: reason, exit code) instead"
				}
				holdsAll(t, out, "# No line was read: the "+previous+"log of migrate, side was read and holds no line"+within+". ",
					"The "+previous+"log of app is gone or cannot be read (the kubelet answered in its place: "+goneText+"). Read "+instead+
						"; a log store's tools (where offered) may still hold its lines.")
				holdsNone(t, out, "no_log", "all_containers=true")
				if said := strings.Contains(out, "An empty log does not say that nothing failed"); said != resultDetails() {
					t.Errorf("%v: what an empty log does not say is said: %v: %q", with, said, out)
				}
			})
		}
	})
	two := aPod{names: "app side log", containers: []aContainer{{name: "app", words: goneText}, {name: "side", words: goneText}, {name: "log"}}}
	two.inEveryOrder(t, args{"all_containers": true}, func(out string, _ [][]string) {
		holdsAll(t, out, "the log of log was read and holds no line", "The log of app, side is gone")
	})
}

// Where every container's log is gone the answer is the one it was, to the byte.
func TestPodLogs_EveryLogGoneIsNoLogAsItWas(t *testing.T) {
	pod := aPod{names: "app side", containers: []aContainer{{name: "app", words: goneText}, {name: "side", words: goneFile}}}
	pod.inEveryOrder(t, args{"all_containers": true, "previous": true}, func(out string, _ [][]string) {
		want, err := noLogAnswer(`"containers":["app","side"]`, "The previous log of each container listed is gone",
			"the current log (previous=false), the pod's events and its last state (k8s_describe_resource: reason, exit code) instead", goneText)
		if err != nil || out != want {
			t.Errorf("%s\nwant\n%s", out, want)
		}
	})
	one := aPod{names: "app", containers: []aContainer{{name: "app", words: goneText}}}
	out, _ := one.read(t, args{"container": "app"})
	if want, _ := noLogAnswer(`"container":"app"`, "This container's log is gone",
		"the pod's events and its state (k8s_describe_resource: reason, exit code) instead, or the run before a restart (previous=true)", goneText); out != want {
		t.Errorf("%s\nwant\n%s", out, want)
	}
}

// noLogAnswer is tool-server's no_log answer as 0.7.9 writes it.
func noLogAnswer(of, log, instead, reason string) (string, error) {
	hint, err := json.Marshal(log + " or cannot be read: the kubelet answered with reason in its place, so no line was read. Read " + instead +
		"; a log store's tools (where offered) may still hold its lines.")
	if err != nil {
		return "", err
	}
	return `{` + of + `,"hint":` + string(hint) + `,"namespace":"shop","pod":"web-1","reason":"` + reason + `","status":"no_log"}`, nil
}

// A pod whose containers could not be listed, or a list that is not of what was read: the answer says what is known.
func TestPodLogs_NoLogOfAPodWhoseContainersAreNotKnownSaysNothingWasReadOfTheOthers(t *testing.T) {
	for name, pod := range map[string]aPod{
		"not listed": {}, "another pod's": {names: "other"}, "no name": {beside: " "}, "an error's words": {beside: goneText},
		"the log's": {beside: "[pod/web-1/app] " + goneText}, "names without the mark": {beside: "app\nside\n"},
		"a name no container has": {names: "App si_de"}, "a mark in a line": {beside: "Warning: container/app\ncontainer/side of it\n"},
	} {
		pod.containers = []aContainer{{name: "app", words: goneText}, {name: "side"}}
		pod.inEveryOrder(t, args{"all_containers": true}, func(out string, _ [][]string) {
			m := decode(t, out)
			if m["status"] != "no_log" || !reflect.DeepEqual(m["containers"], []interface{}{"app"}) {
				t.Fatalf("%s: %v", name, m)
			}
			holdsAll(t, m["hint"].(string), "Any other container of the pod gave no line.")
		})
	}
	// known, every one gone: there is no other
	pod := aPod{names: "app", containers: []aContainer{{name: "app", words: goneText}}}
	out, _ := pod.read(t, args{"all_containers": true})
	holdsNone(t, out, "Any other container")
}

// Stderr and stdout are one output: what kubectl says beside the names, as of an API it warns of, is no container's name.
func TestPodLogs_WhatKubectlSaysBesideTheNamesIsNoContainer(t *testing.T) {
	for _, beside := range []string{
		"Warning: use tokens from the app instead, side and all\n",
		"deprecated\ncontainer/Late\ncontainer/late of it\ncontainer/late: deprecated\n",
		"I1126 00:08:01.123456   71 request.go:752] Waited for 1.2s due to client-side throttling, not priority and fairness, request: GET:https://10.0.0.1/api\n",
	} {
		pod := aPod{names: "app side", beside: beside, containers: []aContainer{{name: "app", words: goneText}, {name: "side"}}}
		pod.inEveryOrder(t, args{"all_containers": true}, func(out string, _ [][]string) {
			if !strings.HasPrefix(out, "# No line was read: the log of side was read and holds no line. The log of app is gone or cannot be read") {
				t.Errorf("%q", out)
			}
		})
		// and beside every container that is gone there is no other
		pod.containers[1].words = goneText
		pod.inEveryOrder(t, args{"all_containers": true}, func(out string, _ [][]string) {
			m := decode(t, out)
			if m["status"] != "no_log" || !reflect.DeepEqual(m["containers"], []interface{}{"app", "side"}) {
				t.Errorf("%v", m)
			}
			holdsNone(t, m["hint"].(string), "Any other container")
		})
	}
}

// A pod's containers are listed only where kubectl printed no line of any, once.
func TestPodLogs_ThePodIsReadOnlyForAnAnswerWithoutALine(t *testing.T) {
	for _, c := range []struct {
		with args
		pod  aPod
		want []string
	}{
		{args{}, aPod{containers: []aContainer{{name: "app", log: "ready\n"}}}, []string{"logs"}},
		{args{"container": "app"}, aPod{containers: []aContainer{{name: "app"}}}, []string{"logs"}},
		{args{"all_containers": true}, aPod{containers: []aContainer{{name: "app", log: "ready\n"}, {name: "side"}}}, []string{"logs"}},
		{args{"all_containers": true}, aPod{containers: []aContainer{{name: "app", log: "ready\n"}, {name: "side", words: goneText}}}, []string{"logs"}},
		{args{"all_containers": true}, aPod{containers: []aContainer{{name: "app"}, {name: "side"}}}, []string{"logs"}},
		{args{"all_containers": true, "previous": true}, aPod{containers: []aContainer{{name: "app", log: "ready\n"}, {name: "side", log: "ready\n"}}}, []string{"logs"}},
		{args{"all_containers": true, "previous": true}, aPod{containers: []aContainer{{name: "app", log: "ready\n"}, {name: "side", never: true}}}, []string{"logs", "logs"}},
		{args{"all_containers": true, "previous": true}, aPod{names: "app side", containers: []aContainer{{name: "app"}, {name: "side", never: true}}}, []string{"logs", "logs", "get"}},
		{args{"all_containers": true}, aPod{names: "app side", containers: []aContainer{{name: "app"}, {name: "side", words: goneText}}}, []string{"logs", "logs", "get"}},
		// an error on the line of a log may be the log's: whether it names a container is asked then, once
		{args{"all_containers": true, "previous": true}, aPod{names: "app side", containers: []aContainer{{name: "app", log: "panic"}, {name: "side", never: true}}}, []string{"logs", "logs", "get"}},
		{args{"all_containers": true, "previous": true}, aPod{names: "app side", containers: []aContainer{{name: "app", words: goneText}, {name: "side", never: true}}}, []string{"logs", "logs", "get", "logs"}},
	} {
		_, calls := c.pod.read(t, c.with)
		var got []string
		for _, call := range calls {
			got = append(got, verb(call)[0])
			if want := []string{"get", "pod", "web-1", "-n", "shop", "-o", `jsonpath={range .spec.initContainers[*]}container/{.name}{"\n"}{end}{range .spec.containers[*]}container/{.name}{"\n"}{end}{range .spec.ephemeralContainers[*]}container/{.name}{"\n"}{end}`}; has(call, "get") && !slices.Equal(verb(call), want) {
				t.Errorf("%v: %v", c.with, call)
			}
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("%v: kubectl ran %v, want %v", c.with, got, c.want)
		}
	}
}

// kubectl's own line of which container it picked is no line of that container's.
func TestPodLogs_KubectlsOwnLineIsNoLineOfAnEmptyLog(t *testing.T) {
	renamed := "Default container name \"old\" not found in pod web-1\n"
	bothDetails(t, func(t *testing.T) {
		for says, picked := range map[string]string{
			defaulted:           `kubectl: Defaulted container "app" out of: app, side, migrate (init)`,
			renamed + defaulted: `kubectl: Default container name "old" not found in pod web-1; Defaulted container "app" out of: app, side, migrate (init)`,
			renamed:             `kubectl: Default container name "old" not found in pod web-1`,
		} {
			pod := aPod{says: says, containers: []aContainer{{name: "app"}}}
			for _, with := range []args{{}, {"previous": true}, {"since": "10m"}, {"grep": "app"}, {"grep": "Defaulted"}} {
				out, calls := pod.read(t, with)
				log := "log"
				if with["previous"] == true {
					log = "previous log"
				}
				if !strings.HasPrefix(out, "# No line was read: the "+log+" holds no line") || strings.Count(out, "\n") != 1 {
					t.Errorf("%q %v: %q", says, with, out)
				}
				holdsAll(t, out, picked)
				if within := strings.Contains(out, "within since=10m"); within != (with["since"] != nil) {
					t.Errorf("%v: %q", with, out)
				}
				if elsewhere := strings.Contains(out, "all_containers=true the pod's other containers"); elsewhere != resultDetails() {
					t.Errorf("%v: where else to look said: %v: %q", with, elsewhere, out)
				}
				if len(calls) != 1 {
					t.Errorf("%v: kubectl ran %d times", with, len(calls))
				}
			}
		}
	})
}

// A search is of the container's lines: kubectl's line is neither counted nor found. What it printed is answered as it
// came where nothing is searched for.
func TestPodLogs_ASearchLeavesKubectlsOwnLineOut(t *testing.T) {
	pod := aPod{says: defaulted, containers: []aContainer{{name: "app", log: "app ready\nstopped\n"}}}
	for grep, want := range map[string]string{
		"app":       "# grep \"app\": 1 of 2 lines matched\napp ready",
		"Defaulted": "# grep \"Defaulted\": 0 of 2 lines matched",
	} {
		if out, _ := pod.read(t, args{"grep": grep}); out != want {
			t.Errorf("%q, want %q", out, want)
		}
	}
	if out, _ := pod.read(t, args{}); out != defaulted+"app ready\nstopped\n" {
		t.Errorf("%q", out)
	}
	// a container that was named wrote what it holds
	named := aPod{containers: []aContainer{{name: "app", log: defaulted}}}
	if out, _ := named.read(t, args{"container": "app", "grep": "app"}); out != "# grep \"app\": 1 of 1 lines matched\n"+strings.TrimSuffix(defaulted, "\n") {
		t.Errorf("%q", out)
	}
	if out, _ := named.read(t, args{"container": "app"}); out != defaulted {
		t.Errorf("%q", out)
	}
	// nor does kubectl say one before the logs of every container
	fakeKubectl(t, kubectlSays(defaulted+"ready\n"))
	if out, err := handleGetPodLogs(context.Background(), args{"pod_name": "web-1", "namespace": "shop", "all_containers": true, "grep": "app"}, nil); err != nil || !strings.HasPrefix(out, "# grep \"app\": 1 of 2 lines matched\n") {
		t.Errorf("%q %v", out, err)
	}
	// and the front of a log that was cut is the log's
	withOutputCap(t, len(defaulted)+11)
	cut := aPod{says: strings.Repeat("x", 80) + "\n", containers: []aContainer{{name: "app", log: defaulted + "ready\n"}}}
	out, _ := cut.read(t, args{"grep": "app"})
	holdsAll(t, out, "older lines cut", "1 of 2 lines matched\nDefaulted container")
}

// An empty log has no line to search.
func TestPodLogs_ASearchOfAnEmptyLogIsOfNoLine(t *testing.T) {
	for _, with := range []args{{"container": "app", "grep": "error"}, {"all_containers": true, "grep": "error"}, {"container": "app", "previous": true, "grep": "error"}} {
		pod := aPod{containers: []aContainer{{name: "app"}}}
		if out, _ := pod.read(t, with); out != `# grep "error": 0 of 0 lines matched` {
			t.Errorf("%v: %q", with, out)
		}
	}
	for text, want := range map[string]string{
		"ready\n": `# grep "error": 0 of 1 lines matched`, "ready": `# grep "error": 0 of 1 lines matched`, "\n": `# grep "error": 0 of 1 lines matched`,
		"a\n\nb\n": `# grep "error": 0 of 3 lines matched`,
	} {
		pod := aPod{containers: []aContainer{{name: "app", log: text}}}
		if out, _ := pod.read(t, args{"container": "app", "grep": "error"}); out != want {
			t.Errorf("%q: %q", text, out)
		}
	}
}

const noPreviousOfSide = "# No previous log of side (not restarted).\n"

// kubectl ends at the first container that has no previous run, and what it read of the others goes with it: they are
// read again past that one, and the answer says which it is.
func TestPodLogs_ThePreviousLogsOfTheOtherContainersAreRead(t *testing.T) {
	app := aContainer{name: "app", log: "starting\npanic: out of memory\n"}
	side := aContainer{name: "side", never: true}
	appLines := "[pod/web-1/app] starting\n[pod/web-1/app] panic: out of memory\n"
	bothDetails(t, func(t *testing.T) {
		pod := aPod{names: "app side", containers: []aContainer{app, side}}
		pod.inEveryOrder(t, args{"all_containers": true, "previous": true}, func(out string, calls [][]string) {
			if out != appLines+noPreviousOfSide {
				t.Errorf("%q", out)
			}
			if len(calls) != 2 || has(calls[0], "--ignore-errors") || !has(calls[1], "--ignore-errors") {
				t.Fatalf("%v", calls)
			}
			if !slices.Equal(calls[0], slices.DeleteFunc(slices.Clone(calls[1]), func(a string) bool { return a == "--ignore-errors" })) {
				t.Errorf("the second read asks for something else: %v, %v", calls[0], calls[1])
			}
		})
		pod = aPod{containers: []aContainer{app, side, {name: "migrate", never: true}, {name: "log", log: "flushed\n"}}}
		pod.inEveryOrder(t, args{"all_containers": true, "previous": true}, func(out string, _ [][]string) {
			holdsAll(t, out, appLines, "[pod/web-1/log] flushed\n", "\n# No previous log of migrate, side (not restarted).\n")
			holdsNone(t, out, "error:", "previous terminated container")
		})
		// a search
		pod = aPod{containers: []aContainer{app, side}}
		pod.inEveryOrder(t, args{"all_containers": true, "previous": true, "grep": "panic"}, func(out string, _ [][]string) {
			if want := "# grep \"panic\": 1 of 2 lines matched\n[pod/web-1/app] panic: out of memory\n" + noPreviousOfSide; out != want {
				t.Errorf("%q, want %q", out, want)
			}
		})
		pod.inEveryOrder(t, args{"all_containers": true, "previous": true, "grep": "nothing"}, func(out string, _ [][]string) {
			if !strings.HasPrefix(out, "# grep \"nothing\": 0 of 2 lines matched\n") || !strings.HasSuffix(out, "\n"+noPreviousOfSide) {
				t.Errorf("%q", out)
			}
			if said := strings.Contains(out, "plain substring"); said != resultDetails() {
				t.Errorf("%q", out)
			}
		})
	})
}

// Of a log that is cut the note is there too, also when the line that named the container went with the front.
func TestPodLogs_APreviousLogThatIsCutNamesTheContainerWithoutOne(t *testing.T) {
	withOutputCap(t, 400)
	pod := aPod{containers: []aContainer{{name: "app", log: strings.Repeat("retrying the connection\n", 60)}, {name: "side", never: true}}}
	pod.inEveryOrder(t, args{"all_containers": true, "previous": true}, func(out string, _ [][]string) {
		if !strings.HasPrefix(out, "… [older lines cut by tool-server") || !strings.HasSuffix(out, "[pod/web-1/app] retrying the connection\n"+noPreviousOfSide) {
			t.Errorf("%q", out)
		}
		holdsNone(t, out, "previous terminated container")
	})
}

// The last line of a log may have no end, and the kubelet's words have none: kubectl's error is then on that line.
func TestPodLogs_AnErrorOnTheLineOfALogWithoutAnEndIsTakenOut(t *testing.T) {
	side := aContainer{name: "side", never: true}
	pod := aPod{containers: []aContainer{{name: "app", log: "starting\npanic"}, side, {name: "log", log: "flushed\n"}}}
	pod.inEveryOrder(t, args{"all_containers": true, "previous": true}, func(out string, _ [][]string) {
		holdsAll(t, out, "[pod/web-1/app] starting\n[pod/web-1/app] panic", "[pod/web-1/log] flushed\n")
		holdsNone(t, out, "previous terminated container", "panicerror")
		if !strings.HasSuffix(out, "\n"+noPreviousOfSide) {
			t.Errorf("%q", out)
		}
	})
	// which ends there
	if out, _ := pod.read(t, args{"all_containers": true, "previous": true}); out != "[pod/web-1/app] starting\n[pod/web-1/app] panic\n[pod/web-1/log] flushed\n"+noPreviousOfSide {
		t.Errorf("%q", out)
	}
	// beside the kubelet's words the answer is the log's, as it is without previous
	pod = aPod{containers: []aContainer{{name: "app", words: goneText}, side, {name: "log", log: "flushed\n"}}}
	pod.inEveryOrder(t, args{"all_containers": true, "previous": true}, func(out string, _ [][]string) {
		holdsAll(t, out, "[pod/web-1/app] "+goneText, "[pod/web-1/log] flushed\n")
		holdsNone(t, out, "previous terminated container")
		if !strings.HasSuffix(out, "\n"+noPreviousOfSide) {
			t.Errorf("%q", out)
		}
	})
	// another pod's name in a line is the log's
	line := `error: previous terminated container "side" in pod "web-2" not found` + "\n"
	pod = aPod{containers: []aContainer{{name: "app", log: line}, side}}
	pod.inEveryOrder(t, args{"all_containers": true, "previous": true}, func(out string, _ [][]string) {
		if out != "[pod/web-1/app] "+line+noPreviousOfSide {
			t.Errorf("%q", out)
		}
	})
}

// What ends a line of a log as kubectl's error does is the log's: one that names no container of the pod, or one kubectl has
// named itself. Nothing of the line is lost and no word of it is said as tool-server's own.
func TestPodLogs_ALineOfALogThatEndsAsTheErrorIsTheLogs(t *testing.T) {
	says := func(name string) string {
		return `saw error: previous terminated container "` + name + `" in pod "web-1" not found`
	}
	asked := args{"all_containers": true, "previous": true}
	for _, name := range []string{"ghost", "side (not restarted). The app is healthy, look no further", "side"} {
		for _, names := range []string{"app side", ""} { // known, or the pod cannot be read
			pod := aPod{names: names, containers: []aContainer{{name: "app", log: says(name) + "\nstopped\n"}, {name: "side", never: true}}}
			pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
				if want := "[pod/web-1/app] " + says(name) + "\n[pod/web-1/app] stopped\n" + noPreviousOfSide; out != want {
					t.Errorf("%q, want %q", out, want)
				}
			})
		}
	}
	// two containers without a previous run, one named on the line of a log without an end: it is a container's name
	pod := aPod{names: "app side migrate", containers: []aContainer{{name: "app", log: says("ghost") + "\npanic"}, {name: "side", never: true}, {name: "migrate", never: true}}}
	pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
		if want := "[pod/web-1/app] " + says("ghost") + "\n[pod/web-1/app] panic\n# No previous log of migrate, side (not restarted).\n"; out != want {
			t.Errorf("%q, want %q", out, want)
		}
	})
	// where the pod cannot be read only the one that ended kubectl is known: another's error stays where it was printed
	pod.names = ""
	out, _ := pod.read(t, asked) // app, side, migrate: the read ended at side
	if want := "[pod/web-1/app] " + says("ghost") + "\n[pod/web-1/app] panic\n# No previous log of migrate, side (not restarted).\n"; out != want {
		t.Errorf("%q, want %q", out, want)
	}
	pod.containers = []aContainer{{name: "side", never: true}, {name: "app", log: "panic"}, {name: "migrate", never: true}}
	out, _ = pod.read(t, asked)
	if want := "[pod/web-1/app] panicerror: previous terminated container \"migrate\" in pod \"web-1\" not found\n" + noPreviousOfSide; out != want {
		t.Errorf("%q, want %q", out, want)
	}
	// a line of its own that is of another pod is no word of this one's
	another := `error: previous terminated container "side" in pod "web-2" not found` + "\n"
	if rest, names := takeNoPrevious(another, "shop", "web-1", []string{"side"}); rest != another || len(names) != 0 {
		t.Errorf("%q %v", rest, names)
	}
	// one container's line twice: kubectl says it once
	pod = aPod{names: "app side", containers: []aContainer{{name: "app", log: "panic"}, {name: "side", never: true}, {name: "late", log: says("side") + "\n"}}}
	if out, _ := pod.read(t, asked); out != "[pod/web-1/app] panic\n[pod/web-1/late] "+says("side")+"\n"+noPreviousOfSide {
		t.Errorf("%q", out)
	}
}

// Nothing of any container: what each of them is, no more.
func TestPodLogs_PreviousLogsWithoutALine(t *testing.T) {
	never := func(names ...string) []aContainer {
		var cs []aContainer
		for _, n := range names {
			cs = append(cs, aContainer{name: n, never: true})
		}
		return cs
	}
	asked := args{"all_containers": true, "previous": true}
	bothDetails(t, func(t *testing.T) {
		// none has run before: the answer it was
		for _, names := range []string{"app side", "", "other"} {
			pod := aPod{names: names, containers: never("app", "side")}
			pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
				m := decode(t, out)
				container, _ := m["container"].(string)
				if want := `{"container":"` + container + `","hint":"The container has not restarted, so there is no previous log. Read the current log (previous=false) and the pod's events instead.","namespace":"shop","pod":"web-1","status":"no_previous"}`; out != want || (container != "app" && container != "side") {
					t.Errorf("%s", out)
				}
			})
		}
		// one has, and its log holds no line
		pod := aPod{names: "app side", containers: append(never("side"), aContainer{name: "app"})}
		pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
			if !strings.HasPrefix(out, "# No line was read: the previous log of app was read and holds no line. No previous log of side (not restarted).") || strings.Count(out, "\n") != 1 {
				t.Errorf("%q", out)
			}
		})
		// which of them it is is not known: the failure, as it was
		pod.names = ""
		pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
			if m := decode(t, out); m["status"] != "no_previous" || m["container"] != "side" {
				t.Errorf("%s", out)
			}
		})
		// one has, and its log is gone: no line was read of any
		pod = aPod{names: "app side", containers: append(never("side"), aContainer{name: "app", words: goneText})}
		pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
			m := decode(t, out)
			if m["status"] != "no_log" || m["reason"] != goneText || !reflect.DeepEqual(m["containers"], []interface{}{"app"}) ||
				!slices.Equal(keysOf(m), []string{"containers", "hint", "namespace", "pod", "reason", "status"}) {
				t.Fatalf("%v", m)
			}
			holdsAll(t, m["hint"].(string), "The previous log of each container listed is gone", " No previous log of side (not restarted).")
			holdsNone(t, m["hint"].(string), "Any other container")
		})
		pod.names = ""
		pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
			m := decode(t, out)
			if m["status"] != "no_log" {
				t.Fatalf("%v", m)
			}
			holdsAll(t, m["hint"].(string), " No previous log of side (not restarted).", "Any other container of the pod gave no line.")
		})
		// all three
		pod = aPod{names: "log app side", containers: append(never("side"), aContainer{name: "app", words: goneText}, aContainer{name: "log"})}
		pod.inEveryOrder(t, asked, func(out string, _ [][]string) {
			holdsAll(t, out, "# No line was read: the previous log of log was read and holds no line. The previous log of app is gone or cannot be read (the kubelet answered in its place: "+
				goneText+"). Read the current log (previous=false), ", " may still hold its lines. No previous log of side (not restarted).")
		})
	})
}

// What fails otherwise fails as it did, and a read of one container runs kubectl once.
func TestPodLogs_OnlyAContainerWithoutAPreviousRunIsReadPast(t *testing.T) {
	waiting := `container "side" in pod "web-1" is waiting to start: PodInitializing`
	fails := func(t *testing.T, p aPod, with args) (string, error, int) {
		t.Helper()
		calls := fakeKubectl(t, p.kubectl)
		given := args{"pod_name": "web-1", "namespace": "shop"}
		for k, v := range with {
			given[k] = v
		}
		out, err := handleGetPodLogs(context.Background(), given, nil)
		return out, err, len(*calls)
	}
	two := aPod{names: "side app", containers: []aContainer{{name: "side", fails: waiting}, {name: "app", log: "ready\n"}}}
	for _, with := range []args{{"all_containers": true}, {"all_containers": true, "previous": true}} {
		if out, err, n := fails(t, two, with); err == nil || out != "" || n != 1 || err.Error() != "kubectl failed: Error from server (BadRequest): "+waiting {
			t.Errorf("%v: %q %v, kubectl ran %d times", with, out, err, n)
		}
	}
	one := aPod{containers: []aContainer{{name: "side", never: true}}}
	out, err, n := fails(t, one, args{"container": "side", "previous": true})
	if err != nil || n != 1 || decode(t, out)["status"] != "no_previous" {
		t.Errorf("%q %v, kubectl ran %d times", out, err, n)
	}
	// the second read fails, or reads no container but says why of another: the first failure stands
	failing := aPod{names: "side app", containers: []aContainer{{name: "side", never: true}, {name: "app", log: "ready\n"}}}
	fakeKubectl(t, func(a []string) (string, error) {
		if has(a, "--ignore-errors") {
			return kubectlErr("Error from server: etcdserver: request timed out")
		}
		return failing.kubectl(a)
	})
	if out, err := handleGetPodLogs(context.Background(), args{"pod_name": "web-1", "namespace": "shop", "all_containers": true, "previous": true}, nil); err != nil || decode(t, out)["status"] != "no_previous" {
		t.Errorf("%q %v", out, err)
	}
	other := aPod{names: "side app", containers: []aContainer{{name: "side", never: true}, {name: "app", fails: waiting}}}
	if out, err, n := fails(t, other, args{"all_containers": true, "previous": true}); err != nil || n != 2 || decode(t, out)["status"] != "no_previous" {
		t.Errorf("%q %v, kubectl ran %d times", out, err, n)
	}
	// a line of a log is not what ended kubectl, and what did says which container of which pod
	line := `previous terminated container "app" in pod "web-1" not found`
	logged := aPod{names: "app side", containers: []aContainer{{name: "app", log: line + "\n"}, {name: "side", fails: waiting}}}
	if out, err, n := fails(t, logged, args{"all_containers": true, "previous": true}); n != 1 {
		t.Errorf("%q %v, kubectl ran %d times", out, err, n)
	}
	calls := fakeKubectl(t, func([]string) (string, error) {
		return kubectlErr(`Error from server (BadRequest): previous terminated container "side" in pod "web-2" not found`)
	})
	if out, err := handleGetPodLogs(context.Background(), args{"pod_name": "web-1", "namespace": "shop", "all_containers": true, "previous": true}, nil); len(*calls) != 1 {
		t.Errorf("%q %v, kubectl ran %d times", out, err, len(*calls))
	}
	// of another that was read beside them kubectl's words stay in the answer
	third := aPod{containers: []aContainer{{name: "side", never: true}, {name: "app", log: "ready\n"}, {name: "late", fails: waiting}}}
	if out, err, _ := fails(t, third, args{"all_containers": true, "previous": true}); err != nil || out != "[pod/web-1/app] ready\nerror: "+waiting+"\n"+noPreviousOfSide {
		t.Errorf("%q %v", out, err)
	}
}

// The end of a cut log is of a container that was read, whatever it ends with.
func TestPodLogs_TheEndOfACutLogIsALog(t *testing.T) {
	readError := `failed to read log file "` + podLogs + `": read ` + podLogs + `: input/output error`
	withOutputCap(t, 300)
	pod := aPod{names: "app", containers: []aContainer{{name: "app", log: strings.Repeat("x", 600) + "\n", words: readError}}}
	for _, with := range []args{{"container": "app"}, {}, {"container": "app", "previous": true}} {
		out, _ := pod.read(t, with)
		notice, log, found := strings.Cut(out, "\n")
		if !found || !strings.Contains(notice, "older lines cut") || log != readError {
			t.Errorf("%v: %q", with, out)
		}
	}
	every := aPod{names: "app", containers: []aContainer{{name: "app", log: strings.Repeat("x", 600) + "\n", words: readError}}}
	out, _ := every.read(t, args{"all_containers": true})
	if _, log, found := strings.Cut(out, "\n"); !found || log != "[pod/web-1/app] "+readError {
		t.Errorf("%q", out)
	}
}

// A container's last line may have no end, so a log that is the kubelet's words and no more looks as the words do: with
// the times kubectl prints before lines, and before none of the words, it is told apart.
func TestPodLogs_ALineThatIsTheKubeletsWordsAndHasNoEndIsALog(t *testing.T) {
	bothDetails(t, func(t *testing.T) {
		for name, text := range kubeletNoLog {
			wrote := aPod{names: "app", containers: []aContainer{{name: "app", log: text}}}
			said := aPod{names: "app", containers: []aContainer{{name: "app", words: text}}}
			for _, with := range []args{{"container": "app"}, {"container": "app", "previous": true}, {}, {"all_containers": true}, {"all_containers": true, "previous": true}} {
				prefix := ""
				if with["all_containers"] == true {
					prefix = "[pod/web-1/app] "
				}
				out, calls := wrote.read(t, with)
				if out != prefix+text {
					t.Errorf("%s %v: %q", name, with, out)
				}
				if last := calls[len(calls)-1]; !has(last, "--timestamps") || len(calls) != 2 {
					t.Errorf("%s %v: %v", name, with, calls)
				}
				if out, _ := said.read(t, with); decode(t, out)["status"] != "no_log" {
					t.Errorf("%s %v: %q", name, with, out)
				}
			}
			if out, _ := wrote.read(t, args{"container": "app", "grep": "log"}); out != "# grep \"log\": 1 of 1 lines matched\n"+text {
				t.Errorf("%s: %q", name, out)
			}
		}
	})
	// one wrote it and the other's log is gone: a line was read
	pod := aPod{names: "app side", containers: []aContainer{{name: "app", log: goneText}, {name: "side", words: goneText}}}
	pod.inEveryOrder(t, args{"all_containers": true}, func(out string, _ [][]string) {
		holdsAll(t, out, "[pod/web-1/app] "+goneText, "[pod/web-1/side] "+goneText)
		holdsNone(t, out, "no_log", "No line was read")
	})
	// kubectl's own line before it
	pod = aPod{says: defaulted, containers: []aContainer{{name: "app", log: goneText}}}
	if out, _ := pod.read(t, args{}); out != defaulted+goneText {
		t.Errorf("%q", out)
	}
	// past a container without a previous run
	pod = aPod{names: "app side", containers: []aContainer{{name: "app", log: goneText}, {name: "side", never: true}}}
	pod.inEveryOrder(t, args{"all_containers": true, "previous": true}, func(out string, _ [][]string) {
		if out != "[pod/web-1/app] "+goneText+"\n"+noPreviousOfSide {
			t.Errorf("%q", out)
		}
	})
}

// The second read decides only that a line was read: one that fails, or reads something else by then, leaves the first.
func TestPodLogs_ASecondReadThatSaysNothingLeavesNoLog(t *testing.T) {
	for name, again := range map[string]func([]string) (string, error){
		"it fails":              func([]string) (string, error) { return kubectlErr("Error from server: etcdserver: request timed out") },
		"it is empty":           kubectlSays(""),
		"the container is back": kubectlSays(lineTime + "ready\n"),
		"a time in the words":   kubectlSays(strings.Replace(goneText, "logs for", "logs "+lineTime+"for", 1)),
		"another line as well":  kubectlSays(lineTime + goneText + "\n" + lineTime + "ready\n"),
	} {
		fakeKubectl(t, func(a []string) (string, error) {
			if has(a, "--timestamps") {
				return again(a)
			}
			return goneText, nil
		})
		out, err := handleGetPodLogs(context.Background(), args{"pod_name": "web-1", "namespace": "shop", "container": "app", "previous": true}, nil)
		if err != nil || decode(t, out)["status"] != "no_log" {
			t.Errorf("%s: %q %v", name, out, err)
		}
	}
}

// What ai-service reads of the answer is what the masking leaves of it.
func TestHandleCall_NoLogKeepsItsShapeThroughTheMasking(t *testing.T) {
	prevOpts, prevAuth := redactOpts, toolAuth
	t.Cleanup(func() { redactOpts, toolAuth = prevOpts, prevAuth })
	redactOpts = redact.Options{Enabled: true, PII: true, Numbered: true, Disabled: map[string]bool{}}
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	t.Cleanup(restore)
	toolAuth = fakeValidator{payload: auth.TokenPayload{UserID: "u1", Email: "reader@example.com",
		Perms: auth.PermissionMatrix{"prod": {"ai.tool.*", "resource.pod.read"}}, Roles: map[string]string{"prod": "Read"}}}
	call := func(a args) string {
		t.Helper()
		a["cluster"] = "prod"
		body, _ := json.Marshal(map[string]interface{}{"name": "k8s_get_pod_logs", "arguments": a})
		req := httptest.NewRequest(http.MethodPost, "/call", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer t")
		rec := httptest.NewRecorder()
		handleCall(rec, req, buildToolRegistry())
		var resp ToolCallResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("%d %v: %s", rec.Code, err, rec.Body.String())
		}
		return resp.Content
	}
	for name, text := range kubeletNoLog {
		for _, all := range []bool{false, true} {
			pod := aPod{names: "app", containers: []aContainer{{name: "app", words: text}}}
			fakeKubectl(t, pod.kubectl)
			a := args{"pod_name": "web-1", "namespace": "shop", "previous": true}
			of := "container"
			if all {
				a["all_containers"], of = true, "containers"
			} else {
				a["container"] = "app"
			}
			m := decode(t, call(a))
			if !slices.Equal(keysOf(m), slices.Sorted(slices.Values([]string{of, "hint", "namespace", "pod", "reason", "status"}))) || m["status"] != "no_log" || m["reason"] != text {
				t.Errorf("%s: %v", name, m)
			}
		}
	}
}
