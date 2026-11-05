package dbmigrate

import (
	"context"
	"fmt"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// On a real database: rows of one created_at keep their place from page to
// page (id breaks the tie), and pages read with the first read's MaxID as
// AsOf neither repeat nor skip rows while rows are written in between.
func TestPostgresAuditListPages(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()
	if _, err := Up(ctx, pool); err != nil {
		t.Fatalf("Up: %v", err)
	}
	store := audit.NewPostgresStore(pool, audit.ServiceAdmin)
	// 30 rows, three to a timestamp
	if _, err := pool.Exec(ctx, `INSERT INTO auth_audit_logs (service, action, created_at)
		SELECT 'admin', 'test.list.page', TIMESTAMP '2020-01-01 00:00:00' + (g / 3) * INTERVAL '1 second' FROM generate_series(0, 29) g`); err != nil {
		t.Fatal(err)
	}
	var want []int64
	rows, err := pool.Query(ctx, `SELECT id FROM auth_audit_logs ORDER BY id DESC`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		want = append(want, id)
	}
	rows.Close()

	asOf, err := store.MaxID(ctx)
	if err != nil || asOf != want[0] {
		t.Fatalf("MaxID = %d, %v; want %d", asOf, err, want[0])
	}
	var got []int64
	var totals []int
	for offset := 0; offset < len(want); offset += 7 {
		if offset > 0 {
			if _, err := store.Write(ctx, audit.Record{Action: "test.list.page"}); err != nil {
				t.Fatal(err)
			}
		}
		page, total, err := store.List(ctx, audit.Filter{Action: "test.list.page", AsOf: asOf, Limit: 7, Offset: offset})
		if err != nil {
			t.Fatal(err)
		}
		totals = append(totals, total)
		for _, e := range page {
			got = append(got, e.ID)
		}
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("pages = %v, want %v", got, want)
	}
	if fmt.Sprint(totals) != "[30 30 30 30 30]" {
		t.Errorf("totals = %v, want 30 on every page", totals)
	}
	if _, total, err := store.List(ctx, audit.Filter{Action: "test.list.page", Limit: 1}); err != nil || total != 34 {
		t.Errorf("without AsOf: total %d, %v; want 34 (the rows written since)", total, err)
	}
}
