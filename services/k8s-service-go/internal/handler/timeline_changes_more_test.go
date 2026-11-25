package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
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

// changesAnswerOf asks the changes route of k8s-service as the configuration it loads from the environment serves it,
// as a person of one cluster, and gives the answer's code and sources and the cluster's lists it made as that person.
func changesAnswerOf(t *testing.T, path string) (code int, bySource map[string]interface{}, lists []string) {
	t.Helper()
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
				next.ServeHTTP(w, req.WithContext(auth.WithPayload(req.Context(), payloadFor())))
			})
		})
		g.Use(h.ClusterMiddleware)
		g.Use(h.NamespaceScopeMiddleware)
		routes.Register(g, h, ws.NewMultiplexer(nil))
	})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	var answer struct {
		Summary struct {
			BySource map[string]interface{} `json:"by_source"`
		} `json:"summary"`
	}
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
			t.Fatal(err)
		}
	}
	for _, call := range api.callerCalls() {
		if call.method == http.MethodGet {
			lists = append(lists, call.path)
		}
	}
	return w.Code, answer.Summary.BySource, lists
}

var furtherLists = []string{
	"/apis/batch/v1/namespaces/shop/jobs", "/apis/networking.k8s.io/v1/namespaces/shop/networkpolicies",
	"/api/v1/namespaces/shop/services", "/apis/apps/v1/namespaces/shop/deployments",
}

// AI_TIMELINE_CHANGES_MORE adds the further sources to the changes view of a namespace, each list going out as the
// person who asked; off, or with no namespace, none is asked, and alone it opens no route.
func TestTimelineChangesMore_TheSwitchAddsTheSourcesOfANamespace(t *testing.T) {
	const inShop, everywhere = "/api/v1/namespaces/shop/timeline/changes?cluster=c", "/api/v1/timeline/changes?cluster=c"
	for _, c := range []struct {
		name, view, more, path string
		code                   int
		sources                bool // named in by_source
		lists                  bool // asked of the cluster
	}{
		{"both off", "", "", inShop, 404, false, false},
		{"the sources alone", "", "true", inShop, 404, false, false},
		{"the view alone", "true", "", inShop, 200, false, false},
		{"the view and a word that is no switch", "true", "maybe", inShop, 200, false, false},
		{"both", "true", "On", inShop, 200, true, true},
		{"both, every namespace", "true", "true", everywhere, 200, true, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("AI_TIMELINE_CHANGES", c.view)
			t.Setenv("AI_TIMELINE_CHANGES_MORE", c.more)
			t.Setenv("ALERT_INVESTIGATION_ENABLED", "")
			code, bySource, lists := changesAnswerOf(t, c.path)
			if code != c.code {
				t.Fatalf("status %d, want %d", code, c.code)
			}
			for _, source := range []string{"jobs", "networkpolicies", "services", "deployment_replicas", "statefulset_replicas"} {
				if _, named := bySource[source]; named != c.sources {
					t.Errorf("by_source %v, want %s named: %v", bySource, source, c.sources)
				}
			}
			for _, path := range furtherLists {
				if asked := slices.Contains(lists, path); asked != c.lists {
					t.Errorf("%s asked as the person: %v, want %v", path, asked, c.lists)
				}
			}
			if code == 200 && len(lists) < 8 {
				t.Errorf("%d lists as the person: %v", len(lists), lists)
			}
		})
	}
}
