package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

const endsTokens = "token_version = token_version + 1"

// A change that makes issued tokens wrong either ends them with it or does not happen: the person doing it hears, and
// the row says so, instead of an old token living on behind a success.
var tokenEndingChanges = []struct {
	name, method, path, body, action, write string
	ok                                      int
}{
	{"a role", http.MethodPatch, "/admin/users/plain", `{"role_id":1}`, "user.role.update", "SET role_id", http.StatusOK},
	{"a password reset", http.MethodPost, "/admin/users/plain/reset-password", "", "user.password.reset", "SET password_hash", http.StatusOK},
	{"a cluster grant", http.MethodPut, "/admin/users/plain/cluster-roles/c", `{"role":"Read"}`, "user.cluster_role.set", "INSERT INTO user_cluster_roles", http.StatusOK},
	{"a revoked grant", http.MethodDelete, "/admin/users/plain/cluster-roles/c", "", "user.cluster_role.unset", "DELETE FROM user_cluster_roles", http.StatusNoContent},
}

func doneRows(s *recordedAudit, action string) []audit.Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []audit.Record
	for _, rec := range s.rows {
		if rec.Action == action && rec.Result == audit.ResultSuccess {
			out = append(out, rec)
		}
	}
	return out
}

func TestAChangeThatCannotEndTheTokensDoesNotPassAsDone(t *testing.T) {
	for _, c := range tokenEndingChanges {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
			api.db.failOn(endsTokens)
			w := api.call(api.actor(globalAdmin, nil), c.method, c.path, c.body)
			if w.Code != http.StatusInternalServerError {
				t.Errorf("%d %s, want 500", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "temporary_password") {
				t.Errorf("the answer hands out a password that was not set: %s", w.Body.String())
			}
			if rows := api.store.failures(c.action); len(rows) != 1 {
				t.Errorf("failure rows of %s = %+v, want one", c.action, rows)
			}
			if rows := doneRows(api.store, c.action); len(rows) != 0 {
				t.Errorf("success rows of %s = %+v, want none", c.action, rows)
			}
		})
	}
}

func TestAChangeEndsTheTokensAndAnswersAsBefore(t *testing.T) {
	for _, c := range tokenEndingChanges {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
			w := api.call(api.actor(globalAdmin, nil), c.method, c.path, c.body)
			if w.Code != c.ok {
				t.Fatalf("%d %s, want %d", w.Code, w.Body.String(), c.ok)
			}
			if !api.db.ran(c.write) || !api.db.ran(endsTokens) {
				t.Errorf("%q ran %v, tokens ended %v", c.write, api.db.ran(c.write), api.db.ran(endsTokens))
			}
			if rows := api.store.failures(c.action); len(rows) != 0 {
				t.Errorf("failure rows = %+v", rows)
			}
		})
	}
}

func TestABulkRoleChangeLeavesOutTheAccountsItCouldNotFinish(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
	api.db.failOn(endsTokens)
	w := api.call(api.actor(globalAdmin, nil), http.MethodPatch, "/admin/users/bulk-role", `{"role_id":1,"user_ids":["plain"]}`)
	if strings.Contains(w.Body.String(), `"id":"plain"`) {
		t.Errorf("the answer lists the account as changed: %s", w.Body.String())
	}
	if rows := api.store.failures("user.role.update"); len(rows) != 1 || rows[0].TargetID != "plain" {
		t.Errorf("failure rows = %+v, want one for the account", rows)
	}
	if rows := doneRows(api.store, "user.role.update"); len(rows) != 0 {
		t.Errorf("success rows = %+v", rows)
	}
}

func TestABulkRoleChangeStillListsWhatItChanged(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
	w := api.call(api.actor(globalAdmin, nil), http.MethodPatch, "/admin/users/bulk-role", `{"role_id":1,"user_ids":["plain"]}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"id":"plain"`) {
		t.Errorf("%d %s", w.Code, w.Body.String())
	}
	if !api.db.ran(endsTokens) {
		t.Error("the tokens were not ended")
	}
}

// bulkAnswer reads the answer of a call that did not change everyone it was given.
type bulkAnswer struct {
	Updated []struct {
		ID string `json:"id"`
	} `json:"updated"`
	Failed []struct {
		UserID string `json:"user_id"`
		Email  string `json:"email"`
		Reason string `json:"reason"`
	} `json:"failed"`
}

