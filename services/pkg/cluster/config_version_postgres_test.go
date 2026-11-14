package cluster

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func versionOf(t *testing.T, r *PostgresRegistry, id ID) (int64, bool) {
	t.Helper()
	versions, err := r.Versions(context.Background())
	if err != nil {
		t.Fatalf("Versions: %v", err)
	}
	v, ok := versions[id]
	return v, ok
}

// Runs against the PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL (skipped when unset): config_version changes with
// each change of what a connection is built from, in the statement that makes it, and with nothing else; Get reads it
// with the row; a deleted cluster is gone from Versions and the same id registered again never shows a value seen
// before.
func TestPostgres_ConfigVersionChangesWithWhatAConnectionIsBuiltFrom(t *testing.T) {
	r, _ := migratedRegistry(t)
	ctx := context.Background()
	secrets := NewFilesystemSecretStore(t.TempDir())
	meta, err := r.AddExternal(ctx, "Prod", "apiVersion: v1\nkind: Config\n", "", "", "tester", secrets)
	if err != nil {
		t.Fatalf("AddExternal: %v", err)
	}
	id := meta.ID
	seen := map[int64]bool{}
	v0, ok := versionOf(t, r, id)
	if !ok {
		t.Fatal("a registered cluster is not in Versions")
	}
	seen[v0] = true
	info, err := r.Get(ctx, id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if info.ConfigVersion != v0 {
		t.Fatalf("Get read config_version %d, Versions %d", info.ConfigVersion, v0)
	}

	// shown only, or the health check: no new version
	name, apiURL := "Prod (eu)", "https://prod.example:6443"
	if _, err := r.UpdateMeta(ctx, id, MetaPatch{DisplayName: &name, APIServerURL: &apiURL}); err != nil {
		t.Fatalf("UpdateMeta display: %v", err)
	}
	if err := r.UpdateHealth(ctx, id, "healthy"); err != nil {
		t.Fatalf("UpdateHealth: %v", err)
	}
	if v, _ := versionOf(t, r, id); v != v0 {
		t.Fatalf("display name, API server URL or health moved the version %d -> %d", v0, v)
	}

	changes := []struct {
		name string
		do   func() error
	}{
		{"prometheus url", func() error {
			u := "https://prom.example"
			_, err := r.UpdateMeta(ctx, id, MetaPatch{PrometheusURL: &u})
			return err
		}},
		{"prometheus auth cleared", func() error {
			cleared := ""
			_, err := r.UpdateMeta(ctx, id, MetaPatch{PrometheusAuthSecretName: &cleared})
			return err
		}},
		{"log store tenant", func() error {
			tenant := "team-a"
			_, err := r.UpdateMeta(ctx, id, MetaPatch{LogSearchTenant: &tenant})
			return err
		}},
		{"kubeconfig replaced, no uid", func() error { return r.ReplaceKubeconfig(ctx, id, "", SecretWrites{}) }},
		{"kubeconfig replaced with uid", func() error { return r.ReplaceKubeconfig(ctx, id, "uid-1", SecretWrites{}) }},
	}
	prev := v0
	for _, c := range changes {
		if err := c.do(); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		v, _ := versionOf(t, r, id)
		if v == prev || seen[v] {
			t.Fatalf("%s: version %d after %d (seen before: %v)", c.name, v, prev, seen[v])
		}
		seen[v] = true
		prev = v
	}
	if uid, err := r.ClusterUID(ctx, id); err != nil || uid != "uid-1" {
		t.Fatalf("ClusterUID = %q, %v; want uid-1", uid, err)
	}
	if err := r.ReplaceKubeconfig(ctx, id, "", SecretWrites{}); err != nil {
		t.Fatal(err)
	}
	if uid, _ := r.ClusterUID(ctx, id); uid != "uid-1" {
		t.Fatalf("a replacement without a uid cleared the stored one: %q", uid)
	}
	prev, _ = versionOf(t, r, id)
	seen[prev] = true
	ran := false
	if err := r.ReplaceKubeconfig(ctx, "nope", "", SecretWrites{Store: func(context.Context) error { ran = true; return nil }}); !errors.Is(err, ErrNotFound) || ran {
		t.Fatalf("ReplaceKubeconfig of an unknown id = %v (store ran: %v), want ErrNotFound without the store", err, ran)
	}

	// A store that fails having written nothing leaves the row as it was: no new version, no new UID, no new
	// Prometheus URL.
	refused := errors.New("the API server refused the Secret")
	if err := r.ReplaceKubeconfig(ctx, id, "uid-2", SecretWrites{Store: func(context.Context) error { return refused }}); !errors.Is(err, refused) {
		t.Fatalf("ReplaceKubeconfig with a failing store = %v", err)
	}
	other := "https://prom-other.example"
	if _, err := r.UpdateMetaStoring(ctx, id, MetaPatch{PrometheusURL: &other}, SecretWrites{Store: func(context.Context) error { return refused }}); !errors.Is(err, refused) {
		t.Fatalf("UpdateMetaStoring with a failing store = %v", err)
	}
	if v, _ := versionOf(t, r, id); v != prev {
		t.Fatalf("a change whose store failed moved the version %d -> %d", prev, v)
	}
	if uid, _ := r.ClusterUID(ctx, id); uid != "uid-1" {
		t.Fatalf("a replacement whose store failed set the uid %q", uid)
	}
	if meta, err := r.GetMeta(ctx, id); err != nil || meta.PrometheusURL != "https://prom.example" {
		t.Fatalf("a change whose store failed set the Prometheus URL: %+v, %v", meta, err)
	}

	// The store runs before the commit: what it reads of the row is the version before.
	stored := false
	if err := r.ReplaceKubeconfig(ctx, id, "", SecretWrites{Store: func(context.Context) error {
		stored = true
		if v, _ := versionOf(t, r, id); v != prev {
			t.Errorf("the new version %d was visible before the commit", v)
		}
		return nil
	}}); err != nil || !stored {
		t.Fatalf("ReplaceKubeconfig = %v (stored: %v)", err, stored)
	}
	if v, _ := versionOf(t, r, id); v == prev || seen[v] {
		t.Fatalf("version %d after a replacement from %d", v, prev)
	}

	if err := r.Remove(ctx, id, secrets); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, ok := versionOf(t, r, id); ok {
		t.Fatal("a deleted cluster is still in Versions")
	}
	again, err := r.AddExternal(ctx, "Prod", "apiVersion: v1\nkind: Config\n", "", "", "tester", secrets)
	if err != nil {
		t.Fatalf("AddExternal again: %v", err)
	}
	if v, _ := versionOf(t, r, again.ID); seen[v] {
		t.Fatalf("the cluster registered again under %s shows version %d, seen before", again.ID, v)
	}
}

// A store that runs past changeRow's deadline (short here) fails like any other: the transaction rolls back, so the
// version and the UID stay, and the row's lock is let go within the deadline, not when the request ends.
func TestPostgres_AStorePastItsDeadlineRollsBack(t *testing.T) {
	r, _ := migratedRegistry(t)
	r.storeLimit = 100 * time.Millisecond
	ctx := context.Background()
	meta, err := r.AddExternal(ctx, "Prod", "apiVersion: v1\nkind: Config\n", "", "", "tester", NewFilesystemSecretStore(t.TempDir()))
	if err != nil {
		t.Fatalf("AddExternal: %v", err)
	}
	before, _ := versionOf(t, r, meta.ID)
	start := time.Now()
	err = r.ReplaceKubeconfig(ctx, meta.ID, "uid-late", SecretWrites{Store: func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ReplaceKubeconfig with a store past its deadline = %v", err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("the change took %v", took)
	}
	if v, _ := versionOf(t, r, meta.ID); v != before {
		t.Fatalf("version %d -> %d after a store past its deadline", before, v)
	}
	if uid, _ := r.ClusterUID(ctx, meta.ID); uid != "" {
		t.Fatalf("uid %q after a store past its deadline", uid)
	}
	// the row is not held: a health update goes through at once
	updateCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := r.UpdateHealth(updateCtx, meta.ID, "healthy"); err != nil {
		t.Fatalf("UpdateHealth after the rollback: %v", err)
	}
}

// memSecret is one Secret held in memory for the SecretWrites of these tests.
type memSecret struct {
	mu sync.Mutex
	v  string
}

func (m *memSecret) get() string  { m.mu.Lock(); defer m.mu.Unlock(); return m.v }
func (m *memSecret) set(v string) { m.mu.Lock(); m.v = v; m.mu.Unlock() }

// writesOf is the SecretWrites of one value: Store reads what the Secret holds and writes value, then answers fail;
// PutBack writes back what Store read.
func writesOf(secret *memSecret, value string, fail error) SecretWrites {
	var before string
	return SecretWrites{
		Store: func(context.Context) error {
			before = secret.get()
			secret.set(value)
			return fail
		},
		PutBack: func(context.Context) (bool, string) {
			secret.set(before)
			return true, ""
		},
	}
}

// waitForLockWaiters waits until n sessions of the test's database wait on a lock.
func waitForLockWaiters(t *testing.T, pool *pgxpool.Pool, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err := pool.QueryRow(context.Background(),
			`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`).Scan(&waiting); err != nil {
			t.Fatalf("pg_stat_activity: %v", err)
		}
		if waiting >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d sessions wait on a lock after 5 s, want %d", waiting, n)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A change whose store wrote a Secret and then failed puts it back and sets one more new config_version, so a
// connection a k8s-service process built from the written value meanwhile, under the version before, is dropped; the
// UID stays. What PutBack could not undo comes back as a PutBackError around the store's error.
func TestPostgres_AFailedStoreThatWroteSetsANewVersion(t *testing.T) {
	r, _ := migratedRegistry(t)
	ctx := context.Background()
	meta, err := r.AddExternal(ctx, "Prod", "apiVersion: v1\nkind: Config\n", "", "", "tester", NewFilesystemSecretStore(t.TempDir()))
	if err != nil {
		t.Fatalf("AddExternal: %v", err)
	}
	id := meta.ID
	before, _ := versionOf(t, r, id)
	secret := &memSecret{v: "kubeconfig before"}
	refused := errors.New("the API server refused the Secret")
	err = r.ReplaceKubeconfig(ctx, id, "uid-refused", writesOf(secret, "kubeconfig refused", refused))
	if !errors.Is(err, refused) {
		t.Fatalf("ReplaceKubeconfig = %v, want the store's error", err)
	}
	var notUndone *PutBackError
	if errors.As(err, &notUndone) {
		t.Fatalf("a change put back whole answered %v", err)
	}
	if got := secret.get(); got != "kubeconfig before" {
		t.Fatalf("the Secret holds %q after the change failed", got)
	}
	after, _ := versionOf(t, r, id)
	if after == before {
		t.Fatalf("version %d stayed after a store that wrote and failed", after)
	}
	if uid, _ := r.ClusterUID(ctx, id); uid != "" {
		t.Fatalf("uid %q after the change failed", uid)
	}

	err = r.ReplaceKubeconfig(ctx, id, "", SecretWrites{
		Store:   func(context.Context) error { return refused },
		PutBack: func(context.Context) (bool, string) { return true, "kubeconfig (the value before was not read)" },
	})
	if !errors.As(err, &notUndone) || !errors.Is(err, refused) || notUndone.Left != "left as written: kubeconfig (the value before was not read)" {
		t.Fatalf("ReplaceKubeconfig with a Secret left as written = %v", err)
	}
	if v, _ := versionOf(t, r, id); v == after {
		t.Fatalf("version %d stayed after a Secret was left as written", v)
	}
}

// Two changes of one cluster at once: the first writes its Secret and then fails, while the second waits on the row.
// The first puts the Secret back before it lets the row go, so the second reads the value from before the first and
// its own write is what stays; the first's put back does not write over it.
func TestPostgres_AFailedStorePutsBackBeforeTheNextChangeOfTheCluster(t *testing.T) {
	r, pool := migratedRegistry(t)
	ctx := context.Background()
	meta, err := r.AddExternal(ctx, "Prod", "apiVersion: v1\nkind: Config\n", "", "", "tester", NewFilesystemSecretStore(t.TempDir()))
	if err != nil {
		t.Fatalf("AddExternal: %v", err)
	}
	id := meta.ID
	secret := &memSecret{v: "kubeconfig before"}
	refused := errors.New("the API server refused the Secret")

	secondStored := make(chan struct{})
	var secondRead string
	second := SecretWrites{
		Store: func(context.Context) error {
			secondRead = secret.get()
			secret.set("kubeconfig second")
			close(secondStored)
			return nil
		},
		PutBack: func(context.Context) (bool, string) { return true, "" },
	}
	secondDone := make(chan error, 1)

	var firstBefore string
	first := SecretWrites{
		Store: func(context.Context) error {
			firstBefore = secret.get()
			secret.set("kubeconfig first")
			go func() { secondDone <- r.ReplaceKubeconfig(ctx, id, "", second) }()
			waitForLockWaiters(t, pool, 1)
			return refused
		},
		PutBack: func(context.Context) (bool, string) {
			time.Sleep(200 * time.Millisecond) // a second change not held by the row would store now
			select {
			case <-secondStored:
				t.Error("the second change stored before the first put its Secret back")
			default:
			}
			secret.set(firstBefore)
			return true, ""
		},
	}
	if err := r.ReplaceKubeconfig(ctx, id, "", first); !errors.Is(err, refused) {
		t.Fatalf("first change = %v, want the store's error", err)
	}
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("second change = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the second change did not end")
	}
	if secondRead != "kubeconfig before" {
		t.Fatalf("the second change read %q before its write, want the value from before the first", secondRead)
	}
	if got := secret.get(); got != "kubeconfig second" {
		t.Fatalf("the Secret holds %q, want the second change's", got)
	}
}

// A commit that fails after the store wrote (here a deferred trigger refuses it) puts the Secret back under the row's
// lock taken again and sets a new config_version in that transaction; the UID of the change stays out.
func TestPostgres_AFailedCommitPutsBackAndSetsANewVersion(t *testing.T) {
	r, pool := migratedRegistry(t)
	ctx := context.Background()
	for _, sql := range []string{
		`CREATE FUNCTION refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit refused by the test'; END $$`,
		`CREATE CONSTRAINT TRIGGER refuse_commit AFTER UPDATE ON clusters DEFERRABLE INITIALLY DEFERRED
			FOR EACH ROW WHEN (NEW.cluster_uid = 'uid-commit-refused') EXECUTE FUNCTION refuse_commit()`,
	} {
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	meta, err := r.AddExternal(ctx, "Prod", "apiVersion: v1\nkind: Config\n", "", "", "tester", NewFilesystemSecretStore(t.TempDir()))
	if err != nil {
		t.Fatalf("AddExternal: %v", err)
	}
	id := meta.ID
	before, _ := versionOf(t, r, id)
	secret := &memSecret{v: "kubeconfig before"}
	err = r.ReplaceKubeconfig(ctx, id, "uid-commit-refused", writesOf(secret, "kubeconfig not committed", nil))
	if err == nil || !strings.Contains(err.Error(), "commit refused by the test") {
		t.Fatalf("ReplaceKubeconfig = %v, want the refused commit", err)
	}
	var notUndone *PutBackError
	if errors.As(err, &notUndone) {
		t.Fatalf("a change put back whole answered %v", err)
	}
	if got := secret.get(); got != "kubeconfig before" {
		t.Fatalf("the Secret holds %q after the commit failed", got)
	}
	if v, _ := versionOf(t, r, id); v == before {
		t.Fatalf("version %d stayed after a commit that failed with the Secret written", v)
	}
	if uid, _ := r.ClusterUID(ctx, id); uid != "" {
		t.Fatalf("uid %q after the commit failed", uid)
	}
}
