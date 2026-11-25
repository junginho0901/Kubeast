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
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/routes"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The v0.7.9 switches k8s-service reads, each unset: what the chart renders by default.
var v079Switches = []string{"ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED", "AI_TIMELINE_CHANGES", "AI_TIMELINE_CHANGES_MORE",
	"ALERT_INVESTIGATION_CHANGES_FIRST", "NODE_NEIGHBORS_ENABLED"}

// With every v0.7.9 switch unset, the configuration k8s-service loads offers the screens and the AI nothing new: the
// features answer says anomalyRank and callGraph are off (or does not name them, as 0.7.8), and the routes those
// switches open answer 404, as 0.7.8 has no such route.
func TestWithEveryV079SwitchOffTheFeaturesAndRoutesAreV078s(t *testing.T) {
	for _, name := range v079Switches {
		t.Setenv(name, "")
	}
	t.Setenv("PROMETHEUS_ENABLED", "false")
	api := newStandIn(t)
	blob := strings.Replace(standInKubeconfig, "SERVER", api.srv.URL, 1)
	svc, err := k8s.NewService(context.Background(), standInRegistry{blob: blob}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{Impersonation: true})
	if err != nil {
		t.Fatal(err)
	}
	h := handler.New(svc, config.Load(), &auditRows{})
	r := chi.NewRouter()
	r.Group(func(g chi.Router) {
		g.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				next.ServeHTTP(w, req.WithContext(auth.WithPayload(req.Context(), globalAdminPayload())))
			})
		})
		g.Use(h.ClusterMiddleware)
		g.Use(h.NamespaceScopeMiddleware)
		routes.Register(g, h, ws.NewMultiplexer(nil))
	})
	get := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		return w
	}

	w := get("/api/v1/features?cluster=c")
	if w.Code != http.StatusOK {
		t.Fatalf("features: status %d: %s", w.Code, w.Body.String())
	}
	var features map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &features); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"anomalyRank", "callGraph", "nodeNeighbors"} {
		raw, named := features[name]
		if !named {
			continue
		}
		var feature struct {
			Enabled *bool `json:"enabled"`
		}
		if err := json.Unmarshal(raw, &feature); err != nil || feature.Enabled == nil || *feature.Enabled {
			t.Errorf("features.%s = %s, want enabled false", name, raw)
		}
	}
	for _, path := range []string{
		"/api/v1/timeline/changes?cluster=c",
		"/api/v1/namespaces/shop/timeline/changes?cluster=c",
		"/api/v1/namespaces/shop/anomalies?cluster=c",
		"/api/v1/nodes/n1/neighbors?cluster=c",
	} {
		if w := get(path); w.Code != http.StatusNotFound {
			t.Errorf("GET %s: status %d, want 404: %s", path, w.Code, w.Body.String())
		}
	}
}
