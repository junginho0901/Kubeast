package main

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

const goneID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

const (
	goneText  = "unable to retrieve container logs for containerd://" + goneID
	podLogs   = "/var/log/pods/shop_web-1_5b1f8e0a-0d0f-4a1c-9c55-8f1d6f0f3f10/app/1.log"
	noFile    = "no such file or directory"
	goneFile  = `failed to try resolving symlinks in path "` + podLogs + `": lstat ` + podLogs + `: ` + noFile
	defaulted = "Defaulted container \"app\" out of: app, side, migrate (init)\n"
)

// What the kubelet writes in place of a container's log, with no line end: GetContainerLogs (kuberuntime) and ReadLogs
// (k8s.io/cri-client/pkg/logs). The texts are those of Kubernetes 1.24, 1.30 and 1.37; only the runtime's name differs.
var kubeletNoLog = map[string]string{
	"containerd":         goneText,
	"cri-o":              "unable to retrieve container logs for cri-o://" + goneID,
	"docker":             "unable to retrieve container logs for docker://" + goneID,
	"a path gone":        goneFile,
	"docker's path gone": `failed to try resolving symlinks in path "` + podLogs + `": lstat /var/lib/docker/containers/` + goneID + `/` + goneID + `-json.log: ` + noFile,
	"a static pod's":     `failed to try resolving symlinks in path "/var/log/pods/shop_web-1_0123456789abcdef0123456789abcdef/app/0.log": lstat /var/log/pods/x: ` + noFile,
	"another directory":  `failed to open log file "/data/kubelet/pods/shop_web-1_5b1f8e0a-0d0f-4a1c-9c55-8f1d6f0f3f10/app/12.log": open /data/x: ` + noFile,
	"a Windows path":     `failed to try resolving symlinks in path "C:\\var\\log\\pods\\shop_web-1_5b1f8e0a-0d0f-4a1c-9c55-8f1d6f0f3f10\\app\\0.log": CreateFile: The system cannot find the file specified.`,
	"a file gone":        `failed to open log file "` + podLogs + `": open ` + podLogs + `: ` + noFile,
	"a tail":             `failed to tail 50 lines of log file "` + podLogs + `": read ` + podLogs + `: input/output error`,
	"a seek":             `failed to seek 4096 in log file "` + podLogs + `": seek ` + podLogs + `: invalid argument`,
	"a read":             `failed to read log file "` + podLogs + `": read ` + podLogs + `: input/output error`,
}

func logsSay(t *testing.T, out string, with args) string {
	t.Helper()
	fakeKubectl(t, kubectlSays(out))
	given := args{"pod_name": "web-1", "namespace": "shop"}
	for k, v := range with {
		given[k] = v
	}
	answer, err := handleGetPodLogs(context.Background(), given, nil)
	if err != nil {
		t.Fatal(err)
	}
	return answer
}

func bothDetails(t *testing.T, run func(t *testing.T)) {
	for name, on := range map[string]bool{"details off": false, "details on": true} {
		t.Run(name, func(t *testing.T) {
			withDetails(t, on)
			run(t)
		})
	}
}