func readBulkAnswer(t *testing.T, w *httptest.ResponseRecorder) bulkAnswer {
	t.Helper()
	var out bulkAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("%d %s: %v", w.Code, w.Body.String(), err)
	}
	return out
}

// failTheChangeOf makes one account's UPDATE fail and leaves the others'.
func failTheChangeOf(api *authAPI, id string) {
	api.db.failOn("WHERE id =  '" + id + "'")
}

func TestABulkRoleChangeSaysWhichAccountsItCouldNotChange(t *testing.T) {
	noSuchAccount := pgRule{match: "u.role_id WHERE u.id =  'gone'", oids: accountRules("gone", roleMember, "Member")[0].oids}
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, append(accountFixture(), noSuchAccount)...)
	failTheChangeOf(api, "reader")
	w := api.call(api.actor(globalAdmin, nil), http.MethodPatch, "/admin/users/bulk-role", `{"role_id":1,"user_ids":["plain","reader","gone"]}`)
	if w.Code != http.StatusMultiStatus {
		t.Fatalf("%d %s, want 207", w.Code, w.Body.String())
	}
	out := readBulkAnswer(t, w)
	if len(out.Updated) != 1 || out.Updated[0].ID != "plain" {
		t.Errorf("updated %+v", out.Updated)
	}
	if len(out.Failed) != 2 || out.Failed[0].UserID != "gone" || out.Failed[0].Reason != "not_found" ||
		out.Failed[1].UserID != "reader" || out.Failed[1].Email != "reader@example.com" || out.Failed[1].Reason != "failed" {
		t.Errorf("failed %+v", out.Failed)
	}
	rows := api.store.failures("user.role.update")
	if len(rows) != 2 || rows[0].TargetID != "gone" || rows[1].TargetID != "reader" {
		t.Errorf("failure rows %+v", rows)
	}
	if rows := doneRows(api.store, "user.role.update"); len(rows) != 1 || rows[0].TargetID != "plain" {
		t.Errorf("success rows %+v", rows)
	}
}

func TestABulkRoleChangeThatChangedNobodyIsAFailure(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
	api.db.failOn(endsTokens)
	w := api.call(api.actor(globalAdmin, nil), http.MethodPatch, "/admin/users/bulk-role", `{"role_id":1,"user_ids":["plain","reader"]}`)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("%d %s, want 500", w.Code, w.Body.String())
	}
	out := readBulkAnswer(t, w)
	if len(out.Updated) != 0 || len(out.Failed) != 2 {
		t.Errorf("%+v", out)
	}
	if !strings.Contains(w.Body.String(), `"detail"`) {
		t.Errorf("no detail for a client that reads only that: %s", w.Body.String())
	}
}

// One's own account is left out as it was, and now said to be, as the single-user route says it.
func TestABulkRoleChangeSaysItLeftOutOnesOwnAccount(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
	w := api.call(api.actor(globalAdmin, nil), http.MethodPatch, "/admin/users/bulk-role", `{"role_id":1,"user_ids":["plain","actor"]}`)
	if w.Code != http.StatusMultiStatus {
		t.Fatalf("%d %s, want 207", w.Code, w.Body.String())
	}
	out := readBulkAnswer(t, w)
	if len(out.Updated) != 1 || out.Updated[0].ID != "plain" || len(out.Failed) != 1 || out.Failed[0].UserID != "actor" || out.Failed[0].Reason != "self" {
		t.Errorf("%+v", out)
	}
	if rows := api.store.failures("user.role.update"); len(rows) != 1 || rows[0].TargetID != "actor" {
		t.Errorf("failure rows %+v", rows)
	}
}

// What a client of the route already reads when nothing went wrong.
func TestABulkRoleChangeOfEveryoneAnswersTheListAsBefore(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
	w := api.call(api.actor(globalAdmin, nil), http.MethodPatch, "/admin/users/bulk-role", `{"role_id":1,"user_ids":["plain","reader"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var list []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list) != 2 {
		t.Errorf("%s: %v", w.Body.String(), err)
	}
}

func TestChangingOnesOwnPasswordThatCannotEndOldSessionsFails(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"})
	api.db.failOn(endsTokens)
	body := `{"current_password":"` + testPassword + `","new_password":"Another-long-phrase-77"}`
	w := api.call(api.sessionToken(), http.MethodPost, "/change-password", body)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("%d %s, want 500", w.Code, w.Body.String())
	}
	if rows := api.store.failures("user.password.change"); len(rows) != 1 {
		t.Errorf("failure rows = %+v", rows)
	}
}
