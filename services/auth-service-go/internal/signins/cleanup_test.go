package signins

import (
	"context"
	"errors"
	"testing"
	"time"
)

// rows stands in for ended_sign_ins: how many rows ended more than keep ago, and the calls made.
type rows struct {
	old   int64
	fail  error
	keeps []time.Duration
	sizes []int
}

func (r *rows) DeleteEndedSignIns(_ context.Context, keep time.Duration, batch int) (int64, error) {
	r.keeps = append(r.keeps, keep)
	r.sizes = append(r.sizes, batch)
	if r.fail != nil {
		return 0, r.fail
	}
	n := min(r.old, int64(batch))
	r.old -= n
	return n, nil
}

func TestASignOutIsKeptForTheTokenLifetimeAndTheMargin(t *testing.T) {
	if got := KeepFor(15 * time.Minute); got != 25*time.Minute {
		t.Fatalf("KeepFor(15m) = %s, want 25m", got)
	}
}

func TestCleanupDeletesBatchByBatchUntilTheOldRowsAreGone(t *testing.T) {
	store := &rows{old: 2*batch + 7}
	got := Cleaner{Store: store, Keep: 25 * time.Minute}.RunOnce(context.Background())
	if got != 2*batch+7 || store.old != 0 {
		t.Fatalf("deleted %d, left %d", got, store.old)
	}
	if len(store.keeps) != 3 || store.keeps[0] != 25*time.Minute || store.sizes[0] != batch {
		t.Fatalf("calls: keeps %v sizes %v", store.keeps, store.sizes)
	}
}

func TestCleanupWithNothingOldAsksOnce(t *testing.T) {
	store := &rows{}
	if got := (Cleaner{Store: store, Keep: time.Hour}).RunOnce(context.Background()); got != 0 || len(store.keeps) != 1 {
		t.Fatalf("deleted %d in %d calls", got, len(store.keeps))
	}
}

func TestACleanupThatFailsStopsAndWaitsForTheNextRun(t *testing.T) {
	store := &rows{old: 10, fail: errors.New("connection refused")}
	if got := (Cleaner{Store: store, Keep: time.Hour}).RunOnce(context.Background()); got != 0 || len(store.keeps) != 1 {
		t.Fatalf("deleted %d in %d calls", got, len(store.keeps))
	}
}
