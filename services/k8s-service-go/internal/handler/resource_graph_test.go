package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A grouping the graph does not know is refused before the cluster is read.
func TestGetResourceGraphRefusesUnknownGrouping(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Handler{}).GetResourceGraph(rec, httptest.NewRequest(http.MethodGet, "/api/v1/resource-graph?namespaces=a&group_pods=1&group_by=owner", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "node or instance") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

// The namespace route (the AI tool resource_graph) reads the same options: an unknown grouping is refused there too.
func TestGetNamespaceResourceGraphReadsTheOptions(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Handler{}).GetNamespaceResourceGraph(rec, httptest.NewRequest(http.MethodGet, "/api/v1/namespaces/a/resource-graph?group_pods=1&group_by=owner", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "node or instance") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}
