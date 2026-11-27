// One read of a pod's logs: what kubectl logs printed of them without kubectl's own lines, the containers it had to be run
// past, and the answer of a read that holds no line of a log.

package main

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
)

type podLogRead struct {
	pod, namespace, container, since string
	previous, allContainers          bool

	args   []string          // what kubectl was run with
	out    string            // what it printed of the logs
	cut    bool              // out is the end of it
	said   string            // its own line, before the log of a container it picked itself
	picked string            // the container read, "" where it is not known
	ended  string            // the container kubectl ended at
	past   []string          // the containers kubectl was run past: without a previous run, or with no log yet
	why    map[string]string // why each of past has no log yet
	names  []string          // the pod's containers, once they were asked for
	logged []string          // those of names that have the log asked for, as the pod's status says
}

// podContainers lists the containers kubectl logs --all-containers reads, and those the kubelet has the log of as it looks for
// it (validateContainerLogStatus), each on a line of its own that rePodContainer or rePodLogged knows: what kubectl says on
// stderr, as of an API it warns of, is in the same output.
func podContainers(previous bool) string {
	has := `{.lastState.terminated.containerID}`
	if !previous {
		has = `{.state.running.startedAt}{.state.terminated.containerID}` + has
	}
	out := "jsonpath="
	for _, kind := range []string{"initContainer", "container", "ephemeralContainer"} {
		out += `{range .spec.` + kind + `s[*]}container/{.name}{"\n"}{end}{range .status.` + kind + `Statuses[*]}logged/{.name}/` + has + `{"\n"}{end}`
	}
	return out
}

// lineTimesWait bounds the read that only tells words from lines.
const lineTimesWait = 10 * time.Second

// read runs kubectl logs. A container without a previous run, or one that has not started, ends it, and what it read of the
// others goes with it: the pod's containers are read again past that one. The failure stands when that read none of the
// others.
func (l *podLogRead) read(ctx context.Context, headers http.Header, args []string) error {
	out, cut, err := runKubectlKeepingEnd(ctx, args...)
	if err == nil {
		l.args = args
		l.take(out, cut)
		return nil
	}
	ended, why := l.endedAt(err)
	if ended == "" || !l.allContainers {
		return err
	}
	l.args, l.ended = append(slices.Clone(args), "--ignore-errors"), ended
	out, cut, againErr := runKubectlKeepingEnd(ctx, l.args...)
	if againErr != nil {
		return err
	}
	if _, after := l.pastLine(); after.MatchString(out) {
		l.list(ctx, headers)
	}
	l.take(out, cut)
	if cut && len(l.past) == 0 { // its line is in the front left out
		l.past, l.why = []string{ended}, map[string]string{ended: why}
	}
	if cut || reLogPrefix.MatchString(l.out) {
		return nil
	}
	if l.out == "" {
		if others, known := l.others(ctx, headers, l.past); known && len(others) > 0 {
			return nil
		}
	}
	return err
}

// endedAt is the container without a log to read that ended kubectl, and why it has none, "" where something else did: the
// text of the failure holds the lines of the containers read before it, and those of a long read are cut.
func (l *podLogRead) endedAt(failed error) (container, why string) {
	text := failed.Error()
	if i := strings.LastIndex(text, truncatedMarkerLead); i >= 0 {
		text = text[:i]
	}
	if l.previous {
		if m := reEndsNoPrevious.FindStringSubmatch(text); m != nil && m[2] == l.pod {
			return m[1], ""
		}
		return "", ""
	}
	if m := reEndsNoLogYet.FindStringSubmatch(text); m != nil && m[2] == l.pod {
		return m[1], whyNotYet(m[3])
	}
	return "", ""
}

// whyNotYet is the kubelet's word of a container that waits, which has no reason of some.
func whyNotYet(is string) string { return strings.TrimSuffix(strings.TrimSpace(is), ":") }

// take reads what kubectl printed. Its own line comes first, so the end of a cut log holds none of it.
func (l *podLogRead) take(out string, cut bool) {
	l.out, l.cut, l.said, l.picked = out, cut, "", l.container
	switch {
	case slices.Contains(l.args, "--ignore-errors"):
		containers := []string{l.ended}
		if len(l.names) > 0 {
			containers = slices.DeleteFunc(slices.Clone(l.names), func(name string) bool { return slices.Contains(l.logged, name) })
		}
		line, _ := l.pastLine()
		l.out, l.past, l.why = takePast(out, l.namespace, l.pod, line, containers)
	case l.container == "" && !l.allContainers && !cut:
		m := reDefaulted.FindStringSubmatch(out)
		l.said, l.picked, l.out = m[0], m[1], out[len(m[0]):]
	}
}

// pastLine is kubectl's own line of a container it is run past, and the same after the text of a line.
func (l *podLogRead) pastLine() (line, after *regexp.Regexp) {
	if l.previous {
		return reNoPreviousLine, reNoPreviousAfter
	}
	return reNoLogYetLine, reNoLogYetAfter
}

