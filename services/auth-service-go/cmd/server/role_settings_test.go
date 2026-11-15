package main

import (
	"bytes"
	"context"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
)

// The roles an upgrade left: the built-ins, ops (which kept its name) and OPS renamed beside it.
var settingRoles = []model.Role{
	{ID: 1, Name: "Pending"}, {ID: 2, Name: "Member"}, {ID: 3, Name: "Read"}, {ID: 4, Name: "Write"}, {ID: 5, Name: "Admin"},
	{ID: 7, Name: "ops"}, {ID: 9, Name: "OPS-renamed-9"}, {ID: 11, Name: "sre readonly"},
}

func settingsNaming(change func(*config.Config)) config.Config {
	cfg := config.Config{
		OIDC:           config.OIDCConfig{Enabled: true, DefaultRole: "Pending", RoleMapping: map[string]string{}, ClusterGroupMapping: map[string]string{}},
		AccessRequests: config.AccessRequestsConfig{Enabled: true, Roles: []string{"Write"}},
	}
	change(&cfg)
	return cfg
}

// Each chart setting naming a role is read against the stored names at start: a name no role holds exactly is told
// with the setting and what follows from it, and an access request entry written as a built-in in other capitals is
// told as read as that built-in.
func TestEachRoleASettingNamesIsCheckedAtStart(t *testing.T) {
	for _, c := range []struct {
		name   string
		change func(*config.Config)
		want   []roleSettingNote
	}{
		{"names every stored role exactly", func(c *config.Config) {
			c.OIDC.RoleMapping = map[string]string{"sre": "Admin", "ops": "ops"}
			c.OIDC.ClusterGroupMapping = map[string]string{"g@example.com": "prod:Read"}
			c.AccessRequests.Roles = []string{"Write", " ops "}
			c.ImpersonationCustomRoles = []string{"sre-readonly", "read"}
		}, nil},
		{"roleMapping naming a renamed role", func(c *config.Config) { c.OIDC.RoleMapping = map[string]string{"sre": "OPS"} },
			[]roleSettingNote{{setting: "auth.oidc.roleMapping", role: "OPS", outcome: "the sign-in of a member of group sre fails (oidc_role_missing)", sameGroupAs: "ops"}}},
		{"defaultRole in other capitals", func(c *config.Config) { c.OIDC.DefaultRole = "pending" },
			[]roleSettingNote{{setting: "auth.oidc.defaultRole", role: "pending", outcome: "a sign-in that maps to no group fails (oidc_role_missing)", sameGroupAs: "Pending"}}},
		{"clusterGroupMapping naming no role", func(c *config.Config) {
			c.OIDC.ClusterGroupMapping = map[string]string{"g@example.com": "prod:auditor"}
		},
			[]roleSettingNote{{setting: "auth.oidc.clusterGroupMapping", role: "auditor", outcome: "the grant on cluster prod for group g@example.com is skipped at sign-in"}}},
		{"an access request entry written as a built-in", func(c *config.Config) { c.AccessRequests.Roles = []string{"WRITE"} },
			[]roleSettingNote{{setting: "auth.accessRequests.roles", role: "WRITE", outcome: "read as the built-in Write, not a custom role of this name", sameGroupAs: "Write"}}},
		{"an access request entry naming a renamed role", func(c *config.Config) { c.AccessRequests.Roles = []string{"OPS"} },
			[]roleSettingNote{{setting: "auth.accessRequests.roles", role: "OPS", outcome: "a request for it is refused (Unknown role)", sameGroupAs: "ops"}}},
		{"a bound group no role acts as", func(c *config.Config) { c.ImpersonationCustomRoles = []string{"auditor"} },
			[]roleSettingNote{{setting: "auth.impersonation.customRoles", role: "auditor", outcome: "the chart binds kubeast:role:auditor, which no stored role acts as"}}},
		{"the sign-in settings without OIDC", func(c *config.Config) {
			c.OIDC.Enabled = false
			c.OIDC.RoleMapping = map[string]string{"sre": "OPS"}
		}, nil},
		{"the request roles with requests off", func(c *config.Config) {
			c.AccessRequests.Enabled = false
			c.AccessRequests.Roles = []string{"OPS"}
		}, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := roleSettingNotes(settingsNaming(c.change), settingRoles)
			if !slices.Equal(got, c.want) {
				t.Errorf("notes %+v, want %+v", got, c.want)
			}
		})
	}
}

// The start-up check reads the stored roles and logs one warning per note, naming the setting and the role.
func TestStartUpWarnsOfARoleASettingNamesThatIsNotStored(t *testing.T) {
	_, pool := startFakePG(t, pgRule{match: "name, is_system FROM roles ORDER BY id", oids: []uint32{integerOID, textOID, booleanOID},
		rows: [][]any{{1, "Pending", "t"}, {5, "Admin", "t"}, {7, "ops", "f"}, {9, "OPS-renamed-9", "f"}}})
	var logged bytes.Buffer
	defer slog.SetDefault(slog.Default())
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))

	warnRoleSettings(context.Background(), repository.New(pool), settingsNaming(func(c *config.Config) {
		c.OIDC.RoleMapping = map[string]string{"sre": "OPS"}
		c.AccessRequests.Roles = []string{"Admin"}
	}))

	lines := strings.Split(strings.TrimSpace(logged.String()), "\n")
	if len(lines) != 1 || !strings.Contains(lines[0], "level=WARN") || !strings.Contains(lines[0], "setting=auth.oidc.roleMapping") ||
		!strings.Contains(lines[0], "role=OPS") || !strings.Contains(lines[0], "same_group_as=ops") {
		t.Errorf("logged %q, want one warning naming auth.oidc.roleMapping and OPS", logged.String())
	}
}
