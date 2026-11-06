package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The password of these accounts is a value a test may look for in an answer.
const bulkPassword = "fake-Bulk-create-pass-9"

var userCreator = auth.PermissionMatrix{"*": {"admin.users.create"}}

type bulkCreateAnswer struct {
	Detail  string `json:"detail"`
	Created *[]struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	} `json:"created"`
	Failed *[]struct {
		Email  string `json:"email"`
		Reason string `json:"reason"`
		Detail string `json:"detail"`
	} `json:"failed"`
	Errors *[]struct {
		Email   string `json:"email"`
		Message string `json:"message"`
	} `json:"errors"`
}

func readBulkCreate(t *testing.T, w *httptest.ResponseRecorder) bulkCreateAnswer {
	t.Helper()
	var out bulkCreateAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("%d %s: %v", w.Code, w.Body.String(), err)
	}
	return out
}

func (a bulkCreateAnswer) createdEmails() []string {
	emails := []string{}
	if a.Created != nil {
		for _, u := range *a.Created {
			emails = append(emails, u.Email)
		}
	}
	return emails
}

func (a bulkCreateAnswer) failedRows() []string {
	rows := []string{}
	if a.Failed != nil {
		for _, f := range *a.Failed {
			rows = append(rows, f.Email+"|"+f.Reason+"|"+f.Detail)
		}
	}
	return rows
}

// bulkCreateFixture holds one taken address and every team but one.
func bulkCreateFixture() []pgRule {
	taken := accountRules("taken", roleMember, "Member")[0]
	free := pgRule{match: "u.role_id WHERE u.email =", oids: taken.oids}
	taken.match = "u.role_id WHERE u.email =  'taken@example.com'"
	return append([]pgRule{
		taken, free,
		{match: "'ghost'", oids: []uint32{booleanOID}, rows: [][]any{{"f"}}},
		{match: "FROM organizations", oids: []uint32{booleanOID}, rows: [][]any{{"t"}}},
	}, accountFixture()...)
}

func bulkRow(name, email, password string, roleID int, team string) string {
	row := map[string]any{"name": name, "email": email, "password": password, "role_id": roleID}
	if team != "" {
		row["team"] = team
	}
	raw, _ := json.Marshal(row)
	return string(raw)
}

func bulkBody(rows ...string) string {
	return `{"users":[` + strings.Join(rows, ",") + `]}`
}

func createdRows(store *recordedAudit, action string) []audit.Record {
	store.mu.Lock()
	defer store.mu.Unlock()
	var out []audit.Record
	for _, rec := range store.rows {
		if rec.Action == action && rec.Result == audit.ResultSuccess {
			out = append(out, rec)
		}
	}
	return out
}

func TestABulkCreationOfEveryoneAnswersAsBefore(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, bulkCreateFixture()...)
	w := api.call(api.actor(globalAdmin, nil), http.MethodPost, "/admin/users/bulk", bulkBody(
		bulkRow("One", "one@example.com", bulkPassword, roleMember, ""),
		bulkRow("Two", "two@example.com", bulkPassword, roleMember, "web"),
	))
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s, want 200", w.Code, w.Body.String())
	}
	out := readBulkCreate(t, w)
	if got := strings.Join(out.createdEmails(), ","); got != "one@example.com,two@example.com" {
		t.Errorf("created %s", got)
	}
	if out.Failed == nil || len(*out.Failed) != 0 {
		t.Errorf("failed: %s", w.Body.String())
	}
	if out.Errors == nil || len(*out.Errors) != 0 {
		t.Errorf("errors: %s", w.Body.String())
	}
	if rows := createdRows(api.store, "user.create"); len(rows) != 2 {
		t.Errorf("success rows %+v", rows)
	}
}

