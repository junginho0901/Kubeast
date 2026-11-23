package cluster

import (
	"context"
	"testing"
)

// Runs against the PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL (skipped when unset): List carries what Get reads
// from each row, so a cluster that names its own log store is listed with its URL (k8s-service LogStoreClusters puts it
// in features.logSearch.clusters from there) and one that names none with no URL.
func TestPostgres_ListCarriesWhatGetReadsFromTheRow(t *testing.T) {
	r, _ := migratedRegistry(t)
	ctx := context.Background()
	secrets := NewFilesystemSecretStore(t.TempDir())
	own, err := r.AddExternal(ctx, "Own store", "apiVersion: v1\nkind: Config\n", "", "", "tester", secrets)
	if err != nil {
		t.Fatalf("AddExternal: %v", err)
	}
	plain, err := r.AddExternal(ctx, "Plain", "apiVersion: v1\nkind: Config\n", "", "", "tester", secrets)
	if err != nil {
		t.Fatalf("AddExternal: %v", err)
	}
	lsURL, tenant, lsLabel := "https://loki.example", "team-a", "kubeast-own"
	promURL, promLabel, promSvc := "https://prom.example", "own", "monitoring/prometheus:9090"
	if _, err := r.UpdateMeta(ctx, own.ID, MetaPatch{
		LogSearchURL: &lsURL, LogSearchTenant: &tenant, LogSearchClusterLabel: &lsLabel,
		PrometheusURL: &promURL, PrometheusClusterLabel: &promLabel, PrometheusService: &promSvc,
	}); err != nil {
		t.Fatalf("UpdateMeta: %v", err)
	}

	listed, err := r.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != 2 {
		t.Fatalf("List = %+v, want the two clusters", listed)
	}
	for _, info := range listed {
		// The registry reads no Secrets here (nil), so Get loads nothing List leaves out.
		got, err := r.Get(ctx, info.ID)
		if err != nil {
			t.Fatalf("Get %s: %v", info.ID, err)
		}
		if info != *got {
			t.Errorf("List gave %s as %+v, Get as %+v", info.ID, info, *got)
		}
		switch info.ID {
		case own.ID:
			if info.LogSearchURL != lsURL || info.LogSearchTenant != tenant || info.LogSearchClusterLabel != lsLabel {
				t.Errorf("own store cluster listed as %+v", info)
			}
		case plain.ID:
			if info.LogSearchURL != "" || info.PrometheusURL != "" {
				t.Errorf("cluster naming no store listed as %+v", info)
			}
		default:
			t.Errorf("List gave %s, registered %s and %s", info.ID, own.ID, plain.ID)
		}
	}
}
