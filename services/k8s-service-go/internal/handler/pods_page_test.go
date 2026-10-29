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
	for _, q := range []string{"sort=image", "dir=up", "limit=0", "limit=501", "offset=-1"} {
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
