package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nodecpu"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// nodeNeighborsRoute is the route on a real service of a stand-in cluster, for payload, with its switch at on.
func nodeNeighborsRoute(t *testing.T, on string, payload auth.TokenPayload) (*standIn, *auditRows, func(path string) *httptest.ResponseRecorder) {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "false")
	t.Setenv("NODE_NEIGHBORS_ENABLED", on)
	api := newStandIn(t)
	blob := strings.Replace(standInKubeconfig, "SERVER", api.srv.URL, 1)
	svc, err := k8s.NewService(context.Background(), standInRegistry{blob: blob}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{Impersonation: true})
	if err != nil {
		t.Fatal(err)
	}
	rows := &auditRows{}
	h := handler.New(svc, config.Load(), rows)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(auth.WithPayload(req.Context(), payload)))
		})
	})
	r.Use(h.ClusterMiddleware)
	r.Get("/api/v1/nodes/{name}/neighbors", h.NodeNeighbors().Get)
	return api, rows, func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		return w
	}
}

// The reads go out as the signed-in user (the node's pods may be the shared read of kubeast:cache, as the node drawer's),
// only reads, no Secret, and no audit row: a metric read leaves none, the AI call's row is ai-service's.
func TestNodeNeighborsReadsTheClusterAsTheCaller(t *testing.T) {
	api, rows, get := nodeNeighborsRoute(t, "true", globalAdminPayload())
	w := get("/api/v1/nodes/n1/neighbors?cluster=c")
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var res nodecpu.Result
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Node.Target != "Node/n1" || res.Node.Role != nodecpu.NodeUnknown || len(res.NotRun) == 0 || res.NotRun[0].What != nodecpu.WhatPrometheus {
		t.Fatalf("%s", w.Body)
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	node, pods := false, false
	for _, c := range api.calls {
		if c.user != signedInUser && c.user != "kubeast:cache" {
			t.Errorf("%s %s went out as %q", c.method, c.path, c.user)
		}
		if strings.Contains(c.path, "secrets") || (c.method != http.MethodGet && !strings.HasSuffix(c.path, "selfsubjectaccessreviews")) {
			t.Errorf("%s %s", c.method, c.path)
		}
		node = node || (c.path == "/api/v1/nodes/n1" && c.user == signedInUser)
		pods = pods || (strings.HasSuffix(c.path, "/pods") && strings.Contains(c.query, "spec.nodeName"))
	}
	if !node || !pods {
		t.Fatalf("the node was not read as the caller, or not its pods: %+v", api.calls)
	}
	if got := rows.actions(); len(got) != 0 {
		t.Fatalf("audit rows %v", got)
	}
}

func TestNodeNeighborsOfALimitedGrantKeepsToItsNamespaces(t *testing.T) {
	limited := globalAdminPayload()
	limited.Perms = auth.PermissionMatrix{"c": {"resource.*.read"}}
	limited.Namespaces = map[string][]string{"c": {inside}}
	api, _, get := nodeNeighborsRoute(t, "true", limited)
	w := get("/api/v1/nodes/n1/neighbors?cluster=c")
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), outside) || strings.Contains(w.Body.String(), second) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	for _, c := range api.calls {
		if strings.Contains(c.path, "/namespaces/"+outside) || strings.Contains(c.path, "/namespaces/"+second) ||
			(c.path == "/api/v1/pods" && c.user == signedInUser) || c.path == "/apis/metrics.k8s.io/v1beta1/pods" {
			t.Errorf("%s %s?%s reaches past the grant", c.method, c.path, c.query)
		}
	}
}

func TestNodeNeighborsOffAnswers404AndAsksTheClusterNothing(t *testing.T) {
	for _, off := range []string{"", "false", "0", "no"} {
		api, _, get := nodeNeighborsRoute(t, off, globalAdminPayload())
		if w := get("/api/v1/nodes/n1/neighbors?cluster=c"); w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "features.nodeNeighbors.enabled") {
			t.Fatalf("%q: %d %s", off, w.Code, w.Body)
		}
		api.mu.Lock()
		for _, c := range api.calls {
			if strings.Contains(c.path, "/nodes") || strings.Contains(c.path, "/pods") || strings.Contains(c.path, "metrics.k8s.io") {
				t.Errorf("%q: %s %s", off, c.method, c.path)
			}
		}
		api.mu.Unlock()
	}
}
