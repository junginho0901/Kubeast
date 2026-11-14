package recording

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// memRow is a session_recordings row as memIndex keeps it.
type memRow struct {
	openRow
	endedAt   *time.Time
	bytes     int64
	truncated bool
	lastError string
}

// memIndex changes rows in memory as pgIndex's statements change them, on a
// clock the test moves (the database's, which heartbeats are written in).
type memIndex struct {
	mu    sync.Mutex
	clock time.Time
	rows  map[string]*memRow
	opens int
	losts int // lost calls, whether or not the row changed
	// meet, when set, holds the first open after its read until a second
	// open has read too, so two recorders decide on the same rows.
	meet    chan struct{}
	readers int
	// beatHeld, when set, gets a beat the test is waiting for, which then
	// waits for beatGo.
	beatHeld, beatGo chan struct{}
}

func newMemIndex() *memIndex {
	return &memIndex{clock: time.Date(2026, 11, 14, 9, 0, 0, 0, time.UTC), rows: map[string]*memRow{}}
}

func isOpenStatus(s string) bool { return s == "recording" || s == "uploading" }

func (x *memIndex) advance(d time.Duration) {
	x.mu.Lock()
	x.clock = x.clock.Add(d)
	x.mu.Unlock()
}

func (x *memIndex) now() time.Time {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.clock
}

func (x *memIndex) row(t *testing.T, id string) memRow {
	t.Helper()
	x.mu.Lock()
	defer x.mu.Unlock()
	r := x.rows[id]
	if r == nil {
		t.Fatalf("no row %s", id)
	}
	return *r
}

func (x *memIndex) lostCalls() int {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.losts
}

func (x *memIndex) openCalls() int {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.opens
}

func (x *memIndex) insert(_ context.Context, meta Meta, _, location, owner string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	now := x.clock
	x.rows[meta.ID] = &memRow{openRow: openRow{id: meta.ID, kind: meta.Kind, cluster: meta.Cluster, target: meta.Target, location: location,
		status: "recording", startedAt: meta.StartedAt, owner: owner, heartbeat: &now}}
	return nil
}

func (x *memIndex) remove(_ context.Context, id string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	delete(x.rows, id)
	return nil
}

func (x *memIndex) ended(_ context.Context, id string, size int64, truncated bool) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if r := x.rows[id]; r != nil {
		now := x.clock
		r.endedAt, r.bytes, r.truncated, r.status = &now, size, truncated, "uploading"
	}
	return nil
}

func (x *memIndex) uploaded(_ context.Context, id string, offset int64, parts int, ended bool) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if r := x.rows[id]; r != nil {
		r.uploaded, r.parts, r.lastError = offset, parts, ""
		if r.status == "recording" && ended {
			r.status = "uploading"
		}
	}
	return nil
}

func (x *memIndex) failed(_ context.Context, id, reason string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if r := x.rows[id]; r != nil {
		r.lastError = reason
	}
	return nil
}

func (x *memIndex) finished(_ context.Context, id, status string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if r := x.rows[id]; r != nil {
		r.status, r.lastError = status, ""
	}
	return nil
}

func (x *memIndex) beat(_ context.Context, owner string) error {
	if x.beatHeld != nil {
		select {
		case x.beatHeld <- struct{}{}:
			<-x.beatGo
		default: // nobody waits for it: before the test looks, or after it let go
		}
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	now := x.clock
	for _, r := range x.rows {
		if r.owner == owner && isOpenStatus(r.status) {
			r.heartbeat = &now
		}
	}
	return nil
}

func (x *memIndex) open(context.Context) ([]openRow, time.Time, error) {
	x.mu.Lock()
	x.opens++
	var list []openRow
	for _, r := range x.rows {
		if isOpenStatus(r.status) {
			list = append(list, r.openRow)
		}
	}
	now := x.clock
	meet := x.meet
	if meet != nil {
		x.readers++
	}
	n := x.readers
	x.mu.Unlock()
	if meet != nil {
		if n == 2 {
			close(meet)
		} else {
			select {
			case <-meet:
			case <-time.After(time.Second):
			}
		}
	}
	return list, now, nil
}

func sameBeat(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

func (x *memIndex) take(_ context.Context, r openRow, owner string) (bool, error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	cur := x.rows[r.id]
	if cur == nil || !isOpenStatus(cur.status) || cur.owner != r.owner || !sameBeat(cur.heartbeat, r.heartbeat) {
		return false, nil
	}
	now := x.clock
	cur.owner, cur.heartbeat = owner, &now
	return true, nil
}

func (x *memIndex) lost(_ context.Context, id, owner string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.losts++
	if r := x.rows[id]; r != nil && r.owner == owner {
		if r.endedAt == nil {
			now := x.clock
			r.endedAt = &now
		}
		r.status, r.bytes, r.lastError = "interrupted", max(r.bytes, r.uploaded), "spool file lost; parts uploaded before are kept"
	}
	return nil
}

func (x *memIndex) cutOff(_ context.Context, id string, size int64) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if r := x.rows[id]; r != nil {
		if r.endedAt == nil {
			now := x.clock
			r.endedAt = &now
		}
		r.bytes = size
	}
	return nil
}

func (x *memIndex) handOver(_ context.Context, owner string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	for _, r := range x.rows {
		if r.owner == owner && isOpenStatus(r.status) {
			r.heartbeat = nil
		}
	}
	return nil
}

// partsStore keeps every part put, and counts a part put twice.
type partsStore struct {
	mu    sync.Mutex
	parts map[string]map[int][]byte
	twice int
	fail  bool
}

func newPartsStore() *partsStore { return &partsStore{parts: map[string]map[int][]byte{}} }

func (s *partsStore) Location(r Meta) string { return datedLocation("", r) }

func (s *partsStore) PutPart(_ context.Context, location string, part int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("the store refuses parts")
	}
	if s.parts[location] == nil {
		s.parts[location] = map[int][]byte{}
	}
	if _, ok := s.parts[location][part]; ok {
		s.twice++
	}
	s.parts[location][part] = append([]byte(nil), data...)
	return nil
}

