package retention

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

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
	if err != nil || !reflect.DeepEqual(res, Result{}) {
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

// The run's record names the tool approvals it deleted while approved, by ids and names, and has no such key when
// it deleted none.
func TestRecordNamesTheApprovalsDeletedWhileApproved(t *testing.T) {
	now := time.Date(2026, 11, 20, 3, 0, 0, 0, time.UTC)
	approvedAt := now.AddDate(0, 0, -200)
	for _, c := range []struct {
		res  Result
		want string
	}{
		{Result{ToolApprovals: 3, OpenApprovals: []OpenApproval{{ID: "t1", SessionID: "s1", Tool: "k8s_patch_resource", Cluster: "self", ApprovedAt: &approvedAt}}},
			`[{"approved_at":"2026-05-04T03:00:00Z","cluster":"self","id":"t1","session_id":"s1","tool":"k8s_patch_resource"}]`},
		{Result{ToolApprovals: 3}, ""},
	} {
		w := &captureWriter{}
		Purger{Cfg: Config{ChatDays: 180}, Audit: w}.record(context.Background(), now, c.res, nil, nil)
		var after map[string]json.RawMessage
		if err := json.Unmarshal(w.recs[0].After, &after); err != nil {
			t.Fatal(err)
		}
		if got := string(after["open_approvals"]); got != c.want {
			t.Errorf("open_approvals = %s, want %q", got, c.want)
		}
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

// fakeDB answers every statement, keeping them in the order they came: a statement holding "DELETE FROM <table> "
// of a table in fail returns that error (after answering as usual passes[table] times), one of a table in deleted
// says it deleted that many rows, one holding a key of returns deletes those rows (and returns them with
// approvalReturning; none otherwise), and a batch of conversations finds one. A transaction's commit returns commitErr.
type fakeDB struct {
	fail      map[string]error
	passes    map[string]int
	deleted   map[string]int64
	returns   map[string][]returnedApproval
	commitErr error
	ran       []string
}

// returnedApproval is a row of a tool approvals' delete with approvalReturning.
type returnedApproval struct {
	OpenApproval
	status string
}

func (f *fakeDB) answer(sql string) (int64, error) {
	f.ran = append(f.ran, sql)
	for table, err := range f.fail {
		if strings.Contains(sql, "DELETE FROM "+table+" ") {
			if f.passes[table] > 0 {
				f.passes[table]--
				break
			}
			return 0, err
		}
	}
	for table, n := range f.deleted {
		if strings.Contains(sql, "DELETE FROM "+table+" ") {
			return n, nil
		}
	}
	for key, rows := range f.returns {
		if strings.Contains(sql, key) {
			return int64(len(rows)), nil
		}
	}
	return 0, nil
}

func (f *fakeDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	n, err := f.answer(sql)
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	return pgconn.NewCommandTag(fmt.Sprintf("DELETE %d", n)), nil
}

func (f *fakeDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	if _, err := f.answer(sql); err != nil {
		return nil, err
	}
	return f.returned(sql), nil
}

func (f *fakeDB) returned(sql string) pgx.Rows {
	for key, rows := range f.returns {
		if strings.Contains(sql, key) {
			return &fakeRows{approvals: rows}
		}
	}
	return &fakeRows{}
}

func (f *fakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	_, err := f.answer(sql)
	return fakeRow{err}
}

func (f *fakeDB) Begin(context.Context) (pgx.Tx, error) { return fakeTx{db: f}, nil }

type fakeRow struct{ err error }

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*int64) = 1
	return nil
}

type fakeTx struct {
	pgx.Tx
	db *fakeDB
}

func (t fakeTx) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	if _, err := t.db.answer(sql); err != nil {
		return nil, err
	}
	if strings.HasPrefix(sql, "DELETE ") {
		return t.db.returned(sql), nil
	}
	return &fakeRows{ids: []string{"s-old"}}, nil
}

func (t fakeTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return t.db.Exec(ctx, sql, args...)
}

func (t fakeTx) Commit(context.Context) error { return t.db.commitErr }
func (fakeTx) Rollback(context.Context) error { return nil }

