// Package auditsink copies audit rows out of the database to configured sinks
// (S3-compatible storage, webhooks, email, a file). The database stays the
// primary store; the dispatcher (dispatcher.go) reads rows past each sink's
// cursor and sends them in batches. Delivery is at least once: Event.ID is the
// deduplication key on the receiving side.
package auditsink

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"
)

// Event is one audit row as it leaves Kubeast (docs/audit-log-plan.md §4).
type Event struct {
	ID          int64           `json:"id"`
	Time        time.Time       `json:"time"`
	Service     string          `json:"service,omitempty"`
	Action      string          `json:"action"`
	Result      string          `json:"result"`
	Error       string          `json:"error,omitempty"`
	ActorUserID string          `json:"actor_user_id,omitempty"`
	ActorEmail  string          `json:"actor_email,omitempty"`
	TargetType  string          `json:"target_type,omitempty"`
	TargetID    string          `json:"target_id,omitempty"`
	TargetEmail string          `json:"target_email,omitempty"`
	Cluster     string          `json:"cluster,omitempty"`
	Namespace   string          `json:"namespace,omitempty"`
	Path        string          `json:"path,omitempty"`
	RequestIP   string          `json:"request_ip,omitempty"`
	UserAgent   string          `json:"user_agent,omitempty"`
	RequestID   string          `json:"request_id,omitempty"`
	Before      json.RawMessage `json:"before,omitempty"`
	After       json.RawMessage `json:"after,omitempty"`
}

// Line is a one-line human summary for chat and mail sinks:
// "k8s.pod.delete failure · alice@example.com · pod nginx · default/test2 · 07:01:02Z".
// A target's name or an error can come from a request, so a control character in
// a field becomes a space and the summary cannot show a line nobody recorded.
func (e Event) Line() string {
	parts := []string{e.Action + " " + e.Result}
	if e.ActorEmail != "" {
		parts = append(parts, e.ActorEmail)
	} else if e.ActorUserID != "" {
		parts = append(parts, e.ActorUserID)
	}
	if e.TargetType != "" || e.TargetID != "" {
		parts = append(parts, strings.TrimSpace(e.TargetType+" "+e.TargetID))
	}
	if scope := strings.Trim(e.Namespace+"/"+e.Cluster, "/"); scope != "" {
		parts = append(parts, scope)
	}
	parts = append(parts, e.Time.UTC().Format(time.RFC3339))
	if e.Error != "" {
		parts = append(parts, "error: "+truncate(e.Error, 200))
	}
	return strings.Map(controlToSpace, strings.Join(parts, " · "))
}

func controlToSpace(r rune) rune {
	if unicode.IsControl(r) || unicode.In(r, unicode.Zl, unicode.Zp, unicode.Bidi_Control) {
		return ' '
	}
	return r
}

// Summary is a short title for a batch ("3 audit events: k8s.pod.delete, …").
func Summary(events []Event) string {
	seen := map[string]bool{}
	var actions []string
	for _, e := range events {
		if !seen[e.Action] {
			seen[e.Action] = true
			actions = append(actions, e.Action)
		}
	}
	if len(actions) > 3 {
		actions = append(actions[:3], "…")
	}
	noun := "events"
	if len(events) == 1 {
		noun = "event"
	}
	return fmt.Sprintf("Kubeast: %d audit %s (%s)", len(events), noun, strings.Join(actions, ", "))
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
