package audit

import (
	"fmt"
	"testing"
	"time"
)

// AsOf bounds the rows by id next to the other filters; zero leaves it out.
func TestBuildWhere_AsOf(t *testing.T) {
	until := time.Date(2026, 11, 5, 1, 30, 59, 999999000, time.UTC)
	where, args := buildWhere(Filter{Action: "admin.audit.read", Until: until, AsOf: 310374})
	if got := fmt.Sprint(where, args); got != fmt.Sprint(" WHERE action = $1 AND created_at <= $2 AND id <= $3", []any{"admin.audit.read", until, int64(310374)}) {
		t.Errorf("where = %s", got)
	}
	if where, args := buildWhere(Filter{Action: "admin.audit.read"}); where != " WHERE action = $1" || len(args) != 1 {
		t.Errorf("without AsOf: %q %v", where, args)
	}
}

// A bound written with an offset goes as the same instant in UTC, the zone of
// created_at's clock reading: pgx drops a time's zone for a timestamp column.
func TestBuildWhere_BoundsGoAsUTC(t *testing.T) {
	seoul := time.FixedZone("+09:00", 9*60*60)
	since := time.Date(2026, 11, 18, 4, 58, 51, 0, seoul)
	until := time.Date(2026, 11, 18, 5, 1, 52, 0, seoul)
	_, args := buildWhere(Filter{Since: since, Until: until})
	if len(args) != 2 {
		t.Fatalf("args = %v", args)
	}
	for i, want := range []time.Time{time.Date(2026, 11, 17, 19, 58, 51, 0, time.UTC), time.Date(2026, 11, 17, 20, 1, 52, 0, time.UTC)} {
		got, _ := args[i].(time.Time)
		if got.Location() != time.UTC || !got.Equal(want) {
			t.Errorf("bound %d = %v, want %v", i, got, want)
		}
	}
}

// Rows of one created_at are ordered by id, so a page boundary between them
// is the same on every read.
func TestListOrder_TieBreak(t *testing.T) {
	if listOrder != " ORDER BY created_at DESC, id DESC" {
		t.Errorf("listOrder = %q", listOrder)
	}
}
