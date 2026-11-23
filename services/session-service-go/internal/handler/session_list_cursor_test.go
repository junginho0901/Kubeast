package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
)

// The list's cursor is the instant it names: before_updated_at written with an offset reaches the store in UTC, the
// zone of updated_at's clock reading, as the list's own updated_at (UTC) and a time with no offset do.
func TestTheListCursorIsTheInstantItNames(t *testing.T) {
	owner := auth.TokenPayload{UserID: "u1", Email: "dev@example.com"}
	want := time.Date(2026, 11, 17, 19, 58, 51, 123456000, time.UTC)
	for _, v := range []string{"2026-11-18T04:58:51.123456+09:00", "2026-11-17T19:58:51.123456Z"} {
		store := &fakeSessions{sessions: map[string]*model.Session{}}
		h := &SessionHandler{repo: store, auditStore: &memAudit{}}
		r := httptest.NewRequest(http.MethodGet, "/api/v1/sessions?"+url.Values{"before_updated_at": {v}, "before_id": {"s9"}}.Encode(), nil)
		w := httptest.NewRecorder()
		h.ListSessions(w, r.WithContext(auth.WithPayload(r.Context(), owner)))
		got := store.askedBeforeUpdatedAt
		if w.Code != http.StatusOK || got == nil || got.Location() != time.UTC || !got.Equal(want) {
			t.Errorf("%s: %d, cursor %v; want %v", v, w.Code, got, want)
		}
	}
	store := &fakeSessions{sessions: map[string]*model.Session{}}
	h := &SessionHandler{repo: store, auditStore: &memAudit{}}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/sessions?before_updated_at=2026-11-17T19:58:51", nil)
	h.ListSessions(httptest.NewRecorder(), r.WithContext(auth.WithPayload(r.Context(), owner)))
	if got := store.askedBeforeUpdatedAt; got == nil || got.Location() != time.UTC || !got.Equal(want.Truncate(time.Second)) {
		t.Errorf("no offset: cursor %v", got)
	}
}
