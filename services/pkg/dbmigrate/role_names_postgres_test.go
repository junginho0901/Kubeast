package dbmigrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

// roleGroupSlugCasesFile is the table auth.RoleGroupSlug and the frontend's roleGroupSlug run too.
const roleGroupSlugCasesFile = "../../../frontend/src/utils/roleGroupSlug.cases.json"

// An upgrade leaves no two roles of one group and no custom role of a built-in's group: the built-in, else the oldest,
// keeps its name, the others are renamed "<name>-renamed-<id>" and lose their grants, the restore that would bring them
// back and their open access requests, the holders sign in again, and each change is an audit row by system /
// migration. From then on the database refuses a role whose name makes another's group.
func TestPostgresRoleNamesOneGroupEach(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()
	p, err := newProvider(stdlib.OpenDBFromPool(pool))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpTo(ctx, 24); err != nil {
		t.Fatalf("up to 24: %v", err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}

	// What an older build could store, in id order: Pending and Write are not stored yet, so PENDING takes a built-in's
	// group with no built-in beside it.
	ids := map[string]int{}
	for _, r := range []struct {
		name   string
		system bool
	}{
		{"Admin", true}, {"Read", true}, {"Member", true},
		{"ADMIN", false}, {"admin", false}, {" read ", false}, {"PENDING", false},
		{"ops", false}, {"OPS", false}, {"a b", false}, {"a-b", false}, {"team", false}, {"ADMİN", false},
		// Korean names of one length make groups of their own; two that differ only in letter case and punctuation do not
		{"운영팀", false}, {"개발팀", false}, {"Ops 팀", false}, {"ops-팀", false},
	} {
		var id int
		if err := pool.QueryRow(ctx, `INSERT INTO roles (name, is_system) VALUES ($1, $2) RETURNING id`, r.name, r.system).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids[r.name] = id
	}
	// A role already holding the name OPS would be renamed to: OPS takes the next one.
	held := fmt.Sprintf("ops-renamed-%d", ids["OPS"])
	if err := pool.QueryRow(ctx, `INSERT INTO roles (name) VALUES ($1) RETURNING id`, held).Scan(new(int)); err != nil {
		t.Fatal(err)
	}

	exec(`INSERT INTO clusters (id, display_name, mode) VALUES ('c', 'c', 'external')`)
	for _, u := range []struct {
		id     string
		global int
	}{
		{"u-admin-grant", ids["Member"]}, {"u-ops-grant", ids["Member"]}, {"u-temporary", ids["Member"]}, {"u-restore", ids["Member"]},
		{"u-global", ids["ADMIN"]}, {"u-requested", ids["Member"]}, {"u-team", ids["Member"]}, {"u-dev", ids["Member"]},
	} {
		exec(`INSERT INTO auth_users (id, name, email, role_id, password_hash) VALUES ($1, $1, $2, $3, 'x')`, u.id, u.id+"@example.com", u.global)
	}
	grant := `INSERT INTO user_cluster_roles (user_id, cluster_id, role_id, namespaces, expires_at, restore_role_id, restore_namespaces, request_id)
	          VALUES ($1, 'c', $2, $3, $4, $5, $6, $7)`
	until := time.Now().UTC().Add(time.Hour)
	exec(grant, "u-admin-grant", ids["ADMIN"], nil, nil, nil, nil, nil)
	exec(grant, "u-ops-grant", ids["ops"], nil, nil, nil, nil, nil)
	exec(`INSERT INTO access_requests (id, user_id, cluster_id, role_id, duration_minutes, reason, status) VALUES ('r-temporary', 'u-temporary', 'c', $1, 60, 'x', 'approved')`, ids["OPS"])
	exec(grant, "u-temporary", ids["OPS"], nil, until, ids["Read"], []string{"shop"}, "r-temporary")
	exec(`INSERT INTO access_requests (id, user_id, cluster_id, role_id, duration_minutes, reason, status) VALUES ('r-restore', 'u-restore', 'c', $1, 60, 'x', 'approved')`, ids["Read"])
	exec(grant, "u-restore", ids["Read"], nil, until, ids[" read "], []string{"web"}, "r-restore")
	exec(`INSERT INTO access_requests (id, user_id, cluster_id, role_id, duration_minutes, reason, status) VALUES ('r-pending', 'u-requested', 'c', $1, 60, 'x', 'pending')`, ids["a-b"])
	exec(grant, "u-requested", ids["team"], nil, nil, nil, nil, nil)
	exec(grant, "u-team", ids["team"], nil, nil, nil, nil, nil)
	exec(grant, "u-dev", ids["개발팀"], nil, nil, nil, nil, nil)

	if _, err := p.UpTo(ctx, 25); err != nil {
		t.Fatalf("up to 25 over roles of one group: %v", err)
	}

	names := func() map[int]string {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT id, name FROM roles`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		got := map[int]string{}
		for rows.Next() {
			var id int
			var name string
			if err := rows.Scan(&id, &name); err != nil {
				t.Fatal(err)
			}
			got[id] = name
		}
		return got
	}
	renamed := func(name string) string { return fmt.Sprintf("%s-renamed-%d", name, ids[name]) }
	want := map[int]string{
		ids["Admin"]: "Admin", ids["Read"]: "Read", ids["Member"]: "Member",
		ids["ADMIN"]: renamed("ADMIN"), ids["admin"]: renamed("admin"), ids[" read "]: fmt.Sprintf("read-renamed-%d", ids[" read "]),
		ids["PENDING"]: renamed("PENDING"), ids["ops"]: "ops", ids["OPS"]: renamed("OPS") + "-2", ids["a b"]: "a b",
		ids["a-b"]: renamed("a-b"), ids["team"]: "team", ids["ADMİN"]: renamed("ADMİN"),
		ids["운영팀"]: "운영팀", ids["개발팀"]: "개발팀", ids["Ops 팀"]: "Ops 팀", ids["ops-팀"]: renamed("ops-팀"),
	}
	got := names()
	for id, name := range want {
		if got[id] != name {
			t.Errorf("role %d is %q, want %q", id, got[id], name)
		}
	}
	if !slices.Contains(slices.Collect(maps.Values(got)), held) {
		t.Errorf("the role named %s was renamed: %v", held, got)
	}

	type grantRow struct {
		role       int
		namespaces []string
		temporary  bool
		restore    *int
		request    *string
	}
	grants := func() map[string]grantRow {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT user_id, role_id, namespaces, expires_at IS NOT NULL, restore_role_id, request_id FROM user_cluster_roles`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := map[string]grantRow{}
		for rows.Next() {
			var user string
			var g grantRow
			if err := rows.Scan(&user, &g.role, &g.namespaces, &g.temporary, &g.restore, &g.request); err != nil {
				t.Fatal(err)
			}
			out[user] = g
		}
		return out
	}
	gs := grants()
	if _, ok := gs["u-admin-grant"]; ok {
		t.Errorf("the grant of ADMIN stayed: %+v", gs["u-admin-grant"])
	}
	if g := gs["u-temporary"]; g.role != ids["Read"] || !slices.Equal(g.namespaces, []string{"shop"}) || g.temporary || g.restore != nil || g.request != nil {
		t.Errorf("the temporary grant of OPS went back to %+v, want Read in shop for good", g)
	}
	if g := gs["u-restore"]; g.role != ids["Read"] || !g.temporary || g.restore != nil {
		t.Errorf("the temporary Read over a grant of ' read ' is %+v, want it with nothing to restore", g)
	}
	for user, role := range map[string]int{"u-ops-grant": ids["ops"], "u-requested": ids["team"], "u-team": ids["team"], "u-dev": ids["개발팀"]} {
		if g, ok := gs[user]; !ok || g.role != role {
			t.Errorf("%s's grant is %+v, want role %d as it was", user, g, role)
		}
	}

	requests := map[string][2]string{}
	rows, err := pool.Query(ctx, `SELECT id, status, coalesce(end_reason, '') FROM access_requests`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, status, reason string
		if err := rows.Scan(&id, &status, &reason); err != nil {
			t.Fatal(err)
		}
		requests[id] = [2]string{status, reason}
	}
	rows.Close()
	if want := map[string][2]string{
		"r-temporary": {"expired", "role_renamed"}, "r-pending": {"expired", "role_renamed"}, "r-restore": {"approved", ""},
	}; !maps.Equal(requests, want) {
		t.Errorf("requests %v, want %v", requests, want)
	}

	versions := map[string]int{}
	rows, err = pool.Query(ctx, `SELECT id, token_version FROM auth_users`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		var v int
		if err := rows.Scan(&id, &v); err != nil {
			t.Fatal(err)
		}
		versions[id] = v
	}
	rows.Close()
	if want := map[string]int{
		"u-admin-grant": 1, "u-ops-grant": 0, "u-temporary": 1, "u-restore": 1, "u-global": 1, "u-requested": 0, "u-team": 0, "u-dev": 0,
	}; !maps.Equal(versions, want) {
		t.Errorf("token versions %v, want %v", versions, want)
	}
	var globalRole int
	if err := pool.QueryRow(ctx, `SELECT role_id FROM auth_users WHERE id = 'u-global'`).Scan(&globalRole); err != nil || globalRole != ids["ADMIN"] {
		t.Errorf("u-global's account level is %d (%v), want the renamed role %d", globalRole, err, ids["ADMIN"])
	}

	audit := auditRows(t, pool)
	if want := map[string]int{"admin.roles.update": 8, "user.cluster_role.unset": 3, "access.request.expire": 2}; !maps.Equal(audit.count, want) {
		t.Errorf("audit rows by action %v, want %v", audit.count, want)
	}
	if r := audit.byTarget[fmt.Sprint(ids["ADMIN"])]; r.before["name"] != "ADMIN" || r.after["name"] != renamed("ADMIN") || r.after["same_group_as"] != "Admin" {
		t.Errorf("ADMIN's row %+v", r)
	}
	if r := audit.byTarget[fmt.Sprint(ids["ops-팀"])]; r.after["same_group_as"] != "Ops 팀" {
		t.Errorf("ops-팀's row %+v, want Ops 팀 named", r)
	}
	if r := audit.byTarget[fmt.Sprint(ids["PENDING"])]; r.after["same_group_as"] != "Pending" {
		t.Errorf("PENDING's row %+v, want the built-in not yet stored named", r)
	}
	if r := audit.byTarget["u-admin-grant"]; r.before["role"] != "ADMIN" || r.after["reason"] != "role_renamed" || r.after["restored_role"] != nil || r.cluster != "c" {
		t.Errorf("u-admin-grant's row %+v", r)
	}
	if r := audit.byTarget["u-temporary"]; r.after["restored_role"] != "Read" || r.after["renamed_to"] != renamed("OPS")+"-2" {
		t.Errorf("u-temporary's row %+v", r)
	}

	refused := func(what string, err error) {
		t.Helper()
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23505" || pgErr.ConstraintName != "roles_name_group_key" {
			t.Errorf("%s: %v, want 23505 on roles_name_group_key", what, err)
		}
	}
	for _, name := range []string{"TEAM", " team ", "Ops", "READ", "aDmIn", "A!B", "ADMİN", " 운영팀", "OPS!팀"} {
		_, err := pool.Exec(ctx, `INSERT INTO roles (name) VALUES ($1)`, name)
		refused("new role "+name, err)
	}
	// another Korean name of the same length, and one that differs from a held name in a space only where that name has
	// none, are names of their own
	exec(`INSERT INTO roles (name) VALUES ('운영부'), ('운영 팀')`)
	// Write is not stored, so its seed or a role of that name is free; the next of its group is not.
	exec(`INSERT INTO roles (name, is_system) VALUES ('Write', true)`)
	_, err = pool.Exec(ctx, `INSERT INTO roles (name) VALUES ('WRITE')`)
	refused("WRITE beside Write", err)
	_, err = pool.Exec(ctx, `UPDATE roles SET name = 'Team' WHERE id = $1`, ids["ops"])
	refused("a rename to another form of a held name", err)
	exec(`UPDATE roles SET name = 'ops-2' WHERE id = $1`, ids["ops"])

	// The database's slug is auth.RoleGroupSlug's.
	raw, err := os.ReadFile(roleGroupSlugCasesFile)
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct{ Name, Slug string }
	}
	if err := json.Unmarshal(raw, &file); err != nil || len(file.Cases) == 0 {
		t.Fatalf("%s: %v", roleGroupSlugCasesFile, err)
	}
	for _, c := range file.Cases {
		var slug string
		if err := pool.QueryRow(ctx, `SELECT role_group_slug($1)`, c.Name).Scan(&slug); err != nil || slug != c.Slug {
			t.Errorf("role_group_slug(%q) = %q (%v), want %q", c.Name, slug, err, c.Slug)
		}
	}

	// Down and up again: the names stay, nothing is renamed twice, the index is back.
	before := names()
	if _, err := p.Down(ctx); err != nil {
		t.Fatalf("down: %v", err)
	}
	var index int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE indexname = 'roles_name_group_key'`).Scan(&index); err != nil || index != 0 {
		t.Fatalf("roles_name_group_key after down: %d, %v", index, err)
	}
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
	if after := names(); !maps.Equal(after, before) {
		t.Errorf("names after up again %v, want %v", after, before)
	}
	if again := auditRows(t, pool); !maps.Equal(again.count, audit.count) {
		t.Errorf("audit rows after up again %v, want %v", again.count, audit.count)
	}
	_, err = pool.Exec(ctx, `INSERT INTO roles (name) VALUES ('TEAM')`)
	refused("TEAM after up again", err)
}

// An account level of a custom role of Pending's group (PENDING, pending) kept the account waiting for approval in the
// builds before, which read the level ignoring case. The upgrade moves it to the built-in Pending, storing it when it is
// not stored yet, so the account still waits, and leaves a user.role.update row. Another renamed account level stays on
// its role.
func TestPostgresPendingGroupAccountLevelsStayPending(t *testing.T) {
	for _, stored := range []bool{false, true} {
		t.Run(fmt.Sprintf("Pending stored %v", stored), func(t *testing.T) {
			pool := freshDatabase(t)
			ctx := context.Background()
			p, err := newProvider(stdlib.OpenDBFromPool(pool))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := p.UpTo(ctx, 24); err != nil {
				t.Fatalf("up to 24: %v", err)
			}
			roles := []struct {
				name   string
				system bool
			}{{"Admin", true}, {"PENDING", false}, {"pending", false}, {"ADMIN", false}}
			if stored {
				roles = append(roles, struct {
					name   string
					system bool
				}{"Pending", true})
			}
			ids := map[string]int{}
			for _, r := range roles {
				var id int
				if err := pool.QueryRow(ctx, `INSERT INTO roles (name, is_system) VALUES ($1, $2) RETURNING id`, r.name, r.system).Scan(&id); err != nil {
					t.Fatal(err)
				}
				ids[r.name] = id
			}
			levels := map[string]string{"u-upper": "PENDING", "u-lower": "pending", "u-admin-level": "ADMIN", "u-admin": "Admin"}
			for user, role := range levels {
				if _, err := pool.Exec(ctx, `INSERT INTO auth_users (id, name, email, role_id, password_hash) VALUES ($1, $1, $2, $3, 'x')`,
					user, user+"@example.com", ids[role]); err != nil {
					t.Fatal(err)
				}
			}

			if _, err := p.UpTo(ctx, 25); err != nil {
				t.Fatalf("up to 25: %v", err)
			}

			var pending int
			var system bool
			if err := pool.QueryRow(ctx, `SELECT id, is_system FROM roles WHERE name = 'Pending'`).Scan(&pending, &system); err != nil {
				t.Fatalf("the built-in Pending: %v", err)
			}
			if !system || (stored && pending != ids["Pending"]) {
				t.Errorf("Pending is role %d (system %v), want the built-in (stored as %d)", pending, system, ids["Pending"])
			}
			want := map[string]int{"u-upper": pending, "u-lower": pending, "u-admin-level": ids["ADMIN"], "u-admin": ids["Admin"]}
			wantVersion := map[string]int{"u-upper": 1, "u-lower": 1, "u-admin-level": 1, "u-admin": 0}
			for user, role := range want {
				var got, version int
				if err := pool.QueryRow(ctx, `SELECT role_id, token_version FROM auth_users WHERE id = $1`, user).Scan(&got, &version); err != nil {
					t.Fatal(err)
				}
				if got != role || version != wantVersion[user] {
					t.Errorf("%s: account level %d, token version %d; want %d, %d", user, got, version, role, wantVersion[user])
				}
			}

			audit := auditRows(t, pool)
			if audit.count["user.role.update"] != 2 {
				t.Errorf("user.role.update rows %d, want 2: %v", audit.count["user.role.update"], audit.count)
			}
			for _, user := range []string{"u-upper", "u-lower"} {
				old := levels[user]
				r := audit.byTarget[user]
				if r.before["role"] != old || r.after["role"] != "Pending" || r.after["reason"] != "role_renamed" ||
					r.after["renamed_to"] != fmt.Sprintf("%s-renamed-%d", old, ids[old]) {
					t.Errorf("%s's row %+v", user, r)
				}
			}
			var emails int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_audit_logs WHERE action = 'user.role.update'
			                               AND target_type = 'user' AND target_user_id = target_id AND target_email = target_id || '@example.com'`).Scan(&emails); err != nil || emails != 2 {
				t.Errorf("user.role.update rows naming their account: %d (%v), want 2", emails, err)
			}
		})
	}
}

