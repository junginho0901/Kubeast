package cluster

import (
	"context"
	"errors"
	"testing"
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
		{"kubeconfig replaced, no uid", func() error { return r.ReplaceKubeconfig(ctx, id, "", nil) }},
		{"kubeconfig replaced with uid", func() error { return r.ReplaceKubeconfig(ctx, id, "uid-1", nil) }},
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
	if err := r.ReplaceKubeconfig(ctx, id, "", nil); err != nil {
		t.Fatal(err)
	}
	if uid, _ := r.ClusterUID(ctx, id); uid != "uid-1" {
		t.Fatalf("a replacement without a uid cleared the stored one: %q", uid)
	}
	prev, _ = versionOf(t, r, id)
	seen[prev] = true
	ran := false
	if err := r.ReplaceKubeconfig(ctx, "nope", "", func(context.Context) error { ran = true; return nil }); !errors.Is(err, ErrNotFound) || ran {
		t.Fatalf("ReplaceKubeconfig of an unknown id = %v (store ran: %v), want ErrNotFound without the store", err, ran)
	}

	// A store that fails leaves the row as it was: no new version, no new UID, no new Prometheus URL.
	refused := errors.New("the API server refused the Secret")
	if err := r.ReplaceKubeconfig(ctx, id, "uid-2", func(context.Context) error { return refused }); !errors.Is(err, refused) {
		t.Fatalf("ReplaceKubeconfig with a failing store = %v", err)
	}
	other := "https://prom-other.example"
	if _, err := r.UpdateMetaStoring(ctx, id, MetaPatch{PrometheusURL: &other}, func(context.Context) error { return refused }); !errors.Is(err, refused) {
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
	if err := r.ReplaceKubeconfig(ctx, id, "", func(context.Context) error {
		stored = true
		if v, _ := versionOf(t, r, id); v != prev {
			t.Errorf("the new version %d was visible before the commit", v)
		}
		return nil
	}); err != nil || !stored {
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
