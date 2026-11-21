package dbmigrate

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/stdlib"
)

// selfSignUpsVersion is the migration that makes the self sign-ups a provider's sign-in reached oidc accounts; renumber
// it with the file.
const selfSignUpsVersion = 31

// An upgrade makes oidc every password account a provider's sign-in took over from a self sign-up: one holding no
// password, and one a user.account.link row names by id, whose password stays. Any other account keeps how it signs in:
// a self sign-up the provider never reached, an account an admin approved that also signs in through the provider, an
// account of the same address as a linked one deleted since. Each change is one user.account.link row by system /
// migration. Down leaves the accounts as they are, and Up again changes nothing and writes no row.
func TestPostgresSelfSignUpsTheProviderReachedBecomeOIDCAccounts(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()
	p, err := newProvider(stdlib.OpenDBFromPool(pool))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpTo(ctx, selfSignUpsVersion-1); err != nil {
		t.Fatalf("up to %d: %v", selfSignUpsVersion-1, err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	var pending, member int
	if err := pool.QueryRow(ctx, `INSERT INTO roles (name, is_system) VALUES ('Pending', true) RETURNING id`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO roles (name, is_system) VALUES ('Member', true) RETURNING id`).Scan(&member); err != nil {
		t.Fatal(err)
	}
	accounts := []struct {
		id, source, hash string
		role             int
		want             string
	}{
		{"linked", "password", "", member, "oidc"},
		{"linked-then-reset", "password", "reset-hash", member, "oidc"},
		{"linked-still-waiting", "password", "", pending, "oidc"},
		{"waiting-never-reached", "password", "signup-hash", pending, "password"},
		{"approved-also-sso", "password", "own-hash", member, "password"},
		{"same-address-new-account", "password", "new-hash", member, "password"},
		{"failed-link-row", "password", "own-hash", member, "password"},
		{"provider-made", "oidc", "", member, "oidc"},
		{"provider-made-reset", "oidc", "reset-hash", member, "oidc"},
		{"admin", "password", "admin-hash", member, "password"},
	}
	for _, a := range accounts {
		exec(`INSERT INTO auth_users (id, name, email, role_id, password_hash, auth_source) VALUES ($1, $1, $2, $3, $4, $5)`,
			a.id, a.id+"@example.com", a.role, a.hash, a.source)
	}
	audit := `INSERT INTO auth_audit_logs (service, action, actor_user_id, actor_email, target_user_id, target_email, target_type, target_id, after, result)
	          VALUES ('auth', $1, $2, $3, $2, $3, 'user', $2, $4::text::jsonb, $5)`
	exec(audit, "user.account.link", "linked-then-reset", "linked-then-reset@example.com", `{"method":"oidc","password_removed":true}`, "success")
	exec(audit, "user.password.reset", "linked-then-reset", "linked-then-reset@example.com", `{}`, "success")
	exec(audit, "user.login.success", "approved-also-sso", "approved-also-sso@example.com", `{"method":"oidc"}`, "success")
	// a linked account deleted since, its address taken by a new password account
	exec(audit, "user.account.link", "deleted-linked", "same-address-new-account@example.com", `{"method":"oidc","password_removed":true}`, "success")
	exec(audit, "user.account.link", "failed-link-row", "failed-link-row@example.com", `{"method":"oidc"}`, "failure")

	if _, err := p.UpTo(ctx, selfSignUpsVersion); err != nil {
		t.Fatalf("up to %d: %v", selfSignUpsVersion, err)
	}
	stored := func() map[string][2]string {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT id, auth_source, password_hash FROM auth_users`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		got := map[string][2]string{}
		for rows.Next() {
			var id, source, hash string
			if err := rows.Scan(&id, &source, &hash); err != nil {
				t.Fatal(err)
			}
			got[id] = [2]string{source, hash}
		}
		return got
	}
	check := func(when string) {
		t.Helper()
		got := stored()
		for _, a := range accounts {
			if got[a.id] != [2]string{a.want, a.hash} {
				t.Errorf("%s: %s is %v, want %s holding %q", when, a.id, got[a.id], a.want, a.hash)
			}
		}
	}
	check("after Up")

	type row struct {
		before, after string
	}
	migrationRows := func() map[string]row {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT target_user_id, target_email, target_type, target_id, before::text, after::text, result
		                                FROM auth_audit_logs WHERE actor_user_id = 'system' AND actor_email = 'migration'`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		got := map[string]row{}
		for rows.Next() {
			var id, email, kind, targetID, before, after, result string
			if err := rows.Scan(&id, &email, &kind, &targetID, &before, &after, &result); err != nil {
				t.Fatal(err)
			}
			if email != id+"@example.com" || kind != "user" || targetID != id || result != "success" {
				t.Errorf("row of %s: email %s, type %s, target_id %s, result %s", id, email, kind, targetID, result)
			}
			got[id] = row{before: before, after: after}
		}
		return got
	}
	rows := migrationRows()
	if len(rows) != 3 {
		t.Fatalf("migration rows = %v, want one for each moved account", rows)
	}
	for id, held := range map[string]bool{"linked": false, "linked-then-reset": true, "linked-still-waiting": false} {
		r, ok := rows[id]
		if !ok {
			t.Errorf("no migration row for %s", id)
			continue
		}
		var before, after map[string]any
		if err := json.Unmarshal([]byte(r.before), &before); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(r.after), &after); err != nil {
			t.Fatal(err)
		}
		if before["auth_source"] != "password" || after["auth_source"] != "oidc" ||
			after["reason"] != "self_sign_up_reached_by_provider" || after["password_held"] != held {
			t.Errorf("row of %s: before %v after %v, want password → oidc, password_held %v", id, before, after, held)
		}
	}
	var linkRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_audit_logs WHERE action = 'user.account.link'`).Scan(&linkRows); err != nil {
		t.Fatal(err)
	}

	if _, err := p.DownTo(ctx, selfSignUpsVersion-1); err != nil {
		t.Fatalf("down to %d: %v", selfSignUpsVersion-1, err)
	}
	if v, err := p.GetDBVersion(ctx); err != nil || v != selfSignUpsVersion-1 {
		t.Fatalf("version after Down = %d, %v; want %d", v, err, selfSignUpsVersion-1)
	}
	check("after Down")

	if _, err := p.UpTo(ctx, selfSignUpsVersion); err != nil {
		t.Fatalf("up again: %v", err)
	}
	check("after Up again")
	var again int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_audit_logs WHERE action = 'user.account.link'`).Scan(&again); err != nil {
		t.Fatal(err)
	}
	if again != linkRows {
		t.Errorf("user.account.link rows went from %d to %d on Up again, want none written", linkRows, again)
	}
}
