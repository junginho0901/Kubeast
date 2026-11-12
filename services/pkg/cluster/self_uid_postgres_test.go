package cluster

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

// Runs against the PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL (the CI dbmigrate job; skipped when unset): an
// in-cluster registration keeps the cluster's kube-system UID, so the same cluster is matched whichever way it was
// registered — the wizard's "Use this cluster" first and a kubeconfig of it after, or the other way round.
const testDatabaseURLEnv = "DBMIGRATE_TEST_DATABASE_URL"

func migratedRegistry(t *testing.T) (*PostgresRegistry, *pgxpool.Pool) {
	t.Helper()
	raw := os.Getenv(testDatabaseURLEnv)
	if raw == "" {
		t.Skipf("%s not set: needs a PostgreSQL server", testDatabaseURLEnv)
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	name := fmt.Sprintf("cluster_self_uid_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	u, _ := url.Parse(raw)
	u.Path = "/" + name
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
		admin.Close(ctx)
	})
	if _, err := dbmigrate.Up(ctx, pool); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	return NewPostgresRegistry(pool, nil), pool
}

// standIn makes the registry run as in a cluster whose kube-system UID is uid, counting the reads of it.
func standIn(t *testing.T, uid string, readErr error) *int {
	t.Helper()
	reads := 0
	oldConfig, oldUID := inClusterConfig, SelfUID
	inClusterConfig = func() (*rest.Config, error) { return &rest.Config{}, nil }
	SelfUID = func(context.Context) (string, error) { reads++; return uid, readErr }
	t.Cleanup(func() { inClusterConfig, SelfUID = oldConfig, oldUID })
	return &reads
}

func storedUID(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var uid *string
	if err := pool.QueryRow(context.Background(), `SELECT cluster_uid FROM clusters WHERE id = $1`, id).Scan(&uid); err != nil {
		t.Fatalf("read %s: %v", id, err)
	}
	if uid == nil {
		return ""
	}
	return *uid
}

func TestPostgres_AnInClusterRegistrationKeepsTheClusterUID(t *testing.T) {
	reg, pool := migratedRegistry(t)
	standIn(t, "uid-a", nil)
	if _, err := reg.AddSelf(context.Background(), "default", "admin"); err != nil {
		t.Fatalf("AddSelf: %v", err)
	}
	if got := storedUID(t, pool, "default"); got != "uid-a" {
		t.Fatalf("cluster_uid = %q, want uid-a", got)
	}
	if id, err := reg.ClusterIDByUID(context.Background(), "uid-a"); err != nil || id != "default" {
		t.Fatalf("ClusterIDByUID = %q, %v: a kubeconfig of this cluster would not be matched", id, err)
	}
}

func TestPostgres_AnInClusterRegistrationOfAClusterRegisteredByKubeconfigIsRefused(t *testing.T) {
	reg, pool := migratedRegistry(t)
	standIn(t, "uid-a", nil)
	if _, err := pool.Exec(context.Background(), `INSERT INTO clusters (id, display_name, mode, cluster_uid) VALUES ('ext', 'ext', 'external', 'uid-a')`); err != nil {
		t.Fatal(err)
	}
	_, err := reg.AddSelf(context.Background(), "default", "admin")
	var same *SameClusterError
	if !errors.As(err, &same) || same.ID != "ext" {
		t.Fatalf("AddSelf = %v, want the same cluster as 'ext'", err)
	}
	var rows int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM clusters`).Scan(&rows)
	if rows != 1 {
		t.Fatalf("%d rows, want the one registered before", rows)
	}
}

func TestPostgres_AnOlderInClusterRowGetsItsUIDOnceAndIsMatched(t *testing.T) {
	reg, pool := migratedRegistry(t)
	reads := standIn(t, "uid-a", nil)
	// as a release before this one wrote it: no cluster_uid
	if _, err := pool.Exec(context.Background(), `INSERT INTO clusters (id, display_name, mode, is_self_cluster) VALUES ('default', 'default', 'in_cluster', true)`); err != nil {
		t.Fatal(err)
	}
	if err := reg.FillSelfUID(context.Background()); err != nil {
		t.Fatalf("FillSelfUID: %v", err)
	}
	if got := storedUID(t, pool, "default"); got != "uid-a" {
		t.Fatalf("cluster_uid = %q, want uid-a", got)
	}
	if id, err := reg.ClusterIDByUID(context.Background(), "uid-a"); err != nil || id != "default" {
		t.Fatalf("ClusterIDByUID = %q, %v", id, err)
	}
	if err := reg.FillSelfUID(context.Background()); err != nil || *reads != 1 {
		t.Fatalf("second FillSelfUID: %v, %d reads of the UID, want 1 (nothing left to fill)", err, *reads)
	}
}

func TestPostgres_AnInClusterRegistrationWhoseUIDCannotBeReadStillGoesThrough(t *testing.T) {
	reg, pool := migratedRegistry(t)
	standIn(t, "", errors.New(`namespaces "kube-system" is forbidden`))
	if _, err := reg.AddSelf(context.Background(), "default", "admin"); err != nil {
		t.Fatalf("AddSelf: %v", err)
	}
	if got := storedUID(t, pool, "default"); got != "" {
		t.Fatalf("cluster_uid = %q, want none", got)
	}
}
