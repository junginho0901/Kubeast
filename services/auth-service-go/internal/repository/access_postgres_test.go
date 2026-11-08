package repository_test

import (
	"context"
	"fmt"
	"maps"
	"net/url"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/accessreview"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

// Runs against the PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL (the CI
// dbmigrate job; skipped when unset): a throwaway database with the real
// migrations, the access request list and its count, the sign-off list, and
// the access review's dormant accounts next to the ones the lock takes.
const testDatabaseURLEnv = "DBMIGRATE_TEST_DATABASE_URL"

func migratedDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv(testDatabaseURLEnv)
	if raw == "" {
		t.Skipf("%s not set: needs a PostgreSQL server", testDatabaseURLEnv)
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	name := fmt.Sprintf("access_repo_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	u, _ := url.Parse(raw)
	u.Path = "/" + name
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
		admin.Close(ctx)
	})
	if _, err := dbmigrate.Up(ctx, pool); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	return pool
}

func exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func roleID(t *testing.T, pool *pgxpool.Pool, name string, perms ...string) int {
	t.Helper()
	var id int
	if err := pool.QueryRow(context.Background(), `INSERT INTO roles (name) VALUES ($1) RETURNING id`, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	for _, p := range perms {
		exec(t, pool, `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`, id, p)
	}
	return id
}

func TestPostgresAccessRequestPagesAndSearch(t *testing.T) {
	pool := migratedDatabase(t)
	ctx := context.Background()
	repo := repository.New(pool)
	member := roleID(t, pool, "t-member")
	write := roleID(t, pool, "t-write", "resource.pod.delete")
	exec(t, pool, `INSERT INTO clusters (id, display_name, mode) VALUES ('c1', 'Prod One', 'external')`)
	exec(t, pool, `INSERT INTO auth_users (id, name, email, password_hash, role_id) VALUES
	  ('u1', 'Alice Kim', 'alice@example.com', 'x', $1), ('u2', 'Bob', 'bob@example.com', 'x', $1), ('d1', 'Dee', 'decider@example.com', 'x', $1)`, member)
	t0 := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	// id, user, status, reason, decided by, minutes after t0 (r3 and r4 share one instant)
	rows := []struct {
		id, user, status, reason, decider string
		at                                int
	}{
		{"r1", "u1", "rejected", "deploy hotfix", "d1", 0},
		{"r2", "u2", "approved", "100% rollout", "d1", 1},
		{"r3", "u1", "cancelled", "a_b test", "", 2},
		{"r4", "u2", "expired", "axb test", "", 2},
		{"r5", "u1", "pending", "deploy again", "", 3},
	}
	for _, r := range rows {
		var decider any
		if r.decider != "" {
			decider = r.decider
		}
		exec(t, pool, `INSERT INTO access_requests (id, user_id, cluster_id, role_id, duration_minutes, reason, status, created_at, decided_by)
		  VALUES ($1, $2, 'c1', $3, 30, $4, $5, $6, $7)`, r.id, r.user, write, r.reason, r.status, t0.Add(time.Duration(r.at)*time.Minute), decider)
	}
	ids := func(list []repository.AccessRequest) []string {
		out := []string{}
		for _, a := range list {
			out = append(out, a.ID)
		}
		return out
	}
	list := func(f repository.AccessRequestFilter) ([]string, int) {
		t.Helper()
		items, err := repo.ListAccessRequests(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		n, err := repo.CountAccessRequests(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		return ids(items), n
	}

	// History: every request no longer pending, two at a time, each once in a fixed order.
	var pages []string
	for off := 0; off < 6; off += 2 {
		got, n := list(repository.AccessRequestFilter{Status: repository.AccessRequestsDecided, Limit: 2, Offset: off})
		if n != 4 {
			t.Errorf("decided total at offset %d = %d, want 4", off, n)
		}
		pages = append(pages, got...)
	}
	if want := []string{"r4", "r3", "r2", "r1"}; !slices.Equal(pages, want) {
		t.Errorf("decided pages = %v, want %v (newest first, the id after the time)", pages, want)
	}
	if got, n := list(repository.AccessRequestFilter{Status: repository.AccessRequestPending, Limit: 50}); !slices.Equal(got, []string{"r5"}) || n != 1 {
		t.Errorf("pending = %v (%d)", got, n)
	}
	if got, n := list(repository.AccessRequestFilter{Limit: 50}); len(got) != 5 || n != 5 {
		t.Errorf("all = %v (%d)", got, n)
	}

	// The search: text, any case, in the fields the page shows.
	for _, c := range []struct {
		q    string
		want []string
	}{
		{"DEPLOY", []string{"r1"}},          // reason, decided only
		{"alice kim", []string{"r3", "r1"}}, // requester name
		{"BOB@", []string{"r4", "r2"}},      // requester email
		{"prod one", []string{"r4", "r3", "r2", "r1"}},
		{"c1", []string{"r4", "r3", "r2", "r1"}}, // cluster id
		{"T-WRITE", []string{"r4", "r3", "r2", "r1"}},
		{"decider@", []string{"r2", "r1"}}, // decider email
		{"0%", []string{"r2"}},             // "%" is text
		{"a_b", []string{"r3"}},            // "_" is text
		{"nobody", []string{}},
	} {
		got, n := list(repository.AccessRequestFilter{Status: repository.AccessRequestsDecided, Query: c.q, Limit: 50})
		if !slices.Equal(got, c.want) || n != len(c.want) {
			t.Errorf("q=%q: %v (%d), want %v", c.q, got, n, c.want)
		}
	}

	since, err := repo.CountAccessRequestsSince(ctx, t0.Add(2*time.Minute))
	if err != nil || since != 3 {
		t.Errorf("requests since t0+2m = %d, %v; want 3", since, err)
	}
	listed, err := repo.ListAccessRequestsSince(ctx, t0, 2)
	if err != nil || !slices.Equal(ids(listed), []string{"r5", "r4"}) {
		t.Errorf("newest 2 since t0 = %v, %v", ids(listed), err)
	}
}

func TestPostgresAccessReviewPages(t *testing.T) {
	pool := migratedDatabase(t)
	ctx := context.Background()
	repo := repository.New(pool)
	t0 := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	for i, id := range []string{"a", "b", "c", "d", "e"} {
		at := t0.Add(time.Duration(i/2) * time.Hour) // a,b · c,d · e
		exec(t, pool, `INSERT INTO access_reviews (id, reviewed_by_email, reviewed_at) VALUES ($1, 'r@example.com', $2)`, id, at)
	}
	var got []string
	for off := 0; off < 6; off += 2 {
		page, err := repo.ListAccessReviews(ctx, 2, off)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range page {
			got = append(got, r.ID)
		}
	}
	if want := []string{"e", "d", "c", "b", "a"}; !slices.Equal(got, want) {
		t.Errorf("sign-off pages = %v, want %v", got, want)
	}
	if n, err := repo.CountAccessReviews(ctx); err != nil || n != 5 {
		t.Errorf("sign-offs = %d, %v", n, err)
	}
	if last, err := repo.LastAccessReview(ctx); err != nil || last == nil || last.ID != "e" {
		t.Errorf("last = %+v, %v", last, err)
	}
}

// The report's dormant accounts are the ones the lock takes: with the admin
// exemption the lock takes the dormant accounts not flagged lock_exempt,
// without it the rest; the report still counts them all after.
func TestPostgresDormantIsWhatTheLockTakes(t *testing.T) {
	pool := migratedDatabase(t)
	ctx := context.Background()
	repo := repository.New(pool)
	star := roleID(t, pool, "t-star", "*")
	audit := roleID(t, pool, "t-audit", "admin.audit.read")
	member := roleID(t, pool, "t-member2")
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	days := func(n int) time.Time { return now.AddDate(0, 0, -n) }
	users := []struct {
		id      string
		role    int
		created time.Time
		login   *time.Time
	}{
		{"admin-old", star, days(300), ptr(days(200))},
		{"auditor-old", audit, days(300), ptr(days(200))},
		{"key-only", member, days(200), nil},
		{"old-key", member, days(300), ptr(days(200))},
		{"expired-key-recent", member, days(300), ptr(days(200))},
		{"fresh", member, days(3), nil},
		{"stale", member, days(200), nil},
		{"active", member, days(300), ptr(days(1))},
	}
	for _, u := range users {
		exec(t, pool, `INSERT INTO auth_users (id, name, email, password_hash, role_id, created_at, last_login_at) VALUES ($1, $1, $2, 'x', $3, $4, $5)`,
			u.id, u.id+"@example.com", u.role, u.created, u.login)
	}
	keys := []struct {
		id, user string
		expires  time.Time
		used     *time.Time
	}{
		{"k1", "key-only", now.AddDate(0, 0, 30), ptr(now.Add(-time.Hour))},
		{"k2", "old-key", now.AddDate(0, 0, 30), ptr(days(120))},
		{"k3", "expired-key-recent", days(1), ptr(days(10))},
		{"k4", "old-key", now.AddDate(0, 0, 30), nil},
	}
	for _, k := range keys {
		exec(t, pool, `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, expires_at, last_used_at, created_at) VALUES ($1, $2, $1, $1, $1, $3, $4, $5)`,
			k.id, k.user, k.expires, k.used, days(300))
	}
	settings := accessreview.Settings{DormantDays: 90, LockEnabled: true, LockDays: 90, LockExemptAdmins: true}
	report := func() *accessreview.Report {
		t.Helper()
		var in accessreview.Input
		var err error
		if in.Users, err = repo.ListUsersForReview(ctx); err != nil {
			t.Fatal(err)
		}
		if in.Keys, err = repo.ListAPIKeysForReview(ctx); err != nil {
			t.Fatal(err)
		}
		if in.Roles, err = repo.ListRoles(ctx); err != nil {
			t.Fatal(err)
		}
		return accessreview.Build(now, settings, now, in)
	}
	withFlag := func(rep *accessreview.Report, flag string) []string {
		out := []string{}
		for _, u := range rep.Users {
			if slices.Contains(u.Flags, flag) {
				out = append(out, u.Name)
			}
		}
		slices.Sort(out)
		return out
	}
	lock := func(exempt bool) []string {
		t.Helper()
		locked, err := repo.LockDormantAccounts(ctx, days(90), now, exempt)
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, d := range locked {
			out = append(out, d.UserID)
		}
		slices.Sort(out)
		return out
	}

	before := report()
	dormant := withFlag(before, accessreview.FlagDormant)
	exempt := withFlag(before, accessreview.FlagLockExempt)
	if want := []string{"admin-old", "auditor-old", "old-key", "stale"}; !slices.Equal(dormant, want) {
		t.Fatalf("report dormant = %v, want %v", dormant, want)
	}
	if want := []string{"admin-old", "auditor-old"}; !slices.Equal(exempt, want) {
		t.Errorf("report lock_exempt = %v, want %v", exempt, want)
	}
	if want := []string{"expired-key-recent", "key-only"}; !slices.Equal(withFlag(before, accessreview.FlagAPIKeyOnly), want) {
		t.Errorf("report api_key_only = %v, want %v", withFlag(before, accessreview.FlagAPIKeyOnly), want)
	}
	if got, want := lock(true), []string{"old-key", "stale"}; !slices.Equal(got, want) {
		t.Errorf("the lock with the exemption took %v, want the dormant ones not lock_exempt %v", got, want)
	}
	if got := lock(false); !slices.Equal(got, exempt) {
		t.Errorf("the lock without the exemption then took %v, want %v", got, exempt)
	}
	after := report()
	if got := withFlag(after, accessreview.FlagDormant); !slices.Equal(got, dormant) || after.Summary.Dormant != len(dormant) {
		t.Errorf("after the locks the report counts %v (%d), want %v", got, after.Summary.Dormant, dormant)
	}
	if got := withFlag(after, accessreview.FlagDormantLocked); !slices.Equal(got, dormant) {
		t.Errorf("dormant_locked = %v, want %v", got, dormant)
	}
}

func ptr(t time.Time) *time.Time { return &t }

// Deleting a cluster takes its grants with it (ON DELETE CASCADE), so it ends the tokens that carry them, as every
// other change of a grant does: a cluster registered again under the same name is not reached with the old role.
func TestPostgresDeletingAClusterEndsTheTokensOfItsGrants(t *testing.T) {
	pool := migratedDatabase(t)
	ctx := context.Background()
	repo := repository.New(pool)
	role := roleID(t, pool, "t-granted", "resource.*.read")
	exec(t, pool, `INSERT INTO clusters (id, display_name, mode) VALUES ('c1', 'One', 'external'), ('c2', 'Two', 'external')`)
	users := []string{"on-c1", "on-both", "on-c2", "none"}
	for _, id := range users {
		exec(t, pool, `INSERT INTO auth_users (id, name, email, password_hash, role_id) VALUES ($1, $1, $2, 'x', $3)`, id, id+"@example.com", role)
	}
	exec(t, pool, `INSERT INTO user_cluster_roles (user_id, cluster_id, role_id) VALUES ('on-c1', 'c1', $1), ('on-both', 'c1', $1), ('on-both', 'c2', $1), ('on-c2', 'c2', $1)`, role)

	if err := cluster.NewPostgresRegistry(pool, nil).Remove(ctx, "c1", nil); err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, id := range users {
		v, err := repo.GetTokenVersion(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		got[id] = v
	}
	if want := map[string]int{"on-c1": 1, "on-both": 1, "on-c2": 0, "none": 0}; !maps.Equal(got, want) {
		t.Errorf("token versions %v, want %v", got, want)
	}
	rows, err := pool.Query(ctx, `SELECT user_id || '@' || cluster_id FROM user_cluster_roles ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	left, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(left, []string{"on-both@c2", "on-c2@c2"}) {
		t.Errorf("grants left %v", left)
	}
}

func TestPostgresRoleEditEndsTheTokensItNames(t *testing.T) {
	pool := migratedDatabase(t)
	ctx := context.Background()
	repo := repository.New(pool)
	held := roleID(t, pool, "t-held", "resource.*.read")
	other := roleID(t, pool, "t-other")
	exec(t, pool, `INSERT INTO clusters (id, display_name, mode) VALUES ('c1', 'One', 'external'), ('c2', 'Two', 'external')`)
	for id, role := range map[string]int{"granted": other, "global": held, "both": held, "neither": other} {
		exec(t, pool, `INSERT INTO auth_users (id, name, email, password_hash, role_id) VALUES ($1, $1, $2, 'x', $3)`, id, id+"@example.com", role)
	}
	exec(t, pool, `INSERT INTO user_cluster_roles (user_id, cluster_id, role_id) VALUES ('granted', 'c1', $1), ('both', 'c1', $1), ('both', 'c2', $1)`, held)

	versions := func() map[string]int {
		got := map[string]int{}
		for _, id := range []string{"granted", "global", "both", "neither"} {
			v, err := repo.GetTokenVersion(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			got[id] = v
		}
		return got
	}
	for _, c := range []struct {
		tokens repository.RoleTokens
		want   map[string]int
	}{
		{repository.RoleTokensKept, map[string]int{"granted": 0, "global": 0, "both": 0, "neither": 0}},
		{repository.RoleTokensOfGrants, map[string]int{"granted": 1, "global": 0, "both": 1, "neither": 0}},
		{repository.RoleTokensOfAllHolders, map[string]int{"granted": 2, "global": 1, "both": 2, "neither": 0}},
	} {
		if _, err := repo.UpdateRole(ctx, held, "t-held", "edited", []string{"resource.*.read"}, c.tokens); err != nil {
			t.Fatal(err)
		}
		if got := versions(); !maps.Equal(got, c.want) {
			t.Errorf("%v: versions %v, want %v", c.tokens, got, c.want)
		}
	}
}
