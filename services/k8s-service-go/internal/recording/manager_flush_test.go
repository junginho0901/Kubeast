package recording

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// noDBManager is an enabled manager whose pool is closed: every index write
// fails at once, no server needed.
func noDBManager(t *testing.T) *Manager {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), "postgres://recording-test@127.0.0.1:1/none")
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	dir := t.TempDir()
	m, err := New(Config{Enabled: true, MaxBytes: 1 << 20, ChunkSeconds: 30, SpoolDir: filepath.Join(dir, "spool"), Storage: "file", FileDir: filepath.Join(dir, "store")}, pool)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// track does what Start does, without its index row.
func track(t *testing.T, m *Manager, id string) (*Session, *tracked) {
	t.Helper()
	meta := Meta{ID: id, Kind: "exec", Cluster: "default", Target: "p", StartedAt: time.Now().UTC()}
	if err := os.MkdirAll(m.cfg.SpoolDir, 0o750); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(m.cfg.SpoolDir, id+".cast")
	s, err := newSession(id, path, 80, 24, "", m.cfg.MaxBytes, m.now)
	if err != nil {
		t.Fatal(err)
	}
	rec := &tracked{meta: meta, location: datedLocation("", meta), path: path, session: s}
	s.onClose = m.ended
	m.mu.Lock()
	m.active[id] = rec
	m.mu.Unlock()
	return s, rec
}

// meetStore keeps the part number of every PUT. The first PUT waits a moment
// for a second one, so two uploaders running at once both reach the store.
type meetStore struct {
	Store
	mu   sync.Mutex
	puts []int
	met  chan struct{}
}

func (s *meetStore) PutPart(ctx context.Context, _ string, part int, _ []byte) error {
	s.mu.Lock()
	s.puts = append(s.puts, part)
	n := len(s.puts)
	s.mu.Unlock()
	switch n {
	case 1:
		select {
		case <-s.met:
		case <-time.After(time.Second):
		case <-ctx.Done():
		}
	case 2:
		close(s.met)
	}
	return nil
}

// Shutdown's Close wakes Run, and Shutdown flushes too: one of them uploads
// the part and the other finds nothing to send.
func TestShutdownWhileRunUploadsEachPartOnce(t *testing.T) {
	m := noDBManager(t)
	st := &meetStore{met: make(chan struct{})}
	m.store = st
	s, rec := track(t, m, "o13")
	s.Output([]byte("still typing\r\n"))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		m.Run(ctx)
		close(done)
	}()
	m.Shutdown(context.Background())
	cancel()
	<-done

	st.mu.Lock()
	puts := append([]int(nil), st.puts...)
	st.mu.Unlock()
	if size := fileSize(rec.path); len(puts) != 1 || rec.parts != 1 || rec.offset != size {
		t.Fatalf("puts %v, parts %d, offset %d of a %d-byte file", puts, rec.parts, rec.offset, size)
	}
}

// stuckStore tells of each PUT, then holds it until its context ends.
type stuckStore struct {
	Store
	put chan struct{}
}

func (s stuckStore) PutPart(ctx context.Context, _ string, _ int, _ []byte) error {
	select {
	case s.put <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return ctx.Err()
}

// A flush under way holds Shutdown only until Shutdown's own ctx ends.
func TestShutdownWaitsForAFlushUnderWayOnlyWithinItsContext(t *testing.T) {
	m := noDBManager(t)
	st := stuckStore{put: make(chan struct{}, 1)}
	m.store, m.putTimeout = st, time.Minute
	s, _ := track(t, m, "o13-stuck")
	s.Output([]byte("ls\r\n"))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		m.Run(ctx)
		close(done)
	}()
	defer func() {
		cancel()
		<-done
	}()
	s.Close() // Run's flush starts and its PUT hangs
	select {
	case <-st.put:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not flush")
	}
	sctx, scancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer scancel()
	began := time.Now()
	m.Shutdown(sctx)
	if took := time.Since(began); took > 5*time.Second {
		t.Fatalf("Shutdown held for %s", took)
	}
}

type okStore struct{ Store }

func (okStore) PutPart(context.Context, string, int, []byte) error { return nil }

// The pending-bytes gauge is read while a flush moves the offset.
func TestPendingBytesWhileAFlushUploads(t *testing.T) {
	m := noDBManager(t)
	m.store = okStore{}
	s, _ := track(t, m, "o13-pending")
	s.Output([]byte("ls\r\n"))
	done := make(chan struct{})
	go func() {
		m.flush(context.Background())
		close(done)
	}()
	for i := 0; i < 1000; i++ {
		_ = m.PendingBytes()
	}
	<-done
	if n := m.PendingBytes(); n != 0 {
		t.Fatalf("pending %d after the flush", n)
	}
}
