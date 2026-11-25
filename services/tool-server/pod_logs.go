// One read of a pod's logs: what kubectl logs printed of them without kubectl's own lines, the containers it had to be run
// past, and the answer of a read that holds no line of a log.

package main

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
)

type podLogRead struct {
	pod, namespace, container, since string
	previous, allContainers          bool

	args   []string // what kubectl was run with
	out    string   // what it printed of the logs
	cut    bool     // out is the end of it
	said   string   // its own line, before the log of a container it picked itself
	picked string   // the container read, "" where it is not known
	ended  string   // the container without a previous run that ended kubectl
	never  []string // the containers without a previous run
	names  []string // the pod's containers, once they were asked for
}

// podContainers lists the containers kubectl logs --all-containers reads, each on a line of its own that rePodContainer
// knows: what kubectl says on stderr, as of an API it warns of, is in the same output.
const podContainers = `jsonpath={range .spec.initContainers[*]}container/{.name}{"\n"}{end}{range .spec.containers[*]}container/{.name}{"\n"}{end}` +
	`{range .spec.ephemeralContainers[*]}container/{.name}{"\n"}{end}`

// lineTimesWait bounds the read that only tells words from lines.
const lineTimesWait = 10 * time.Second

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
	l.args, l.ended = append(slices.Clone(args), "--ignore-errors"), ended
	out, cut, againErr := runKubectlKeepingEnd(ctx, l.args...)
	if againErr != nil {
		return err
	}
	if reNoPreviousAfter.MatchString(out) {
		l.list(ctx, headers)
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
		containers := l.names
		if len(containers) == 0 {
			containers = []string{l.ended}
		}
		l.out, l.never = takeNoPrevious(out, l.namespace, l.pod, containers)
	case l.container == "" && !l.allContainers && !cut:
		m := reDefaulted.FindStringSubmatch(out)
		l.said, l.picked, l.out = m[0], m[1], out[len(m[0]):]
	}
}

// takeNoPrevious takes kubectl's own lines of the containers without a previous run out of what --ignore-errors printed,
// and names them. One is on the line of what was printed before it where that has no end: a log's last line, which ends
// here, or the kubelet's words, which noLogOf reads. What a container wrote may end a line the same, so one that is not a
// line of its own is kubectl's only where it names one of containers, which kubectl has not named yet: it names each once.
func takeNoPrevious(out, namespace, pod string, containers []string) (string, []string) {
	var rest strings.Builder
	var names []string
	for line := range strings.SplitAfterSeq(out, "\n") {
		if m := reNoPreviousLine.FindStringSubmatchIndex(line); m != nil && m[0] == 0 && line[m[4]:m[5]] == pod {
			names = append(names, line[m[2]:m[3]])
		}
	}
	for line := range strings.SplitAfterSeq(out, "\n") {
		m := reNoPreviousLine.FindStringSubmatchIndex(line)
		if m == nil || line[m[4]:m[5]] != pod {
			rest.WriteString(line)
			continue
		}
		if name := line[m[2]:m[3]]; m[0] > 0 {
			if !slices.Contains(containers, name) || slices.Contains(names, name) {
				rest.WriteString(line)
				continue
			}
			names = append(names, name)
		}
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
	out, err := runKubectl(ctx, headers, "get", "pod", l.pod, "-n", l.namespace, "-o", podContainers)
	if err != nil {
		return
	}
	for _, m := range rePodContainer.FindAllStringSubmatch(out, -1) {
		l.names = append(l.names, m[1])
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
// container without a previous run beside others, or kubectl's own line before an empty log. ok is false of any other.
func (l *podLogRead) withoutALine(ctx context.Context, headers http.Header) (answer string, ok bool, err error) {
	gone, words, none := l.noLog()
	switch {
	case none && l.wrote(ctx):
		return "", false, nil
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