type fakeRows struct {
	pgx.Rows
	ids       []string
	approvals []returnedApproval
	next      int
}

func (r *fakeRows) Next() bool { r.next++; return r.next <= len(r.ids)+len(r.approvals) }
func (r *fakeRows) Scan(dest ...any) error {
	if r.approvals != nil {
		a := r.approvals[r.next-1]
		*dest[0].(*string), *dest[1].(*string), *dest[2].(*string), *dest[3].(*string) = a.ID, a.SessionID, a.Tool, a.Cluster
		*dest[4].(*string), *dest[5].(**time.Time) = a.status, a.ApprovedAt
		return nil
	}
	*dest[0].(*string) = r.ids[r.next-1]
	return nil
}
func (r *fakeRows) Err() error { return nil }
func (r *fakeRows) Close()     {}

// The tables each window deletes from, in the order a run takes the windows.
var windowTables = []struct {
	name   string
	tables []string
}{
	{"audit", []string{"auth_audit_logs", "session_recordings"}},
	{"chat", []string{"tool_approvals", "session_contexts", "messages", "sessions"}},
	{"review", []string{"access_reviews", "hygiene_reviews"}},
	{"investigation", []string{"alert_investigations", "alert_inbox"}},
}

// What a database whose chat tables do not cascade answers the conversations' delete.
var sessionsStillNamed = &pgconn.PgError{Severity: "ERROR", Code: "23503", Message: `update or delete on table "sessions" violates foreign key constraint "messages_session_id_fkey" on table "messages"`}

// A window that fails is named, and the windows after it still delete.
func TestAWindowThatFailsLeavesTheOthersToRun(t *testing.T) {
	all := Config{AuditDays: 365, ChatDays: 180, ReviewDays: 1095, InvestigationDays: 90}
	for _, failing := range windowTables {
		t.Run(failing.name, func(t *testing.T) {
			db := &fakeDB{fail: map[string]error{failing.tables[0]: errors.New("refused")}}
			if failing.name == "chat" {
				db.fail = map[string]error{"sessions": sessionsStillNamed}
			}
			_, failed, err := Purger{Pool: db, Cfg: all}.purge(context.Background(), time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC))
			if err == nil || !slices.Equal(failed, []string{failing.name}) {
				t.Fatalf("failed windows %v, error %v; want [%s] and its error", failed, err, failing.name)
			}
			if failing.name == "chat" {
				if pgErr := (*pgconn.PgError)(nil); !errors.As(err, &pgErr) || pgErr.Code != "23503" || !strings.HasPrefix(err.Error(), "sessions: ") {
					t.Fatalf("error %q does not carry the database's answer under the step that got it", err)
				}
			}
			for _, w := range windowTables {
				if w.name == failing.name {
					continue
				}
				for _, table := range w.tables {
					if !slices.ContainsFunc(db.ran, func(sql string) bool { return strings.Contains(sql, "DELETE FROM "+table+" ") }) {
						t.Errorf("window %s failed and %s's delete of %s did not run; ran:\n%s", failing.name, w.name, table, strings.Join(db.ran, "\n"))
					}
				}
			}
		})
	}
}

