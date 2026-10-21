package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
)

type memAudit struct{ rows []audit.Record }

func (m *memAudit) Write(_ context.Context, rec audit.Record) (int64, error) {
	m.rows = append(m.rows, rec)
	return int64(len(m.rows)), nil
}

type fakeSessions struct {
	sessions  map[string]*model.Session
	deleteErr error
}

func (f *fakeSessions) CreateSession(context.Context, string, string, string, string) (*model.Session, error) {
	return nil, nil
}
func (f *fakeSessions) GetSession(_ context.Context, id string) (*model.Session, error) {
	return f.sessions[id], nil
}
func (f *fakeSessions) ListSessionsWithMessageCounts(context.Context, string, string, int, int, *time.Time, *string) ([]model.Session, error) {
	return nil, nil
}
func (f *fakeSessions) UpdateSessionTitle(_ context.Context, id, title string) error {
	f.sessions[id].Title = title
	return nil
}
func (f *fakeSessions) DeleteSession(_ context.Context, id string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	delete(f.sessions, id)
	return nil
}
func (f *fakeSessions) GetMessages(context.Context, string, int) ([]model.Message, error) {
	return nil, nil
}
func (f *fakeSessions) AddMessage(context.Context, string, string, string, *json.RawMessage, *json.RawMessage) (*model.Message, error) {
	return nil, nil
}
func (f *fakeSessions) GetMessageCount(context.Context, string) (int, error) { return 0, nil }

func sessionRequest(method, id, body string, user auth.TokenPayload) *http.Request {
	r := httptest.NewRequest(method, "/api/v1/sessions/"+id, strings.NewReader(body))
	rc := chi.NewRouteContext()
	rc.URLParams.Add("session_id", id)
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rc)
	return r.WithContext(auth.WithPayload(ctx, user))
}

// Renaming and deleting a conversation leave ai.session.rename/.delete rows
// (failures too); another user's conversation is 404 and leaves none.
func TestRenameAndDeleteAreRecorded(t *testing.T) {
	owner := auth.TokenPayload{UserID: "u1", Email: "dev@example.com"}
	store := &fakeSessions{sessions: map[string]*model.Session{
		"s1": {ID: "s1", UserID: "u1", Title: "old"},
		"s2": {ID: "s2", UserID: "u1", Title: "keep"},
	}}
	rows := &memAudit{}
	h := &SessionHandler{repo: store, auditStore: rows}

	w := httptest.NewRecorder()
	h.UpdateSession(w, sessionRequest(http.MethodPatch, "s1", `{"title":"new"}`, owner))
	if w.Code != http.StatusOK || len(rows.rows) != 1 {
		t.Fatalf("rename: %d rows %d", w.Code, len(rows.rows))
	}
	r := rows.rows[0]
	if r.Action != "ai.session.rename" || r.Service != audit.ServiceAI || r.TargetID != "s1" || r.ActorUserID != "u1" ||
		string(r.Before) != `{"title":"old"}` || string(r.After) != `{"title":"new"}` || r.Result != audit.ResultSuccess {
		t.Fatalf("rename row %+v", r)
	}

	w = httptest.NewRecorder()
	h.DeleteSession(w, sessionRequest(http.MethodDelete, "s1", "", owner))
	if w.Code != http.StatusOK || rows.rows[1].Action != "ai.session.delete" || string(rows.rows[1].Before) != `{"title":"new"}` {
		t.Fatalf("delete: %d %+v", w.Code, rows.rows[1])
	}

	store.deleteErr = errors.New("db down")
	w = httptest.NewRecorder()
	h.DeleteSession(w, sessionRequest(http.MethodDelete, "s2", "", owner))
	if w.Code != http.StatusInternalServerError || rows.rows[2].Result != audit.ResultFailure || rows.rows[2].Error != "db down" {
		t.Fatalf("failed delete: %d %+v", w.Code, rows.rows[2])
	}

	w = httptest.NewRecorder()
	h.DeleteSession(w, sessionRequest(http.MethodDelete, "s2", "", auth.TokenPayload{UserID: "u2"}))
	if w.Code != http.StatusNotFound || len(rows.rows) != 3 {
		t.Fatalf("someone else's: %d rows %d", w.Code, len(rows.rows))
	}
}
