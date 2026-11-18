package dbmigrate

import (
	"context"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// On a real database: a window written with an offset finds the rows of the instants it names. A row written now
// (created_at is the database's NOW()) is in the window from its own time to its own time written in +09:00, as in
// UTC, and not in the window starting a microsecond after it or the one ending a microsecond before it.
func TestPostgresAuditListWindowWithAnOffset(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()
	if _, err := Up(ctx, pool); err != nil {
		t.Fatalf("Up: %v", err)
	}
	store := audit.NewPostgresStore(pool, audit.ServiceAdmin)
	if _, err := store.Write(ctx, audit.Record{Action: "test.list.window"}); err != nil {
		t.Fatal(err)
	}
	rows, _, err := store.List(ctx, audit.Filter{Action: "test.list.window", Limit: 1})
	if err != nil || len(rows) != 1 {
		t.Fatalf("the row: %v, %v", rows, err)
	}
	at := rows[0].CreatedAt // the time the list shows for it, in UTC
	seoul := time.FixedZone("+09:00", 9*60*60)
	for _, c := range []struct {
		name         string
		since, until time.Time
		want         int
	}{
		{"its own time, +09:00", at.In(seoul), at.In(seoul), 1},
		{"its own time, UTC", at, at, 1},
		{"a second either side, +09:00", at.Add(-time.Second).In(seoul), at.Add(time.Second).In(seoul), 1},
		{"from a microsecond after it, +09:00", at.Add(time.Microsecond).In(seoul), at.Add(time.Second).In(seoul), 0},
		{"until a microsecond before it, +09:00", at.Add(-time.Second).In(seoul), at.Add(-time.Microsecond).In(seoul), 0},
	} {
		_, total, err := store.List(ctx, audit.Filter{Action: "test.list.window", Since: c.since, Until: c.until, Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		if total != c.want {
			t.Errorf("%s (%s … %s): %d rows, want %d", c.name, c.since.Format(time.RFC3339Nano), c.until.Format(time.RFC3339Nano), total, c.want)
		}
	}
}