func (s *partsStore) GetPart(_ context.Context, location string, part int) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.parts[location][part]
	if !ok {
		return nil, errors.New("no such part")
	}
	return b, nil
}

// joined is the recording's parts in order; false when one is missing.
func (s *partsStore) joined(location string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var b strings.Builder
	for i := 0; i < len(s.parts[location]); i++ {
		p, ok := s.parts[location][i]
		if !ok {
			return "", false
		}
		b.Write(p)
	}
	return b.String(), true
}

// server is a k8s-service process: its own owner name and spool volume, the
// shared index and store.
func server(t *testing.T, x *memIndex, spool string, st Store) *Manager {
	t.Helper()
	m := noDBManager(t)
	m.rows, m.store = x, st
	m.cfg.SpoolDir = spool
	return m
}

func record(t *testing.T, m *Manager, target string) *Session {
	t.Helper()
	s, err := m.Start(context.Background(), Meta{Kind: "exec", Cluster: "default", Namespace: "shop", Target: target})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// A server starting beside one that records (a rolling update starts the new
// pod first) leaves those recordings alone, also on a spool volume both mount.
func TestAServerStartingBesideAnotherLeavesItsLiveRecordings(t *testing.T) {
	for _, shared := range []bool{false, true} {
		x, st := newMemIndex(), newPartsStore()
		ctx := context.Background()
		spool := t.TempDir()
		old := server(t, x, spool, st)
		s := record(t, old, "web-1")
		s.Output([]byte("ls\r\n"))
		old.flush(ctx)

		other := t.TempDir()
		if shared {
			other = spool
		}
		x.advance(ownerStaleAfter - time.Second)
		nu := server(t, x, other, st)
		if n := nu.recover(ctx); n != 0 || len(nu.active) != 0 {
			t.Fatalf("shared spool %v: the new server took %d recordings, tracks %d", shared, n, len(nu.active))
		}
		if r := x.row(t, s.ID); r.status != "recording" || r.owner != old.owner || r.lastError != "" || x.lostCalls() != 0 {
			t.Fatalf("shared spool %v: row %+v after another server started, lost calls %d", shared, r, x.lostCalls())
		}
	}
}

// Of two recorders that find a row whose owner stopped beating ownerStaleAfter
// ago, one takes it: it closes the row out, or uploads it when it holds the
// spool file, once.
func TestARecordingWhoseOwnerStoppedIsTakenByOneRecorder(t *testing.T) {
	for _, shared := range []bool{false, true} {
		x, st := newMemIndex(), newPartsStore()
		ctx := context.Background()
		spool := t.TempDir()
		gone := server(t, x, spool, st)
		s := record(t, gone, "node-1")
		s.Output([]byte("uname -a\r\nLinux\r\n"))
		// the process ends here: no Close, no flush, no more beats

		dirA, dirB := t.TempDir(), t.TempDir()
		if shared {
			dirA, dirB = spool, spool
		}
		a, b := server(t, x, dirA, st), server(t, x, dirB, st)
		x.advance(ownerStaleAfter - time.Second)
		if n := a.recover(ctx) + b.recover(ctx); n != 0 {
			t.Fatalf("shared spool %v: taken %d before the heartbeat was a minute old", shared, n)
		}
		x.advance(time.Second)
		x.meet = make(chan struct{})
		var na, nb int
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); na = a.recover(ctx) }()
		go func() { defer wg.Done(); nb = b.recover(ctx) }()
		wg.Wait()
		if na+nb != 1 || len(a.active)+len(b.active) != map[bool]int{false: 0, true: 1}[shared] {
			t.Fatalf("shared spool %v: taken %d and %d, tracked %d and %d", shared, na, nb, len(a.active), len(b.active))
		}
		winner := a
		if nb == 1 {
			winner = b
		}
		if !shared {
			if r := x.row(t, s.ID); x.lostCalls() != 1 || r.status != "interrupted" || r.owner != winner.owner || !strings.Contains(r.lastError, "spool file lost") {
				t.Fatalf("lost calls %d, row %+v", x.lostCalls(), r)
			}
			continue
		}
		winner.flush(ctx)
		r := x.row(t, s.ID)
		cast, whole := st.joined(r.location)
		if x.lostCalls() != 0 || r.status != "interrupted" || !whole || int64(len(cast)) != r.uploaded || !strings.Contains(cast, "Linux") || st.twice != 0 {
			t.Fatalf("lost calls %d, row %+v, cast %q whole %v, parts put twice %d", x.lostCalls(), r, cast, whole, st.twice)
		}
	}
}

