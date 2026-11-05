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

// Rows of one created_at are ordered by id, so a page boundary between them
// is the same on every read.
func TestListOrder_TieBreak(t *testing.T) {
	if listOrder != " ORDER BY created_at DESC, id DESC" {
		t.Errorf("listOrder = %q", listOrder)
	}
}
