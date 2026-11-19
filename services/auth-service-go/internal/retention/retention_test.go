package retention

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

func TestConfigValidateAndEnabled(t *testing.T) {
	if (Config{}).Enabled() {
		t.Fatal("zero config must be disabled")
	}
	for _, c := range []Config{{AuditDays: 365}, {ChatDays: 180}, {AuditDays: 365, ChatDays: 180}} {
		if !c.Enabled() {
			t.Fatalf("%+v should be enabled", c)
		}
		if err := c.Validate(); err != nil {
			t.Fatalf("%+v: %v", c, err)
		}
	}
	for _, c := range []Config{{AuditDays: -1}, {ChatDays: -7}} {
		if err := c.Validate(); err == nil {
			t.Fatalf("%+v should be rejected", c)
		}
	}
}

func TestCutoffs(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	a, c := Config{AuditDays: 365, ChatDays: 180}.Cutoffs(now)
	if a != now.AddDate(0, 0, -365) || c != now.AddDate(0, 0, -180) {
		t.Fatalf("cutoffs = %v %v", a, c)
	}
	a, c = Config{AuditDays: 365}.Cutoffs(now)
	if a.IsZero() || !c.IsZero() {
		t.Fatalf("chat cutoff must be zero when off: %v %v", a, c)
	}
}

func TestPurgeWithoutPolicyTouchesNothing(t *testing.T) {
	res, err := Purger{Cfg: Config{}}.Purge(context.Background(), time.Now())
	if err != nil || res != (Result{}) {
		t.Fatalf("disabled purge = %+v, %v", res, err)
	}
	if _, err := (Purger{Cfg: Config{AuditDays: 1}}).Purge(context.Background(), time.Now()); err == nil {
		t.Fatal("enabled purge without a pool must fail, not panic")
	}
}

type captureWriter struct{ recs []audit.Record }

func (c *captureWriter) Write(_ context.Context, rec audit.Record) (int64, error) {
	c.recs = append(c.recs, rec)
	return int64(len(c.recs)), nil
}

func TestRunOnceRecordsTheRunEvenWhenItFails(t *testing.T) {
	w := &captureWriter{}
	now := time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC)
	p := Purger{Cfg: Config{AuditDays: 365, ChatDays: 180}, Audit: w, Now: func() time.Time { return now }}
	p.RunOnce(context.Background()) // no pool → failure path

	if len(w.recs) != 1 {
		t.Fatalf("want one audit record, got %d", len(w.recs))
	}
	rec := w.recs[0]
	if rec.Action != Action || rec.Service != audit.ServiceAdmin || rec.ActorEmail != "system" || rec.TargetType != "retention" {
		t.Fatalf("record identity: %+v", rec)
	}
	if rec.Result != audit.ResultFailure || rec.Error == "" {
		t.Fatalf("failure must be recorded: result=%q error=%q", rec.Result, rec.Error)
	}
	var after map[string]any
	if err := json.Unmarshal(rec.After, &after); err != nil {
		t.Fatal(err)
	}
	if after["audit_days"].(float64) != 365 || after["chat_days"].(float64) != 180 {
		t.Fatalf("after payload: %v", after)
	}
	if after["audit_cutoff"] != now.AddDate(0, 0, -365).Format(time.RFC3339) || after["chat_cutoff"] != now.AddDate(0, 0, -180).Format(time.RFC3339) {
		t.Fatalf("cutoffs in payload: %v", after)
	}
}

func TestInvestigationWindow(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	c := Config{InvestigationDays: 90}
	if !c.Enabled() || c.Validate() != nil {
		t.Fatalf("%+v should be enabled and valid", c)
	}
	if got := c.InvestigationCutoff(now); got != now.AddDate(0, 0, -90) {
		t.Fatalf("cutoff = %v", got)
	}
	if !(Config{AuditDays: 30}).InvestigationCutoff(now).IsZero() {
		t.Fatal("investigation cutoff must be zero when off")
	}
	if err := (Config{InvestigationDays: -1}).Validate(); err == nil {
		t.Fatal("negative window should be rejected")
	}
}

// A cut-off is in UTC, the same instant, whatever zone now is in: the TIMESTAMP columns hold UTC and pgx sends a
// time's clock reading without its zone, so a pod with TZ=Asia/Seoul would keep or delete nine hours off.
func TestCutoffsAreInUTC(t *testing.T) {
	now := time.Date(2026, 11, 18, 5, 0, 0, 0, time.FixedZone("KST", 9*60*60))
	c := Config{AuditDays: 1, ChatDays: 1, ReviewDays: 1, InvestigationDays: 1}
	auditCut, chatCut := c.Cutoffs(now)
	want := time.Date(2026, 11, 16, 20, 0, 0, 0, time.UTC)
	for name, got := range map[string]time.Time{"audit": auditCut, "chat": chatCut, "review": c.ReviewCutoff(now), "investigation": c.InvestigationCutoff(now)} {
		if got.Location() != time.UTC || !got.Equal(want) {
			t.Errorf("%s cut-off = %v, want %v", name, got, want)
		}
	}
}

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

// Every table whose rows name a session is cleared before the session rows go, in the order a batch runs its
// statements: an install whose chat tables have no ON DELETE CASCADE would otherwise refuse the purge.
func TestExpiredSessionsGoAfterEveryTableThatNamesThem(t *testing.T) {
	refs := sessionReferences(t)
	for _, known := range []string{"messages.session_id", "session_contexts.session_id", "tool_approvals.session_id"} {
		if !slices.Contains(refs, known) {
			t.Fatalf("the migrations read as referencing sessions from %v, without %s: the reading missed it", refs, known)
		}
	}
	last := len(expiredSessionStatements) - 1
	if expiredSessionStatements[last] != `DELETE FROM sessions WHERE id = ANY($1)` {
		t.Fatalf("the last statement is %q, want the session rows' delete (it is counted as the sessions)", expiredSessionStatements[last])
	}
	if !strings.HasPrefix(expiredSessionStatements[0], "DELETE FROM tool_approvals ") {
		t.Fatalf("the first statement is %q, want the tool approvals' delete (it is counted as the approvals)", expiredSessionStatements[0])
	}
	for _, ref := range refs {
		table, column, _ := strings.Cut(ref, ".")
		want := "DELETE FROM " + table + " WHERE " + column + " = ANY($1)"
		if !slices.Contains(expiredSessionStatements[:last], want) {
			t.Errorf("%s references sessions and the purge does not run %q before deleting the sessions", ref, want)
		}
	}
}
