// One read of a pod's logs: what kubectl logs printed of them without kubectl's own lines, the containers it had to be run
// past, and the answer of a read that holds no line of a log.

package main

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
)

type podLogRead struct {
	pod, namespace, container, since string
	previous, allContainers          bool

	args   []string // what kubectl was run with
	out    string   // what it printed of the logs
	cut    bool     // out is the end of it
	said   string   // its own line, before the log of a container it picked itself
	picked string   // the container read, "" where it is not known
	never  []string // the containers without a previous run
	names  []string // the pod's containers, once they were asked for
}

// podContainers lists the containers kubectl logs --all-containers reads.
const podContainers = "jsonpath={.spec.initContainers[*].name} {.spec.containers[*].name} {.spec.ephemeralContainers[*].name}"

// read runs kubectl logs. A container without a previous run ends it, and what it read of the others goes with it: the
// pod's containers are read again past that one. The failure stands when that read none of the others.
func (l *podLogRead) read(ctx context.Context, headers http.Header, args []string) error {
	out, cut, err := runKubectlKeepingEnd(ctx, args...)
	if err == nil {
		l.args = args
		l.take(out, cut)
		return nil
	}
	ended := endedWithoutPrevious(err, l.pod)
	if ended == "" || !l.previous || !l.allContainers {
		return err
	}
	l.args = append(slices.Clone(args), "--ignore-errors")
	out, cut, againErr := runKubectlKeepingEnd(ctx, l.args...)
	if againErr != nil {
		return err
	}
	l.take(out, cut)
	if cut && len(l.never) == 0 { // its line is in the front left out
		l.never = []string{ended}
	}
	if cut || reLogPrefix.MatchString(l.out) {
		return nil
	}
	if l.out == "" {
		if others, known := l.others(ctx, headers, l.never); known && len(others) > 0 {
			return nil
		}
	}
	return err
}

// endedWithoutPrevious is the container without a previous run that ended kubectl, "" where something else did: the text
// of the failure holds the lines of the containers read before it, and those of a long read are cut.
func endedWithoutPrevious(failed error, pod string) string {
	text := failed.Error()
	if i := strings.LastIndex(text, truncatedMarkerLead); i >= 0 {
		text = text[:i]
	}
	if m := reEndsNoPrevious.FindStringSubmatch(text); m != nil && m[2] == pod {
		return m[1]
	}
	return ""
}

// take reads what kubectl printed. Its own line comes first, so the end of a cut log holds none of it.
func (l *podLogRead) take(out string, cut bool) {
	l.out, l.cut, l.said, l.picked = out, cut, "", l.container
	switch {
	case slices.Contains(l.args, "--ignore-errors"):
		l.out, l.never = takeNoPrevious(out, l.namespace, l.pod)
	case l.container == "" && !l.allContainers && !cut:
		m := reDefaulted.FindStringSubmatch(out)
		l.said, l.picked, l.out = m[0], m[1], out[len(m[0]):]
	}
}

// takeNoPrevious takes kubectl's own lines of the containers without a previous run out of what --ignore-errors printed,
// and names them. One is on the line of what was printed before it where that has no end: a log's last line, which ends
// here, or the kubelet's words, which noLogOf reads.
func takeNoPrevious(out, namespace, pod string) (string, []string) {
	var rest strings.Builder
	var names []string
	for line := range strings.SplitAfterSeq(out, "\n") {
		m := reNoPreviousLine.FindStringSubmatchIndex(line)
		if m == nil || line[m[4]:m[5]] != pod {
			rest.WriteString(line)
			continue
		}
		names = append(names, line[m[2]:m[3]])
		before := line[:m[0]]
		rest.WriteString(before)
		if _, _, words := noLogOf(before, namespace, pod, "", true); before != "" && !words {
			rest.WriteByte('\n')
		}
	}
	slices.Sort(names)
	return rest.String(), names
}

// noLog is noLogOf of this read. The end of a cut log is of one that was read, whatever it ends with.
func (l *podLogRead) noLog() (containers []string, words string, ok bool) {
	if l.cut {
		return nil, "", false
	}
	return noLogOf(l.out, l.namespace, l.pod, l.picked, l.allContainers)
}

// others are the pod's containers but those seen. They are not known when the pod could not be read, or when what was read
// does not hold every one of seen.
func (l *podLogRead) others(ctx context.Context, headers http.Header, seen []string) (names []string, known bool) {
	if l.names == nil {
		out, err := runKubectl(ctx, headers, "get", "pod", l.pod, "-n", l.namespace, "-o", podContainers)
		if err != nil {
			return nil, false
		}
		l.names = strings.Fields(out)
	}
	for _, name := range l.names {
		if !slices.Contains(seen, name) {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return names, len(l.names)-len(names) == len(seen)
}

// withoutALine answers a read that holds no line and has something to say of it: the kubelet's words in place of a log, a
// container without a previous run beside others, or kubectl's own line before an empty log. ok is false of any other.
func (l *podLogRead) withoutALine(ctx context.Context, headers http.Header) (answer string, ok bool, err error) {
	gone, words, none := l.noLog()
	switch {
	case none && !l.allContainers:
		answer, err = l.noLogResult(gone, words, true)
	case none || l.out == "" && len(l.never) > 0:
		// a container without a line leaves nothing in what kubectl printed
		empty, known := l.others(ctx, headers, append(slices.Clone(gone), l.never...))
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
	if len(l.never) > 0 {
		says += " " + noPreviousLog(l.never)
	}
	return l.noLineSays(says)
}

func (l *podLogRead) noLineSays(says string) string {
	if resultDetails() {
		says += emptyLogNote(l.previous, l.allContainers)
	}
	return "# No line was read: " + says + "\n"
}
