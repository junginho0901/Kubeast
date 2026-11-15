package repository_test

import (
	"context"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
)

// The seed writes the built-ins on a migrated database, and from then on a new role or a rename whose name makes
// another role's group, a built-in's or a custom one's, is refused by the database as a taken name.
func TestPostgresRoleNamesTakenInTheDatabase(t *testing.T) {
	pool := migratedDatabase(t)
	ctx := context.Background()
	repo := repository.New(pool)
	if err := repo.SeedSystemRoles(ctx); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := repo.SeedSystemRoles(ctx); err != nil {
		t.Fatalf("seed again: %v", err)
	}
	ab := roleID(t, pool, "a b")
	for _, name := range []string{"ADMIN", " member ", "a-b", "A!B"} {
		if _, err := repo.CreateRole(ctx, name, "", nil); !repository.IsRoleNameTaken(err) {
			t.Errorf("a new role %q: %v, want the name taken", name, err)
		}
	}
	if _, err := repo.UpdateRole(ctx, ab, "a b", "described", nil, repository.RoleTokensKept); err != nil {
		t.Fatalf("an edit of the stored name: %v", err)
	}
	if _, err := repo.UpdateRole(ctx, ab, "Admin ", "described", nil, repository.RoleTokensKept); !repository.IsRoleNameTaken(err) {
		t.Fatalf("a rename to the built-in's name with a space: %v, want the name taken", err)
	}
	if _, err := repo.UpdateRole(ctx, ab, "site-admin", "described", nil, repository.RoleTokensKept); err != nil {
		t.Fatalf("a rename to a free name: %v", err)
	}
	if _, err := repo.CreateRole(ctx, "SITE ADMIN", "", nil); !repository.IsRoleNameTaken(err) {
		t.Fatalf("a new role of that group: %v, want the name taken", err)
	}
	if _, err := repo.CreateRole(ctx, "a b", "", nil); err != nil {
		t.Fatalf("the name given up by the rename: %v", err)
	}
}
