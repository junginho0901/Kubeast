package pglock

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Runs against PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL; skipped when unset. Advisory locks
// need no schema, so it uses that database as it is, with a key no other test takes.
func pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("DBMIGRATE_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("DBMIGRATE_TEST_DATABASE_URL not set: needs a PostgreSQL server")
	}
	p, err := pgxpool.New(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

// Of two processes one holds the lock and keeps it; when it gives the lock up (it stops, or its
// connection closes) the other takes it at its next try; one process alone holds it at once.
func TestPostgresOneProcessHoldsTheLock(t *testing.T) {
	p := pool(t)
	ctx := context.Background()
	const key int64 = 0x6b62746573746c6b
	a, b := New(p, key), New(p, key)
	t.Cleanup(a.Close)
	t.Cleanup(b.Close)
	if !a.Held(ctx) {
		t.Fatal("a process alone did not take the lock")
	}
	if b.Held(ctx) {
		t.Fatal("a second process took a held lock")
	}
	if !a.Held(ctx) || b.Held(ctx) {
		t.Fatal("the holder lost the lock, or the other took it, with nothing changed")
	}
	// the holder's connection goes (a process killed): the server releases the lock
	if err := a.conn.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if !b.Held(ctx) {
		t.Fatal("the other process did not take the lock its holder gave up")
	}
	if a.Held(ctx) {
		t.Fatal("the old holder took the lock back while the other holds it")
	}
	b.Close()
	if !a.Held(ctx) {
		t.Fatal("the lock was not free after its holder closed it")
	}
}
