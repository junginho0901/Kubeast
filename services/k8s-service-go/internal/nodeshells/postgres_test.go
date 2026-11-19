package nodeshells

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

// Runs against PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL (each test makes and drops its own database); skipped
// when unset.
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
	name := fmt.Sprintf("nodeshells_test_%d", time.Now().UnixNano())
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

// silence moves a row's heartbeat back by d, as if its owner had stopped then.
func silence(t *testing.T, pool *pgxpool.Pool, id string, d time.Duration) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE node_shells SET heartbeat_at = heartbeat_at - make_interval(secs => $2) WHERE id = $1`, id, d.Seconds()); err != nil {
		t.Fatal(err)
	}
}

func pgRow(id string) Row {
	return Row{ID: id, Cluster: "self", Namespace: "kubeast-node-shell", Pod: "node-debugger-n1-" + id, Node: "n1", Owner: "a/1",
		Person: json.RawMessage(`{"UserID":"u1","Email":"ops@example.com"}`), Audit: json.RawMessage(`{"Action":"k8s.session.end"}`)}
}

// The statements against PostgreSQL: a beating owner's row is not taken, a silent one is taken once with the owner it
// had, a row in skip is not taken, Claim and Remove answer for the holder only, Release marks the row and stops its
// beats, and Take says which rows are past the deadline by the database's clock.
func TestPostgres_NodeShellRows(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	pg := NewPG(pool)
	defer pg.Idle()
	for _, id := range []string{"live", "dead", "mine", "old"} {
		if err := pg.Insert(ctx, pgRow(id)); err != nil {
			t.Fatal(err)
		}
		silence(t, pool, id, 2*staleAfter)
	}
	if _, err := pool.Exec(ctx, `UPDATE node_shells SET opened_at = opened_at - make_interval(secs => 7200) WHERE id = 'old'`); err != nil {
		t.Fatal(err)
	}
	found, err := pg.Beat(ctx, "a/1", []string{"live", "gone"})
	if err != nil || len(found) != 1 || found[0] != "live" {
		t.Fatalf("beat = %v %v, want [live]", found, err)
	}

	taken, err := pg.Take(ctx, "b/2", staleAfter, time.Hour, []string{"mine"}, takeBatch)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]Row{}
	for _, r := range taken {
		byID[r.ID] = r
	}
	if len(taken) != 2 || byID["dead"].Owner != "a/1" || byID["dead"].Pod != "node-debugger-n1-dead" || byID["dead"].Expired ||
		string(byID["dead"].Person) == "" || string(byID["dead"].Audit) == "" || !byID["old"].Expired {
		t.Fatalf("taken %+v, want dead (not expired) and old (expired) with their previous owner, person and audit", taken)
	}
	again, err := pg.Take(ctx, "c/3", staleAfter, time.Hour, nil, takeBatch)
	if err != nil || len(again) != 1 || again[0].ID != "mine" {
		t.Fatalf("second take = %+v %v, want only mine", again, err)
	}

	if ok, err := pg.Claim(ctx, "dead", "a/1"); err != nil || ok {
		t.Fatalf("claim by the owner before the take = %v %v, want false", ok, err)
	}
	if ok, err := pg.Claim(ctx, "dead", "b/2"); err != nil || !ok {
		t.Fatalf("claim by the holder = %v %v, want true", ok, err)
	}
	if removed, err := pg.Remove(ctx, "dead", "a/1"); err != nil || removed {
		t.Fatalf("remove by the owner before the take = %v %v, want false", removed, err)
	}
	if removed, err := pg.Remove(ctx, "dead", "b/2"); err != nil || !removed {
		t.Fatalf("remove by the holder = %v %v, want true", removed, err)
	}

	if err := pg.Release(ctx, "live", "a/1"); err != nil {
		t.Fatal(err)
	}
	if found, err := pg.Beat(ctx, "a/1", []string{"live"}); err != nil || len(found) != 0 {
		t.Fatalf("beat of a released row = %v %v, want none", found, err)
	}
	silence(t, pool, "live", 2*staleAfter)
	rel, err := pg.Take(ctx, "b/2", staleAfter, time.Hour, nil, takeBatch)
	if err != nil || len(rel) != 1 || rel[0].ID != "live" || !rel[0].Released {
		t.Fatalf("take of the released row = %+v %v", rel, err)
	}
}

// The heartbeat goes over the connection the store holds: requests that take every other connection of the pool do
// not hold it back.
func TestPostgres_TheHeartbeatGoesOutWithThePoolFull(t *testing.T) {
	small := freshDB(t)
	cfg := small.Config().Copy()
	cfg.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	ctx := context.Background()
	pg := NewPG(pool)
	if err := pg.Insert(ctx, pgRow("s1")); err != nil { // takes the held connection
		t.Fatal(err)
	}
	busy, err := pool.Acquire(ctx) // the requests take the other
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Release()
	bctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	found, err := pg.Beat(bctx, "a/1", []string{"s1"})
	if err != nil || len(found) != 1 {
		t.Fatalf("beat with the pool full = %v %v, want it saved", found, err)
	}
	pg.Idle()
	if st := pool.Stat(); st.AcquiredConns() != 1 {
		t.Fatalf("acquired connections after Idle = %d, want 1 (the test's)", st.AcquiredConns())
	}
}

// Of many sweeps at once each silent row is taken by exactly one, and a row whose owner beats in between is taken by
// none.
func TestPostgres_OneTakerPerRow(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	pg := NewPG(pool)
	defer pg.Idle()
	const rows = 30
	for i := 0; i < rows; i++ {
		id := fmt.Sprintf("s%02d", i)
		if err := pg.Insert(ctx, pgRow(id)); err != nil {
			t.Fatal(err)
		}
		silence(t, pool, id, 2*staleAfter)
	}
	if _, err := pg.Beat(ctx, "a/1", []string{"s00"}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	takers := map[string][]string{}
	var wg sync.WaitGroup
	for w := 0; w < 6; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			owner := fmt.Sprintf("sweeper/%d", w)
			for {
				got, err := pg.Take(ctx, owner, staleAfter, time.Hour, nil, 4)
				if err != nil {
					t.Error(err)
					return
				}
				if len(got) == 0 {
					return
				}
				mu.Lock()
				for _, r := range got {
					takers[r.ID] = append(takers[r.ID], owner)
				}
				mu.Unlock()
			}
		}(w)
	}
	wg.Wait()
	if len(takers) != rows-1 {
		t.Fatalf("%d rows taken, want %d (all but the one that beat)", len(takers), rows-1)
	}
	if _, ok := takers["s00"]; ok {
		t.Fatal("the row whose owner beat was taken")
	}
	for id, by := range takers {
		if len(by) != 1 {
			t.Fatalf("row %s taken by %v", id, by)
		}
	}
}

// The tracker over PostgreSQL: a shell whose owner stopped is deleted by another server's sweep, a beating one is not.
func TestPostgres_SweepDeletesOnlyTheSilentShell(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	p := &pods{exist: map[string]bool{}}
	rows := &auditRows{}
	pgA, pgB := NewPG(pool), NewPG(pool)
	defer pgA.Idle()
	a := NewTracker(pgA, p.remover(), rows, time.Hour)
	b := NewTracker(pgB, p.remover(), rows, time.Hour)
	for _, id := range []string{"beating", "silent"} {
		if err := a.Begin(ctx, Row{ID: id, Cluster: "self", Namespace: "kubeast-node-shell", Pod: "node-debugger-n1-" + id, Node: "n1"}, base("n1"), nil); err != nil {
			t.Fatal(err)
		}
		p.exist[id] = true
	}
	// a stops beating "silent" as a killed server would: drop it from a's shells without telling the database
	a.mu.Lock()
	delete(a.active, "silent")
	a.mu.Unlock()
	silence(t, pool, "silent", 2*staleAfter)
	silence(t, pool, "beating", 2*staleAfter)
	a.beat(ctx)
	inContact(b)
	b.sweep(ctx)
	if got := p.gone(); len(got) != 1 || got[0] != "silent" {
		t.Fatalf("deleted %v, want [silent]", got)
	}
	var left []string
	r, _ := pool.Query(ctx, `SELECT id FROM node_shells ORDER BY id`)
	for r.Next() {
		var id string
		_ = r.Scan(&id)
		left = append(left, id)
	}
	r.Close()
	if len(left) != 1 || left[0] != "beating" {
		t.Fatalf("rows left %v, want [beating]", left)
	}
	if got := rows.reasons(); len(got) != 1 || got[0] != ReasonServerGone {
		t.Fatalf("end rows %v, want [server_gone]", got)
	}
}
