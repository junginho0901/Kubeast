package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A page query the server cannot answer as asked is refused before the cluster is read.
func TestGetPodPageRefusesBadQueries(t *testing.T) {
	h := &Handler{} // no service: a query that passed the checks would panic here
	for _, q := range []string{"sort=image", "dir=up", "limit=0", "limit=501", "offset=-1", "owner=web-rs", "owner=/web-rs", "health=red", "service_account=app", "service_account=a/app,/b"} {
		rec := httptest.NewRecorder()
		h.GetPodPage(rec, httptest.NewRequest(http.MethodGet, "/api/v1/pods/page?"+q, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", q, rec.Code)
		}
		if q == "sort=image" && !strings.Contains(rec.Body.String(), "node_name") {
			t.Errorf("the refusal must list the sort keys: %s", rec.Body.String())
		}
	}
}

// The pods of one node need the node named; "" (the pods not scheduled) is a value, a missing one is refused.
func TestGetPodsOnNodeNeedsNode(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Handler{}).GetPodsOnNode(rec, httptest.NewRequest(http.MethodGet, "/api/v1/pods/on-node?namespace=a", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "node is required") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}