// A renamed role's new name starts from its old name trimmed of Go's whitespace (strings.TrimSpace), the set
// role_group_slug trims, so no character a list does not show stays in front of it.
func TestPostgresRenamedRoleNamesTrimmedAsGo(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()
	p, err := newProvider(stdlib.OpenDBFromPool(pool))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpTo(ctx, 24); err != nil {
		t.Fatalf("up to 24: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO roles (name, is_system) VALUES ('Admin', true)`); err != nil {
		t.Fatal(err)
	}
	var spaces []rune
	for r := rune(1); r <= unicode.MaxRune; r++ {
		if unicode.IsSpace(r) {
			spaces = append(spaces, r)
		}
	}
	want := map[int]string{}
	for _, r := range spaces {
		name := string(r) + "ADMIN" + string(r)
		var id int
		if err := pool.QueryRow(ctx, `INSERT INTO roles (name) VALUES ($1) RETURNING id`, name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		want[id] = fmt.Sprintf("%s-renamed-%d", strings.TrimSpace(name), id)
	}

	if _, err := p.UpTo(ctx, 25); err != nil {
		t.Fatalf("up to 25: %v", err)
	}

	for id, name := range want {
		var got string
		if err := pool.QueryRow(ctx, `SELECT name FROM roles WHERE id = $1`, id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != name {
			t.Errorf("role %d is %q, want %q", id, got, name)
		}
	}
	for _, r := range spaces {
		var slug string
		if err := pool.QueryRow(ctx, `SELECT role_group_slug($1)`, string(r)+"x"+string(r)).Scan(&slug); err != nil || slug != "x" {
			t.Errorf("role_group_slug(%q) = %q (%v), want x", string(r)+"x"+string(r), slug, err)
		}
	}
}

// upgradeDocsQueries are the two queries of docs/getting-started.md "Upgrade", which docs/ko gives the same: the
// preview of what the migration renames and the check for a grant of a renamed role after it.
func upgradeDocsQueries(t *testing.T) (preview, check string) {
	t.Helper()
	blocks := func(path string) (preview, check string) {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		parts := strings.Split(string(raw), "```")
		for i := 1; i < len(parts); i += 2 {
			sql, ok := strings.CutPrefix(parts[i], "sql\n")
			switch {
			case !ok:
			case strings.Contains(sql, "AS same_group_as"):
				preview = sql
			case strings.Contains(sql, "FROM user_cluster_roles g JOIN roles r"):
				check = sql
			}
		}
		if preview == "" || check == "" {
			t.Fatalf("%s: the upgrade queries are not there", path)
		}
		return preview, check
	}
	preview, check = blocks("../../../docs/getting-started.md")
	if p, c := blocks("../../../docs/ko/getting-started.md"); p != preview || c != check {
		t.Errorf("docs/ko/getting-started.md gives other upgrade queries")
	}
	return preview, check
}

// The upgrade docs' preview, run before the migration, lists the roles it renames, each with the role whose group it
// shares and what it holds; the check after it lists a grant of a renamed role written once the migration had run.
func TestPostgresUpgradeDocsQueriesSayWhatTheMigrationDoes(t *testing.T) {
	previewSQL, checkSQL := upgradeDocsQueries(t)
	pool := freshDatabase(t)
	ctx := context.Background()
	p, err := newProvider(stdlib.OpenDBFromPool(pool))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpTo(ctx, 24); err != nil {
		t.Fatalf("up to 24: %v", err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	ids := map[string]int{}
	for _, r := range []struct {
		name   string
		system bool
	}{
		{"Admin", true}, {"Read", true}, {"Member", true},
		{"ADMIN", false}, {" read ", false}, {"PENDING", false}, {"ops", false}, {"OPS", false},
		{"a b", false}, {"a-b", false}, {"team", false}, {"　team ", false}, {"ADMİN", false},
		{"운영팀", false}, {"개발팀", false}, {"Ops 팀", false}, {"ops-팀", false}, {"😀", false}, {"😁", false},
	} {
		var id int
		if err := pool.QueryRow(ctx, `INSERT INTO roles (name, is_system) VALUES ($1, $2) RETURNING id`, r.name, r.system).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids[r.name] = id
	}
	exec(`INSERT INTO clusters (id, display_name, mode) VALUES ('c', 'c', 'external')`)
	exec(`INSERT INTO auth_users (id, name, email, role_id, password_hash) VALUES ('u-waiting', 'w', 'w@example.com', $1, 'x')`, ids["PENDING"])
	exec(`INSERT INTO auth_users (id, name, email, role_id, password_hash) VALUES ('u-member', 'm', 'm@example.com', $1, 'x')`, ids["Member"])
	exec(`INSERT INTO user_cluster_roles (user_id, cluster_id, role_id) VALUES ('u-member', 'c', $1)`, ids["OPS"])
	exec(`INSERT INTO access_requests (id, user_id, cluster_id, role_id, duration_minutes, reason, status) VALUES ('r', 'u-member', 'c', $1, 60, 'x', 'pending')`, ids["a-b"])

	type previewRow struct {
		name, sameGroupAs                             string
		grants, restores, openRequests, accountLevels int
	}
	preview := map[int]previewRow{}
	rows, err := pool.Query(ctx, previewSQL)
	if err != nil {
		t.Fatalf("the preview query: %v", err)
	}
	for rows.Next() {
		var id int
		var r previewRow
		if err := rows.Scan(&id, &r.name, &r.sameGroupAs, &r.grants, &r.restores, &r.openRequests, &r.accountLevels); err != nil {
			t.Fatal(err)
		}
		preview[id] = r
	}
	rows.Close()
	if want := map[int]previewRow{
		ids["ADMIN"]: {"ADMIN", "Admin", 0, 0, 0, 0}, ids[" read "]: {" read ", "Read", 0, 0, 0, 0},
		ids["PENDING"]: {"PENDING", "Pending", 0, 0, 0, 1}, ids["OPS"]: {"OPS", "ops", 1, 0, 0, 0},
		ids["a-b"]: {"a-b", "a b", 0, 0, 1, 0}, ids["　team "]: {"　team ", "team", 0, 0, 0, 0},
		ids["ADMİN"]: {"ADMİN", "Admin", 0, 0, 0, 0}, ids["ops-팀"]: {"ops-팀", "Ops 팀", 0, 0, 0, 0},
	}; !maps.Equal(preview, want) {
		t.Errorf("the preview lists %+v, want %+v", preview, want)
	}

	if _, err := p.UpTo(ctx, 25); err != nil {
		t.Fatalf("up to 25: %v", err)
	}
	renamed := map[int]string{}
	rows, err = pool.Query(ctx, `SELECT target_id::int, after->>'same_group_as' FROM auth_audit_logs
	                              WHERE actor_user_id = 'system' AND actor_email = 'migration' AND action = 'admin.roles.update'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id int
		var same string
		if err := rows.Scan(&id, &same); err != nil {
			t.Fatal(err)
		}
		renamed[id] = same
	}
	rows.Close()
	previewed := map[int]string{}
	for id, r := range preview {
		previewed[id] = r.sameGroupAs
	}
	if !maps.Equal(renamed, previewed) {
		t.Errorf("the migration renamed %v, the preview listed %v", renamed, previewed)
	}

	checked := func() []string {
		t.Helper()
		rows, err := pool.Query(ctx, checkSQL)
		if err != nil {
			t.Fatalf("the check query: %v", err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var user, cluster, role string
			if err := rows.Scan(&user, &cluster, &role); err != nil {
				t.Fatal(err)
			}
			out = append(out, user+" "+cluster+" "+role)
		}
		return out
	}
	if got := checked(); len(got) != 0 {
		t.Errorf("the check lists %v right after the migration, want none", got)
	}
	// What a pod of the version before writes in the moment before the migration commits.
	exec(`INSERT INTO user_cluster_roles (user_id, cluster_id, role_id) VALUES ('u-member', 'c', $1)`, ids["ADMIN"])
	if got, want := checked(), []string{fmt.Sprintf("u-member c ADMIN-renamed-%d", ids["ADMIN"])}; !slices.Equal(got, want) {
		t.Errorf("the check lists %v, want %v", got, want)
	}
}

type migrationAuditRow struct {
	cluster       string
	before, after map[string]any
}

type migrationAudit struct {
	count    map[string]int
	byTarget map[string]migrationAuditRow
}

// auditRows reads the rows by system / migration, by action and by target.
func auditRows(t *testing.T, pool *pgxpool.Pool) migrationAudit {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT action, coalesce(target_id, ''), coalesce(cluster, ''), before, after, result FROM auth_audit_logs
		  WHERE actor_user_id = 'system' AND actor_email = 'migration'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := migrationAudit{count: map[string]int{}, byTarget: map[string]migrationAuditRow{}}
	for rows.Next() {
		var action, target, cluster, result string
		var before, after []byte
		if err := rows.Scan(&action, &target, &cluster, &before, &after, &result); err != nil {
			t.Fatal(err)
		}
		if result != "success" {
			t.Errorf("%s row for %s: result %s", action, target, result)
		}
		r := migrationAuditRow{cluster: cluster}
		if err := json.Unmarshal(before, &r.before); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(after, &r.after); err != nil {
			t.Fatal(err)
		}
		out.count[action]++
		if action != "access.request.expire" {
			out.byTarget[target] = r
		}
	}
	return out
}
