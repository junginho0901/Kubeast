// The Timeline screen's answer as a tool: k8s-service reads the events and the rollouts as the caller, inside a grant
// limited to namespaces, and its counts go out as they are. Its window is whole hours back from now and its object
// filter needs a name; an end before now or a kind alone is kept from the rows it lists, and what that leaves
// uncounted is null, not zero.

package main

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	timelineEventsDefault = 200
	// the newest the screen lists
	timelineEventsMax   = 500
	timelineDefaultSpan = 24 * time.Hour
	// parseFromTime's longest window and the API's, which answers 400 past it
	timelineMaxBack = 90 * 24 * time.Hour
)

type timelineWindow struct {
	hours int
	until time.Time // zero when the window ends now
	note  string
}

// timelineWindowOf is the API's hours for since_time (24h, 7d or an RFC3339 time, back from until_time when given) to
// until_time (default now), the day before the end when no start is given, rounded out to a whole hour.
func timelineWindowOf(sinceTime, untilTime string, now time.Time) (timelineWindow, error) {
	var w timelineWindow
	end := now
	if untilTime != "" {
		t, err := time.Parse(time.RFC3339, untilTime)
		if err != nil {
			return w, wrapBadRequest("until_time must be an RFC3339 time")
		}
		if t.Before(now) {
			w.until, end = t, t
		}
	}
	start := end.Add(-timelineDefaultSpan)
	if sinceTime != "" {
		t, err := parseFromTime(sinceTime, end)
		if err != nil {
			return w, wrapBadRequest("since_time: " + err.Error())
		}
		start = t
	}
	if !start.Before(end) {
		return w, wrapBadRequest("since_time must be before until_time and before now")
	}
	back := now.Sub(start)
	if back > timelineMaxBack {
		return w, wrapBadRequest("since_time reaches at most 90 days back")
	}
	w.hours = int(math.Ceil(back.Hours()))
	if time.Duration(w.hours)*time.Hour != back {
		w.note = "k8s-service reads whole hours back from now: the window starts at summary.time_range.start, at or before the start asked."
	}
	return w, nil
}

// timelineEventsNote says how far the list holds what it could: the screen's "newest M of N", or null counted out loud.
func timelineEventsNote(listed, read, matching int, inRange interface{}, narrowed bool, eventType string) string {
	events := "events"
	if eventType != "" {
		events = eventType + " events"
	}
	total := matching
	if narrowed {
		counted, ok := inRange.(int)
		if !ok {
			return fmt.Sprintf("Read the newest %d of the %d %s in the window and %d of them match. The older ones were not read, so how many match is null: not counted, not zero. "+
				"Narrow with namespace, event_type, or kind and name.", read, matching, events, listed)
		}
		total = counted
	}
	if listed < total {
		return fmt.Sprintf("The newest %d of the %d %s in this range are listed.", listed, total, events)
	}
	return ""
}

