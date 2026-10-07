package handler

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/gitops"
)

func TestGitopsTargetsFromPath(t *testing.T) {
	cases := []struct {
		method, path string
		want         []gitopsTarget
	}{
		{"DELETE", "/api/v1/namespaces/service-alpha/deployments/web", []gitopsTarget{{resourceType: "deployments", namespace: "service-alpha", name: "web"}}},
		{"POST", "/api/v1/namespaces/service-alpha/deployments/web/rollback", []gitopsTarget{{resourceType: "deployments", namespace: "service-alpha", name: "web"}}},
		{"POST", "/api/v1/namespaces/ns/cronjobs/cj/suspend", []gitopsTarget{{resourceType: "cronjobs", namespace: "ns", name: "cj"}}},
		{"DELETE", "/api/v1/namespaces/ns/hpas/h", []gitopsTarget{{resourceType: "hpas", namespace: "ns", name: "h"}}},
		{"DELETE", "/api/v1/namespaces/old", []gitopsTarget{{resourceType: "namespaces", name: "old"}}},
		{"POST", "/api/v1/namespaces", nil},
		{"DELETE", "/api/v1/clusterroles/cr", []gitopsTarget{{resourceType: "clusterroles", name: "cr"}}},
		{"POST", "/api/v1/nodes/n1/cordon", []gitopsTarget{{resourceType: "nodes", name: "n1"}}},
		{"DELETE", "/api/v1/custom-resources/kgateway.dev/v1alpha1/trafficpolicies/ns/tp", []gitopsTarget{{group: "kgateway.dev", version: "v1alpha1", plural: "trafficpolicies", namespace: "ns", name: "tp"}}},
		{"DELETE", "/api/v1/custom-resources/g/v1/things/-/x", []gitopsTarget{{group: "g", version: "v1", plural: "things", name: "x"}}},
		{"POST", "/api/v1/helm/releases/ns/rel/rollback", nil},
		{"POST", "/api/v1/search", nil},
		{"POST", "/api/v1/resources/yaml/create", nil},
	}
	for _, tc := range cases {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		got, err := gitopsTargets(r)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		if len(got) != len(tc.want) {
			t.Fatalf("%s %s: got %+v, want %+v", tc.method, tc.path, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("%s %s: got %+v, want %+v", tc.method, tc.path, got[i], tc.want[i])
			}
		}
	}
}

func TestGitopsTargetsFromYAMLBody(t *testing.T) {
	body := `{"namespace":"ns","yaml":"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n  namespace: other\n---\nkind: Nameless\n"}`
	r := httptest.NewRequest("POST", "/api/v1/namespaces/ns/yaml/apply", strings.NewReader(body))
	got, err := gitopsTargets(r)
	if err != nil {
		t.Fatal(err)
	}
	want := []gitopsTarget{
		{apiVersion: "apps/v1", kind: "Deployment", namespace: "ns", name: "web"},
		{apiVersion: "v1", kind: "ConfigMap", namespace: "other", name: "cm"},
	}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	// The body is still there for the handler.
	rest, _ := io.ReadAll(r.Body)
	if string(rest) != body {
		t.Fatal("body was not restored")
	}
	// /resources/yaml/apply and /nodes/{name}/yaml/apply read the body the same way.
	for _, p := range []string{"/api/v1/resources/yaml/apply", "/api/v1/nodes/n1/yaml/apply"} {
		r := httptest.NewRequest("POST", p, strings.NewReader(body))
		if got, _ := gitopsTargets(r); len(got) != 2 {
			t.Errorf("%s: got %+v", p, got)
		}
	}
}

type guardRegistry struct{}

func (guardRegistry) List(context.Context) ([]cluster.Info, error) { return nil, nil }
func (guardRegistry) Get(context.Context, cluster.ID) (*cluster.Info, error) {
	return nil, cluster.ErrNotFound
}
func (guardRegistry) Default(context.Context) (cluster.ID, error) { return "", cluster.ErrNotFound }

// Disabled, or enabled in warn mode, the guard never touches the request.
func TestGitopsGuardPassesUnlessBlocking(t *testing.T) {
	for _, cfg := range []gitops.Config{{}, {Enabled: true, Mode: gitops.ModeWarn}} {
		svc, err := k8s.NewService(context.Background(), guardRegistry{}, false, nil, k8s.ServiceOptions{Gitops: cfg})
		if err != nil {
			t.Fatal(err)
		}
		h := &Handler{svc: svc}
		called := false
		mw := h.GitopsGuard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
		r := httptest.NewRequest("DELETE", "/api/v1/namespaces/ns/deployments/web", nil)
		r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1"}))
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, r)
		if !called || rec.Code != http.StatusOK {
			t.Fatalf("cfg %+v: called=%v code=%d", cfg, called, rec.Code)
		}
	}
}
