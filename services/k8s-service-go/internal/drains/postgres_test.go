package drains

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

// Runs against PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL (each test makes
// and drops its own database); skipped when unset.
func freshDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("DBMIGRATE_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("DBMIGRATE_TEST_DATABASE_URL not set: needs a PostgreSQL server")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("drains_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(raw)
	u.Path = "/" + name
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
		admin.Close(ctx)
	})
	if _, err := dbmigrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

// stopBeats moves a drain's heartbeat back by d, as if its owner had stopped then.
func stopBeats(t *testing.T, pool *pgxpool.Pool, id string, d time.Duration) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE node_drains SET heartbeat_at = heartbeat_at - make_interval(secs => $2) WHERE id = $1`, id, d.Seconds()); err != nil {
		t.Fatal(err)
	}
}

// Two servers on one database: the other server reads the progress; the owner stops beating, the
// other reads it as interrupted with one finished row, and the owner, back, stops the drain and
// cannot end it over that.
func TestPostgresTwoServersShareADrainAndItsInterruption(t *testing.T) {
	pool := freshDB(t)
	rows := &auditRows{}
	a, b := NewTracker(PG{pool}, rows), NewTracker(PG{pool}, rows)
	running := begin(t, a, "d1", "n1")
	total, done := 3, 2
	msg := "evicting"
	a.Progress("d1", Progress{Status: StatusDraining, Message: &msg, PodsTotal: &total, PodsDone: &done})
	r := status(t, b, "d1")
	if r.Status != StatusDraining || r.Message != "evicting" || *r.PodsTotal != 3 || *r.PodsDone != 2 || r.Cluster != "self" ||
		r.UserEmail != "ops@example.com" || !r.Open() || r.Stale {
		t.Fatalf("server b reads %+v", r)
	}
	a.beat(context.Background())
	stopBeats(t, pool, "d1", a.staleAfter-time.Second)
	inContact(b)
	if r := status(t, b, "d1"); r.Status != StatusDraining {
		t.Fatalf("before the stale time: %+v", r)
	}
	stopBeats(t, pool, "d1", 2*time.Second)
	if r := status(t, b, "d1"); r.Status != StatusInterrupted || r.Message != MessageOwnerGone || r.Open() {
		t.Fatalf("past the stale time: %+v", r)
	}
	got := rows.all()
	if len(got) != 1 || got[0].ActorUserID != "u1" || got[0].RequestIP != "10.0.0.9" || got[0].Result != audit.ResultFailure {
		t.Fatalf("finished rows %+v", got)
	}
	a.beat(context.Background())
	select {
	case <-running.Done():
	default:
		t.Fatal("the owner did not stop the drain another server marked")
	}
	if a.Finish("d1", StatusSuccess, "drain completed") || len(rows.all()) != 1 {
		t.Fatal("the owner wrote an end over interrupted")
	}
}

// Servers mark one stale drain at the same moment, some reading its status and some sweeping:
// PostgreSQL lets one UPDATE take it, so one finished row.
func TestPostgresOneTakerWhenServersMarkAtOnce(t *testing.T) {
	pool := freshDB(t)
	rows := &auditRows{}
	begin(t, NewTracker(PG{pool}, rows), "d1", "n1")
	stopBeats(t, pool, "d1", time.Minute)

	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range 12 {
		tr := NewTracker(PG{pool}, rows)
		inContact(tr)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if i%2 == 0 {
				tr.sweep(context.Background())
				return
			}
			if r, err := tr.Status(context.Background(), "d1"); err != nil || r == nil || r.Status != StatusInterrupted {
				t.Errorf("reader %d: %+v %v", i, r, err)
			}
		}()
	}
	close(start)
	wg.Wait()
	if got := rows.all(); len(got) != 1 {
		t.Fatalf("%d finished rows, want 1", len(got))
	}
}

// An owner's beat and another server's mark at the same moment: the drain ends interrupted with
// its owner stopped, or stays open and beating — never interrupted while its owner goes on.
func TestPostgresABeatAndAMarkAtOnceAgree(t *testing.T) {
	pool := freshDB(t)
	for i := range 10 {
		id := fmt.Sprintf("d%d", i)
		a, b := NewTracker(PG{pool}, nil), NewTracker(PG{pool}, nil)
		running := begin(t, a, id, "n1")
		stopBeats(t, pool, id, a.staleAfter+time.Second)
		inContact(b)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); a.beat(context.Background()) }()
		go func() { defer wg.Done(); b.sweep(context.Background()) }()
		wg.Wait()
		r := status(t, b, id)
		stopped := running.Err() != nil
		if (r.Status == StatusInterrupted) != stopped {
			t.Fatalf("%s: row %s, owner stopped %v", id, r.Status, stopped)
		}
	}
}

// A server that has just reached the database (a restarted one, or any after a pause of the database)
// reads a stale drain as it is and only checks the database in its sweep; once its calls have answered
// for the stale time it marks the drain.
func TestPostgresAServerJudgesOnlyAfterItsOwnContact(t *testing.T) {
	pool := freshDB(t)
	rows := &auditRows{}
	begin(t, NewTracker(PG{pool}, rows), "d1", "n1")
	stopBeats(t, pool, "d1", time.Minute)
	b := NewTracker(PG{pool}, rows)
	if r := status(t, b, "d1"); r.Status != StatusPending || !r.Open() || !r.Stale {
		t.Fatalf("a server just in contact reads %+v", r)
	}
	b.sweep(context.Background())
	if r, _ := (PG{pool}).Get(context.Background(), "d1", b.staleAfter); r == nil || !r.Open() || len(rows.all()) != 0 {
		t.Fatalf("the sweep of a server just in contact marked %+v", r)
	}
	inContact(b)
	if r := status(t, b, "d1"); r.Status != StatusInterrupted || len(rows.all()) != 1 {
		t.Fatalf("a server in contact for the stale time reads %+v, %d rows", r, len(rows.all()))
	}
}

// Shutdown marks only this server's drains; old finished rows go, open ones and recent ones stay.
func TestPostgresShutdownAndPurge(t *testing.T) {
	pool := freshDB(t)
	a, b := NewTracker(PG{pool}, nil), NewTracker(PG{pool}, nil)
	begin(t, a, "mine", "n1")
	begin(t, b, "theirs", "n2")
	begin(t, b, "old", "n3")
	b.Finish("old", StatusSuccess, "drain completed")
	a.Shutdown(context.Background())
	if r := status(t, b, "mine"); r.Status != StatusInterrupted || r.Message != MessageOwnerShutdown {
		t.Fatalf("this server's drain: %+v", r)
	}
	if r := status(t, a, "theirs"); r.Status != StatusPending {
		t.Fatalf("another server's drain: %+v", r)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE node_drains SET finished_at = finished_at - interval '25 hours' WHERE id = 'old'`); err != nil {
		t.Fatal(err)
	}
	b.purge(context.Background())
	var left []string
	rs, err := pool.Query(context.Background(), `SELECT id FROM node_drains ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	for rs.Next() {
		var id string
		_ = rs.Scan(&id)
		left = append(left, id)
	}
	rs.Close()
	if fmt.Sprint(left) != "[mine theirs]" {
		t.Fatalf("rows left %v, want [mine theirs]", left)
	}
}
