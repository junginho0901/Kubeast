package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func createRefusalRows(store *recordedAudit) []audit.Record {
	store.mu.Lock()
	defer store.mu.Unlock()
	var out []audit.Record
	for _, rec := range store.rows {
		if rec.Action == "user.create" && rec.Result == audit.ResultFailure {
			out = append(out, rec)
		}
	}
	return out
}

// One account from the form says why as an account of a file does, and leaves the same row.
func TestACreationFromTheFormThatIsRefusedSaysWhyAndLeavesAFailureRow(t *testing.T) {
	for _, c := range []struct {
		name, body                   string
		actor                        auth.PermissionMatrix
		failOn                       string
		status                       int
		detail, reason, reasonDetail string
		email, role                  string
	}{
		{"no name", bulkRow("", "a@example.com", bulkPassword, roleMember, ""), globalAdmin, "", http.StatusBadRequest, "Name required", "missing_fields", "", "a@example.com", ""},
		{"no address", bulkRow("A", "not-an-address", bulkPassword, roleMember, ""), globalAdmin, "", http.StatusBadRequest, "Invalid email", "missing_fields", "", "not-an-address", ""},
		{"a name no cluster can take", bulkRow("A", "a:b@example.com", bulkPassword, roleMember, ""), globalAdmin, "", http.StatusBadRequest, "", "name", "", "a:b@example.com", ""},
		{"a weak password", bulkRow("A", "weak@example.com", "short", roleMember, ""), globalAdmin, "", http.StatusBadRequest, "password must be at least 12 characters", "password", "password must be at least 12 characters", "weak@example.com", ""},
		{"no such role", bulkRow("A", "role@example.com", bulkPassword, 99, ""), globalAdmin, "", http.StatusBadRequest, "Invalid role_id", "role", "", "role@example.com", ""},
		{"a role past the caller", bulkRow("A", "high@example.com", bulkPassword, roleAdmin, ""), userCreator, "", http.StatusForbidden, "", "ceiling", "*", "high@example.com", "Admin"},
		{"no such team", bulkRow("A", "team@example.com", bulkPassword, roleMember, "ghost"), globalAdmin, "", http.StatusBadRequest, "Invalid Team value", "team", "ghost", "team@example.com", "Member"},
		{"an address with an account", bulkRow("A", "taken@example.com", bulkPassword, roleMember, ""), globalAdmin, "", http.StatusConflict, "Email already exists", "exists", "", "taken@example.com", "Member"},
		{"a write that failed", bulkRow("A", "broken@example.com", bulkPassword, roleMember, ""), globalAdmin, "INSERT INTO auth_users", http.StatusInternalServerError, "internal server error", "failed", "", "broken@example.com", "Member"},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, bulkCreateFixture()...)
			if c.failOn != "" {
				api.db.failOn(c.failOn)
			}
			w := api.call(api.actor(c.actor, nil), http.MethodPost, "/admin/users", c.body)
			if w.Code != c.status {
				t.Fatalf("%d %s, want %d", w.Code, w.Body.String(), c.status)
			}
			if strings.Contains(w.Body.String(), bulkPassword) {
				t.Errorf("a password reached the answer: %s", w.Body.String())
			}
			var answer struct {
				Detail       string `json:"detail"`
				Reason       string `json:"reason"`
				ReasonDetail string `json:"reason_detail"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
				t.Fatalf("%s: %v", w.Body.String(), err)
			}
			if answer.Detail == "" || (c.detail != "" && answer.Detail != c.detail) {
				t.Errorf("detail %q, want %q as a client that reads only that gets it", answer.Detail, c.detail)
			}
			if answer.Reason != c.reason || answer.ReasonDetail != c.reasonDetail {
				t.Errorf("reason %q %q, want %q %q: %s", answer.Reason, answer.ReasonDetail, c.reason, c.reasonDetail, w.Body.String())
			}

			rows := createRefusalRows(api.store)
			if len(rows) != 1 {
				t.Fatalf("%d failure rows, want 1", len(rows))
			}
			row := rows[0]
			if row.TargetEmail != c.email || row.Error == "" {
				t.Errorf("row of %q, error %q", row.TargetEmail, row.Error)
			}
			if strings.Contains(row.Error, bulkPassword) || strings.Contains(string(row.After), bulkPassword) {
				t.Errorf("a password reached the row: %q %s", row.Error, row.After)
			}
			var after map[string]any
			if err := json.Unmarshal(row.After, &after); err != nil {
				t.Fatalf("after %s: %v", row.After, err)
			}
			if after["reason"] != c.reason {
				t.Errorf("after.reason %v, want %q: %s", after["reason"], c.reason, row.After)
			}
			if after["email"] != c.email {
				t.Errorf("after.email %v, want %q", after["email"], c.email)
			}
			if role, _ := after["role"].(string); role != c.role {
				t.Errorf("after.role %q, want %q", role, c.role)
			}
			if _, bulk := after["bulk"]; bulk {
				t.Errorf("a row of the form reads as one of a file: %s", row.After)
			}
			if done := createdRows(api.store, "user.create"); len(done) != 0 {
				t.Errorf("success rows %+v", done)
			}
		})
	}
}

// A body that is not JSON names no account, as for a file.
func TestACreationFromTheFormThatIsNotJSONLeavesNoRow(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, bulkCreateFixture()...)
	w := api.call(api.actor(globalAdmin, nil), http.MethodPost, "/admin/users", `{not json`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("%d %s, want 400", w.Code, w.Body.String())
	}
	if rows := createRefusalRows(api.store); len(rows) != 0 {
		t.Errorf("failure rows %+v", rows)
	}
}

func TestACreationFromTheFormStillAnswersAsBefore(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, bulkCreateFixture()...)
	w := api.call(api.actor(globalAdmin, nil), http.MethodPost, "/admin/users", bulkRow("Fine", "fine@example.com", bulkPassword, roleMember, ""))
	if w.Code != http.StatusCreated {
		t.Fatalf("%d %s, want 201", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"reason"`) {
		t.Errorf("an answer with no refusal has a reason: %s", w.Body.String())
	}
	api.store.mu.Lock()
	defer api.store.mu.Unlock()
	if rows := api.store.rows; len(rows) != 1 || rows[0].Action != "user.create" || rows[0].TargetEmail != "fine@example.com" || rows[0].Result == audit.ResultFailure {
		t.Errorf("rows %+v, want one row of the account made", rows)
	}
}
