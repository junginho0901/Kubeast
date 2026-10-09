package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A call that names no cluster is refused before authorization or kubectl:
// ai-service always sends the cluster it resolved, and an empty one must not be
// read as a cluster that happens to be called "default".
func TestHandleCallRequiresCluster(t *testing.T) {
	ran := false
	tools := map[string]ToolDefinition{"k8s_get_resources": {
		Name: "k8s_get_resources",
		Handler: func(context.Context, map[string]interface{}, http.Header) (string, error) {
			ran = true
			return "", nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/call", strings.NewReader(`{"name":"k8s_get_resources","arguments":{"resource_type":"pods"}}`))
	rec := httptest.NewRecorder()
	handleCall(rec, req, tools)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "cluster is required") || ran {
		t.Fatalf("status %d body %s ran=%v, want 400 cluster is required and no run", rec.Code, rec.Body.String(), ran)
	}
}
