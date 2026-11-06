package handler

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
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
		{"POST", "/api/v1/hygiene/signoff", nil},
		{"POST", "/api/v1/alertstore/silences", nil},
		{"DELETE", "/api/v1/alertstore/silences/s1", nil},
	}
	for _, tc := range cases {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		got := gitopsTargets(r)
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
	inYAML := []gitopsTarget{
		{apiVersion: "apps/v1", kind: "Deployment", namespace: "ns", name: "web", inBody: true},
		{apiVersion: "v1", kind: "ConfigMap", namespace: "other", name: "cm", inBody: true},
	}
	for path, address := range map[string]gitopsTarget{
		"/api/v1/namespaces/ns/yaml/apply": {resourceType: "namespaces", name: "ns"},
		"/api/v1/nodes/n1/yaml/apply":      {resourceType: "nodes", name: "n1"},
	} {
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		got := gitopsTargets(r)
		want := append(append([]gitopsTarget{}, inYAML...), address)
		if !slices.Equal(got, want) {
			t.Fatalf("%s: got %+v, want %+v", path, got, want)
		}
		// The body is still there for the handler.
		rest, _ := io.ReadAll(r.Body)
		if string(rest) != body {
			t.Fatalf("%s: body was not restored", path)
		}
	}
}

// The patch of a YAML apply goes where its JSON says, read as the handler reads it.
func TestGitopsTargetsFromApply(t *testing.T) {
	address := gitopsTarget{resourceType: "deployments", namespace: "ns", name: "web"}
	for name, body := range map[string]string{
		"name":                      `{"resource_type":"deployments","namespace":"ns","name":"web","yaml":"spec:\n  replicas: 0\n"}`,
		"resource_name":             `{"resource_type":"deployments","namespace":"ns","resource_name":"web","yaml":"spec:\n  replicas: 0\n"}`,
		"name before resource_name": `{"resource_type":"deployments","namespace":"ns","name":"web","resource_name":"other","yaml":""}`,
		"bytes after the JSON":      `{"resource_type":"deployments","namespace":"ns","name":"web","yaml":""} more`,
	} {
		r := httptest.NewRequest("POST", "/api/v1/resources/yaml/apply", strings.NewReader(body))
		if got := gitopsTargets(r); !slices.Equal(got, []gitopsTarget{address}) {
			t.Errorf("%s: got %+v", name, got)
		}
		rest, _ := io.ReadAll(r.Body)
		if string(rest) != body {
			t.Errorf("%s: body was not restored", name)
		}
	}
	r := httptest.NewRequest("POST", "/api/v1/resources/yaml/apply", strings.NewReader(`{"resource_type":"deployments","namespace":"ns","name":"web","yaml":"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: other\n"}`))
	want := []gitopsTarget{{apiVersion: "apps/v1", kind: "Deployment", namespace: "ns", name: "other", inBody: true}, address}
	if got := gitopsTargets(r); !slices.Equal(got, want) {
		t.Errorf("a body naming another object: got %+v, want %+v", got, want)
	}
	if got := gitopsTargets(httptest.NewRequest("POST", "/api/v1/resources/yaml/apply", strings.NewReader("not json"))); got != nil {
		t.Errorf("not JSON is the handler's: got %+v", got)
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
