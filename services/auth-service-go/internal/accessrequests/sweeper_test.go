package accessrequests

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/audit"
)

type fakeStore struct {
	grants  []repository.ExpiredGrant
	lapsed  []repository.LapsedRequest
	before  time.Time
	grantsE error
}

func (f *fakeStore) ExpireGrants(context.Context, time.Time) ([]repository.ExpiredGrant, error) {
	return f.grants, f.grantsE
}

func (f *fakeStore) ExpirePendingRequests(_ context.Context, before, _ time.Time) ([]repository.LapsedRequest, error) {
	f.before = before
	return f.lapsed, nil
}

type memWriter struct{ recs []audit.Record }

func (m *memWriter) Write(_ context.Context, rec audit.Record) (int64, error) {
	m.recs = append(m.recs, rec)
	return int64(len(m.recs)), nil
}

func TestRunOnce_AuditsEveryReversalAsSystem(t *testing.T) {
	restored := "Read"
	reqID := "req-1"
	store := &fakeStore{
		grants: []repository.ExpiredGrant{{UserID: "u1", UserEmail: "dev@example.com", ClusterID: "beta", Role: "Write", RestoredRole: &restored, RequestID: &reqID}},
		lapsed: []repository.LapsedRequest{{ID: "req-2", UserID: "u2", UserEmail: "ops@example.com", ClusterID: "alpha", Role: "Write"}},
	}
	w := &memWriter{}
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	res := Sweeper{Store: store, Audit: w, Now: func() time.Time { return now }}.RunOnce(context.Background())

	if res.GrantsExpired != 1 || res.RequestsLapsed != 1 {
		t.Fatalf("result = %+v", res)
	}
	if !store.before.Equal(now.Add(-PendingTTL)) {
		t.Fatalf("pending cutoff = %v, want now-%v", store.before, PendingTTL)
	}
	if len(w.recs) != 2 {
		t.Fatalf("audit rows = %d, want 2", len(w.recs))
	}
	g := w.recs[0]
	if g.Action != ActionGrantExpire || g.ActorEmail != "system" || g.TargetID != "u1" || g.Cluster != "beta" || g.Result != audit.ResultSuccess {
		t.Fatalf("grant row = %+v", g)
	}
	if string(g.After) != `{"request_id":"req-1","restored_role":"Read","role":"Write"}` {
		t.Fatalf("grant after = %s", g.After)
	}
	l := w.recs[1]
	if l.Action != ActionRequestExpire || l.TargetEmail != "ops@example.com" || l.Cluster != "alpha" {
		t.Fatalf("lapsed row = %+v", l)
	}
}

func TestRunOnce_StoreErrorIsLoggedNotFatal(t *testing.T) {
	store := &fakeStore{grantsE: errors.New("db down")}
	res := Sweeper{Store: store, Audit: &memWriter{}}.RunOnce(context.Background())
	if res.GrantsExpired != 0 {
		t.Fatalf("result = %+v", res)
	}
}
