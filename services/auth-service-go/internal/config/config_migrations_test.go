package config

import "testing"

// MIGRATIONS_MODE / MIGRATE_ONLY select who applies the schema (services/pkg/dbmigrate).
func TestLoadMigrationSettings(t *testing.T) {
	t.Run("defaults: startup mode, not migrate-only", func(t *testing.T) {
		t.Setenv("MIGRATIONS_MODE", "")
		t.Setenv("MIGRATE_ONLY", "")
		cfg := Load()
		if cfg.MigrationsMode != "startup" {
			t.Fatalf("MigrationsMode = %q, want startup", cfg.MigrationsMode)
		}
		if cfg.MigrateOnly {
			t.Fatal("MigrateOnly = true, want false")
		}
	})

	t.Run("job mode and migrate-only from the environment (the chart's hook Job)", func(t *testing.T) {
		t.Setenv("MIGRATIONS_MODE", "job")
		t.Setenv("MIGRATE_ONLY", "true")
		cfg := Load()
		if cfg.MigrationsMode != "job" {
			t.Fatalf("MigrationsMode = %q, want job", cfg.MigrationsMode)
		}
		if !cfg.MigrateOnly {
			t.Fatal("MigrateOnly = false, want true")
		}
	})

	t.Run("an unparsable MIGRATE_ONLY falls back to false", func(t *testing.T) {
		t.Setenv("MIGRATE_ONLY", "yes-please")
		if Load().MigrateOnly {
			t.Fatal("MigrateOnly = true for an unparsable value, want false")
		}
	})
}
