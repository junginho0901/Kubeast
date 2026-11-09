package handler

import (
	"strconv"
	"strings"
	"time"
)

// logLineTimeFormat is the kubelet's fixed-width stamp; in UTC it ends in Z, so ids compare as text too.
const logLineTimeFormat = "2006-01-02T15:04:05.000000000Z07:00"

// logLineID names a followed log line in the SSE id the browser sends back as Last-Event-ID when it reconnects: the
// line's stamp and its place among the lines given that stamp (a runtime may stamp the lines of one write alike).
type logLineID struct {
	at time.Time
	n  int
}

func (id logLineID) String() string {
	return id.at.UTC().Format(logLineTimeFormat) + "#" + strconv.Itoa(id.n)
}

func (id logLineID) after(o logLineID) bool {
	return id.at.After(o.at) || (id.at.Equal(o.at) && id.n > o.n)
}

// parseLogLineID reads an id logLineID.String wrote; anything else is no place to go on from.
func parseLogLineID(s string) (logLineID, bool) {
	stamp, place, ok := strings.Cut(s, "#")
	if !ok {
		return logLineID{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil {
		return logLineID{}, false
	}
	n, err := strconv.Atoi(place)
	if err != nil || n < 1 {
		return logLineID{}, false
	}
	return logLineID{at: at, n: n}, true
}

// logLineIDs numbers a followed log's lines in the order they come, so each id is after the one before: a line
// stamped no later than the last (stdout and stderr written a moment apart) or with no stamp takes the next place.
type logLineIDs struct {
	last     logLineID
	numbered bool
}

// next is the id of line; false while no line so far had a stamp.
func (l *logLineIDs) next(line string) (logLineID, bool) {
	stamp, _, _ := strings.Cut(line, " ")
	at, err := time.Parse(time.RFC3339Nano, stamp)
	switch {
	case err == nil && (!l.numbered || at.After(l.last.at)):
		l.last = logLineID{at: at, n: 1}
	case l.numbered:
		l.last.n++
	default:
		return logLineID{}, false
	}
	l.numbered = true
	return l.last, true
}
