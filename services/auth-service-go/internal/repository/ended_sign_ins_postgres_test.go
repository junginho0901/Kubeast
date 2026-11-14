package repository_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
)

// The signed-out sign-ins on the real schema: the end is stored once, a user who is gone ends nothing, the session state
// statement every service runs lists a user's own and no one else's, the cleanup deletes only what ended more than keep
// ago, batch by batch, and a deleted user takes its rows along.
func TestPostgresEndedSignIns(t *testing.T) {
	pool := migratedDatabase(t)
	ctx := context.Background()
	repo := repository.New(pool)
	role := roleID(t, pool, "e2e-ended")
	for _, id := range []string{"u1", "u2"} {
		exec(t, pool, `INSERT INTO auth_users (id, name, email, role_id, password_hash, token_version) VALUES ($1, $1, $1 || '@example.com', $2, 'x', 3)`, id, role)
	}

	for range 2 {
		if err := repo.EndSignIn(ctx, "u1", 1763100042); err != nil {
			t.Fatalf("end: %v", err)
		}
	}
	if err := repo.EndSignIn(ctx, "u1", 1763100000); err != nil {
		t.Fatal(err)
	}
	if err := repo.EndSignIn(ctx, "u2", 1763100500); err != nil {
		t.Fatal(err)
	}
	state, err := repo.SessionStateFor(ctx, "u1", "")
	if err != nil || state.Version != 3 || !slices.Equal(state.SignedOut, []int64{1763100000, 1763100042}) {
		t.Fatalf("u1 = %+v, %v", state, err)
	}
	if none, err := repo.SessionStateFor(ctx, "u3", ""); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("a user who is gone: %+v, %v", none, err)
	}
	if err := repo.EndSignIn(ctx, "nobody", 1); err != nil {
		t.Fatalf("a user who is gone has nothing to end: %v", err)
	}

	// Two of the three ended long ago.
	exec(t, pool, `UPDATE ended_sign_ins SET ended_at = NOW() - INTERVAL '2 hours' WHERE auth_time IN (1763100000, 1763100500)`)
	if n, err := repo.DeleteEndedSignIns(ctx, time.Hour, 1); err != nil || n != 1 {
		t.Fatalf("first batch: %d, %v", n, err)
	}
	if n, err := repo.DeleteEndedSignIns(ctx, time.Hour, 1); err != nil || n != 1 {
		t.Fatalf("second batch: %d, %v", n, err)
	}
	if n, err := repo.DeleteEndedSignIns(ctx, time.Hour, 1); err != nil || n != 0 {
		t.Fatalf("nothing old is left: %d, %v", n, err)
	}
	if state, err := repo.SessionStateFor(ctx, "u1", ""); err != nil || !slices.Equal(state.SignedOut, []int64{1763100042}) {
		t.Fatalf("u1 after the cleanup = %+v, %v", state, err)
	}
	if state, err := repo.SessionStateFor(ctx, "u2", ""); err != nil || len(state.SignedOut) != 0 {
		t.Fatalf("u2 after the cleanup = %+v, %v", state, err)
	}

	exec(t, pool, `DELETE FROM auth_users WHERE id = 'u1'`)
	var left int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM ended_sign_ins`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("rows of a deleted user: %d, %v", left, err)
	}
}
