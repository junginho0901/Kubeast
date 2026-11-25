package handler_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/routes"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// keptRig asks one service and one handler as more than one token, so what either keeps is there for the next.
type keptRig struct {
	*scopeRig
	payload auth.TokenPayload
}

func newKeptRig(t *testing.T) *keptRig {
	t.Helper()
	k := &keptRig{scopeRig: newScopeRig(t, auth.TokenPayload{}, nil)}
	h := handler.New(k.svc, config.Config{ImpersonationEnabled: true, HygieneEnabled: true, NodeShellEnabled: true, HygieneIntervalDays: 30, TimelineChangesView: true}, k.audit)
	r := chi.NewRouter()
	r.Use(chimiddleware.Recoverer)
	r.Group(func(g chi.Router) {
		g.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				next.ServeHTTP(w, req.WithContext(auth.WithPayload(req.Context(), k.payload)))
			})
		})
		g.Use(h.ClusterMiddleware)
		g.Use(h.NamespaceScopeMiddleware)
		routes.Register(g, h, ws.NewMultiplexer(nil))
	})
	k.router = r
	return k
}

func (k *keptRig) ask(p auth.TokenPayload, target string) (int, string) {
	k.payload = p
	w := k.do("GET", target, "")
	return w.Code, w.Body.String()
}

// keptFor are tokens whose identity in the cluster is the same whatever namespaces their grant is limited to: alert
// investigations, each limited to its alert's namespace, and a person with a custom role whose grant was changed.
var keptFor = map[string]func(namespaces ...string) auth.TokenPayload{
	"investigations": func(namespaces ...string) auth.TokenPayload {
		p := payloadFor(namespaces...)
		p.UserID, p.Email, p.System, p.Roles = "system", auth.UserInvestigator, auth.SystemInvestigator, nil
		return p
	},
	"a person's grant": func(namespaces ...string) auth.TokenPayload {
		p := payloadFor(namespaces...)
		p.Roles = map[string]string{"c": "team"}
		return p
	},
}

// No GET route gives a token what it kept for another token of the same identity limited to other namespaces. Every
// route without a namespace in its path is asked by a token limited to one namespace and then by one limited to another:
// a route that keeps an answer and leaves the grant's namespaces out of its key fails here.
func TestNoRouteGivesATokenWhatItKeptForOtherNamespaces(t *testing.T) {
	skip := map[string]bool{"/api/v1/ws": true, "/api/v1/wsMultiplexer": true, "/api/v1/helm/releases/stream": true}
	fill := strings.NewReplacer("{name}", "probe", "{id}", "1", "{group}", "example.com", "{version}", "v1", "{plural}", "widgets", "{traceID}", "abc", "{silenceID}", "s")
	rig, token := newKeptRig(t), keptFor["investigations"]
	asked, held := 0, 0
	err := chi.Walk(rig.router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method != http.MethodGet || strings.Contains(route, "{namespace}") || skip[route] {
			return nil
		}
		asked++
		target := fill.Replace(route)
		if _, first := rig.ask(token(inside), target); strings.Contains(first, inside) {
			held++
		}
		if code, next := rig.ask(token(second), target); strings.Contains(next, inside) {
			t.Errorf("%s: status %d, a token limited to %s is given %s: %.300s", route, code, second, inside, next)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%d routes asked, %d of them answered with the first token's namespace", asked, held)
	if asked < 100 || held < 30 {
		t.Errorf("%d routes asked, %d of them answered with the first token's namespace", asked, held)
	}
}

// The Timeline and its changes are kept for the grant that asked, whatever the order in which grants of one identity ask,
// and the same grant is answered from what was kept.
func TestATimelineIsKeptForTheGrantThatAsked(t *testing.T) {
	for name, token := range keptFor {
		for _, target := range []string{"/api/v1/timeline?hours=24", "/api/v1/timeline/changes?limit=50"} {
			t.Run(name+" "+target, func(t *testing.T) {
				rig := newKeptRig(t)
				for _, grant := range [][]string{{inside}, {second}, {second, inside}, nil, {outside}} {
					code, body := rig.ask(token(grant...), target)
					if code != http.StatusOK {
						t.Fatalf("a grant of %v: %d %.300s", grant, code, body)
					}
					for _, ns := range []string{inside, second, outside} {
						want := len(grant) == 0 || slices.Contains(grant, ns)
						if has := strings.Contains(body, `"namespace":"`+ns+`"`); has != want {
							t.Errorf("a grant of %v: rows of %s %v, want %v", grant, ns, has, want)
						}
					}
				}
				rig.api.reset()
				if code, body := rig.ask(token(inside, second), target); code != http.StatusOK {
					t.Fatalf("%d %.300s", code, body)
				}
				rig.api.mu.Lock()
				defer rig.api.mu.Unlock()
				if len(rig.api.calls) > 0 {
					t.Errorf("the same grant, its namespaces in another order, asked the cluster again: %+v", rig.api.calls)
				}
			})
		}
	}
}
