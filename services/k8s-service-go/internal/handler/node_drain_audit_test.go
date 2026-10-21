package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// A drain's outcome is a second k8s.node.drain row with the request's actor,
// address and cluster: success when every pod was evicted, failure otherwise.
func TestTheDrainOutcomeIsRecorded(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/nodes/n1/drain", nil)
	r = r.WithContext(cluster.WithID(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "ops@example.com"}), cluster.ID("self")))
	base := auditBase(r, audit.ServiceK8s, "k8s.node.drain", "node", "n1", "")
	store := &memAudit{}
	h := &Handler{auditStore: store}

	setDrainStatus(&DrainStatus{ID: "d-ok", Node: "n1", Status: "success", Message: "drain completed, 3 pods evicted", Created: time.Now()})
	h.recordDrainEnd(base, "d-ok")
	setDrainStatus(&DrainStatus{ID: "d-bad", Node: "n1", Status: "error", Message: "drain incomplete: 1 of 3 pods could not be evicted", Created: time.Now()})
	h.recordDrainEnd(base, "d-bad")
	h.recordDrainEnd(base, "d-unknown") // nothing to say

	if len(store.rows) != 2 {
		t.Fatalf("rows %d", len(store.rows))
	}
	ok, bad := store.rows[0], store.rows[1]
	if ok.Action != "k8s.node.drain" || ok.Result != audit.ResultSuccess || ok.ActorUserID != "u1" || ok.Cluster != "self" ||
		ok.TargetID != "n1" || !strings.Contains(string(ok.After), `"phase":"finished"`) {
		t.Fatalf("success row %+v", ok)
	}
	if bad.Result != audit.ResultFailure || !strings.Contains(bad.Error, "could not be evicted") || !strings.Contains(string(bad.After), `"status":"error"`) {
		t.Fatalf("failure row %+v", bad)
	}
}
