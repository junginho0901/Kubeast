package repository_test

import (
	"context"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
)

// MoveToSingleSignOn on the real schema asks the row again under its lock: it takes over a self sign-up waiting for
// approval (its password gone, its tokens ended, auth_source oidc) and one holding no password (its tokens kept), and
// leaves alone an account an admin made, Pending or not, a self sign-up an admin approved while it held a password and
// an account the provider made. A second statement for an account it took over, as from a sign-in that overlapped the
// first, changes nothing.
func TestPostgresMoveToSingleSignOnTakesOverOnlyASelfSignUp(t *testing.T) {
	pool := migratedDatabase(t)
	ctx := context.Background()
	repo := repository.New(pool)
	pending := roleID(t, pool, "Pending")
	member := roleID(t, pool, "Member")
	accounts := []struct {
		id, source, hash string
		role             int
		signedUp         bool
		after            string // auth_source afterwards
		keeps            bool   // the password stays
		version          int    // token_version afterwards
	}{
		{"waiting", "password", "signup-hash", pending, true, "oidc", false, 3},
		{"taken-over-before", "password", "", member, true, "oidc", true, 2},
		{"approved", "password", "own-hash", member, true, "password", true, 2},
		{"made-pending", "password", "made-hash", pending, false, "password", true, 2},
		{"made-holding-none", "password", "", member, false, "password", true, 2},
		{"provider-made", "oidc", "", pending, false, "oidc", true, 2},
	}
	for _, a := range accounts {
		exec(t, pool, `INSERT INTO auth_users (id, name, email, role_id, password_hash, auth_source, self_signed_up, token_version)
		               VALUES ($1, $1, $2, $3, $4, $5, $6, 2)`, a.id, a.id+"@example.com", a.role, a.hash, a.source, a.signedUp)
	}

	for _, c := range []struct {
		id   string
		want repository.SingleSignOnMove
	}{
		{"waiting", repository.SingleSignOnMove{Moved: true, PasswordRemoved: true, TokenVersion: 3}},
		{"taken-over-before", repository.SingleSignOnMove{Moved: true, TokenVersion: 2}},
		{"approved", repository.SingleSignOnMove{}},
		{"made-pending", repository.SingleSignOnMove{}},
		{"made-holding-none", repository.SingleSignOnMove{}},
		{"provider-made", repository.SingleSignOnMove{}},
		{"waiting", repository.SingleSignOnMove{}}, // again, as an overlapping sign-in
		{"no-such-account", repository.SingleSignOnMove{}},
	} {
		move, err := repo.MoveToSingleSignOn(ctx, c.id)
		if err != nil || move != c.want {
			t.Errorf("%s: %+v, %v; want %+v", c.id, move, err, c.want)
		}
	}

	for _, a := range accounts {
		var source, hash string
		var version int
		if err := pool.QueryRow(ctx, `SELECT auth_source, password_hash, token_version FROM auth_users WHERE id = $1`, a.id).Scan(&source, &hash, &version); err != nil {
			t.Fatal(err)
		}
		wantHash := ""
		if a.keeps {
			wantHash = a.hash
		}
		if source != a.after || hash != wantHash || version != a.version {
			t.Errorf("%s: auth_source %s, password %q, token_version %d; want %s, %q, %d", a.id, source, hash, version, a.after, wantHash, a.version)
		}
	}
}
