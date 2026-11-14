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

// The page saves an answer whose stream was cut as the answer to its question: only while that question is the newest
// message, since a stream that lost only its end had its whole answer saved by ai-service, and once, marked failed.
func TestSaveMessages_ACutAnswerOnlyAfterItsQuestion(t *testing.T) {
	const question = "are my clusters healthy?"
	cut := `{"messages":[{"role":"assistant","content":"Two clusters so far","failed":true,"answers":"are my clusters healthy?"}]}`
	for name, c := range map[string]struct {
		before []model.Message
		saved  bool
	}{
		"its question is the newest message":     {[]model.Message{{Role: "user", Content: question}}, true},
		"ai-service saved the answer after it":   {[]model.Message{{Role: "user", Content: question}, {Role: "assistant", Content: "Two clusters, both healthy."}}, false},
		"another question came after it":         {[]model.Message{{Role: "user", Content: question}, {Role: "user", Content: "and now?"}}, false},
		"the question never reached the service": {nil, false},
	} {
		f := &fakeSessions{sessions: map[string]*model.Session{"s1": {ID: "s1", UserID: "u1"}}, messages: append([]model.Message(nil), c.before...)}
		h := &SessionHandler{repo: f, auditStore: &memAudit{}}
		w := httptest.NewRecorder()
		h.SaveMessages(w, sessionRequest(http.MethodPost, "s1", cut, auth.TokenPayload{UserID: "u1"}))
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d %s", name, w.Code, w.Body)
		}
		var got struct {
			Saved int `json:"saved"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		added := f.messages[len(c.before):]
		if !c.saved {
			if len(added) != 0 || got.Saved != 0 {
				t.Errorf("%s: added %+v (saved %d), want none", name, added, got.Saved)
			}
			continue
		}
		if len(added) != 1 || got.Saved != 1 {
			t.Errorf("%s: added %d (saved %d), want 1", name, len(added), got.Saved)
			continue
		}
		if a := added[0]; a.Role != "assistant" || a.Content != "Two clusters so far" || a.Usage == nil || string(*a.Usage) != `{"failed":true}` {
			t.Errorf("%s: added %s %q usage %v", name, a.Role, a.Content, a.Usage)
		}
	}
}

// A save that names no question is added as before: the stopped answer, and messages a caller writes itself.
func TestSaveMessages_WithoutAQuestionAddsEach(t *testing.T) {
	f := &fakeSessions{sessions: map[string]*model.Session{"s1": {ID: "s1", UserID: "u1"}}, messages: []model.Message{{Role: "assistant", Content: "earlier"}}}
	h := &SessionHandler{repo: f, auditStore: &memAudit{}}
	w := httptest.NewRecorder()
	body := `{"messages":[{"role":"user","content":"q"},{"role":"assistant","content":"part","stopped":true}]}`
	h.SaveMessages(w, sessionRequest(http.MethodPost, "s1", body, auth.TokenPayload{UserID: "u1"}))
	if w.Code != http.StatusOK || len(f.messages) != 3 {
		t.Fatalf("status %d, %d messages, want 200 and 3", w.Code, len(f.messages))
	}
	if u := f.messages[2].Usage; u == nil || string(*u) != `{"stopped":true}` {
		t.Errorf("stopped answer usage %v", u)
	}
}
