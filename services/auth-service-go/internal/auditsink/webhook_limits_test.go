package auditsink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// limitedReceiver answers 400 to a body over max bytes, as Teams does past
// 28 KB and PagerDuty past 512 000 bytes, and keeps the bodies it took.
type limitedReceiver struct {
	mu     sync.Mutex
	max    int
	status int
	bodies [][]byte
	sizes  []int
}

func (l *limitedReceiver) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sizes = append(l.sizes, len(b))
	if len(b) > l.max {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "message too large")
		return
	}
	l.bodies = append(l.bodies, b)
	w.WriteHeader(l.status)
}

func (l *limitedReceiver) taken() [][]byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([][]byte(nil), l.bodies...)
}

func longTargetEvents(n, targetLen int) []Event {
	t0 := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	var out []Event
	for i := 1; i <= n; i++ {
		out = append(out, Event{ID: int64(i), Time: t0.Add(time.Duration(i) * time.Second), Service: "k8s", Action: "k8s.configmap.update",
			Result: "success", ActorEmail: "alice@example.com", TargetType: "configmap", TargetID: fmt.Sprintf("cm-%03d-%s", i, strings.Repeat("n", targetLen)),
			Cluster: "prod", Namespace: "default"})
	}
	return out
}

// legacyTeamsMessage is teamsMessage as it was before cards had a size limit.
func legacyTeamsMessage(events []Event, start, end int) map[string]any {
	body := []map[string]any{{"type": "TextBlock", "text": Summary(events[start:end]), "weight": "Bolder", "wrap": true}}
	for _, e := range events[start:end] {
		body = append(body, map[string]any{"type": "RichTextBlock", "spacing": "Small", "inlines": []map[string]any{{"type": "TextRun", "text": e.Line()}}})
	}
	return map[string]any{
		"type": "message",
		"attachments": []map[string]any{{
			"contentType": "application/vnd.microsoft.card.adaptive",
			"contentUrl":  nil,
			"content": map[string]any{
				"$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
				"type":    "AdaptiveCard",
				"version": "1.4",
				"body":    body,
			},
		}},
	}
}

func teamsLines(t *testing.T, card []byte) []string {
	t.Helper()
	var msg struct {
		Attachments []struct {
			Content struct {
				Body []struct {
					Type    string `json:"type"`
					Inlines []struct {
						Text string `json:"text"`
					} `json:"inlines"`
				} `json:"body"`
			} `json:"content"`
		} `json:"attachments"`
	}
	if err := json.Unmarshal(card, &msg); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, b := range msg.Attachments[0].Content.Body {
		if b.Type == "RichTextBlock" {
			lines = append(lines, b.Inlines[0].Text)
		}
	}
	return lines
}

// A card under the limit is the bytes it was.
func TestTeamsCardUnderTheLimitIsUnchanged(t *testing.T) {
	for name, events := range map[string][]Event{
		"sample":                sampleEvents(),
		"45 lines in 3 cards":   longTargetEvents(45, 200),
		"20 lines near the cap": longTargetEvents(20, 1000),
	} {
		t.Run(name, func(t *testing.T) {
			recv := &limitedReceiver{max: 28 << 10, status: http.StatusAccepted}
			srv := httptest.NewServer(recv)
			defer srv.Close()
			if err := webhook(t, "teams", "", map[string]string{"url": srv.URL}, nil).Send(context.Background(), events); err != nil {
				t.Fatal(err)
			}
			got := recv.taken()
			var want [][]byte
			for start := 0; start < len(events); start += chatLinesPerMessage {
				end := min(start+chatLinesPerMessage, len(events))
				want = append(want, mustJSON(legacyTeamsMessage(events, start, end)))
			}
			if len(got) != len(want) {
				t.Fatalf("%d cards, want %d (sizes %v)", len(got), len(want), recv.sizes)
			}
			for i := range want {
				if len(want[i]) > teamsMaxBytes {
					t.Fatalf("case is over the limit: card %d is %d bytes", i, len(want[i]))
				}
				if !bytes.Equal(got[i], want[i]) {
					t.Errorf("card %d differs\ngot:  %s\nwant: %s", i, got[i], want[i])
				}
			}
		})
	}
}

// A batch whose card would be over 28 KB goes out as cards under the limit,
// every line once and in order, and the rows after it go too.
func TestTeamsBatchOverTheLimitGoesOutInCardsUnderIt(t *testing.T) {
	events := longTargetEvents(25, 2600)
	if n := len(mustJSON(legacyTeamsMessage(events, 0, chatLinesPerMessage))); n <= 28<<10 {
		t.Fatalf("the first batch's card is %d bytes; the case needs one over 28 KB", n)
	}
	recv := &limitedReceiver{max: 28 << 10, status: http.StatusAccepted}
	srv := httptest.NewServer(recv)
	defer srv.Close()
	sc := SinkConfig{Name: "teams", Type: "webhook", Webhook: WebhookConfig{Format: "teams"}, secrets: map[string]string{"url": srv.URL}}
	sink, err := sc.build()
	if err != nil {
		t.Fatal(err)
	}
	store := &memStore{rows: events, cursors: map[string]int64{}, fails: map[string]int{}}
	s := run(sc, sink)
	next, _, err := (&Dispatcher{store: store}).step(context.Background(), s, 0)
	if err != nil || next != 25 || store.cursors["teams"] != 25 || s.sent.Load() != 25 || s.failures.Load() != 0 {
		t.Fatalf("next %d cursor %d sent %d failures %d err %v (sizes %v)", next, store.cursors["teams"], s.sent.Load(), s.failures.Load(), err, recv.sizes)
	}
	var lines []string
	for i, card := range recv.taken() {
		if len(card) > teamsMaxBytes {
			t.Errorf("card %d is %d bytes", i, len(card))
		}
		lines = append(lines, teamsLines(t, card)...)
	}
	if len(lines) != len(events) {
		t.Fatalf("%d lines, want %d", len(lines), len(events))
	}
	for i, e := range events {
		if lines[i] != e.Line() {
			t.Errorf("line %d is not event %d as written", i, e.ID)
		}
	}
}

func TestTeamsOneLineOverTheLimitIsCut(t *testing.T) {
	events := longTargetEvents(1, 0)
	events[0].TargetType = strings.Repeat("t", 40<<10)
	cards := teamsBodies(events, 0, 1)
	if len(cards) != 1 || len(cards[0]) > teamsMaxBytes {
		t.Fatalf("%d cards, first %d bytes", len(cards), len(cards[0]))
	}
	lines := teamsLines(t, cards[0])
	if len(lines) != 1 || len([]rune(lines[0])) != 1000 || !strings.HasSuffix(lines[0], "…") || !strings.HasPrefix(lines[0], "k8s.configmap.update success") {
		t.Fatalf("line %.80q… (%d characters)", lines[0], len([]rune(lines[0])))
	}
}