// takePast takes kubectl's own lines (own) of the containers it was run past out of what --ignore-errors printed, and names
// them, with why a line says a container has no log. One is on the line of what was printed before it where that has no end:
// a log's last line, which ends here, or the kubelet's words, which noLogOf reads. What a container wrote may end a line the
// same, so one that is not a line of its own is kubectl's only where it names one of containers, the ones that may have no
// log, of which no line was read. It names each once: two lines that name one are the log's where one is a line of its own,
// and where none is, both stay, since which of them is kubectl's is not known.
func takePast(out, namespace, pod string, own *regexp.Regexp, containers []string) (string, []string, map[string]string) {
	var rest strings.Builder
	var names []string
	why, after := map[string]string{}, map[string]int{}
	containers = slices.DeleteFunc(slices.Clone(containers), func(name string) bool {
		return strings.Contains(out, "[pod/"+pod+"/"+name+"] ")
	})
	named := func(line string, m []int) {
		name := line[m[2]:m[3]]
		names = append(names, name)
		if len(m) > 6 {
			why[name] = whyNotYet(line[m[6]:m[7]])
		}
	}
	for line := range strings.SplitAfterSeq(out, "\n") {
		switch m := own.FindStringSubmatchIndex(line); {
		case m == nil || line[m[4]:m[5]] != pod:
		case m[0] == 0:
			named(line, m)
		default:
			after[line[m[2]:m[3]]]++
		}
	}
	for line := range strings.SplitAfterSeq(out, "\n") {
		m := own.FindStringSubmatchIndex(line)
		if m == nil || line[m[4]:m[5]] != pod {
			rest.WriteString(line)
			continue
		}
		if name := line[m[2]:m[3]]; m[0] > 0 {
			if !slices.Contains(containers, name) || slices.Contains(names, name) || after[name] > 1 {
				rest.WriteString(line)
				continue
			}
			named(line, m)
		}
		before := line[:m[0]]
		rest.WriteString(before)
		if _, _, words := noLogOf(before, namespace, pod, "", true); before != "" && !words {
			rest.WriteByte('\n')
		}
	}
	slices.Sort(names)
	return rest.String(), names, why
}

// noLog is noLogOf of this read. The end of a cut log is of one that was read, whatever it ends with.
func (l *podLogRead) noLog() (containers []string, words string, ok bool) {
	if l.cut {
		return nil, "", false
	}
	return noLogOf(l.out, l.namespace, l.pod, l.picked, l.allContainers)
}

// wrote reports whether what noLog took for the kubelet's words is what a container wrote: a log's last line may have no
// end either. Asked for times, kubectl prints one before each line and none before the words.
func (l *podLogRead) wrote(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, lineTimesWait)
	defer cancel()
	out, cut, err := runKubectlKeepingEnd(ctx, append(slices.Clone(l.args), "--timestamps")...)
	if err != nil {
		return false
	}
	timed := *l
	timed.take(out, cut)
	if _, _, words := timed.noLog(); words {
		return false
	}
	timed.take(reLineTime.ReplaceAllString(out, "$1"), cut)
	_, _, words := timed.noLog()
	return words
}

// list asks for the pod's containers, once; none is known of a pod that could not be read.
func (l *podLogRead) list(ctx context.Context, headers http.Header) {
	if l.names != nil {
		return
	}
	l.names = []string{}
	out, err := runKubectl(ctx, headers, "get", "pod", l.pod, "-n", l.namespace, "-o", podContainers(l.previous))
	if err != nil {
		return
	}
	for _, m := range rePodContainer.FindAllStringSubmatch(out, -1) {
		l.names = append(l.names, m[1])
	}
	for _, m := range rePodLogged.FindAllStringSubmatch(out, -1) {
		l.logged = append(l.logged, m[1])
	}
}

// others are the pod's containers but those seen. They are not known when the pod could not be read, or when what was read
// does not hold every one of seen.
func (l *podLogRead) others(ctx context.Context, headers http.Header, seen []string) (names []string, known bool) {
	l.list(ctx, headers)
	for _, name := range l.names {
		if !slices.Contains(seen, name) {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return names, len(l.names)-len(names) == len(seen)
}

// withoutALine answers a read that holds no line and has something to say of it: the kubelet's words in place of a log, a
// container kubectl was run past beside others, or kubectl's own line before an empty log. ok is false of any other.
func (l *podLogRead) withoutALine(ctx context.Context, headers http.Header) (answer string, ok bool, err error) {
	gone, words, none := l.noLog()
	switch {
	case none && l.wrote(ctx):
		return "", false, nil
	case none && !l.allContainers:
		answer, err = l.noLogResult(gone, words, true)
	case none || l.out == "" && len(l.past) > 0:
		// a container without a line leaves nothing in what kubectl printed
		empty, known := l.others(ctx, headers, append(slices.Clone(gone), l.past...))
		if known && len(empty) > 0 {
			return l.noLine(empty, gone, words), true, nil
		}
		answer, err = l.noLogResult(gone, words, known)
	case l.out == "" && l.said != "":
		said := strings.Join(strings.Split(strings.TrimSuffix(l.said, "\n"), "\n"), "; ")
		return l.noLineSays(fmt.Sprintf("the %s holds no line%s (kubectl: %s).", l.log(), sinceText(l.since), said)), true, nil
	default:
		return "", false, nil
	}
	return answer, true, err
}

func (l *podLogRead) log() string {
	if l.previous {
		return "previous log"
	}
	return "log"
}

// noLine is the answer of a read of every container that read the logs of empty, which hold no line.
func (l *podLogRead) noLine(empty, gone []string, words string) string {
	says := fmt.Sprintf("the %s of %s was read and holds no line%s.", l.log(), strings.Join(empty, ", "), sinceText(l.since))
	if len(gone) > 0 {
		says += fmt.Sprintf(" The %s of %s is gone or cannot be read (the kubelet answered in its place: %s). %s",
			l.log(), strings.Join(gone, ", "), words, l.goneElsewhere())
	}
	if len(l.past) > 0 {
		says += " " + l.noLogOfPast()
	}
	return l.noLineSays(says)
}

func (l *podLogRead) noLineSays(says string) string {
	if resultDetails() {
		says += emptyLogNote(l.previous, l.allContainers)
	}
	return "# No line was read: " + says + "\n"
}
