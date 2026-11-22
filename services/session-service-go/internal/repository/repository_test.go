package repository

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The schema's migrations, which auth-service applies (services/pkg/dbmigrate).
const migrationsDir = "../../../pkg/dbmigrate/migrations"

var (
	tableOfStatement = regexp.MustCompile(`(?i)^\s*(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?(\w+)`)
	// a column defined with the reference (`session_id VARCHAR NOT NULL REFERENCES sessions(id)`) or a table constraint
	columnReference = regexp.MustCompile(`(?i)(\w+)\s+\w+(?:\([^)]*\))?(?:\s+NOT\s+NULL|\s+NULL|\s+UNIQUE)*\s+REFERENCES\s+sessions\s*\(`)
	keyReference    = regexp.MustCompile(`(?i)FOREIGN\s+KEY\s*\(\s*(\w+)\s*\)\s*REFERENCES\s+sessions\s*\(`)
)

// sessionReferences reads the up migrations for the columns that reference sessions, as "table.column".
func sessionReferences(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(migrationsDir, "*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no migrations in %s: %v", migrationsDir, err)
	}
	var refs []string
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		up, _, _ := strings.Cut(string(raw), "-- +goose Down")
		// comments first: one may hold a semicolon
		var code []string
		for _, line := range strings.Split(up, "\n") {
			line, _, _ = strings.Cut(line, "--")
			code = append(code, line)
		}
		for _, text := range strings.Split(strings.Join(code, "\n"), ";") {
			table := tableOfStatement.FindStringSubmatch(text)
			if table == nil {
				continue
			}
			for _, re := range []*regexp.Regexp{columnReference, keyReference} {
				for _, m := range re.FindAllStringSubmatch(text, -1) {
					refs = append(refs, strings.ToLower(table[1]+"."+m[1]))
				}
			}
		}
	}
	return refs
}

// Every table whose rows name a session is cleared before the session row goes, in the order DeleteSession runs its
// statements: a reference without ON DELETE CASCADE (tool_approvals) would otherwise refuse the delete.
func TestDeleteSessionClearsEveryTableThatNamesTheSessionFirst(t *testing.T) {
	refs := sessionReferences(t)
	for _, known := range []string{"messages.session_id", "session_contexts.session_id", "tool_approvals.session_id"} {
		if !slices.Contains(refs, known) {
			t.Fatalf("the migrations read as referencing sessions from %v, without %s: the reading missed it", refs, known)
		}
	}
	last := len(deleteSessionStatements) - 1
	if deleteSessionStatements[last] != `DELETE FROM sessions WHERE id = $1` {
		t.Fatalf("the last statement is %q, want the session row's delete", deleteSessionStatements[last])
	}
	for _, ref := range refs {
		table, column, _ := strings.Cut(ref, ".")
		want := "DELETE FROM " + table + " WHERE " + column + " = $1"
		if !slices.ContainsFunc(deleteSessionStatements[:last], func(s string) bool { return strings.HasPrefix(s, want) }) {
			t.Errorf("%s references sessions and DeleteSession does not run %q before deleting the session", ref, want)
		}
	}
}
