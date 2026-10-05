package recording

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

// Runs against PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL (each test makes
// and drops its own database); skipped when unset.
func freshDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("DBMIGRATE_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("DBMIGRATE_TEST_DATABASE_URL not set: needs a PostgreSQL server")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("recording_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(raw)
	u.Path = "/" + name
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
		admin.Close(ctx)
	})
	if _, err := dbmigrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

func status(t *testing.T, pool *pgxpool.Pool, id string) (st string, parts int, uploaded int64) {
	t.Helper()
	if err := pool.QueryRow(context.Background(), `SELECT status, parts, uploaded_bytes FROM session_recordings WHERE id = $1`, id).Scan(&st, &parts, &uploaded); err != nil {
		t.Fatal(err)
	}
	return
}

func TestPostgresFileStoreUploadsPartsWhileRunningAndOnClose(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	m, err := New(Config{Enabled: true, Required: true, MaxBytes: 1 << 20, ChunkSeconds: 30, SpoolDir: filepath.Join(dir, "spool"), Storage: "file", FileDir: filepath.Join(dir, "store")}, pool)
	if err != nil {
		t.Fatal(err)
	}
	s, err := m.Start(ctx, Meta{Kind: "exec", UserEmail: "alice@example.com", Cluster: "test2", Namespace: "default", Target: "nginx", Width: 100, Height: 30})
	if err != nil {
		t.Fatal(err)
	}
	s.Output([]byte("first\r\n"))
	m.flush(ctx) // mid-session part
	if st, parts, _ := status(t, pool, s.ID); st != "recording" || parts != 1 {
		t.Fatalf("mid-session: %s %d", st, parts)
	}
	s.Output([]byte("second\r\n"))
	s.Close()
	m.flush(ctx)
	st, parts, uploaded := status(t, pool, s.ID)
	if st != "uploaded" || parts != 2 || uploaded == 0 {
		t.Fatalf("after close: %s %d %d", st, parts, uploaded)
	}
	if _, err := os.Stat(filepath.Join(dir, "spool", s.ID+".cast")); !os.IsNotExist(err) {
		t.Fatal("spool file should be gone once uploaded")
	}
	rec, err := m.Get(ctx, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	cast, err := m.Cast(ctx, rec)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(cast), `{"version":2,"width":100,"height":30`) || !strings.Contains(string(cast), "first") || !strings.Contains(string(cast), "second") {
		t.Fatalf("cast:\n%s", cast)
	}
	if tr := Transcript(cast); tr != "first\nsecond\n" {
		t.Fatalf("transcript %q", tr)
	}
	list, err := m.List(ctx, Filter{User: "alice"})
	if err != nil || len(list) != 1 || list[0].Target != "nginx" || list[0].Cluster != "test2" {
		t.Fatalf("list %+v %v", list, err)
	}
}

func TestPostgresRecoveryUploadsWhatThePreviousProcessLeft(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	cfg := Config{Enabled: true, MaxBytes: 1 << 20, ChunkSeconds: 30, SpoolDir: filepath.Join(dir, "spool"), Storage: "database"}
	m1, _ := New(cfg, pool)
	s, err := m1.Start(ctx, Meta{Kind: "node-shell", Cluster: "default", Target: "node-1"})
	if err != nil {
		t.Fatal(err)
	}
	s.Output([]byte("uname -a\r\nLinux\r\n"))
	// the process dies here: no Close, no flush
	m2, _ := New(cfg, pool)
	m2.recover(ctx)
	m2.flush(ctx)
	st, parts, _ := status(t, pool, s.ID)
	if st != "interrupted" || parts != 1 {
		t.Fatalf("recovered: %s %d", st, parts)
	}
	rec, _ := m2.Get(ctx, s.ID)
	cast, err := m2.Cast(ctx, rec)
	if err != nil || !strings.Contains(string(cast), "Linux") {
		t.Fatalf("cast from the database store: %q %v", cast, err)
	}
	// a row whose spool file is gone (the pod was replaced) is closed out, parts kept
	s2, _ := m2.Start(ctx, Meta{Kind: "exec", Cluster: "default", Target: "p"})
	s2.Output([]byte("ls\r\n"))
	m2.flush(ctx)
	_ = os.Remove(filepath.Join(cfg.SpoolDir, s2.ID+".cast"))
	m3, _ := New(cfg, pool)
	m3.recover(ctx)
	if st, parts, _ := status(t, pool, s2.ID); st != "interrupted" || parts != 1 {
		t.Fatalf("lost spool: %s %d", st, parts)
	}
	var size, uploaded int64
	_ = pool.QueryRow(ctx, `SELECT bytes, uploaded_bytes FROM session_recordings WHERE id = $1`, s2.ID).Scan(&size, &uploaded)
	if size == 0 || size != uploaded {
		t.Fatalf("lost spool keeps the uploaded size: bytes %d uploaded %d", size, uploaded)
	}
}