// The run's audit record keeps its fields and counts and adds the windows that failed, in the order they ran.
func TestRunOnceNamesTheFailedWindowsInItsRecord(t *testing.T) {
	now := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	cfg := Config{AuditDays: 365, ChatDays: 180, ReviewDays: 1095, InvestigationDays: 90}
	fields := slices.Sorted(slices.Values([]string{"audit_days", "chat_days", "audit_cutoff", "chat_cutoff", "audit_rows", "sessions", "tool_approvals", "session_recordings",
		"review_days", "review_cutoff", "access_reviews", "hygiene_reviews", "investigation_days", "alert_investigations", "alert_inbox", "failed_windows"}))
	for _, tc := range []struct {
		name   string
		fail   map[string]error
		failed []any
	}{
		{"none", nil, []any{}},
		{"chat", map[string]error{"sessions": sessionsStillNamed}, []any{"chat"}},
		{"chat and investigation", map[string]error{"sessions": sessionsStillNamed, "alert_inbox": errors.New("inbox refused")}, []any{"chat", "investigation"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := &captureWriter{}
			db := &fakeDB{fail: tc.fail, deleted: map[string]int64{"auth_audit_logs": 4, "access_reviews": 3, "hygiene_reviews": 1, "alert_investigations": 2}}
			Purger{Pool: db, Cfg: cfg, Audit: w, Now: func() time.Time { return now }}.RunOnce(context.Background())
			if len(w.recs) != 1 {
				t.Fatalf("want one audit record, got %d", len(w.recs))
			}
			rec := w.recs[0]
			var after map[string]any
			if err := json.Unmarshal(rec.After, &after); err != nil {
				t.Fatal(err)
			}
			if got := slices.Sorted(maps.Keys(after)); !slices.Equal(got, fields) {
				t.Fatalf("after fields %v, want %v", got, fields)
			}
			if got, ok := after["failed_windows"].([]any); !ok || !slices.Equal(got, tc.failed) {
				t.Fatalf("failed_windows = %#v, want %v", after["failed_windows"], tc.failed)
			}
			for field, want := range map[string]float64{"audit_rows": 4, "access_reviews": 3, "hygiene_reviews": 1, "alert_investigations": 2, "sessions": 0} {
				if after[field] != want {
					t.Errorf("%s = %v, want %v (a window after a failed one still counts)", field, after[field], want)
				}
			}
			if len(tc.failed) == 0 {
				if rec.Result != audit.ResultSuccess || rec.Error != "" {
					t.Fatalf("a run with no failed window: result %q, error %q", rec.Result, rec.Error)
				}
				return
			}
			if rec.Result != audit.ResultFailure {
				t.Fatalf("result = %q, want failure", rec.Result)
			}
			for _, err := range tc.fail {
				if !strings.Contains(rec.Error, err.Error()) {
					t.Errorf("error %q does not say %q", rec.Error, err)
				}
			}
		})
	}
}

// The run's record names the tool approvals the chat window deleted while approved, by their age and with their
// expired conversation; a batch of conversations that did not commit (a statement refused, or the commit itself)
// names none of its approvals, which are still there.
func TestTheChatWindowNamesTheApprovalsItDeletedWhileApproved(t *testing.T) {
	now := time.Date(2026, 11, 20, 3, 0, 0, 0, time.UTC)
	old, recent := now.AddDate(0, 0, -200), now.AddDate(0, 0, -1)
	byAge := []returnedApproval{
		{OpenApproval{ID: "a-old-approved", SessionID: "s-live", Tool: "k8s_patch_resource", Cluster: "self", ApprovedAt: &old}, "approved"},
		{OpenApproval{ID: "a-old-executed", SessionID: "s-live", Tool: "k8s_scale", Cluster: "self", ApprovedAt: &old}, "executed"},
	}
	withSession := []returnedApproval{
		{OpenApproval{ID: "a-idle-approved", SessionID: "s-idle", Tool: "k8s_scale", Cluster: "prod", ApprovedAt: &recent}, "approved"},
		{OpenApproval{ID: "a-idle-rejected", SessionID: "s-idle", Tool: "k8s_scale", Cluster: "prod", ApprovedAt: &recent}, "rejected"},
	}
	want := map[string]OpenApproval{byAge[0].ID: byAge[0].OpenApproval, withSession[0].ID: withSession[0].OpenApproval}
	for _, tc := range []struct {
		name      string
		fail      map[string]error
		commitErr error
		approvals int64
		named     []string
		failed    []string
	}{
		{"committed", nil, nil, 4, []string{"a-old-approved", "a-idle-approved"}, []string{}},
		{"conversations refused", map[string]error{"sessions": sessionsStillNamed}, nil, 2, []string{"a-old-approved"}, []string{"chat"}},
		{"conversations' commit failed", nil, errors.New("commit failed"), 2, []string{"a-old-approved"}, []string{"chat"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := &fakeDB{fail: tc.fail, commitErr: tc.commitErr, returns: map[string][]returnedApproval{"tool_approvals WHERE created_at < $1": byAge, "tool_approvals WHERE session_id = ANY($1)": withSession}}
			w := &captureWriter{}
			res := Purger{Pool: db, Cfg: Config{ChatDays: 180}, Audit: w, Now: func() time.Time { return now }}.RunOnce(context.Background())
			if res.ToolApprovals != tc.approvals {
				t.Fatalf("tool_approvals = %d, want %d", res.ToolApprovals, tc.approvals)
			}
			if len(w.recs) != 1 {
				t.Fatalf("want one audit record, got %d", len(w.recs))
			}
			var after struct {
				OpenApprovals []OpenApproval `json:"open_approvals"`
				Failed        []string       `json:"failed_windows"`
			}
			if err := json.Unmarshal(w.recs[0].After, &after); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(after.Failed, tc.failed) {
				t.Fatalf("failed_windows = %v, want %v", after.Failed, tc.failed)
			}
			var named []string
			for _, a := range after.OpenApprovals {
				named = append(named, a.ID)
				e := want[a.ID]
				if a.SessionID != e.SessionID || a.Tool != e.Tool || a.Cluster != e.Cluster || a.ApprovedAt == nil || !a.ApprovedAt.Equal(*e.ApprovedAt) {
					t.Errorf("open_approvals has %+v, want %+v", a, e)
				}
			}
			if !slices.Equal(named, tc.named) {
				t.Fatalf("open_approvals names %v, want %v", named, tc.named)
			}
		})
	}
}

