package main

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
)

// sharedGroupAPI is an install holding roles of one group, ADMIN beside the built-in Admin and a-b beside a b, which
// migration 25 and its index leave none of: the refusals are a second check. Role id and name are what the grant names
// and the pending request r1 asks for.
func sharedGroupAPI(t *testing.T, id int, name string) *authAPI {
	t.Helper()
	now := time.Now().UTC().Format(pgTimestamp)
	return newAuthAPIWith(t, pendingRequest{owner: "requester"}, func(c *config.Config) { c.AccessRequests.Roles = []string{"Write", name} },
		pgRule{match: "name, is_system FROM roles ORDER BY id", oids: []uint32{integerOID, textOID, booleanOID},
			rows: [][]any{{10, "Admin", "t"}, {7, "ops", "f"}, {8, "ADMIN", "f"}, {15, "a b", "f"}, {18, "a-b", "f"}}},
		pgRule{match: "FROM roles WHERE name", oids: []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID},
			rows: [][]any{{id, name, "", "f", now, now}}},
		pgRule{match: "WHERE ar.id =",
			oids: []uint32{textOID, textOID, textOID, textOID, textOID, textOID, integerOID, textOID, integerOID, textOID, textOID, stampOID, textOID, textOID, stampOID, textOID, stampOID, stampOID, textOID, listOID},
			rows: [][]any{{"r1", "requester", "req@example.com", "Req", "c", "c", id, name, 30, "needed", "pending", now, nil, nil, nil, nil, nil, nil, nil, nil}}},
	)
}

// A role whose name differs from another role's only in letter case, spaces or punctuation is not given any more, by a
// grant or an approval: the answer names both roles for the screen and a failure row stays. A role alone in its group
// is given as before.
func TestARoleSharingAGroupIsNotGivenAnyMore(t *testing.T) {
	for _, c := range []struct {
		id          int
		name, other string
	}{
		{8, "ADMIN", "Admin"},
		{18, "a-b", "a b"},
	} {
		t.Run("grant of "+c.name, func(t *testing.T) {
			api := sharedGroupAPI(t, c.id, c.name)
			w := api.call(api.grantor([]string{"*"}), http.MethodPut, "/admin/users/target/cluster-roles/c", `{"role":"`+c.name+`"}`)
			body := w.Body.String()
			if w.Code != http.StatusBadRequest || !strings.Contains(body, `"code":"role_same_group"`) || !strings.Contains(body, `"same_group_as":"`+c.other+`"`) {
				t.Fatalf("%d %s, want 400 role_same_group naming %s", w.Code, body, c.other)
			}
			if api.db.ran("INSERT INTO user_cluster_roles") {
				t.Error("the grant was written")
			}
			if rows := api.store.failures("user.cluster_role.set"); len(rows) != 1 || !strings.Contains(rows[0].Error, "cannot be given on a cluster") {
				t.Errorf("audit failures = %+v, want one saying why", rows)
			}
		})
		t.Run("approval of "+c.name, func(t *testing.T) {
			api := sharedGroupAPI(t, c.id, c.name)
			w := api.call(api.grantor([]string{"*"}), http.MethodPost, "/admin/access-requests/r1/approve", "")
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"role_same_group"`) {
				t.Fatalf("%d %s, want 400 role_same_group", w.Code, w.Body.String())
			}
			if api.db.ran("INSERT INTO user_cluster_roles") {
				t.Error("the approval wrote a grant")
			}
			if rows := api.store.failures("access.request.approve"); len(rows) != 1 {
				t.Errorf("audit failures = %+v, want one", rows)
			}
		})
	}
	api := sharedGroupAPI(t, 7, "ops")
	if w := api.call(api.grantor([]string{"*"}), http.MethodPut, "/admin/users/target/cluster-roles/c", `{"role":"ops"}`); w.Code != http.StatusOK {
		t.Errorf("a role alone in its group: %d %s", w.Code, w.Body.String())
	}
}

// A provider group naming such a role gives no grant at sign-in: the sign-in goes on, a failure row says why. A group
// naming a role alone in its group gives it.
func TestAProviderGroupNamingARoleSharingAGroupGivesNoGrant(t *testing.T) {
	for _, c := range []struct {
		id      int
		name    string
		granted bool
	}{
		{8, "ADMIN", false},
		{18, "a-b", false},
		{7, "ops", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := startOIDCProvider(t)
			now := pgNow()
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, p.settings, storedAccount("someone@example.com", "Member", ""),
				pgRule{match: "SELECT ucr.cluster_id, ro.name", oids: []uint32{textOID, textOID}},
				pgRule{match: "name, is_system FROM roles ORDER BY id", oids: []uint32{integerOID, textOID, booleanOID},
					rows: [][]any{{10, "Admin", "t"}, {7, "ops", "f"}, {8, "ADMIN", "f"}, {15, "a b", "f"}, {18, "a-b", "f"}}},
				pgRule{match: "FROM roles WHERE name", oids: []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID},
					rows: [][]any{{c.id, c.name, "", "f", now, now}}},
			)
			_, session := p.signIn(api, map[string]any{"email": "someone@example.com", "email_verified": true, "groups": []any{"kubeast:cluster:c:" + c.name}})
			if session == nil {
				t.Fatal("no session")
			}
			if got := api.db.ran("INSERT INTO user_cluster_roles"); got != c.granted {
				t.Errorf("grant written = %v, want %v", got, c.granted)
			}
			rows := api.store.failures("user.cluster_role.set")
			if c.granted && len(rows) != 0 {
				t.Errorf("failure rows %+v for a role alone in its group", rows)
			}
			if !c.granted && (len(rows) != 1 || !strings.Contains(rows[0].Error, "cannot be given on a cluster")) {
				t.Errorf("failure rows %+v, want one saying why", rows)
			}
		})
	}
}
