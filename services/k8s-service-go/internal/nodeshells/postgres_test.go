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
// had, a row in skip is not taken, Remove deletes only for the owner holding the row.
func TestPostgres_NodeShellRows(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	pg := PG{Pool: pool}
	for _, id := range []string{"live", "dead", "mine"} {
		if err := pg.Insert(ctx, pgRow(id)); err != nil {
			t.Fatal(err)
		}
	}
	silence(t, pool, "live", 2*staleAfter)
	silence(t, pool, "dead", 2*staleAfter)
	silence(t, pool, "mine", 2*staleAfter)
	found, err := pg.Beat(ctx, "a/1", []string{"live", "gone"})
	if err != nil || len(found) != 1 || found[0] != "live" {
		t.Fatalf("beat = %v %v, want [live]", found, err)
	}

	taken, err := pg.Take(ctx, "b/2", staleAfter, []string{"mine"}, takeBatch)
	if err != nil {
		t.Fatal(err)
	}
	if len(taken) != 1 || taken[0].ID != "dead" || taken[0].Owner != "a/1" || taken[0].Pod != "node-debugger-n1-dead" ||
		string(taken[0].Person) == "" || string(taken[0].Audit) == "" {
		t.Fatalf("taken %+v, want dead with its previous owner, person and audit", taken)
	}
	again, err := pg.Take(ctx, "c/3", staleAfter, nil, takeBatch)
	if err != nil || len(again) != 1 || again[0].ID != "mine" {
		t.Fatalf("second take = %+v %v, want only mine (dead was taken with a fresh heartbeat, live beat)", again, err)
	}

	if err := pg.Remove(ctx, "dead", "a/1"); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM node_shells WHERE id = 'dead'`).Scan(&n)
	if n != 1 {
		t.Fatal("Remove by the owner before the take deleted the row b holds")
	}
	if err := pg.Remove(ctx, "dead", "b/2"); err != nil {
		t.Fatal(err)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM node_shells WHERE id = 'dead'`).Scan(&n)
	if n != 0 {
		t.Fatal("Remove by the holder left the row")
	}
}

// Of many sweeps at once each silent row is taken by exactly one, and a row whose owner beats in between is taken by
// none.
func TestPostgres_OneTakerPerRow(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	pg := PG{Pool: pool}
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
				got, err := pg.Take(ctx, owner, staleAfter, nil, 4)
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
	a := NewTracker(PG{Pool: pool}, p.remover(), rows)
	b := NewTracker(PG{Pool: pool}, p.remover(), rows)
	for _, id := range []string{"beating", "silent"} {
		if err := a.Begin(ctx, Row{ID: id, Cluster: "self", Namespace: "kubeast-node-shell", Pod: "node-debugger-n1-" + id, Node: "n1"}, base("n1")); err != nil {
			t.Fatal(err)
		}
		p.exist[id] = true
	}
	a.Release("silent") // a no longer beats it, as a killed server would not
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
	if len(rows.all()) != 1 {
		t.Fatalf("audit rows %d, want 1", len(rows.all()))
	}
}
