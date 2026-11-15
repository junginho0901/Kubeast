package auditchain

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

// Runs the anchor lock against PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL
// (same variable as services/pkg/dbmigrate; skipped when unset): a throwaway
// database migrated with the real migrations, one pool per replica.
const testDatabaseURLEnv = "DBMIGRATE_TEST_DATABASE_URL"

func freshMigratedDatabaseURL(t *testing.T) string {
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
	name := fmt.Sprintf("auditchain_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	u, _ := url.Parse(raw)
	u.Path = "/" + name
	t.Cleanup(func() {
		_, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
		admin.Close(ctx)
	})
	pool := newPool(t, u.String())
	if _, err := dbmigrate.Up(ctx, pool); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	return u.String()
}

func newPool(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestPostgresReplicasWriteOneAnchorAPeriodEachOnTheOneBefore(t *testing.T) {
	dsn := freshMigratedDatabaseURL(t)
	ctx := context.Background()
	pools := []*pgxpool.Pool{newPool(t, dsn), newPool(t, dsn)}
	if _, err := pools[0].Exec(ctx, `INSERT INTO auth_audit_logs (service, action) SELECT 'auth', 'user.login.success' FROM generate_series(1, 5)`); err != nil {
		t.Fatal(err)
	}
	if n, _, err := (PG{Pool: pools[0]}).SealBatch(ctx, 100); err != nil || n != 5 {
		t.Fatalf("sealed %d err = %v", n, err)
	}
	objects := &slowObjects{fakeObjects: newFakeObjects()}
	// A second later on every call.
	var seconds atomic.Int64
	base := time.Date(2026, 11, 14, 3, 0, 0, 0, time.UTC)
	clock := func() time.Time { return base.Add(time.Duration(seconds.Add(1)) * time.Second) }
	replicas := []*Anchorer{
		{Store: PG{Pool: pools[0]}, Objects: objects, Sink: "archive", Now: clock},
		{Store: PG{Pool: pools[1]}, Objects: objects, Sink: "archive", Now: clock},
	}
	day := 24 * time.Hour
	anchors := func() []Anchor {
		t.Helper()
		rows, err := pools[0].Query(ctx, `SELECT `+anchorColumns+` FROM audit_anchors ORDER BY id`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []Anchor
		for rows.Next() {
			a, err := scanAnchor(rows)
			if err != nil {
				t.Fatal(err)
			}
			out = append(out, a)
		}
		return out
	}

	// Both replicas tick at once: one anchor, the other replica writes nothing.
	wrote := make([]bool, 2)
	at(func() {
		_, w, err := replicas[0].RunOnce(ctx, day)
		if err != nil {
			t.Error(err)
		}
		wrote[0] = w
	}, func() {
		_, w, err := replicas[1].RunOnce(ctx, day)
		if err != nil {
			t.Error(err)
		}
		wrote[1] = w
	})
	if got := anchors(); len(got) != 1 || wrote[0] == wrote[1] {
		t.Fatalf("anchors = %d, wrote = %v; want one anchor by one replica", len(got), wrote)
	}
	writer, other := replicas[0], replicas[1]
	if wrote[1] {
		writer, other = replicas[1], replicas[0]
	}
	// The other replica's next tick finds the period anchored; the writer's
	// next one writes on its own anchor.
	if _, w, err := other.RunOnce(ctx, day); err != nil || w {
		t.Fatalf("the other replica: wrote = %v err = %v", w, err)
	}
	if _, w, err := writer.RunOnce(ctx, day); err != nil || !w {
		t.Fatalf("the writer: wrote = %v err = %v", w, err)
	}
	// "Anchor now" on the other replica while the writer anchors: both, one
	// after the other.
	at(func() {
		if _, w, err := writer.RunOnce(ctx, day); err != nil || !w {
			t.Errorf("the writer: wrote = %v err = %v", w, err)
		}
	}, func() {
		if _, err := other.AnchorOnce(ctx, "admin@example.com"); err != nil {
			t.Errorf("anchor now: %v", err)
		}
	})
	got := anchors()
	if len(got) != 4 {
		t.Fatalf("anchors = %d, want 4: %+v", len(got), got)
	}
	assertLinear(t, got)

	// The integrity screen's verification agrees with every anchor and digest.
	rep, err := Verifier{Store: PG{Pool: pools[0]}, Objects: objects}.Verify(ctx, 1, 5, true)
	if err != nil || !rep.OK || len(rep.Anchors) != 4 {
		t.Fatalf("verify = %+v err = %v", rep, err)
	}
	for _, c := range rep.Anchors {
		if !c.HeadOK || c.ObjectOK == nil || !*c.ObjectOK {
			t.Errorf("anchor %d check = %+v", c.ID, c)
		}
	}
}

// An anchor's transaction waits for the lock and runs past the session limits each service's connections carry
// (postgresql.sessionLimits): another replica holds the lock through its upload. The limits it sets end with it.
func TestPostgresTheAnchorLockWaitsPastTheSessionLimits(t *testing.T) {
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(freshMigratedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 1
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = "15s"
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "30s"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var lockIn, statementIn string
	err = PG{Pool: pool}.AnchorLocked(ctx, func(s Store) error {
		return s.(PG).tx.QueryRow(ctx, `SELECT current_setting('lock_timeout'), current_setting('statement_timeout')`).Scan(&lockIn, &statementIn)
	})
	if err != nil {
		t.Fatalf("AnchorLocked: %v", err)
	}
	if lockIn != anchorLockWait || statementIn != anchorLockWait {
		t.Fatalf("in the anchor's transaction lock_timeout %s, statement_timeout %s, want %s for both", lockIn, statementIn, anchorLockWait)
	}
	var lockAfter, statementAfter string
	if err := pool.QueryRow(ctx, `SELECT current_setting('lock_timeout'), current_setting('statement_timeout')`).Scan(&lockAfter, &statementAfter); err != nil {
		t.Fatal(err)
	}
	if lockAfter != "15s" || statementAfter != "30s" {
		t.Fatalf("after the anchor's transaction the connection has lock_timeout %s, statement_timeout %s, want its own 15s and 30s", lockAfter, statementAfter)
	}
}