func keysOf(m map[string]interface{}) []string {
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// The kubelet has answered 200 when it finds no log to read, so kubectl ends with 0 and its one line is all there is.
func TestPodLogs_TheKubeletsOwnLineInPlaceOfALogIsNoLog(t *testing.T) {
	bothDetails(t, func(t *testing.T) {
		for name, text := range kubeletNoLog {
			for _, with := range []args{
				{"container": "app", "previous": true}, {"container": "app"}, {"container": "app", "previous": true, "since": "1h"},
				// a search of it matched none of no lines, and one for its own words found none of the container's
				{"container": "app", "previous": true, "grep": "error"}, {"container": "app", "grep": "log"},
			} {
				m := decode(t, logsSay(t, text, with))
				if m["status"] != "no_log" || m["pod"] != "web-1" || m["namespace"] != "shop" || m["container"] != "app" || m["reason"] != text {
					t.Errorf("%s %v: %v", name, with, m)
				}
				if got := keysOf(m); !slices.Equal(got, []string{"container", "hint", "namespace", "pod", "reason", "status"}) {
					t.Errorf("%s %v: keys %v", name, with, got)
				}
			}
		}
	})
}

func TestPodLogs_NoLogSaysWhereElseToLook(t *testing.T) {
	previous := decode(t, logsSay(t, goneText, args{"container": "app", "previous": true}))["hint"].(string)
	for _, want := range []string{"The previous container's log is gone", "no line was read", "previous=false", "events", "k8s_describe_resource", "log store"} {
		if !strings.Contains(previous, want) {
			t.Errorf("previous: %q is not in %q", want, previous)
		}
	}
	if strings.Contains(previous, "previous=true") {
		t.Errorf("previous: what was asked for is said again: %q", previous)
	}
	current := decode(t, logsSay(t, goneText, args{"container": "app"}))["hint"].(string)
	for _, want := range []string{"This container's log is gone", "no line was read", "previous=true", "events", "k8s_describe_resource", "log store"} {
		if !strings.Contains(current, want) {
			t.Errorf("current: %q is not in %q", want, current)
		}
	}
	if strings.Contains(current, "previous=false") || strings.Contains(current, "previous container") {
		t.Errorf("current: speaks of the previous container: %q", current)
	}
	all := decode(t, logsSay(t, "[pod/web-1/app] "+goneText, args{"all_containers": true, "previous": true}))["hint"].(string)
	if !strings.Contains(all, "The previous log of each container listed is gone") {
		t.Errorf("all: %q", all)
	}
	all = decode(t, logsSay(t, "[pod/web-1/app] "+goneText, args{"all_containers": true}))["hint"].(string)
	if !strings.Contains(all, "The log of each container listed is gone") {
		t.Errorf("all: %q", all)
	}
}

// Without a container kubectl says first, on stderr, which one it read.
func TestPodLogs_NoLogOfTheContainerKubectlPicked(t *testing.T) {
	for name, c := range map[string]struct {
		out       string
		container interface{}
	}{
		"one container":                    {goneText, nil},
		"the first of several":             {defaulted + goneText, "app"},
		"an annotation that names no one":  {"Default container name \"old\" not found in pod web-1\n" + defaulted + goneText, "app"},
		"that annotation on one container": {"Default container name \"old\" not found in pod web-1\n" + goneText, nil},
	} {
		m := decode(t, logsSay(t, c.out, args{"previous": true}))
		if m["status"] != "no_log" || m["container"] != c.container || m["reason"] != goneText {
			t.Errorf("%s: %v", name, m)
		}
		if _, there := m["container"]; there != (c.container != nil) {
			t.Errorf("%s: container %v", name, m["container"])
		}
	}
}

// all_containers reads them one after another, in any order, and the kubelet's line has no end: the next container's
// first line is on it.
func TestPodLogs_NoLogOfAnyContainer(t *testing.T) {
	one, two := "[pod/web-1/app] "+goneText, "[pod/web-1/side] "+goneFile
	for name, c := range map[string]struct {
		out    string
		names  []string
		reason string
	}{
		"one":              {one, []string{"app"}, goneText},
		"two":              {one + two, []string{"app", "side"}, goneText},
		"two, other order": {two + one, []string{"app", "side"}, goneText},
	} {
		m := decode(t, logsSay(t, c.out, args{"all_containers": true, "previous": true}))
		var names []string
		for _, n := range m["containers"].([]interface{}) {
			names = append(names, n.(string))
		}
		if m["status"] != "no_log" || !slices.Equal(names, c.names) || m["reason"] != c.reason {
			t.Errorf("%s: %v", name, m)
		}
		if got := keysOf(m); !slices.Equal(got, []string{"containers", "hint", "namespace", "pod", "reason", "status"}) {
			t.Errorf("%s: keys %v", name, got)
		}
	}
}

// Whatever a container may have written is a log, to the byte: a line of one ends with a line break, and the kubelet's
// text is no more than the text.
func TestPodLogs_ALogThatHoldsTheKubeletsWordsStaysALog(t *testing.T) {
	bothDetails(t, func(t *testing.T) {
		for name, text := range kubeletNoLog {
			for what, out := range map[string]string{
				"a line":                 text + "\n",
				"a line after a time":    "2026-11-25T12:00:00Z " + text + "\n",
				"after a time, no end":   "2026-11-25T12:00:00Z " + text,
				"after another":          "starting\n" + text,
				"before another":         text + "\nretrying\n",
				"before another, no end": text + "\nretrying",
				"two":                    text + "\n" + text + "\n",
				"two, no end":            text + "\n" + text,
				"as JSON":                `{"level":"error","msg":"` + strings.ReplaceAll(text, `"`, `\"`) + `"}` + "\n",
				"as JSON, no end":        `{"level":"error","msg":"` + strings.ReplaceAll(text, `"`, `\"`) + `"}`,
				"quoted":                 `"` + text + `"`,
				"in other letters":       strings.ToUpper(text[:1]) + text[1:],
				"an empty line before":   "\n" + text,
			} {
				for _, with := range []args{{}, {"container": "app"}, {"container": "app", "previous": true}, {"all_containers": true}} {
					if got := logsSay(t, out, with); got != out {
						t.Errorf("%s, %s %v: %q", name, what, with, got)
					}
				}
			}
		}
		for what, out := range map[string]string{
			"words after the ID":         goneText + ": retrying",
			"a longer ID":                goneText + "0",
			"a shorter ID":               strings.TrimSuffix(goneText, "f"),
			"words that run on":          goneText + "ready",
			"an ID not parsed":           "unable to retrieve container logs for ://",
			"no ID":                      "unable to retrieve container logs for web-1",
			"a file without a reason":    `failed to open log file "` + podLogs + `"`,
			"a file without quotes":      "failed to open log file " + podLogs + ": " + noFile,
			"a file of the program's":    `failed to open log file "/var/log/app/web-1.log": open /var/log/app/web-1.log: permission denied`,
			"a program's numbered file":  `failed to open log file "/logs/app/1.log": open /logs/app/1.log: permission denied`,
			"a path without a UID":       `failed to open log file "/logs/shop_web-1/app/1.log": open /logs/shop_web-1/app/1.log: permission denied`,
			"another pod's log file":     strings.ReplaceAll(goneFile, "shop_web-1_", "shop_web-2_"),
			"another namespace's":        strings.ReplaceAll(goneFile, "shop_web-1_", "db_web-1_"),
			"a pod whose name ends so":   strings.ReplaceAll(goneFile, "shop_web-1_", "shop_my-web-1_"),
			"another file of the pod's":  strings.ReplaceAll(goneFile, "app/1.log", "app/previous.log"),
			"another failure with it":    strings.Replace(goneFile, "failed to try resolving symlinks in path", "failed to rotate log file", 1),
			"a first line quoted":        `failed to get parse function: unsupported log format: "connection refused\n"`,
			"words any program may say":  "container status is nil",
			"a line of kubectl's, alone": strings.TrimSuffix(defaulted, "\n"),
		} {
			for _, with := range []args{{}, {"container": "app", "previous": true}, {"all_containers": true}} {
				if got := logsSay(t, out, with); got != out {
					t.Errorf("%s %v: %q", what, with, got)
				}
			}
		}
	})
}

// A container that was named is read without a word of kubectl's: what looks like one is a line of the log.
func TestPodLogs_KubectlsLineOfANamedContainerIsTheLogs(t *testing.T) {
	out := defaulted + goneText
	for _, with := range []args{{"container": "app"}, {"container": "app", "previous": true}, {"all_containers": true}} {
		if got := logsSay(t, out, with); got != out {
			t.Errorf("%v: %q", with, got)
		}
	}
	// another line first is the log's too
	out = "starting\n" + defaulted + goneText
	if got := logsSay(t, out, args{}); got != out {
		t.Errorf("%q", got)
	}
}

func TestPodLogs_AContainerThatWasReadMakesTheAnswerALog(t *testing.T) {
	gone := "[pod/web-1/app] " + goneText
	for name, out := range map[string]string{
		"a line after":                gone + "[pod/web-1/side] ready\n",
		"a line before":               "[pod/web-1/side] ready\n" + gone,
		"a line without an end":       gone + "[pod/web-1/side] ready",
		"one without an end before":   "[pod/web-1/side] ready" + gone,
		"the words on a line":         "[pod/web-1/side] " + goneText + "\n" + gone,
		"a line that names a prefix":  "[pod/web-1/side] copied " + gone,
		"a file's failure and a line": "[pod/web-1/app] " + goneFile + "[pod/web-1/side] ready",
		"no prefix":                   goneText,
		"words before the prefix":     "x " + gone,
		"an empty line":               gone + "[pod/web-1/side] \n",
	} {
		for _, with := range []args{{"all_containers": true}, {"all_containers": true, "previous": true}} {
			if got := logsSay(t, out, with); got != out {
				t.Errorf("%s %v: %q", name, with, got)
			}
		}
	}
	// and without all_containers kubectl writes no prefix: it is the log's
	if got := logsSay(t, gone, args{"container": "app"}); got != gone {
		t.Errorf("%q", got)
	}
}

// The other answers of a log read are as they were, to the byte.
func TestPodLogs_OtherAnswersAreAsTheyWere(t *testing.T) {
	for _, c := range []struct {
		name    string
		out     string
		with    args
		details bool
		want    string
	}{
		{"a log", "ready\nstopped\n", args{}, false, "ready\nstopped\n"},
		{"a log, details", "ready\nstopped\n", args{}, true, "ready\nstopped\n"},
		{"an empty log", "", args{"previous": true}, false, ""},
		{"an empty log, details", "", args{"previous": true, "container": "app"}, true,
			"# No line was read: the newest 50 lines were asked for. An empty log does not say that nothing failed: all_containers=true the pod's other containers, a log store's tools (where offered) older lines and pods that are gone.\n"},
		{"a search", "error one\nready\n", args{"grep": "error"}, false, "# grep \"error\": 1 of 2 lines matched\nerror one"},
		{"a search without a match", "ready\n", args{"grep": "error"}, false, "# grep \"error\": 0 of 1 lines matched"},
		{"a search for the kubelet's words", goneText + "\nready\n", args{"grep": "retrieve"}, false, "# grep \"retrieve\": 1 of 2 lines matched\n" + goneText},
	} {
		t.Run(c.name, func(t *testing.T) {
			withDetails(t, c.details)
			if got := logsSay(t, c.out, c.with); got != c.want {
				t.Errorf("%q, want %q", got, c.want)
			}
		})
	}
}

// What the API server refuses before a log: kubectl ends with 1, and these answers are as they were. A pod that is being
// deleted answers one of them, or its containers are gone (no_log).
func TestPodLogs_WhatFailsBeforeALogIsStillAFailure(t *testing.T) {
	const asked = "shop"
	for text, want := range map[string]string{
		`Error from server (BadRequest): previous terminated container "app" in pod "web-1" not found`:                                       `{"container":"app","hint":"The container has not restarted, so there is no previous log. Read the current log (previous=false) and the pod's events instead.","namespace":"shop","pod":"web-1","status":"no_previous"}`,
		`Error from server (BadRequest): container "app" in pod "web-1" is terminated`:                                                       "",
		`Error from server (BadRequest): container "app" in pod "web-1" is waiting to start: PodInitializing`:                                "",
		`Error from server (BadRequest): pod "web-1" cannot be found - no logs available`:                                                    "",
		`Error from server (NotFound): the server could not find the requested resource ( pods/log web-1)`:                                   "",
		`Error from server: Get "https://10.0.0.7:10250/containerLogs/shop/web-1/app": dial tcp 10.0.0.7:10250: connect: connection refused`: "",
		// kubectl that failed: the kubelet's words in its output do not make it a read
		goneText: "",
	} {
		fakeKubectl(t, func([]string) (string, error) { return kubectlErr(text) })
		got, err := handleGetPodLogs(context.Background(), args{"pod_name": "web-1", "namespace": asked, "previous": true}, nil)
		if want != "" {
			if err != nil || got != want {
				t.Errorf("%s:\n%s %v", text, got, err)
			}
			continue
		}
		if err == nil || got != "" || !strings.Contains(err.Error(), text) {
			t.Errorf("%s: %q %v", text, got, err)
		}
		if errors.Is(err, errBadRequest) {
			t.Errorf("%s: the model's arguments are not what failed", text)
		}
	}
}