// Run beats for the rows its process holds, so another recorder leaves them
// however long the session runs, and takes them once the beats stop.
func TestTheOwnersHeartbeatKeepsItsRecording(t *testing.T) {
	x, st := newMemIndex(), newPartsStore()
	ctx := context.Background()
	owner := server(t, x, t.TempDir(), st)
	owner.beatEvery = 5 * time.Millisecond
	s := record(t, owner, "web-1")
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { owner.Run(runCtx); close(done) }()

	other := server(t, x, t.TempDir(), st)
	for i := 0; i < 3; i++ {
		x.advance(45 * time.Second)
		waitFor(t, "a heartbeat at the database's new time", func() bool {
			hb := x.row(t, s.ID).heartbeat
			return hb != nil && hb.Equal(x.now())
		})
		if n := other.recover(ctx); n != 0 {
			t.Fatalf("%s in: another recorder took the owner's row", time.Duration(i+1)*45*time.Second)
		}
	}
	stop()
	<-done
	x.advance(ownerStaleAfter)
	if n := other.recover(ctx); n != 1 {
		t.Fatalf("taken %d after the beats stopped", n)
	}
}

// Run returns once its last beat is done, so no beat of a stopped recorder
// comes after.
func TestRunReturnsAfterItsLastBeat(t *testing.T) {
	x, st := newMemIndex(), newPartsStore()
	x.beatHeld, x.beatGo = make(chan struct{}), make(chan struct{})
	m := server(t, x, t.TempDir(), st)
	m.beatEvery = time.Millisecond
	record(t, m, "web-1")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	<-x.beatHeld
	cancel()
	select {
	case <-done:
		t.Fatal("Run returned while a beat was under way")
	case <-time.After(50 * time.Millisecond):
	}
	close(x.beatGo)
	<-done
}