// handleTimeline answers events and rollout revisions of a namespace, one object, or every namespace the caller reads.
func handleTimeline(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	kind := eventKindName(argString(args, "kind", ""))
	name := argString(args, "name", "")
	eventType := argString(args, "event_type", "")
	if name != "" && (kind == "" || namespace == "") {
		return "", wrapBadRequest("name needs kind and namespace (a cluster-scoped object's events are in namespace default)")
	}
	now := time.Now()
	window, err := timelineWindowOf(argString(args, "since_time", ""), argString(args, "until_time", ""), now)
	if err != nil {
		return "", err
	}
	limit := argInt(args, "limit", timelineEventsDefault)
	if limit <= 0 {
		limit = timelineEventsDefault
	}
	if limit > timelineEventsMax {
		limit = timelineEventsMax
	}
	kindAlone := kind != "" && name == ""
	narrowed := !window.until.IsZero() || kindAlone
	read := limit
	if narrowed {
		read = timelineEventsMax
	}

	q := url.Values{"hours": {strconv.Itoa(window.hours)}, "limit": {strconv.Itoa(read)}}
	if eventType != "" {
		q.Set("type", eventType)
	}
	path := "/timeline"
	if namespace != "" {
		path = "/namespaces/" + url.PathEscape(namespace) + "/timeline"
		if name != "" {
			path += "/" + url.PathEscape(kind) + "/" + url.PathEscape(name)
		}
	}
	status, body, err := k8sServiceGet(ctx, headers, path, q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("timeline", "", status, body)
	if err != nil || out != "" {
		return out, err
	}

	summary, _ := reply["summary"].(map[string]interface{})
	events, _ := reply["events"].([]interface{})
	rollouts, _ := reply["rollout_history"].([]interface{})
	matching := 0
	if v, ok := summary["events_matching"].(float64); ok {
		matching = int(v)
	}
	after := func(row map[string]interface{}, key string) bool {
		if window.until.IsZero() {
			return false
		}
		t, err := time.Parse(time.RFC3339, fmt.Sprint(row[key]))
		return err == nil && t.After(window.until)
	}
	otherKind := func(v interface{}) bool {
		return kindAlone && !strings.EqualFold(fmt.Sprint(v), kind)
	}

	listedAfter := 0
	kept := make([]interface{}, 0, len(events))
	for _, e := range events {
		row, _ := e.(map[string]interface{})
		// the same object written twice: the model pays for every copy
		delete(row, "resource")
		if after(row, "timestamp") {
			listedAfter++
			continue
		}
		object, _ := row["involved_object"].(map[string]interface{})
		if otherKind(object["kind"]) {
			continue
		}
		kept = append(kept, row)
	}
	// The list is the newest of the window: whole, it counts anything; reaching past the end, it holds all that came after.
	var inRange interface{}
	switch {
	case len(events) >= matching:
		inRange = len(kept)
	case !kindAlone && listedAfter < len(events):
		inRange = matching - listedAfter
	}
	if len(kept) > limit {
		kept = kept[:limit]
	}

	result := map[string]interface{}{
		"namespace": namespaceOrAll(namespace),
		"summary":   summary,
		"events":    kept,
	}
	if scope := scopedNamespaces(ctx); len(scope) > 0 && namespace == "" {
		result["namespace"] = scope
	}
	if name != "" {
		result["object"] = map[string]interface{}{"kind": kind, "name": name}
	}
	if eventType != "" {
		result["event_type"] = eventType
	}
	if window.note != "" {
		result["window_note"] = window.note
	}
	if note := timelineEventsNote(len(kept), len(events), matching, inRange, narrowed, eventType); note != "" {
		result["events_note"] = note
	}

	noRollouts := false
	if rolloutsError, _ := summary["rollouts_error"].(string); rolloutsError != "" {
		result["rollouts_total"] = nil
		result["rollout_history"] = nil
		result["rollouts_note"] = "The rollouts could not be read, so none are listed: they are not counted, not zero (" + rolloutsError + ")."
	} else {
		rows := make([]interface{}, 0, len(rollouts))
		for _, r := range rollouts {
			row, _ := r.(map[string]interface{})
			if after(row, "created_at") || otherKind(row["kind"]) {
				continue
			}
			rows = append(rows, row)
		}
		noRollouts = len(rows) == 0
		result["rollouts_total"] = len(rows)
		result["rollout_history"] = rows
	}

	if narrowed {
		block := map[string]interface{}{
			"events_listed":   len(kept),
			"events_matching": inRange,
			"note":            "summary counts the whole window up to now and every kind; events_matching is what this narrowing keeps of it, null when it was not counted.",
		}
		if !window.until.IsZero() {
			block["until_time"] = window.until.UTC().Format(time.RFC3339)
		}
		if kindAlone {
			block["kind"] = kind
		}
		result["narrowed"] = block
	}
	if len(kept) == 0 && noRollouts && inRange != nil {
		result["hint"] = "Nothing in this window. Kubernetes events typically have a ~1 hour TTL, so an older window can be empty though things happened."
	}
	return marshalOrdered(result,
		[]string{"namespace", "object", "event_type", "window_note", "summary", "events_note", "narrowed", "rollouts_total", "rollouts_note", "hint"},
		[]string{"rollout_history", "events"})
}
