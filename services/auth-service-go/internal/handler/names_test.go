package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func adminRequest(path string, body map[string]any) *http.Request {
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(b)))
	return r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{
		UserID: "a1", Email: "admin@example.com",
		Perms: auth.PermissionMatrix{"*": {"admin.roles.*", "admin.users.*", "admin.organizations.*", "menu.*", auth.PermClustersCreate}},
	}))
}

// Each name is held to its limit in characters: one past it is a 400 naming the field and the limit, and the limit
// itself goes on to the next check (a role's unknown permission, a team's store, a cluster's registry, a user's email).
func TestNamesAreHeldToTheirLengthInCharacters(t *testing.T) {
	// one letter a slug can hold (a cluster's display name needs one), the rest Korean: three bytes each
	ko := func(n int) string { return "a" + strings.Repeat("가", n-1) }
	cases := []struct {
		what     string
		run      func(name string) *httptest.ResponseRecorder
		limit    int
		refused  string
		pastName string
	}{
		{"role", func(name string) *httptest.ResponseRecorder {
			w := httptest.NewRecorder()
			(&RoleHandler{auditStore: &memAuditStore{}}).CreateRole(w, adminRequest("/auth/admin/roles", map[string]any{"name": name, "permissions": []string{"made.up"}}))
			return w
		}, 100, "name: up to 100 characters", "made.up"},
		{"team", func(name string) *httptest.ResponseRecorder {
			w := httptest.NewRecorder()
			if reachedTheRegistry(func() {
				(&AuthHandler{auditStore: &memAuditStore{}}).AdminCreateOrganization(w, adminRequest("/auth/admin/organizations", map[string]any{"type": "team", "name": name}))
			}) {
				w.WriteString("reached the store")
			}
			return w
		}, 100, "name: up to 100 characters", "reached the store"},
		{"cluster", func(name string) *httptest.ResponseRecorder {
			w := httptest.NewRecorder()
			h := &ClustersHandler{auditStore: &memAuditStore{}, cfg: config.Config{K8sServiceURL: acceptingProbe(t, "https://10.0.0.1:6443")}}
			if reachedTheRegistry(func() {
				h.RegisterCluster(w, adminRequest("/api/v1/clusters", map[string]any{"mode": "external", "display_name": name, "kubeconfig": plainKubeconfig}))
			}) {
				w.WriteString("reached the registry")
			}
			return w
		}, 100, "display_name: up to 100 characters", "reached the registry"},
		{"user", func(name string) *httptest.ResponseRecorder {
			w := httptest.NewRecorder()
			(&AuthHandler{auditStore: &memAuditStore{}}).AdminCreateUser(w, adminRequest("/auth/admin/users", map[string]any{"name": name, "email": "no-at-sign"}))
			return w
		}, 255, "name: up to 255 characters", "Invalid email"},
	}
	for _, c := range cases {
		t.Run(c.what, func(t *testing.T) {
			if w := c.run(ko(c.limit + 1)); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), c.refused) {
				t.Errorf("%d letters: %d %s, want 400 %q", c.limit+1, w.Code, w.Body.String(), c.refused)
			}
			if w := c.run(ko(c.limit)); !strings.Contains(w.Body.String(), c.pastName) {
				t.Errorf("%d letters (%d bytes) did not get past the name: %d %s", c.limit, len(ko(c.limit)), w.Code, w.Body.String())
			}
		})
	}
}

// A bulk creation holds each row's name to the same 255 characters: a longer one is left out with its own reason and
// goes no further than the checks.
func TestABulkCreationHoldsEachNameToItsLimit(t *testing.T) {
	h := &AuthHandler{auditStore: &memAuditStore{}}
	w := httptest.NewRecorder()
	reached := reachedTheRegistry(func() {
		h.AdminBulkCreateUsers(w, adminRequest("/auth/admin/users/bulk", map[string]any{"users": []map[string]any{
			{"name": strings.Repeat("가", 256), "email": "long@example.com", "password": "e2e-Fake-pass-1"},
		}}))
	})
	if reached {
		t.Fatal("a row past the limit went on to the store")
	}
	if !strings.Contains(w.Body.String(), `"reason":"name_length"`) || !strings.Contains(w.Body.String(), "long@example.com") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

// On an update the value the object already holds is not checked again: a name stored before the limit came can be
// sent back with an edit beside it (the role and AI Models windows send it on every save), and a changed one is held
// to the limit.
func TestAStoredNameSentBackIsNotCheckedAgain(t *testing.T) {
	long := strings.Repeat("가", 120)
	if msg := changedNameTooLong("name", long, long, nameMax); msg != "" {
		t.Errorf("the stored name sent back: %q", msg)
	}
	if msg := changedNameTooLong("name", " "+long+" ", long, nameMax); msg != "" {
		t.Errorf("the stored name sent back trimmed differently: %q", msg)
	}
	if msg := changedNameTooLong("name", long+"가", long, nameMax); msg != "name: up to 100 characters" {
		t.Errorf("a changed name past the limit: %q", msg)
	}
	if msg := changedNameTooLong("name", long, "", userNameMax); msg != "" {
		t.Errorf("a new name within the limit: %q", msg)
	}
}