// A recorder looks for such rows while it runs, not only when it starts.
func TestRecoveryLooksAgainWhileTheServerRuns(t *testing.T) {
	x, st := newMemIndex(), newPartsStore()
	gone := server(t, x, t.TempDir(), st)
	s := record(t, gone, "web-1")
	nu := server(t, x, t.TempDir(), st)
	nu.recoverEvery = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { nu.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	waitFor(t, "the look at start", func() bool { return x.openCalls() >= 1 })
	x.advance(ownerStaleAfter) // the owner stops after the new server started
	waitFor(t, "the row closed out", func() bool { return x.row(t, s.ID).status == "interrupted" })
	if x.lostCalls() != 1 {
		t.Fatalf("lost calls %d", x.lostCalls())
	}
}

// The rolling update: the new server starts while the old one records, the old
// one drains for longer than a heartbeat lasts (one session ends meanwhile),
// then stops. Both recordings are whole and nothing marked one lost.
func TestRollingUpdateLeavesTheRecordingsComplete(t *testing.T) {
	x, st := newMemIndex(), newPartsStore()
	ctx := context.Background()
	old := server(t, x, t.TempDir(), st)
	exits, cut := record(t, old, "exits-in-the-drain"), record(t, old, "cut-at-the-end")
	exits.Output([]byte("exits 0\r\n"))
	cut.Output([]byte("cut 0\r\n"))
	old.flush(ctx)

	nu := server(t, x, t.TempDir(), st)
	if n := nu.recover(ctx); n != 0 {
		t.Fatalf("the new server took %d recordings at start", n)
	}
	for i := 1; i <= 4; i++ { // two minutes of drain
		x.advance(30 * time.Second)
		old.beat(ctx)
		if n := nu.recover(ctx); n != 0 {
			t.Fatalf("the new server took %d recordings %ds into the drain", n, i*30)
		}
		cut.Output([]byte("cut " + string(rune('0'+i)) + "\r\n"))
		if i < 3 {
			exits.Output([]byte("exits " + string(rune('0'+i)) + "\r\n"))
		}
		old.flush(ctx)
		if i == 2 {
			exits.Close()
			old.flush(ctx)
		}
	}
	old.Shutdown(ctx)
	x.advance(2 * ownerStaleAfter)
	if n := nu.recover(ctx); n != 0 {
		t.Fatalf("the new server took %d recordings after the old one stopped", n)
	}

	for _, c := range []struct {
		s      *Session
		status string
		lines  int
	}{{exits, "uploaded", 3}, {cut, "interrupted", 5}} {
		r := x.row(t, c.s.ID)
		cast, whole := st.joined(r.location)
		if r.status != c.status || r.lastError != "" || !whole || int64(len(cast)) != r.uploaded || r.bytes != r.uploaded {
			t.Fatalf("%s: row %+v, cast whole %v of %d bytes", r.target, r, whole, len(cast))
		}
		for i := 0; i < c.lines; i++ {
			if want := strings.Split(r.target, "-")[0] + " " + string(rune('0'+i)); !strings.Contains(cast, want) {
				t.Fatalf("%s: %q missing from the cast:\n%s", r.target, want, cast)
			}
		}
		if _, err := os.Stat(filepath.Join(old.cfg.SpoolDir, c.s.ID+".cast")); !os.IsNotExist(err) {
			t.Fatalf("%s: spool file still there", r.target)
		}
	}
	if x.lostCalls() != 0 || st.twice != 0 {
		t.Fatalf("lost calls %d, parts put twice %d", x.lostCalls(), st.twice)
	}
}

// What Shutdown could not upload it hands over: another recorder takes it at
// once, and the stopping process beats for it no more.
func TestShutdownHandsOverWhatItCouldNotUpload(t *testing.T) {
	x, st := newMemIndex(), newPartsStore()
	ctx := context.Background()
	old := server(t, x, t.TempDir(), st)
	s := record(t, old, "web-1")
	s.Output([]byte("ls\r\n"))
	st.fail = true
	old.Shutdown(ctx)
	if r := x.row(t, s.ID); r.status != "uploading" || r.owner != old.owner || r.heartbeat != nil {
		t.Fatalf("after Shutdown: %+v", r)
	}
	old.beat(ctx)
	if r := x.row(t, s.ID); r.heartbeat != nil {
		t.Fatalf("a beat after the hand-over: %v", r.heartbeat)
	}
	nu := server(t, x, t.TempDir(), st)
	if n := nu.recover(ctx); n != 1 {
		t.Fatalf("taken %d right after the hand-over", n)
	}
	if r := x.row(t, s.ID); r.status != "interrupted" || r.owner != nu.owner {
		t.Fatalf("row %+v", r)
	}
}

// A row written before rows had owners may still belong to the pod a rolling
// update is replacing, so it waits until this process has run unownedAfter.
func TestARowFromBeforeOwnersWaitsForTheOldPodToStop(t *testing.T) {
	x := newMemIndex()
	x.rows["legacy"] = &memRow{openRow: openRow{id: "legacy", kind: "exec", cluster: "default", target: "p", status: "recording"}}
	ctx := context.Background()
	nu := server(t, x, t.TempDir(), newPartsStore())
	if n := nu.recover(ctx); n != 0 {
		t.Fatalf("taken %d at start", n)
	}
	nu.started = nu.started.Add(-unownedAfter)
	if n := nu.recover(ctx); n != 1 {
		t.Fatalf("taken %d after %s", n, unownedAfter)
	}
	if r := x.row(t, "legacy"); r.status != "interrupted" || r.owner != nu.owner {
		t.Fatalf("row %+v", r)
	}
}

// A row this process holds is not taken again, also when another process took
// it while this one could not beat and then stopped.
func TestRecoveryLeavesARecordingThisProcessHolds(t *testing.T) {
	x, st := newMemIndex(), newPartsStore()
	ctx := context.Background()
	m := server(t, x, t.TempDir(), st)
	s := record(t, m, "web-1")
	x.mu.Lock()
	x.rows[s.ID].owner = "another-process"
	x.mu.Unlock()
	x.advance(ownerStaleAfter)
	if n := m.recover(ctx); n != 0 || m.active[s.ID].session != s {
		t.Fatalf("taken %d; the live session is still tracked: %v", n, m.active[s.ID].session == s)
	}
}
