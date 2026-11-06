package auditsink

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const fieldWithControls = "x\r\n- k8s.node.drain success\ty\x00z\x7fw\u0085v u t‮s"
const fieldOnOneLine = "x  - k8s.node.drain success y z w v u t s"

func TestLineKeepsEveryFieldOnOneLine(t *testing.T) {
	cases := map[string]func(*Event, string){
		"action":      func(e *Event, v string) { e.Action = v },
		"result":      func(e *Event, v string) { e.Result = v },
		"actor email": func(e *Event, v string) { e.ActorEmail = v },
		"actor id":    func(e *Event, v string) { e.ActorUserID = v },
		"target type": func(e *Event, v string) { e.TargetType = v },
		"target id":   func(e *Event, v string) { e.TargetID = v },
		"namespace":   func(e *Event, v string) { e.Namespace = v },
		"cluster":     func(e *Event, v string) { e.Cluster = v },
		"error":       func(e *Event, v string) { e.Error = v },
	}
	for name, set := range cases {
		t.Run(name, func(t *testing.T) {
			ev := Event{Time: time.Date(2026, 10, 5, 7, 1, 2, 0, time.UTC)}
			set(&ev, fieldWithControls)
			if line := ev.Line(); !strings.Contains(line, fieldOnOneLine) {
				t.Fatalf("line = %q, want it to hold %q", line, fieldOnOneLine)
			}
		})
	}
}

func TestLineLeavesOrdinaryTextAlone(t *testing.T) {
	ev := sampleEvents()[0]
	if got, want := ev.Line(), "k8s.pod.delete success · alice@example.com · pod nginx · default/test2 · 2026-10-05T07:01:02Z"; got != want {
		t.Fatalf("line = %q, want %q", got, want)
	}
	ev.Error = "접근 거부 ✓ <x>"
	if got := ev.Line(); !strings.Contains(got, "error: 접근 거부 ✓ <x>") {
		t.Fatalf("line = %q", got)
	}
}

func TestEmailSummaryHasOneLinePerEventAndTheRecordsStayExact(t *testing.T) {
	sent := Event{ID: 7, Time: time.Date(2026, 10, 5, 7, 1, 2, 0, time.UTC), Action: "k8s.networkflows.query", Result: "success",
		TargetType: "deployment", TargetID: "web\r\n- k8s.node.drain success · admin@example.com", Namespace: "team\na", Error: "first\nsecond"}
	e := &emailSink{cfg: EmailConfig{From: "kubeast@example.com", To: []string{"sre@example.com"}}}

	_, body, ok := strings.Cut(string(e.message([]Event{sent}, sent.Time)), "\r\n\r\n")
	if !ok {
		t.Fatal("message has no body")
	}
	summary, records, ok := strings.Cut(body, "\r\n-- records (NDJSON) --\r\n")
	if !ok {
		t.Fatalf("message has no records part:\n%s", body)
	}
	if lines := strings.Split(strings.TrimRight(summary, "\r\n"), "\n"); len(lines) != 1 {
		t.Fatalf("summary has %d lines for one event:\n%s", len(lines), summary)
	}
	var got Event
	if err := json.Unmarshal([]byte(strings.TrimSpace(records)), &got); err != nil {
		t.Fatal(err)
	}
	if got.TargetID != sent.TargetID || got.Namespace != sent.Namespace || got.Error != sent.Error {
		t.Fatalf("records changed the row: %+v", got)
	}
}
