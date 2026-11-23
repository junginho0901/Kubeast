package retention

import (
	"context"
	"encoding/json"
	"reflect"
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
		Purger{Cfg: Config{ChatDays: 180}, Audit: w}.record(context.Background(), now, c.res, nil)
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
