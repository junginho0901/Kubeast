package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// drainRows hands each audit row to the test as it is written.
type drainRows chan audit.Record

func (c drainRows) Write(_ context.Context, rec audit.Record) (int64, error) {
	c <- rec
	return 1, nil
}

// A drain's status is answered on the cluster the drain runs on: a request on another cluster does not find it,
// whatever the caller holds there.
func TestADrainsStatusIsReadOnItsOwnClusterOnly(t *testing.T) {
	svc, err := k8s.NewService(context.Background(), guardRegistry{}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	rows := make(drainRows, 4)
	h := &Handler{svc: svc, auditStore: rows}
	request := func(method, target string, clusterID cluster.ID, perms auth.PermissionMatrix) *http.Request {
		r := httptest.NewRequest(method, target, nil)
		rc := chi.NewRouteContext()
		rc.URLParams.Add("name", "n1")
		ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rc)
		ctx = auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Email: "ops@example.com", Perms: perms})
		return r.WithContext(cluster.WithID(ctx, clusterID))
	}
	both := auth.PermissionMatrix{"a": {"resource.node.drain"}, "b": {"resource.node.drain"}}

	w := httptest.NewRecorder()
	h.DrainNode(w, request(http.MethodPost, "/api/v1/nodes/n1/drain", "a", both))
	var started struct {
		DrainID string `json:"drain_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &started); w.Code != http.StatusOK || err != nil || started.DrainID == "" {
		t.Fatalf("drain not started: %d %s", w.Code, w.Body)
	}
	// started, then finished: this registry has no cluster a, so the drain ends at once
	for range 2 {
		select {
		case <-rows:
		case <-time.After(10 * time.Second):
			t.Fatal("the drain did not end")
		}
	}

	status := func(clusterID cluster.ID, perms auth.PermissionMatrix) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.DrainNodeStatus(w, request(http.MethodGet, "/api/v1/nodes/n1/drain/status?drain_id="+started.DrainID, clusterID, perms))
		return w
	}
	if got := status("a", both); got.Code != http.StatusOK {
		t.Errorf("on its own cluster: %d %s, want 200", got.Code, got.Body)
	}
	for name, perms := range map[string]auth.PermissionMatrix{
		"holding drain on both clusters":  both,
		"holding drain on cluster b only": {"b": {"resource.node.drain"}},
	} {
		if got := status("b", perms); got.Code != http.StatusNotFound {
			t.Errorf("%s, on cluster b: %d %s, want 404", name, got.Code, got.Body)
		}
	}
}
