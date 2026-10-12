package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A create with no YAML is a 400 before any permission check or cluster call
// (it used to answer 200 with nothing created).
func TestCreateResourcesFromYAMLEmptyIs400(t *testing.T) {
	h := &Handler{}
	for _, body := range []string{`{}`, `{"yaml":"   \n"}`} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/resources/yaml/create", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		h.CreateResourcesFromYAML(rec, req)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "yaml is required") {
			t.Fatalf("body %s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
}
