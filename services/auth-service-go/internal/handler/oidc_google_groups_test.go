package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

type fakeGroups struct {
	groups map[string][]string
	err    error
}

func (f fakeGroups) Groups(_ context.Context, email string) ([]string, error) {
	return f.groups[email], f.err
}

func googleGroupsHandler(store *memAuditStore, lookup groupLookup) *AuthHandler {
	h := &AuthHandler{auditStore: store, cfg: config.Config{OIDC: config.OIDCConfig{
		RoleMapping:         map[string]string{"kubeast-test1@jobplanet.com": "Admin", "kubeast-test2@jobplanet.com": "Member", "kubeast-test3@jobplanet.com": "Member"},
		ClusterGroupMapping: map[string]string{"kubeast-test2@jobplanet.com": "self:Write", "kubeast-test3@jobplanet.com": "self:Read"},
		ClusterGroupPrefix:  "kubeast:cluster:",
		DefaultRole:         "Pending",
	}}}
	h.SetGoogleGroups(lookup)
	return h
}

var directory = fakeGroups{groups: map[string][]string{
	"inho-admin@jobplanet.com": {"kubeast-test1@jobplanet.com", "claude_infra2@jobplanet.com"},
	"whchoi@jobplanet.com":     {"kubeast-test2@jobplanet.com", "kubeast-test3@jobplanet.com", "all@jobplanet.com"},
}}

func TestAddGoogleGroupsTakesOnlyMappedGroups(t *testing.T) {
	h := googleGroupsHandler(&memAuditStore{}, directory)
	claims := oidcClaims{Email: "whchoi@jobplanet.com"}
	if got := h.addGoogleGroups(context.Background(), &claims); got != "ok" {
		t.Fatalf("status %q", got)
	}
	if !claims.HasGroups || !reflect.DeepEqual(claims.Groups, []string{"kubeast-test2@jobplanet.com", "kubeast-test3@jobplanet.com"}) {
		t.Fatalf("claims %+v (company groups must not be added)", claims)
	}
	// both mappings to one cluster: the higher role wins
	if got := h.clusterGrantsOf(append(claims.Groups, "kubeast:cluster:prod:Read")); !reflect.DeepEqual(got, map[string]string{"self": "Write", "prod": "Read"}) {
		t.Fatalf("grants %v", got)
	}
}

func TestAFailedLookupKeepsTheClaimsSoTheRoleStays(t *testing.T) {
	h := googleGroupsHandler(&memAuditStore{}, fakeGroups{err: errors.New("directory API 404: Domain not found.")})
	claims := oidcClaims{Email: "x@jobplanet.com"}
	got := h.addGoogleGroups(context.Background(), &claims)
	if got != "failed: directory API 404: Domain not found." || claims.HasGroups || len(claims.Groups) != 0 {
		t.Fatalf("status %q claims %+v", got, claims)
	}
	// lookup off: nothing happens
	off := &AuthHandler{}
	if s := off.addGoogleGroups(context.Background(), &claims); s != "" {
		t.Fatalf("off: %q", s)
	}
}

func adminGroupsRequest(email string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/auth/admin/oidc/groups?email="+email, nil)
	return r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": {"admin.users.*"}}}))
}

func TestAdminOIDCGroupsPreviewsTheMappingAndCountsTheRest(t *testing.T) {
	store := &memAuditStore{}
	h := googleGroupsHandler(store, directory)
	w := httptest.NewRecorder()
	h.AdminOIDCGroups(w, adminGroupsRequest("Inho-Admin@jobplanet.com"))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var got map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["role"] != "Admin" || got["role_from"] != "mapping" || got["other_groups"] != float64(1) || len(got["mapped_groups"].([]any)) != 1 {
		t.Fatalf("body %v", got)
	}
	if len(store.written) != 1 || store.written[0].Action != "admin.oidc.groups.read" || store.written[0].TargetEmail != "inho-admin@jobplanet.com" {
		t.Fatalf("audit %+v", store.written)
	}
	if after := string(store.written[0].After); !strings.Contains(after, `"other_groups":1`) || strings.Contains(after, "claude_infra2") {
		t.Fatalf("audit after %s (counts only, no company group names)", after)
	}

	// nobody mapped: the default role; a failed lookup: 502 and a failure row; lookup off: 404
	w = httptest.NewRecorder()
	h.AdminOIDCGroups(w, adminGroupsRequest("nobody@jobplanet.com"))
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["role"] != "Pending" || got["role_from"] != "default" {
		t.Fatalf("default: %v", got)
	}
	bad := googleGroupsHandler(store, fakeGroups{err: errors.New("boom")})
	w = httptest.NewRecorder()
	bad.AdminOIDCGroups(w, adminGroupsRequest("x@jobplanet.com"))
	if w.Code != http.StatusBadGateway || store.written[len(store.written)-1].Result != "failure" {
		t.Fatalf("failure: %d %+v", w.Code, store.written[len(store.written)-1])
	}
	w = httptest.NewRecorder()
	(&AuthHandler{auditStore: store}).AdminOIDCGroups(w, adminGroupsRequest("x@jobplanet.com"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("off: %d", w.Code)
	}
}
