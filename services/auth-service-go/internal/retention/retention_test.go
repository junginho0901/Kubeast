package retention

import (
	"context"
	"encoding/json"
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
