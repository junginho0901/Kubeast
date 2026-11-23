package retention

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// turnLog is what happened in a turn, in order: the lock asked, the row written, the lock given back.
type turnLog struct{ events []string }

type fakeLock struct {
	log   *turnLog
	ok    bool
	err   error
	onTry func()
}

func (f fakeLock) TryLock(context.Context) (func(), bool, error) {
	f.log.events = append(f.log.events, "lock")
	if f.onTry != nil {
		f.onTry()
	}
	if f.err != nil || !f.ok {
		return nil, false, f.err
	}
	return func() { f.log.events = append(f.log.events, "release") }, true, nil
}

type loggedWriter struct {
	log  *turnLog
	recs []audit.Record
}

func (w *loggedWriter) Write(_ context.Context, rec audit.Record) (int64, error) {
	w.log.events = append(w.log.events, "record")
	w.recs = append(w.recs, rec)
	return int64(len(w.recs)), nil
}

// A replica whose turn comes while another holds the lock purges nothing and writes no row: the run holding the lock
// writes that run's one row. (No pool here: a turn that ran anyway would write a failure row.)
func TestATurnAnotherReplicaHoldsRunsNothingAndWritesNoRow(t *testing.T) {
	log := &turnLog{}
	p := Purger{Cfg: Config{AuditDays: 365, ChatDays: 180}, Audit: &loggedWriter{log: log}}
	p.turn(context.Background(), fakeLock{log: log, ok: false})
	if want := []string{"lock"}; !slices.Equal(log.events, want) {
		t.Fatalf("events = %v, want %v", log.events, want)
	}
}

// The turn that gets the lock runs and keeps the lock until its row is written, so a run after it starts once that row
// is in.
func TestATurnHoldsTheLockUntilItsRowIsWritten(t *testing.T) {
	log := &turnLog{}
	w := &loggedWriter{log: log}
	p := Purger{Cfg: Config{AuditDays: 365, ChatDays: 180}, Audit: w}
	p.turn(context.Background(), fakeLock{log: log, ok: true})
	if want := []string{"lock", "record", "release"}; !slices.Equal(log.events, want) {
		t.Fatalf("events = %v, want %v", log.events, want)
	}
	if w.recs[0].Action != Action {
		t.Fatalf("record = %+v", w.recs[0])
	}
}

// A lock that cannot be asked (the database down) is a failed run with the lock's error, in a row of the same fields
// as any run's with no failed window, and no purge.
func TestATurnWhoseLockCannotBeAskedIsARecordedFailure(t *testing.T) {
	now := time.Date(2026, 11, 21, 3, 0, 0, 0, time.UTC)
	cfg := Config{AuditDays: 365, ChatDays: 180, ReviewDays: 1095, InvestigationDays: 90}
	log := &turnLog{}
	w := &loggedWriter{log: log}
	Purger{Cfg: cfg, Audit: w, Now: func() time.Time { return now }}.turn(context.Background(), fakeLock{log: log, err: errors.New("connection refused")})
	if want := []string{"lock", "record"}; !slices.Equal(log.events, want) {
		t.Fatalf("events = %v, want %v", log.events, want)
	}
	rec := w.recs[0]
	if rec.Action != Action || rec.Service != audit.ServiceAdmin || rec.ActorEmail != "system" || rec.TargetType != "retention" || rec.TargetID != "database" {
		t.Fatalf("record identity: %+v", rec)
	}
	if rec.Result != audit.ResultFailure || !strings.Contains(rec.Error, "connection refused") {
		t.Fatalf("result = %q, error = %q; want a failure naming the lock's error", rec.Result, rec.Error)
	}

	run := &captureWriter{}
	Purger{Cfg: cfg, Audit: run, Now: func() time.Time { return now }}.RunOnce(context.Background())
	var lockRow, runRow map[string]any
	if err := json.Unmarshal(rec.After, &lockRow); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(run.recs[0].After, &runRow); err != nil {
		t.Fatal(err)
	}
	if got, want := slices.Sorted(maps.Keys(lockRow)), slices.Sorted(maps.Keys(runRow)); !slices.Equal(got, want) {
		t.Fatalf("fields = %v, want a run's %v", got, want)
	}
	if got, ok := lockRow["failed_windows"].([]any); !ok || len(got) != 0 {
		t.Fatalf("failed_windows = %#v, want [] (no window ran)", lockRow["failed_windows"])
	}
}

// Run takes its turns through the lock it is given, the first one at start too.
func TestRunTakesItsTurnsThroughTheLock(t *testing.T) {
	log := &turnLog{}
	p := Purger{Cfg: Config{AuditDays: 365}, Audit: &loggedWriter{log: log}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		Run(ctx, p, fakeLock{log: log, ok: false, onTry: cancel}, time.Hour)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		cancel()
		<-done
	}
	if want := []string{"lock"}; !slices.Equal(log.events, want) {
		t.Fatalf("events = %v, want %v", log.events, want)
	}
}
