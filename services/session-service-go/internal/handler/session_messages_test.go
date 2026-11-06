package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
)

func sessionWithMessages(n int) *fakeSessions {
	f := &fakeSessions{sessions: map[string]*model.Session{"s1": {ID: "s1", UserID: "u1", Title: "t"}}}
	for i := 1; i <= n; i++ {
		f.messages = append(f.messages, model.Message{ID: i, SessionID: "s1", Role: "user", Content: "m"})
	}
	return f
}

func messagesRequest(target, id string, user auth.TokenPayload) *http.Request {
	r := sessionRequest(http.MethodGet, id, "", user)
	u := httptest.NewRequest(http.MethodGet, target, nil).URL
	r.URL = u
	if rc := chi.RouteContext(r.Context()); rc == nil {
		panic("no route context")
	}
	return r
}

// A conversation longer than one page opens at its newest messages and says how many come before them, so the screen
// does not read as if they were all.
func TestGetSession_SaysHowManyMessagesComeBefore(t *testing.T) {
	for _, c := range []struct{ messages, shown, before int }{{150, 100, 50}, {100, 100, 0}, {3, 3, 0}} {
		h := &SessionHandler{repo: sessionWithMessages(c.messages), auditStore: &memAudit{}}
		w := httptest.NewRecorder()
		h.GetSession(w, messagesRequest("/api/v1/sessions/s1", "s1", auth.TokenPayload{UserID: "u1"}))
		if w.Code != http.StatusOK {
			t.Fatalf("%d messages: status %d %s", c.messages, w.Code, w.Body)
		}
		var got model.SessionDetailResponse
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Messages) != c.shown || got.MessagesBefore != c.before {
			t.Errorf("%d messages: %d shown, messages_before %d, want %d and %d", c.messages, len(got.Messages), got.MessagesBefore, c.shown, c.before)
		}
	}
}

// The earlier messages come a page at a time before the one named, only to the conversation's owner.
func TestGetEarlierMessages_APageBeforeTheOneNamed(t *testing.T) {
	f := sessionWithMessages(250)
	h := &SessionHandler{repo: f, auditStore: &memAudit{}}
	w := httptest.NewRecorder()
	h.GetEarlierMessages(w, messagesRequest("/api/v1/sessions/s1/messages?before_id=151", "s1", auth.TokenPayload{UserID: "u1"}))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	var got struct {
		Messages []model.MessageResponse `json:"messages"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if f.askedBefore != 151 || f.askedLimit != 100 {
		t.Errorf("asked the store before %d limit %d, want 151 and 100", f.askedBefore, f.askedLimit)
	}
	if len(got.Messages) != 100 || got.Messages[0].ID != 51 || got.Messages[99].ID != 150 {
		t.Errorf("%d messages, want 51 to 150", len(got.Messages))
	}

	for name, c := range map[string]struct {
		target string
		user   string
		status int
	}{
		"another user's conversation": {"/api/v1/sessions/s1/messages?before_id=151", "u2", http.StatusNotFound},
		"no message named":            {"/api/v1/sessions/s1/messages", "u1", http.StatusBadRequest},
		"not a message id":            {"/api/v1/sessions/s1/messages?before_id=x", "u1", http.StatusBadRequest},
	} {
		f := sessionWithMessages(250)
		h := &SessionHandler{repo: f, auditStore: &memAudit{}}
		w := httptest.NewRecorder()
		h.GetEarlierMessages(w, messagesRequest(c.target, "s1", auth.TokenPayload{UserID: c.user}))
		if w.Code != c.status || f.askedBefore != 0 {
			t.Errorf("%s: status %d (store asked before %d), want %d and not asked", name, w.Code, f.askedBefore, c.status)
		}
	}
}
