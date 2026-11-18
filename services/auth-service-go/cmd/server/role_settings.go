package main

import (
	"context"
	"log/slog"
	"slices"
	"strings"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// roleSettingNote is a role name in a chart setting that no stored role holds exactly, or that is read as another
// role, and what follows from it at sign-in, on a request or on a cluster.
type roleSettingNote struct {
	setting, role, outcome string
	// sameGroupAs is the stored role whose name makes the same group, when one does (an upgrade may have renamed the
	// role the setting meant, or the setting writes it in other capitals).
	sameGroupAs string
}

// roleSettingNotes reads the chart settings that name roles against the roles stored. The service starts either way: a
// role missing from a mapping no one signs in through yet must not stop it, and the sign-in it fails names the role.
func roleSettingNotes(cfg config.Config, roles []model.Role) []roleSettingNote {
	stored := map[string]bool{}
	bySlug := map[string]string{}
	for _, r := range roles {
		stored[r.Name] = true
		if _, ok := bySlug[auth.RoleGroupSlug(r.Name)]; !ok {
			bySlug[auth.RoleGroupSlug(r.Name)] = r.Name
		}
	}
	var notes []roleSettingNote
	missing := func(setting, role, outcome string) {
		if !stored[role] {
			notes = append(notes, roleSettingNote{setting: setting, role: role, outcome: outcome, sameGroupAs: bySlug[auth.RoleGroupSlug(role)]})
		}
	}
	if cfg.OIDC.Enabled {
		for _, group := range sortedKeys(cfg.OIDC.RoleMapping) {
			missing("auth.oidc.roleMapping", cfg.OIDC.RoleMapping[group], "the sign-in of a member of group "+group+" fails (oidc_role_missing)")
		}
		missing("auth.oidc.defaultRole", cfg.OIDC.DefaultRole, "a sign-in that maps to no group fails (oidc_role_missing)")
		for _, group := range sortedKeys(cfg.OIDC.ClusterGroupMapping) {
			cluster, role, _ := strings.Cut(cfg.OIDC.ClusterGroupMapping[group], ":")
			missing("auth.oidc.clusterGroupMapping", role, "the grant on cluster "+cluster+" for group "+group+" is skipped at sign-in")
		}
	}
	if cfg.AccessRequests.Enabled {
		for _, entry := range cfg.AccessRequests.Roles {
			entry = strings.TrimSpace(entry)
			if builtin, ok := auth.BuiltinRoleNamed(entry); ok {
				if builtin != entry {
					notes = append(notes, roleSettingNote{setting: "auth.accessRequests.roles", role: entry, outcome: "read as the built-in " + builtin + ", not a custom role of this name", sameGroupAs: builtin})
				}
				continue
			}
			missing("auth.accessRequests.roles", entry, "a request for it is refused (Unknown role)")
		}
	}
	for _, bound := range cfg.ImpersonationCustomRoles {
		slug := auth.RoleGroupSlug(bound)
		if slug != "" && bySlug[slug] == "" {
			notes = append(notes, roleSettingNote{setting: "auth.impersonation.customRoles", role: bound,
				outcome: "the chart binds kubeast:role:" + slug + ", which no stored role acts as"})
		}
	}
	return notes
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// warnRoleSettings logs each roleSettingNote once at start, after the roles are seeded.
func warnRoleSettings(ctx context.Context, repo *repository.Repository, cfg config.Config) {
	roles, err := repo.ListRoleNames(ctx)
	if err != nil {
		slog.Warn("role settings: could not read the roles to check the chart's role names", "error", err)
		return
	}
	for _, n := range roleSettingNotes(cfg, roles) {
		slog.Warn("a chart setting names a role not stored as written", "setting", n.setting, "role", n.role, "outcome", n.outcome, "same_group_as", n.sameGroupAs)
	}
}
