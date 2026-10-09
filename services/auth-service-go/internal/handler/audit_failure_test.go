package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// A refused sign-in is stored as a failure with the reason, so the audit log's
// result filter finds it; ordinary events keep the store's default (success).
func TestAuthFailuresAreStoredAsFailures(t *testing.T) {
	store := &memAuditStore{}
	h := &AuthHandler{auditStore: store}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	email := "u1@example.com"

	h.writeAuditFailure(r, "user.login.failed", nil, nil, nil, &email, "password_mismatch", nil)
	h.writeAuditLog(r, "user.logout", nil, &email, nil, &email, nil, nil)
	h.oidcFail(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/callback", nil), "state_mismatch", "", errors.New("bad state"))

	if len(store.written) != 3 {
		t.Fatalf("rows %d, want 3", len(store.written))
	}
	if got := store.written[0]; got.Result != audit.ResultFailure || got.Error != "password_mismatch" {
		t.Errorf("password failure stored as %q / %q", got.Result, got.Error)
	}
	if got := store.written[1]; got.Result != "" {
		t.Errorf("logout stored as %q, want the default", got.Result)
	}
	if got := store.written[2]; got.Action != "user.login.failed" || got.Result != audit.ResultFailure || got.Error != "state_mismatch" {
		t.Errorf("oidc failure stored as %s %q / %q", got.Action, got.Result, got.Error)
	}
}
