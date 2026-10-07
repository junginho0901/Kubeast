package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/dormant"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func dormantHandler(enabled bool, sweeper *dormant.Sweeper) *AuthHandler {
	h := &AuthHandler{auditStore: &memAuditStore{}, cfg: config.Config{DormantAccounts: config.DormantAccountsConfig{Enabled: enabled, Days: 90, ExemptAdmins: true, SweepHours: 24}}}
	h.SetDormantSweeper(sweeper)
	return h
}

func TestDormantAccountsConfig(t *testing.T) {
	w := httptest.NewRecorder()
	dormantHandler(true, nil).DormantAccountsConfig(w, httptest.NewRequest(http.MethodGet, "/auth/dormant-accounts/config", nil))
	var got dormantAccountsConfigResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Enabled || got.Days != 90 || !got.ExemptAdmins {
		t.Fatalf("config = %+v", got)
	}
}

func TestDormantSweepAndUnlockGuards(t *testing.T) {
	// No permission → 403 before anything else is touched.
	h := dormantHandler(true, &dormant.Sweeper{Days: 90})
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){"sweep": h.AdminDormantSweep, "unlock": h.AdminUnlockUser} {
		w := httptest.NewRecorder()
		call(w, reviewRequest(http.MethodPost, "/auth/admin/dormant-accounts/sweep", auth.PermissionMatrix{"*": {"admin.users.read"}}))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s without admin.users.update: status = %d, want 403", name, w.Code)
		}
	}
	// Feature off → sweep answers 404 (the sweeper is never run).
	w := httptest.NewRecorder()
	dormantHandler(false, &dormant.Sweeper{Days: 90}).AdminDormantSweep(w, reviewRequest(http.MethodPost, "/auth/admin/dormant-accounts/sweep", auth.PermissionMatrix{"*": {"admin.users.update"}}))
	if w.Code != http.StatusNotFound {
		t.Errorf("sweep with the feature off: status = %d, want 404", w.Code)
	}
}
