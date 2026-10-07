package dormant

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/audit"
)

type fakeStore struct {
	cutoff, now  time.Time
	exemptAdmins bool
	locked       []repository.DormantLocked
	err          error
}

func (f *fakeStore) LockDormantAccounts(_ context.Context, cutoff, now time.Time, exemptAdmins bool) ([]repository.DormantLocked, error) {
	f.cutoff, f.now, f.exemptAdmins = cutoff, now, exemptAdmins
	return f.locked, f.err
}

type memAudit struct{ recs []audit.Record }

func (m *memAudit) Write(_ context.Context, rec audit.Record) (int64, error) {
	m.recs = append(m.recs, rec)
	return int64(len(m.recs)), nil
}

func TestRunOncePassesCutoffAndRecordsEachLock(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	store := &fakeStore{locked: []repository.DormantLocked{
		{UserID: "u1", Email: "old@example.com", LastActivity: now.AddDate(0, 0, -120)},
		{UserID: "u2", Email: "older@example.com", LastActivity: now.AddDate(0, 0, -400)},
	}}
	aud := &memAudit{}
	res := Sweeper{Store: store, Audit: aud, Now: func() time.Time { return now }, Days: 90, ExemptAdmins: true}.RunOnce(context.Background())

	if !store.cutoff.Equal(now.AddDate(0, 0, -90)) || !store.now.Equal(now) || !store.exemptAdmins {
		t.Fatalf("store called with cutoff=%v now=%v exempt=%v", store.cutoff, store.now, store.exemptAdmins)
	}
	if len(res.Locked) != 2 || res.Err != nil || !res.Cutoff.Equal(now.AddDate(0, 0, -90)) {
		t.Fatalf("result = %+v", res)
	}
	if len(aud.recs) != 2 {
		t.Fatalf("audit records = %d, want 2", len(aud.recs))
	}
	rec := aud.recs[1]
	if rec.Action != ActionLock || rec.ActorEmail != "system" || rec.TargetID != "u2" || rec.TargetEmail != "older@example.com" || rec.Result != audit.ResultSuccess {
		t.Errorf("record = %+v", rec)
	}
	var after map[string]any
	_ = json.Unmarshal(rec.After, &after)
	if after["days"] != float64(90) || after["last_activity"] != now.AddDate(0, 0, -400).Format(time.RFC3339) || after["exempt_admins"] != true {
		t.Errorf("after = %v", after)
	}
}

func TestRunOnceStoreErrorAndZeroDays(t *testing.T) {
	store := &fakeStore{err: errors.New("db down")}
	aud := &memAudit{}
	res := Sweeper{Store: store, Audit: aud, Days: 90}.RunOnce(context.Background())
	if res.Err == nil || len(res.Locked) != 0 || len(aud.recs) != 0 {
		t.Fatalf("error should be reported and nothing recorded: %+v %d", res, len(aud.recs))
	}
	store2 := &fakeStore{locked: []repository.DormantLocked{{UserID: "u1"}}}
	if res := (Sweeper{Store: store2, Days: 0}).RunOnce(context.Background()); len(res.Locked) != 0 || !store2.now.IsZero() {
		t.Fatalf("Days 0 must not touch the store: %+v", res)
	}
}
