package dbmigrate

import (
	"context"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/stdlib"
)

// An upgrade leaves each role reading what it read: a custom role that read the lists gets the key and nothing wider,
// a role holding a wildcard needs nothing, an empty role still reaches no cluster, and a role of admin keys held only
// globally stays as it is, so an editor who holds no cluster key can still save it.
func TestPostgresAnUpgradeKeepsWhatACustomRoleReads(t *testing.T) {
	const key = "resource.objects.read"
	pool := freshDatabase(t)
	ctx := context.Background()
	p, err := newProvider(stdlib.OpenDBFromPool(pool))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpTo(ctx, 21); err != nil {
		t.Fatalf("up to 21: %v", err)
	}

	roles := []struct {
		name    string
		system  bool
		perms   []string
		wantKey bool
	}{
		{"tools", false, []string{"ai.tool.*", "ai.mcp.use"}, true},
		{"menus", false, []string{"menu.*"}, true},
		{"writer", false, []string{"resource.*.edit", "resource.*.delete"}, true},
		{"helm", false, []string{"resource.helm.read"}, true},
		{"reader", false, []string{"menu.*", "resource.*.read"}, false},
		{"everything", false, []string{"resource.*.*"}, false},
		{"resources", false, []string{"resource.*"}, false},
		{"star", false, []string{"*"}, false},
		{"empty", false, nil, false},
		{"empty-granted", false, nil, false},
		{"auditor", false, []string{"admin.audit.read"}, false},
		{"auditor-granted", false, []string{"admin.audit.read"}, true},
		{"Read", true, []string{"resource.*.read"}, false},
		{"Member", true, nil, false},
	}
	ids := map[string]int{}
	for _, r := range roles {
		var id int
		if err := pool.QueryRow(ctx, `INSERT INTO roles (name, is_system) VALUES ($1, $2) RETURNING id`, r.name, r.system).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids[r.name] = id
		for _, perm := range r.perms {
			if _, err := pool.Exec(ctx, `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`, id, perm); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO clusters (id, display_name, mode) VALUES ('c', 'c', 'external')`); err != nil {
		t.Fatal(err)
	}
	// Who signs in again: a grant of a role that got the key. A global role gives no cluster key, and a wildcard's token holds it.
	for _, u := range []struct{ id, global, grant string }{
		{"on-tools", "Member", "tools"},
		{"on-reader", "Member", "reader"},
		{"global-tools", "tools", ""},
		{"on-nothing", "Member", ""},
		{"on-empty", "Member", "empty-granted"},
		{"on-auditor", "Member", "auditor-granted"},
		{"global-auditor", "auditor", ""},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO auth_users (id, name, email, role_id, password_hash) VALUES ($1, $1, $1, $2, 'x')`, u.id, ids[u.global]); err != nil {
			t.Fatal(err)
		}
		if u.grant != "" {
			if _, err := pool.Exec(ctx, `INSERT INTO user_cluster_roles (user_id, cluster_id, role_id) VALUES ($1, 'c', $2)`, u.id, ids[u.grant]); err != nil {
				t.Fatal(err)
			}
		}
	}

	if v, err := Up(ctx, pool); err != nil || v != Required {
		t.Fatalf("Up = %d, %v; want %d, nil", v, err, Required)
	}

	held := func(id int) []string {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT permission FROM role_permissions WHERE role_id = $1 ORDER BY permission`, id)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var perm string
			if err := rows.Scan(&perm); err != nil {
				t.Fatal(err)
			}
			out = append(out, perm)
		}
		return out
	}
	for _, r := range roles {
		want := slices.Clone(r.perms)
		if r.wantKey {
			want = append(want, key)
		}
		slices.Sort(want)
		if got := held(ids[r.name]); !slices.Equal(got, want) {
			t.Errorf("role %s holds %v, want %v", r.name, got, want)
		}
	}
	for id, want := range map[string]int{"on-tools": 1, "on-reader": 0, "global-tools": 0, "on-nothing": 0, "on-empty": 0, "on-auditor": 1, "global-auditor": 0} {
		var got int
		if err := pool.QueryRow(ctx, `SELECT token_version FROM auth_users WHERE id = $1`, id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("%s token_version = %d, want %d", id, got, want)
		}
	}

	// Down: an older build could not save a role holding a key it does not know.
	if _, err := p.DownTo(ctx, 21); err != nil {
		t.Fatalf("down to 21: %v", err)
	}
	if got := held(ids["tools"]); slices.Contains(got, key) {
		t.Errorf("after Down the role holds %v", got)
	}
}