func TestPostgresFailedUploadKeepsTheBytesAndRetries(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	m, _ := New(Config{Enabled: true, MaxBytes: 1 << 20, ChunkSeconds: 1, SpoolDir: filepath.Join(dir, "spool"), Storage: "file", FileDir: filepath.Join(dir, "store")}, pool)
	// make the store unwritable: a file where its directory should be
	if err := os.WriteFile(filepath.Join(dir, "store"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, _ := m.Start(ctx, Meta{Kind: "exec", Cluster: "default", Target: "p"})
	s.Output([]byte("hello\r\n"))
	s.Close()
	m.flush(ctx)
	if m.Failures() == 0 || m.PendingBytes() == 0 {
		t.Fatalf("failures %d pending %d", m.Failures(), m.PendingBytes())
	}
	var lastErr *string
	_ = pool.QueryRow(ctx, `SELECT last_error FROM session_recordings WHERE id = $1`, s.ID).Scan(&lastErr)
	if lastErr == nil || *lastErr == "" {
		t.Fatal("last_error not recorded")
	}
	_ = os.Remove(filepath.Join(dir, "store"))
	for _, t2 := range m.active {
		t2.nextTry = time.Time{}
	}
	m.flush(ctx)
	if st, _, _ := status(t, pool, s.ID); st != "uploaded" {
		t.Fatalf("after the store came back: %s", st)
	}
}

// hangingStore never answers a PUT, like an S3 endpoint whose packets are dropped.
type hangingStore struct{ Store }

func (hangingStore) PutPart(ctx context.Context, _ string, _ int, _ []byte) error {
	<-ctx.Done()
	return ctx.Err()
}

func TestPostgresHangingStoreFailsThePartInsteadOfStalling(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	m, _ := New(Config{Enabled: true, MaxBytes: 1 << 20, ChunkSeconds: 1, SpoolDir: filepath.Join(dir, "spool"), Storage: "file", FileDir: filepath.Join(dir, "store")}, pool)
	real := m.store
	m.store, m.putTimeout = hangingStore{real}, 200*time.Millisecond
	s, _ := m.Start(ctx, Meta{Kind: "exec", Cluster: "default", Target: "p"})
	s.Output([]byte("hello\r\n"))
	s.Close()
	began := time.Now()
	m.flush(ctx)
	if took := time.Since(began); took > 5*time.Second {
		t.Fatalf("flush held for %s", took)
	}
	var lastErr *string
	_ = pool.QueryRow(ctx, `SELECT last_error FROM session_recordings WHERE id = $1`, s.ID).Scan(&lastErr)
	if m.Failures() == 0 || lastErr == nil || !strings.Contains(*lastErr, "deadline") {
		t.Fatalf("failures %d last_error %v", m.Failures(), lastErr)
	}
	m.store = real
	for _, t2 := range m.active {
		t2.nextTry = time.Time{}
	}
	m.flush(ctx)
	if st, _, _ := status(t, pool, s.ID); st != "uploaded" {
		t.Fatalf("after the store answered again: %s", st)
	}
}

func TestPostgresShutdownUploadsLiveSessionsAsInterrupted(t *testing.T) {
	pool := freshDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	m, _ := New(Config{Enabled: true, MaxBytes: 1 << 20, ChunkSeconds: 1, SpoolDir: filepath.Join(dir, "spool"), Storage: "file", FileDir: filepath.Join(dir, "store")}, pool)
	s, _ := m.Start(ctx, Meta{Kind: "exec", Cluster: "default", Target: "p"})
	s.Output([]byte("still typing\r\n"))
	m.Shutdown(ctx)
	if st, _, _ := status(t, pool, s.ID); st != "interrupted" {
		t.Fatalf("status %s", st)
	}
	r, err := m.Get(ctx, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	cast, err := m.Cast(ctx, r)
	if err != nil || !strings.Contains(string(cast), "still typing") {
		t.Fatalf("cast %q err %v", cast, err)
	}
}
