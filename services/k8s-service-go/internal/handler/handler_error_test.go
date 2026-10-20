package handler

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
)

func TestStatusForError(t *testing.T) {
	pods := schema.GroupResource{Resource: "pods"}
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"api not found", apierrors.NewNotFound(pods, "web-1"), http.StatusNotFound},
		{"api not found, wrapped", fmt.Errorf("get pod: %w", apierrors.NewNotFound(pods, "web-1")), http.StatusNotFound},
		{"api forbidden, wrapped", fmt.Errorf("list: %w", apierrors.NewForbidden(pods, "web-1", errors.New("rbac"))), http.StatusForbidden},
		{"api unauthorized", apierrors.NewUnauthorized("token expired"), http.StatusUnauthorized},
		{"api already exists", apierrors.NewAlreadyExists(pods, "web-1"), http.StatusConflict},
		{"api conflict", apierrors.NewConflict(pods, "web-1", errors.New("resourceVersion")), http.StatusConflict},
		{"api invalid", apierrors.NewBadRequest("bad selector"), http.StatusBadRequest},
		{"api server timeout", apierrors.NewServerTimeout(pods, "list", 1), http.StatusServiceUnavailable},
		// Errors without a status (helm, registry, exec) keep the message mapping.
		{"text not found", errors.New("release not found"), http.StatusNotFound},
		{"text forbidden", errors.New("forbidden: no access to cluster x"), http.StatusForbidden},
		{"text unreachable", errors.New("dial tcp: connection refused"), http.StatusServiceUnavailable},
		{"yaml parse", fmt.Errorf("parse YAML: %w", errors.New("yaml: unmarshal errors: line 16: mapping key already defined")), http.StatusBadRequest},
		{"unknown", errors.New("boom"), http.StatusInternalServerError},
		// The metrics store: its own error is not this service's (502), a missing API is 404, a bad selector 400.
		{"metrics store 401", fmt.Errorf("%w: prometheus request failed (status 401): Invalid API key", k8s.ErrPrometheusUpstream), http.StatusBadGateway},
		{"metrics store unreachable", fmt.Errorf("%w: prometheus request failed: dial tcp: connection refused", k8s.ErrPrometheusUpstream), http.StatusBadGateway},
		{"metrics store without rules", fmt.Errorf("%w: /api/v1/rules", k8s.ErrPrometheusNotServed), http.StatusNotFound},
		{"bad selector", fmt.Errorf("%w: sum(up) is an expression", k8s.ErrBadSelector), http.StatusBadRequest},
		{"query a shared store cannot scope", fmt.Errorf("%w: parse error", k8s.ErrBadQuery), http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := statusForError(tc.err); got != tc.want {
				t.Fatalf("statusForError(%v) = %d, want %d", tc.err, got, tc.want)
			}
		})
	}
}

func TestUninstallConfirmed(t *testing.T) {
	if !uninstallConfirmed("", "web", true) {
		t.Fatal("dry run must not require confirmation")
	}
	if uninstallConfirmed("", "web", false) {
		t.Fatal("missing confirm must be refused")
	}
	if uninstallConfirmed("wrong", "web", false) {
		t.Fatal("mismatched confirm must be refused")
	}
	if !uninstallConfirmed("web", "web", false) {
		t.Fatal("matching confirm must pass")
	}
	if uninstallConfirmed("", "", false) {
		t.Fatal("empty release name must be refused")
	}
}