// The tool approvals' delete by age that fails after a full batch counts that batch: its rows are gone and those of
// them deleted while approved are named, so the record never names more approvals than it counts.
func TestAnApprovalsDeleteByAgeThatFailsAfterABatchCountsThatBatch(t *testing.T) {
	now := time.Date(2026, 11, 21, 3, 0, 0, 0, time.UTC)
	old := now.AddDate(0, 0, -200)
	batch := make([]returnedApproval, BatchSize)
	for i := range batch {
		batch[i] = returnedApproval{OpenApproval{ID: fmt.Sprintf("a-%d", i), SessionID: "s-live", Tool: "k8s_scale", Cluster: "self", ApprovedAt: &old}, "executed"}
	}
	batch[0].status = "approved"
	db := &fakeDB{
		fail:    map[string]error{"tool_approvals": errors.New("approvals refused")},
		passes:  map[string]int{"tool_approvals": 1},
		returns: map[string][]returnedApproval{"tool_approvals WHERE created_at < $1": batch},
	}
	w := &captureWriter{}
	res := Purger{Pool: db, Cfg: Config{ChatDays: 180}, Audit: w, Now: func() time.Time { return now }}.RunOnce(context.Background())
	if res.ToolApprovals != BatchSize {
		t.Fatalf("tool_approvals = %d, want %d (the batch deleted before the failure)", res.ToolApprovals, BatchSize)
	}
	if len(w.recs) != 1 {
		t.Fatalf("want one audit record, got %d", len(w.recs))
	}
	var after struct {
		ToolApprovals int64          `json:"tool_approvals"`
		OpenApprovals []OpenApproval `json:"open_approvals"`
		Failed        []string       `json:"failed_windows"`
	}
	if err := json.Unmarshal(w.recs[0].After, &after); err != nil {
		t.Fatal(err)
	}
	if after.ToolApprovals != BatchSize || len(after.OpenApprovals) != 1 || after.OpenApprovals[0].ID != "a-0" {
		t.Fatalf("tool_approvals = %d, open_approvals = %+v; want %d and a-0", after.ToolApprovals, after.OpenApprovals, BatchSize)
	}
	if !slices.Equal(after.Failed, []string{"chat"}) || !strings.Contains(w.recs[0].Error, "tool approvals: approvals refused") {
		t.Fatalf("failed_windows = %v, error = %q; want [chat] and the approvals' error", after.Failed, w.recs[0].Error)
	}
}
