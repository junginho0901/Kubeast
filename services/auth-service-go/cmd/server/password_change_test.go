package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
)

const wrongCurrentPassword = `{"current_password":"not-the-password","new_password":"Another-long-phrase-77"}`

// A typo in the current password is a refusal of that field, not the end of the
// sign-in: the console signs out on any 401, so the answer is a 403 with a reason.
func TestAWrongCurrentPasswordIsA403WithItsReasonAndChangesNothing(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"})
	w := api.call(api.sessionToken(), http.MethodPost, "/change-password", wrongCurrentPassword)
	if w.Code != http.StatusForbidden {
		t.Fatalf("%d %s, want 403", w.Code, w.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("%s: %v", w.Body.String(), err)
	}
	if want := map[string]string{"detail": "Invalid current password", "reason": "password_mismatch"}; !reflect.DeepEqual(body, want) {
		t.Errorf("body %v, want %v", body, want)
	}
	if cookies := w.Result().Cookies(); len(cookies) != 0 {
		t.Errorf("cookies %v, want none", cookies)
	}
	rows := api.store.failures("user.password.change")
	if len(rows) != 1 || rows[0].Error != "password_mismatch" || rows[0].TargetID != "owner" || rows[0].ActorUserID != "owner" {
		t.Errorf("failure rows %+v, want one password_mismatch on owner", rows)
	}
	for _, write := range []string{"SET password_hash", endsTokens} {
		if api.db.ran(write) {
			t.Errorf("%q reached the database", write)
		}
	}
}

// The login lockout counts failed sign-ins only: wrong current passwords past
// the threshold leave the counter and the sign-in as they were.
func TestWrongCurrentPasswordsCountTowardNoLoginLockout(t *testing.T) {
	api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, func(c *config.Config) {
		c.LoginMaxFailures, c.LoginLockoutMinutes = 2, 15
	})
	token := api.sessionToken()
	for i := 0; i < 3; i++ {
		if w := api.call(token, http.MethodPost, "/change-password", wrongCurrentPassword); w.Code != http.StatusForbidden {
			t.Fatalf("try %d: %d %s, want 403", i+1, w.Code, w.Body.String())
		}
	}
	for _, write := range []string{"SET failed_logins", "locked_until ="} {
		if api.db.ran(write) {
			t.Errorf("%q reached the database", write)
		}
	}
	if rows := api.store.failures("user.password.change"); len(rows) != 3 {
		t.Errorf("failure rows %d, want 3", len(rows))
	}
	if rows := api.store.failures("user.login.locked"); len(rows) != 0 {
		t.Errorf("lock rows %+v", rows)
	}
	if w := api.call(token, http.MethodGet, "/me", ""); w.Code != http.StatusOK {
		t.Errorf("me after the refusals: %d %s", w.Code, w.Body.String())
	}
}
