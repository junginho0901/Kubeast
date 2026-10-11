package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func resizeRequest(body string, perms auth.PermissionMatrix) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/namespaces/apps/optimization/resize", strings.NewReader(body))
	payload := auth.TokenPayload{UserID: "u1", Email: "w@example.com", Perms: perms}
	return r.WithContext(cluster.WithID(auth.WithPayload(r.Context(), payload), "self"))
}

// The switch off answers 404 before any permission or body check; a reader is
// refused with one k8s.access.denied row.
func TestResizeOptimizationGates(t *testing.T) {
	store := &memAudit{}
	off := &Handler{cfg: config.Config{InPlaceResizeEnabled: false}, auditStore: store}
	rec := httptest.NewRecorder()
	off.ResizeOptimization(rec, resizeRequest(`{"kind":"Deployment","name":"web","container":"app","cpu_request_m":100}`, auth.PermissionMatrix{"self": {"resource.*.edit"}}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("switch off: status %d", rec.Code)
	}
	if len(store.rows) != 0 {
		t.Fatalf("switch off wrote %d rows", len(store.rows))
	}

	on := &Handler{cfg: config.Config{InPlaceResizeEnabled: true}, auditStore: store}
	rec = httptest.NewRecorder()
	on.ResizeOptimization(rec, resizeRequest(`{"kind":"Deployment","name":"web","container":"app","cpu_request_m":100}`, auth.PermissionMatrix{"self": {"resource.*.read"}}))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("reader: status %d body %s", rec.Code, rec.Body.String())
	}
	if len(store.rows) != 1 || store.rows[0].Action != "k8s.access.denied" || store.rows[0].TargetID != "resource.pod.edit" {
		t.Fatalf("rows = %+v", store.rows)
	}

	// A body without a workload or a value is refused before the cluster is touched.
	for _, body := range []string{`{"kind":"Node","name":"n","container":"c","cpu_request_m":1}`, `{"kind":"Deployment","name":"web","container":"app"}`, `{"kind":"Deployment","name":"","container":"app","cpu_request_m":1}`} {
		rec = httptest.NewRecorder()
		on.ResizeOptimization(rec, resizeRequest(body, auth.PermissionMatrix{"self": {"resource.*.edit"}}))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d", body, rec.Code)
		}
	}
}
