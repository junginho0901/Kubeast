package routes

import (
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// Facts about the cluster or the feature: no object to keep from anyone. A socket asks per subscription.
var routesThatReadNoObject = []string{
	"GET /api/v1/api-resources",
	"GET /api/v1/can-i",
	"GET /api/v1/cluster-config",
	"GET /api/v1/current",
	"GET /api/v1/features",
	"GET /api/v1/hygiene/config",
	"GET /api/v1/logsearch/status",
	"GET /api/v1/prometheus/status",
	"GET /api/v1/ws",
	"GET /api/v1/wsMultiplexer",
}

// The reads whose handlers ask a permission of their own. Written out by hand: resource.objects.read opens none of them.
var routesThatAskTheirOwn = map[string]string{
	"GET /api/v1/alertstore/alerts":                                               "resource.pod.read",
	"GET /api/v1/alertstore/silences":                                             "resource.pod.read",
	"GET /api/v1/alertstore/silences/preview":                                     "resource.pod.read",
	"GET /api/v1/cost":                                                            "resource.cost.read",
	"GET /api/v1/cost/status":                                                     "resource.cost.read",
	"GET /api/v1/helm/releases":                                                   "resource.helm.read",
	"GET /api/v1/helm/releases/stream":                                            "resource.helm.read",
	"GET /api/v1/helm/releases/{namespace}/{name}":                                "resource.helm.read",
	"GET /api/v1/helm/releases/{namespace}/{name}/history":                        "resource.helm.read",
	"GET /api/v1/helm/releases/{namespace}/{name}/images":                         "resource.helm.read",
	"GET /api/v1/helm/releases/{namespace}/{name}/resources":                      "resource.helm.read",
	"GET /api/v1/helm/releases/{namespace}/{name}/revisions/{revision}/{section}": "resource.helm.read",
	"GET /api/v1/helm/releases/{namespace}/{name}/{section}":                      "resource.helm.read",
	"GET /api/v1/hygiene":                                                         "resource.hygiene.scan",
	"GET /api/v1/hygiene/history":                                                 "resource.hygiene.scan",
	"GET /api/v1/hygiene/snapshot/{id}":                                           "resource.hygiene.scan",
	"GET /api/v1/logsearch":                                                       "resource.pod.read",
	"GET /api/v1/logsearch/labels":                                                "resource.pod.read",
	"GET /api/v1/logsearch/logql":                                                 "resource.pod.read",
	"GET /api/v1/logsearch/patterns":                                              "resource.pod.read",
	"GET /api/v1/logsearch/query":                                                 "resource.pod.read",
	"GET /api/v1/namespaces/{namespace}/logsearch":                                "resource.pod.read",
	"GET /api/v1/namespaces/{namespace}/logsearch/labels":                         "resource.pod.read",
	"GET /api/v1/namespaces/{namespace}/logsearch/logql":                          "resource.pod.read",
	"GET /api/v1/namespaces/{namespace}/logsearch/patterns":                       "resource.pod.read",
	"GET /api/v1/namespaces/{namespace}/logsearch/query":                          "resource.pod.read",
	"GET /api/v1/namespaces/{namespace}/networkdrops":                             "resource.networkflow.read",
	"GET /api/v1/namespaces/{namespace}/networkflows":                             "resource.networkflow.read",
	"GET /api/v1/namespaces/{namespace}/networkpolicies/effective":                "resource.networkpolicy.read",
	"GET /api/v1/namespaces/{namespace}/networktopflows":                          "resource.networkflow.read",
	"GET /api/v1/namespaces/{namespace}/pods/{name}/exec/ws":                      "resource.pod.exec",
	"GET /api/v1/namespaces/{namespace}/pods/{name}/logfiles":                     "resource.pod.logfile",
	"GET /api/v1/namespaces/{namespace}/pods/{name}/logfiles/content":             "resource.pod.logfile",
	"GET /api/v1/namespaces/{namespace}/pods/{name}/logfiles/stream":              "resource.pod.logfile",
	"GET /api/v1/namespaces/{namespace}/pods/{name}/logs":                         "resource.pod.read",
	"GET /api/v1/namespaces/{namespace}/pods/{name}/logs/stream":                  "resource.pod.read",
	"GET /api/v1/namespaces/{namespace}/policyreports/resource":                   "resource.policyreport.read",
	"GET /api/v1/networkpolicies/check":                                           "resource.networkpolicy.read",
	"GET /api/v1/networktraffic":                                                  "resource.networkflow.read",
	"GET /api/v1/nodes/{name}/debug-shell/ws":                                     "resource.node.shell",
	"GET /api/v1/nodes/{name}/drain/status":                                       "resource.node.drain",
	"GET /api/v1/policyreports/resource":                                          "resource.policyreport.read",
	"GET /api/v1/policyreports/results":                                           "resource.policyreport.read",
	"GET /api/v1/policyreports/status":                                            "resource.policyreport.read",
	"GET /api/v1/policyreports/summary":                                           "resource.policyreport.read",
}

// Their answer without the feature comes before the permission: the handler's own check is out of reach here.
var ownRoutesBehindAFeature = []string{"/alertstore/", "/hygiene", "/logsearch", "/networkflows", "/networktopflows"}

func askHolding(r http.Handler, perms []string, method, path string) *httptest.ResponseRecorder {
	payload := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"alpha": perms}}
	req := httptest.NewRequest(method, path, strings.NewReader("{}"))
	req = req.WithContext(cluster.WithID(auth.WithPayload(req.Context(), payload), "alpha"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func walkRoutes(t *testing.T, r chi.Routes, each func(method, route string)) {
	t.Helper()
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		each(method, route)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// listAndDetailRoutes is every GET route that holds a caller to the key.
func listAndDetailRoutes(t *testing.T, r chi.Routes) []string {
	t.Helper()
	var out []string
	walkRoutes(t, r, func(method, route string) {
		if method != http.MethodGet || slices.Contains(routesThatReadNoObject, method+" "+route) {
			return
		}
		if _, own := routesThatAskTheirOwn[method+" "+route]; !own {
			out = append(out, route)
		}
	})
	return out
}

func refusedForTheKey(rec *httptest.ResponseRecorder) bool {
	return rec.Code == http.StatusForbidden && strings.Contains(rec.Body.String(), "requires "+auth.PermObjectsRead+" permission")
}

// Every read says what it asks: a new route asks the key until someone writes it into the tables, as here.
func TestEveryReadRouteSaysWhatItAsks(t *testing.T) {
	r := chi.NewRouter()
	r.Group(func(g chi.Router) { Register(g, &handler.Handler{}, ws.NewMultiplexer(nil)) })
	var noObject []string
	own := map[string]string{}
	objects := 0
	walkRoutes(t, r, func(method, route string) {
		permission, asksItself := handler.ReadPermissionFor(method, route)
		switch {
		case method != http.MethodGet:
			if permission != "" {
				t.Errorf("%s %s asks %s: a write asks in its handler", method, route, permission)
			}
		case permission == "":
			noObject = append(noObject, method+" "+route)
		case asksItself:
			own[method+" "+route] = permission
		case permission == auth.PermObjectsRead:
			objects++
		default:
			t.Errorf("%s %s asks %s", method, route, permission)
		}
	})
	slices.Sort(noObject)
	if !slices.Equal(noObject, routesThatReadNoObject) {
		t.Errorf("routes that read no object:\n got %v\nwant %v", noObject, routesThatReadNoObject)
	}
	if !reflect.DeepEqual(own, routesThatAskTheirOwn) {
		for route, want := range routesThatAskTheirOwn {
			if own[route] != want {
				t.Errorf("%s asks %q itself, want %q", route, own[route], want)
			}
		}
		for route, got := range own {
			if _, listed := routesThatAskTheirOwn[route]; !listed {
				t.Errorf("%s is said to ask %s itself, and is not written out here", route, got)
			}
		}
	}
	if objects < 200 {
		t.Errorf("only %d routes ask %s: the routes were not read", objects, auth.PermObjectsRead)
	}
	if permission, asksItself := handler.ReadPermissionFor(http.MethodGet, "/api/v1/a-route-nobody-wrote-down"); permission != auth.PermObjectsRead || asksItself {
		t.Errorf("a route nobody classified asks %q (itself %v), want the key at the gate", permission, asksItself)
	}
}

// main.go is the one place the routes get the gate: without the line no test above would notice.
func TestTheServerPutsTheGateInFrontOfTheRoutes(t *testing.T) {
	raw, err := os.ReadFile("../../cmd/server/main.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	cluster, gate, routes := strings.Index(src, "r.Use(h.ClusterMiddleware)"), strings.Index(src, "r.Use(h.ReadGateMiddleware)"), strings.Index(src, "routes.RegisterRole(r, h, wsMux, role)")
	if cluster < 0 || gate < cluster || routes < gate {
		t.Fatalf("cluster %d, read gate %d, routes %d: the gate goes after the cluster is known and before the routes", cluster, gate, routes)
	}
}

func TestARoleWithoutTheKeyReadsNoListOrDetail(t *testing.T) {
	r := screenRouter(t)
	routes := listAndDetailRoutes(t, r)
	if len(routes) < 200 {
		t.Fatalf("%d routes: the routes were not read", len(routes))
	}
	for _, route := range routes {
		rec := askAsToolsOnly(r, http.MethodGet, routeParam.ReplaceAllString(route, "x"))
		if !refusedForTheKey(rec) {
			t.Errorf("GET %s: status %d body %.120s, want 403 naming %s", route, rec.Code, rec.Body.String(), auth.PermObjectsRead)
		}
	}
}

func TestAHolderOfTheKeyGetsPastTheGateOnEveryListAndDetail(t *testing.T) {
	r := screenRouter(t)
	for _, route := range listAndDetailRoutes(t, r) {
		rec := askHolding(r, []string{auth.PermObjectsRead}, http.MethodGet, routeParam.ReplaceAllString(route, "x"))
		if rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
			t.Errorf("GET %s: status %d body %.120s, want no refusal by the app", route, rec.Code, rec.Body.String())
		}
	}
}

// The key is what an upgraded custom role gets, so it must not open what that role could not read before.
func TestTheKeyOpensNoReadThatAsksItsOwnPermission(t *testing.T) {
	r := screenRouter(t)
	for key, permission := range routesThatAskTheirOwn {
		route := strings.TrimPrefix(key, "GET ")
		// source: networktraffic reads its argument before its permission, and metrics needs no flow store to be set up
		rec := askHolding(r, []string{auth.PermObjectsRead}, http.MethodGet, routeParam.ReplaceAllString(route, "x")+"?source=metrics")
		behindAFeature := slices.ContainsFunc(ownRoutesBehindAFeature, func(part string) bool { return strings.Contains(route, part) })
		switch {
		case behindAFeature && rec.Code == http.StatusNotFound:
		case rec.Code != http.StatusForbidden:
			t.Errorf("GET %s with the key alone: status %d body %.120s, want 403", route, rec.Code, rec.Body.String())
		case strings.HasSuffix(route, "/ws"):
		case !strings.Contains(rec.Body.String(), permission):
			t.Errorf("GET %s with the key alone: %s, want it to name %s", route, rec.Body.String(), permission)
		}
	}
}

// The gate alone, with a handler that answers at once: some of these are streams and terminals that stay open.
func TestAReadThatAsksItsOwnPermissionDoesNotAlsoAskTheKey(t *testing.T) {
	h := &handler.Handler{}
	r := chi.NewRouter()
	r.Group(func(g chi.Router) {
		g.Use(h.ReadGateMiddleware)
		for key := range routesThatAskTheirOwn {
			g.Get(strings.TrimPrefix(key, "GET "), func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
		}
	})
	for key, permission := range routesThatAskTheirOwn {
		route := strings.TrimPrefix(key, "GET ")
		if rec := askHolding(r, []string{permission}, http.MethodGet, routeParam.ReplaceAllString(route, "x")); rec.Code != http.StatusNoContent {
			t.Errorf("GET %s with %s: status %d body %.120s, want the handler to answer", route, permission, rec.Code, rec.Body.String())
		}
	}
}

func TestARouteThatReadsNoObjectAsksNothing(t *testing.T) {
	r := screenRouter(t)
	for _, key := range routesThatReadNoObject {
		route := strings.TrimPrefix(key, "GET ")
		if strings.HasSuffix(route, "/ws") || strings.HasSuffix(route, "/wsMultiplexer") {
			continue // the router under test has no socket; the multiplexer's tests hold those
		}
		if rec := askHolding(r, []string{"menu.dashboard"}, http.MethodGet, route); rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
			t.Errorf("%s: status %d body %.120s, want no refusal by the app", key, rec.Code, rec.Body.String())
		}
	}
}

// What the key is read from, by the same matching as every other permission.
func TestWhoHoldsTheKey(t *testing.T) {
	r := screenRouter(t)
	const list = "/api/v1/namespaces/x/configmaps"
	for _, c := range []struct {
		name  string
		perms []string
		holds bool
	}{
		{"Admin", []string{"*"}, true},
		{"Read and Write hold it through the wildcard", []string{"menu.*", "resource.*.read"}, true},
		{"every action", []string{"resource.*.*"}, true},
		{"every resource", []string{"resource.*"}, true},
		{"the key", []string{auth.PermObjectsRead}, true},
		{"menus", []string{"menu.*"}, false},
		{"AI tools", []string{"ai.tool.*", "ai.mcp.use"}, false},
		{"writes", []string{"resource.*.create", "resource.*.edit", "resource.*.delete"}, false},
		{"Pod logs", []string{"resource.pod.read"}, false},
		{"Helm", []string{"resource.helm.read", "resource.helm.upgrade"}, false},
		{"an admin page", []string{"admin.audit.read"}, false},
	} {
		rec := askHolding(r, c.perms, http.MethodGet, list)
		if got := !refusedForTheKey(rec); got != c.holds {
			t.Errorf("%s: status %d body %.120s, holds = %v, want %v", c.name, rec.Code, rec.Body.String(), got, c.holds)
		}
	}
}

func TestTheKeyOnAnotherClusterDoesNotCount(t *testing.T) {
	r := screenRouter(t)
	payload := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"alpha": {"menu.*"}, "prod": {auth.PermObjectsRead}}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/namespaces/x/configmaps", nil)
	req = req.WithContext(cluster.WithID(auth.WithPayload(req.Context(), payload), "alpha"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if !refusedForTheKey(rec) {
		t.Fatalf("status %d body %s, want 403 naming the key", rec.Code, rec.Body.String())
	}
}

// A write is the handler's to ask: the gate does not stop one, even for a role that reads nothing.
func TestAWriteIsNotHeldToTheKey(t *testing.T) {
	r := screenRouter(t)
	rec := askHolding(r, []string{"resource.*.delete"}, http.MethodDelete, "/api/v1/namespaces/x/configmaps/y")
	if refusedForTheKey(rec) {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
}

// What the screen shows comes from this answer.
func TestTheRefusalNamesTheKeyAndTheCluster(t *testing.T) {
	rec := askHolding(screenRouter(t), []string{"menu.*"}, http.MethodGet, "/api/v1/nodes")
	want := `{"detail":"forbidden: requires resource.objects.read permission in cluster \"alpha\""}`
	if rec.Code != http.StatusForbidden || strings.TrimSpace(rec.Body.String()) != want {
		t.Fatalf("status %d body %s, want 403 %s", rec.Code, rec.Body.String(), want)
	}
}

// The request's cost: a table lookup and one permission check, from the token. No cluster call, no database, no row.
// The longest list a role holds: the key after every AI tool, every menu and every other resource key.
func BenchmarkReadGate(b *testing.B) {
	var longRole []string
	for i := range 90 {
		longRole = append(longRole, "ai.tool.tool_number_"+strconv.Itoa(i))
	}
	readRole := append([]string{"menu.workloads", "menu.network", "menu.storage", "menu.security", "menu.cluster", "menu.gateway", "menu.gpu", "menu.helm", "menu.configuration", "menu.dashboard", "resource.*.read"}, longRole[:52]...)
	for _, c := range []struct {
		name  string
		gate  bool
		perms []string
	}{
		{"no gate, for the difference", false, readRole},
		{"Read role", true, readRole},
		{"Admin", true, []string{"*"}},
		{"key last of 91", true, append(slices.Clone(longRole), auth.PermObjectsRead)},
		{"refused, 90 kept", true, longRole},
	} {
		b.Run(c.name, func(b *testing.B) {
			h := &handler.Handler{}
			r := chi.NewRouter()
			r.Group(func(g chi.Router) {
				if c.gate {
					g.Use(h.ReadGateMiddleware)
				}
				g.Get("/api/v1/namespaces/{namespace}/configmaps", func(http.ResponseWriter, *http.Request) {})
			})
			payload := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"alpha": c.perms}}
			req := httptest.NewRequest(http.MethodGet, "/api/v1/namespaces/x/configmaps", nil)
			req = req.WithContext(cluster.WithID(auth.WithPayload(req.Context(), payload), "alpha"))
			b.ReportAllocs()
			for b.Loop() {
				r.ServeHTTP(httptest.NewRecorder(), req)
			}
		})
	}
}
