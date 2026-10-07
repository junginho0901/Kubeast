package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func TestClusterSwitchRecordsUserClusterSwitch(t *testing.T) {
	store := &memAuditStore{}
	h := &AuthHandler{auditStore: store}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/audit/cluster-switch", strings.NewReader(`{"previous_cluster":"self","new_cluster":"test2"}`))
	r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "u1@example.com"}))
	rec := httptest.NewRecorder()
	h.ClusterSwitch(rec, r)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	if len(store.written) != 1 {
		t.Fatalf("audit rows %d, want 1", len(store.written))
	}
	got := store.written[0]
	if got.Action != "user.cluster.switch" || got.TargetID != "test2" || got.Cluster != "test2" || got.ActorUserID != "u1" {
		t.Errorf("row = action %q target %q cluster %q actor %q", got.Action, got.TargetID, got.Cluster, got.ActorUserID)
	}
}
