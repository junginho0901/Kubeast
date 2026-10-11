package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// A refused write or sensitive action leaves one k8s.access.denied row; a
// refused read and a capability question (canForCluster) leave none.
func TestDeniedActionsAreRecorded(t *testing.T) {
	store := &memAudit{}
	h := &Handler{auditStore: store}
	reader := auth.TokenPayload{UserID: "u1", Email: "r@example.com", Perms: auth.PermissionMatrix{"self": {"menu.dashboard"}}}
	req := func(method string) *http.Request {
		r := httptest.NewRequest(method, "/api/v1/namespaces/default/configmaps/x", nil)
		return r.WithContext(cluster.WithID(auth.WithPayload(r.Context(), reader), "self"))
	}

	if err := h.requirePermissionForCluster(req(http.MethodDelete), "resource.configmap.delete"); err == nil {
		t.Fatal("delete allowed for a reader")
	}
	if err := h.requirePermissionForCluster(req(http.MethodGet), "resource.pod.read"); err == nil {
		t.Fatal("pod read allowed without a grant")
	}
	if h.canForCluster(req(http.MethodGet), "resource.secret.reveal") {
		t.Fatal("reveal allowed for a reader")
	}
	if err := h.requirePermission(req(http.MethodGet), "admin.sessions.read"); err == nil {
		t.Fatal("admin read allowed for a reader")
	}

	if len(store.rows) != 2 {
		t.Fatalf("rows = %+v, want the delete and the admin read", store.rows)
	}
	for i, want := range []string{"resource.configmap.delete", "admin.sessions.read"} {
		got := store.rows[i]
		if got.Action != "k8s.access.denied" || got.TargetID != want || got.Result != "failure" || got.Cluster != "self" {
			t.Errorf("row %d = %s %s %s %s", i, got.Action, got.TargetID, got.Result, got.Cluster)
		}
	}
}

// A user with no grant on the cluster: a write is recorded at the cluster
// gate, a read is not.
func TestClusterGateRecordsRefusedWrites(t *testing.T) {
	svc, err := k8s.NewService(context.Background(), middlewareRegistry{def: "known"}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	store := &memAudit{}
	h := &Handler{svc: svc, auditStore: store}
	member := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{}}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		r := httptest.NewRequest(method, "/api/v1/resources/yaml/create?cluster=known", nil)
		r = r.WithContext(auth.WithPayload(r.Context(), member))
		rec := httptest.NewRecorder()
		h.ClusterMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(rec, r)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s: status %d", method, rec.Code)
		}
	}
	if len(store.rows) != 1 || store.rows[0].Action != "k8s.access.denied" || store.rows[0].Cluster != "known" {
		t.Errorf("rows = %+v, want one k8s.access.denied for the POST", store.rows)
	}
}
