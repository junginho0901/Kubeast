package dbmigrate

import (
	"context"
	"errors"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// On a real database: the write probe keeps no row; a table that refuses rows
// (here a trigger) while the database still answers pings makes Guarded refuse
// after the first failed write, and lets actions through again once rows land.
func TestPostgresAuditWriteProbe(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()
	if _, err := Up(ctx, pool); err != nil {
		t.Fatalf("Up: %v", err)
	}
	store := audit.NewPostgresStore(pool, audit.ServiceK8s)
	count := func() int {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_audit_logs`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if err := store.ProbeWrite(ctx); err != nil || count() != 0 {
		t.Fatalf("probe: %v, rows %d (keeps none)", err, count())
	}

	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit table refuses rows'; END $$;
		CREATE TRIGGER refuse_audit BEFORE INSERT ON auth_audit_logs FOR EACH ROW EXECUTE FUNCTION refuse_audit();`); err != nil {
		t.Fatal(err)
	}
	g := audit.Guard(store, store, true)
	if err := g.Ready(ctx); err != nil {
		t.Fatalf("before any write the ping passes: %v", err)
	}
	if _, err := g.Write(ctx, audit.Record{Action: "k8s.pod.delete"}); err == nil {
		t.Fatal("the trigger refuses the row")
	}
	if err := g.Ready(ctx); !errors.Is(err, audit.ErrUnavailable) {
		t.Fatalf("after the failed write: %v", err)
	}

	if _, err := pool.Exec(ctx, `DROP TRIGGER refuse_audit ON auth_audit_logs`); err != nil {
		t.Fatal(err)
	}
	fresh := audit.Guard(store, store, true) // a new wrapper: no cached probe
	if _, err := fresh.Write(ctx, audit.Record{Action: "k8s.pod.delete"}); err != nil || count() != 1 {
		t.Fatalf("rows land again: %v rows %d", err, count())
	}
	if err := fresh.Ready(ctx); err != nil {
		t.Fatalf("ready: %v", err)
	}
}
