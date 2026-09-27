package dbmigrate

import (
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The embedded migration set is the contract other services check against:
// files are numbered without gaps, every file has an Up section, and Required
// names the newest one.
func TestEmbeddedMigrations(t *testing.T) {
	fsys, err := fs.Sub(migrations, dir)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		t.Fatal(err)
	}
	var versions []int64
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			t.Fatalf("unexpected file in migrations/: %s", name)
		}
		prefix, _, ok := strings.Cut(name, "_")
		if !ok {
			t.Fatalf("migration %s is not named <version>_<name>.sql", name)
		}
		v, err := strconv.ParseInt(prefix, 10, 64)
		if err != nil {
			t.Fatalf("migration %s has a non-numeric version: %v", name, err)
		}
		versions = append(versions, v)

		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Count(string(body), "-- +goose Up") != 1 {
			t.Errorf("%s must contain exactly one '-- +goose Up' annotation", name)
		}
		if !strings.Contains(string(body), "-- +goose Down") {
			t.Errorf("%s must contain a '-- +goose Down' section (may be empty with a comment)", name)
		}
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	for i, v := range versions {
		if v != int64(i+1) {
			t.Fatalf("migration versions must be 1..N without gaps, got %v", versions)
		}
	}
	if int64(len(versions)) != Required {
		t.Fatalf("Required = %d but the newest migration is %d; bump Required with every new file", Required, len(versions))
	}
}

func TestBaselineIsIdempotent(t *testing.T) {
	body, err := fs.ReadFile(migrations, dir+"/00001_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	for _, stmt := range []string{"CREATE TABLE ", "CREATE INDEX ", "ADD COLUMN ", "DROP COLUMN "} {
		count := strings.Count(s, stmt)
		guarded := strings.Count(s, stmt+"IF NOT EXISTS ")
		if stmt == "DROP COLUMN " {
			guarded = strings.Count(s, stmt+"IF EXISTS ")
		}
		if count != guarded {
			t.Errorf("baseline: %d %q statements but only %d carry an IF (NOT) EXISTS guard", count, strings.TrimSpace(stmt), guarded)
		}
	}
}
