package dbmigrate

import (
	"context"
	"errors"
	"maps"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
)

// An upgrade keeps every stored role name, also names equal ignoring case: the built-in, else the oldest, stays in the
// index and the others are marked name_kept. From then on the database refuses a new or renamed role whose name equals
// another's ignoring case and surrounding spaces, and a role renamed out of its mark is held to the index.
func TestPostgresRoleNamesEqualIgnoringCase(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()
	p, err := newProvider(stdlib.OpenDBFromPool(pool))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpTo(ctx, 22); err != nil {
		t.Fatalf("up to 22: %v", err)
	}
	// What an older build could store: a built-in's name in other capitals or with spaces, two custom roles of one name.
	for _, r := range []struct {
		name   string
		system bool
	}{
		{"ADMIN", false}, {"Admin", true}, {"admin", false}, {"Read", true}, {" read ", false}, {"ops", false}, {"OPS", false}, {"team", false},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO roles (name, is_system) VALUES ($1, $2)`, r.name, r.system); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := p.UpTo(ctx, 23); err != nil {
		t.Fatalf("up to 23 over names equal ignoring case: %v", err)
	}
	marks := func() map[string]bool {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT name, name_kept FROM roles`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		got := map[string]bool{}
		for rows.Next() {
			var name string
			var kept bool
			if err := rows.Scan(&name, &kept); err != nil {
				t.Fatal(err)
			}
			got[name] = kept
		}
		return got
	}
	want := map[string]bool{"ADMIN": true, "Admin": false, "admin": true, "Read": false, " read ": true, "ops": false, "OPS": true, "team": false}
	if got := marks(); !maps.Equal(got, want) {
		t.Fatalf("name_kept %v, want %v", got, want)
	}

	refused := func(what string, err error) {
		t.Helper()
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23505" || pgErr.ConstraintName != "roles_name_folded_key" {
			t.Errorf("%s: %v, want 23505 on roles_name_folded_key", what, err)
		}
	}
	for _, name := range []string{"TEAM", " team ", "Ops", "READ", "aDmIn"} {
		_, err := pool.Exec(ctx, `INSERT INTO roles (name) VALUES ($1)`, name)
		refused("new role "+name, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO roles (name) VALUES ('team-2')`); err != nil {
		t.Fatalf("a name free ignoring case: %v", err)
	}
	// As repository.UpdateRole writes it: the mark stays with the stored name and goes with a rename.
	rename := `UPDATE roles SET name = $1, name_kept = (name_kept AND $2) WHERE name = $3`
	if _, err := pool.Exec(ctx, rename, "OPS", true, "OPS"); err != nil {
		t.Fatalf("a kept name saved as it is: %v", err)
	}
	_, err = pool.Exec(ctx, rename, "Ops", false, "OPS")
	refused("a kept name renamed to another form of a held one", err)
	if _, err := pool.Exec(ctx, rename, "ops-2", false, "OPS"); err != nil {
		t.Fatalf("a kept name renamed to a free one: %v", err)
	}
	if got := marks()["ops-2"]; got {
		t.Error("a renamed role kept its mark")
	}

	// Down and up again over the same rows.
	if _, err := p.Down(ctx); err != nil {
		t.Fatalf("down: %v", err)
	}
	var columns int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_name = 'roles' AND column_name = 'name_kept'`).Scan(&columns); err != nil || columns != 0 {
		t.Fatalf("name_kept after down: %d, %v", columns, err)
	}
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
	if got := marks(); !got["ADMIN"] || !got["admin"] || !got[" read "] || got["Admin"] || got["ops-2"] {
		t.Fatalf("name_kept after up again %v", got)
	}
}
