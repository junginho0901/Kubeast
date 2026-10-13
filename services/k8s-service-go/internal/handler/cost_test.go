package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func costRequest(path string, perms auth.PermissionMatrix) *http.Request {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	payload := auth.TokenPayload{UserID: "u1", Email: "r@example.com", Perms: perms}
	return r.WithContext(cluster.WithID(auth.WithPayload(r.Context(), payload), "self"))
}

// The switch off answers 404 before any permission check; a grant without
// resource.cost.read is refused (a read denial is not an audit row, like every
// other read); a window or aggregate OpenCost would not take is refused before
// the cluster is touched.
func TestCostGates(t *testing.T) {
	store := &memAudit{}
	h := &Handler{auditStore: store}
	read := auth.PermissionMatrix{"self": {"resource.*.read"}}

	t.Setenv("COST_ENABLED", "false")
	for name, call := range map[string]http.HandlerFunc{"cost": h.GetCost, "status": h.GetCostStatus} {
		rec := httptest.NewRecorder()
		call(rec, costRequest("/api/v1/cost", read))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s with the switch off: status %d", name, rec.Code)
		}
	}
	if len(store.rows) != 0 {
		t.Fatalf("switch off wrote %d rows", len(store.rows))
	}

	t.Setenv("COST_ENABLED", "true")
	rec := httptest.NewRecorder()
	h.GetCost(rec, costRequest("/api/v1/cost", auth.PermissionMatrix{"self": {"resource.pod.read"}}))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "resource.cost.read") {
		t.Fatalf("pod reader: status %d body %s", rec.Code, rec.Body.String())
	}
	if len(store.rows) != 0 {
		t.Fatalf("a refused read wrote %d audit rows", len(store.rows))
	}

	for _, q := range []string{"?window=2h", "?window=today", "?aggregate=pod", "?window=24h&aggregate=namespace,controller"} {
		rec = httptest.NewRecorder()
		h.GetCost(rec, costRequest("/api/v1/cost"+q, read))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d", q, rec.Code)
		}
	}
}

// resource.*.read (the Read role) covers cost: the request passes the gate and
// reaches the cluster, which here has no OpenCost.
func TestCostReadRolePasses(t *testing.T) {
	t.Setenv("COST_ENABLED", "true")
	svc, err := k8s.NewService(context.Background(), middlewareRegistry{}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{svc: svc, auditStore: &memAudit{}}
	reader := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"known": {"resource.*.read"}}}
	for _, path := range []string{"/api/v1/cost?window=24h", "/api/v1/cost/status"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r = r.WithContext(cluster.WithID(auth.WithPayload(r.Context(), reader), "known"))
		rec := httptest.NewRecorder()
		if strings.HasSuffix(path, "/status") {
			h.GetCostStatus(rec, r)
			if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"available":false`) {
				t.Fatalf("status: %d %s", rec.Code, rec.Body.String())
			}
			continue
		}
		h.GetCost(rec, r)
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "OpenCost not found") {
			t.Fatalf("cost: %d %s", rec.Code, rec.Body.String())
		}
	}
}
