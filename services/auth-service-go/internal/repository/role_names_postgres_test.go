package repository_test

import (
	"context"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
)

// The seed writes the built-ins over custom roles that hold their names in other capitals (made before such names were
// refused): those keep their names, marked out of the index of names ignoring case, and a boot does not stop on them.
// An edit keeps the mark while the name stays and a rename drops it, so the new name is held to the index.
func TestPostgresSeedAndEditKeepStoredRoleNames(t *testing.T) {
	pool := migratedDatabase(t)
	ctx := context.Background()
	repo := repository.New(pool)
	member := roleID(t, pool, "MEMBER")
	admin := roleID(t, pool, "admin")
	if err := repo.SeedSystemRoles(ctx); err != nil {
		t.Fatalf("seed over custom roles of a built-in's name: %v", err)
	}
	kept := func(id int) bool {
		t.Helper()
		var k bool
		if err := pool.QueryRow(ctx, `SELECT name_kept FROM roles WHERE id = $1`, id).Scan(&k); err != nil {
			t.Fatal(err)
		}
		return k
	}
	if !kept(member) || !kept(admin) {
		t.Fatalf("custom MEMBER kept %v, admin kept %v; want both", kept(member), kept(admin))
	}
	if err := repo.SeedSystemRoles(ctx); err != nil {
		t.Fatalf("seed again: %v", err)
	}

	if _, err := repo.UpdateRole(ctx, admin, "admin", "described", nil, repository.RoleTokensKept, true); err != nil || !kept(admin) {
		t.Fatalf("an edit of the stored name: %v, kept %v", err, kept(admin))
	}
	if _, err := repo.UpdateRole(ctx, admin, "Admin ", "described", nil, repository.RoleTokensKept, false); !repository.IsRoleNameTaken(err) {
		t.Fatalf("a rename to the built-in's name with a space: %v, want the name taken", err)
	}
	if _, err := repo.UpdateRole(ctx, admin, "site-admin", "described", nil, repository.RoleTokensKept, false); err != nil || kept(admin) {
		t.Fatalf("a rename to a free name: %v, kept %v", err, kept(admin))
	}
	if _, err := repo.CreateRole(ctx, "SITE-ADMIN", "", nil); !repository.IsRoleNameTaken(err) {
		t.Fatalf("a new role of that name in capitals: %v, want the name taken", err)
	}
}