func TestABulkCreationSaysWhichAccountsItCouldNotCreateAndWhy(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, bulkCreateFixture()...)
	api.db.failOn("'Broken'")
	w := api.call(api.actor(userCreator, nil), http.MethodPost, "/admin/users/bulk", bulkBody(
		bulkRow("Fine", "fine@example.com", bulkPassword, roleMember, ""),
		bulkRow("", "noname@example.com", bulkPassword, roleMember, ""),
		bulkRow("Weak", "weak@example.com", "short", roleMember, ""),
		bulkRow("Role", "role@example.com", bulkPassword, 99, ""),
		bulkRow("High", "high@example.com", bulkPassword, roleAdmin, ""),
		bulkRow("Team", "team@example.com", bulkPassword, roleMember, "ghost"),
		bulkRow("Taken", "taken@example.com", bulkPassword, roleMember, ""),
		bulkRow("Broken", "broken@example.com", bulkPassword, roleMember, ""),
	))
	if w.Code != http.StatusMultiStatus {
		t.Fatalf("%d %s, want 207", w.Code, w.Body.String())
	}
	out := readBulkCreate(t, w)
	if got := strings.Join(out.createdEmails(), ","); got != "fine@example.com" {
		t.Errorf("created %s", got)
	}
	want := []string{
		"noname@example.com|missing_fields|",
		"weak@example.com|password|password must be at least 12 characters",
		"role@example.com|role|",
		"high@example.com|ceiling|*",
		"team@example.com|team|ghost",
		"taken@example.com|exists|",
		"broken@example.com|failed|",
	}
	if got := out.failedRows(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("failed:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	body := w.Body.String()
	if strings.Contains(body, "fake database failure") {
		t.Errorf("a database error reached the answer: %s", body)
	}
	if strings.Contains(body, bulkPassword) {
		t.Errorf("a password reached the answer: %s", body)
	}
	// A failure row per account left out, which says why; the one the store refused with the store's own words.
	rows := api.store.failures("user.create")
	var rowEmails []string
	for _, rec := range rows {
		rowEmails = append(rowEmails, rec.TargetEmail)
		if strings.Contains(rec.Error, bulkPassword) || strings.Contains(string(rec.After), bulkPassword) {
			t.Errorf("a password reached the row of %s", rec.TargetEmail)
		}
		if rec.Error == "" || !strings.Contains(string(rec.After), `"bulk":true`) {
			t.Errorf("row of %s: error %q after %s", rec.TargetEmail, rec.Error, rec.After)
		}
	}
	wantEmails := "noname@example.com,weak@example.com,role@example.com,high@example.com,team@example.com,taken@example.com,broken@example.com"
	if got := strings.Join(rowEmails, ","); got != wantEmails {
		t.Errorf("failure rows %s, want %s", got, wantEmails)
	}
	if len(rows) == 7 {
		if !strings.Contains(rows[6].Error, "fake database failure") {
			t.Errorf("the row does not say why: %q", rows[6].Error)
		}
		if !strings.Contains(rows[3].Error, "permission ceiling") || !strings.Contains(string(rows[3].After), `"role":"Admin"`) {
			t.Errorf("the ceiling's row: %q %s", rows[3].Error, rows[3].After)
		}
		if !strings.Contains(string(rows[4].After), `"reason":"team"`) {
			t.Errorf("the team's row: %s", rows[4].After)
		}
	}
	if done := createdRows(api.store, "user.create"); len(done) != 1 || done[0].TargetEmail != "fine@example.com" {
		t.Errorf("success rows %+v", done)
	}
}

// A client that read errors before keeps reading every account it could not create.
func TestABulkCreationStillNamesEachAccountInTheOlderField(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, bulkCreateFixture()...)
	w := api.call(api.actor(globalAdmin, nil), http.MethodPost, "/admin/users/bulk", bulkBody(
		bulkRow("Fine", "fine@example.com", bulkPassword, roleMember, ""),
		bulkRow("Team", "team@example.com", bulkPassword, roleMember, "ghost"),
		bulkRow("Taken", "taken@example.com", bulkPassword, roleMember, ""),
	))
	out := readBulkCreate(t, w)
	if out.Errors == nil {
		t.Fatalf("no errors field: %s", w.Body.String())
	}
	var got []string
	for _, e := range *out.Errors {
		got = append(got, fmt.Sprintf("%s: %s", e.Email, e.Message))
	}
	if want := "team@example.com: Invalid Team: ghost,taken@example.com: Email already exists"; strings.Join(got, ",") != want {
		t.Errorf("errors %v, want %s", got, want)
	}
}

func TestABulkCreationThatAWriteLeftEmptyIsAFailure(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, bulkCreateFixture()...)
	api.db.failOn("INSERT INTO auth_users")
	w := api.call(api.actor(globalAdmin, nil), http.MethodPost, "/admin/users/bulk", bulkBody(
		bulkRow("One", "one@example.com", bulkPassword, roleMember, ""),
		bulkRow("Two", "two@example.com", bulkPassword, roleMember, ""),
	))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("%d %s, want 500", w.Code, w.Body.String())
	}
	out := readBulkCreate(t, w)
	if out.Detail == "" {
		t.Errorf("no detail for a client that reads only that: %s", w.Body.String())
	}
	if got := out.failedRows(); strings.Join(got, ",") != "one@example.com|failed|,two@example.com|failed|" {
		t.Errorf("failed %v", got)
	}
	if out.Created == nil || len(*out.Created) != 0 {
		t.Errorf("created is a list, empty: %s", w.Body.String())
	}
}

// The screen reads created.length: an answer of nothing created is an empty list and not null.
func TestABulkCreationOfNobodyIsAnAnswerWithEmptyLists(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, bulkCreateFixture()...)
	w := api.call(api.actor(globalAdmin, nil), http.MethodPost, "/admin/users/bulk", bulkBody(
		bulkRow("Taken", "taken@example.com", bulkPassword, roleMember, ""),
	))
	if w.Code != http.StatusMultiStatus {
		t.Fatalf("%d %s, want 207", w.Code, w.Body.String())
	}
	out := readBulkCreate(t, w)
	if out.Created == nil || len(*out.Created) != 0 {
		t.Errorf("created: %s", w.Body.String())
	}
	if got := out.failedRows(); len(got) != 1 || got[0] != "taken@example.com|exists|" {
		t.Errorf("failed %v", got)
	}
}
