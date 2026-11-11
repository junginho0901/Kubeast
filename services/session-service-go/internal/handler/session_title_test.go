package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
)

// A rename takes a title of up to 100 characters, counted as the screen counts them: 100 Korean letters (300 bytes)
// are kept, 101 are a 400 and the title stays.
func TestARenameTakesATitleOfUpTo100Characters(t *testing.T) {
	owner := auth.TokenPayload{UserID: "u1", Email: "dev@example.com"}
	store := &fakeSessions{sessions: map[string]*model.Session{"s1": {ID: "s1", UserID: "u1", Title: "old"}}}
	h := &SessionHandler{repo: store, auditStore: &memAudit{}}

	w := httptest.NewRecorder()
	h.UpdateSession(w, sessionRequest(http.MethodPatch, "s1", `{"title":"`+strings.Repeat("가", 101)+`"}`, owner))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "title: up to 100 characters") || store.sessions["s1"].Title != "old" {
		t.Fatalf("101 letters: %d %s, title %q", w.Code, w.Body.String(), store.sessions["s1"].Title)
	}
	w = httptest.NewRecorder()
	h.UpdateSession(w, sessionRequest(http.MethodPatch, "s1", `{"title":"`+strings.Repeat("가", 100)+`"}`, owner))
	if w.Code != http.StatusOK || store.sessions["s1"].Title != strings.Repeat("가", 100) {
		t.Fatalf("100 letters: %d %s", w.Code, w.Body.String())
	}
}

// A new conversation takes the same title limit: 101 characters are a 400 and nothing is made.
func TestANewConversationTakesATitleOfUpTo100Characters(t *testing.T) {
	owner := auth.TokenPayload{UserID: "u1", Email: "dev@example.com"}
	store := &fakeSessions{sessions: map[string]*model.Session{}}
	h := &SessionHandler{repo: store, auditStore: &memAudit{}}
	w := httptest.NewRecorder()
	h.CreateSession(w, sessionRequest(http.MethodPost, "", `{"title":"`+strings.Repeat("가", 101)+`"}`, owner))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "title: up to 100 characters") || len(store.sessions) != 0 {
		t.Fatalf("101 letters: %d %s, %d made", w.Code, w.Body.String(), len(store.sessions))
	}
}
