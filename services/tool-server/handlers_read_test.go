package main

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestCheckResourceAllowed(t *testing.T) {
	denied := []string{"secret", "secrets", "Secrets", "secret/db-pass", "secrets.v1", "secrets.core", "pods,secrets", " secrets "}
	for _, rt := range denied {
		if err := checkResourceAllowed(rt); err == nil {
			t.Errorf("%q should be denied", rt)
		} else if !errors.Is(err, errBadRequest) {
			t.Errorf("%q: expected bad-request error, got %v", rt, err)
		}
	}
	allowed := []string{"pods", "configmaps", "deployments.apps", "pod/web-1", "secretproviderclasses", "all"}
	for _, rt := range allowed {
		if err := checkResourceAllowed(rt); err != nil {
			t.Errorf("%q should be allowed: %v", rt, err)
		}
	}
}

// The three read handlers must refuse before ever invoking kubectl.
func TestReadHandlersRefuseSecrets(t *testing.T) {
	args := map[string]interface{}{"resource_type": "secrets", "resource_name": "db", "namespace": "default"}
	for name, h := range map[string]ToolHandler{
		"get":      handleGetResources,
		"yaml":     handleGetResourceYAML,
		"describe": handleDescribeResource,
	} {
		out, err := h(context.Background(), args, http.Header{})
		if err == nil || out != "" {
			t.Errorf("%s: expected refusal, got out=%q err=%v", name, out, err)
		}
	}
}
