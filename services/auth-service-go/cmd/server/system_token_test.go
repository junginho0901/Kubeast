package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
)

// noSystemAccount is what a real database answers: the investigator has no user row.
var noSystemAccount = pgRule{match: "SELECT token_version FROM auth_users WHERE id =  'system'", oids: []uint32{integerOID}}

func registeredClusters(ids ...string) pgRule {
	rule := pgRule{match: "FROM clusters ORDER BY", oids: []uint32{
		textOID, textOID, textOID, textOID, booleanOID,
		textOID, stampOID, textOID, stampOID, stampOID,
		textOID, textOID, textOID, textOID,
		textOID, textOID, textOID, textOID,
	}}
	for _, id := range ids {
		rule.rows = append(rule.rows, []any{id, id, "external", nil, "f", "healthy", nil, "admin", pgNow(), pgNow(), nil, nil, nil, nil, nil, nil, nil, nil})
	}
	return rule
}

func investigationOn(c *config.Config) { c.AlertInvestigationEnabled = true }

func (a *authAPI) investigatorToken(cluster string) string {
	a.t.Helper()
	tok, err := a.mgr.CreateInvestigatorToken(cluster, "", repository.InvestigatorPermissions, time.Minute)
	if err != nil {
		a.t.Fatal(err)
	}
	return tok
}

func (a *authAPI) fetch(token, method, path, body string) *httptest.ResponseRecorder {
	a.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.router.ServeHTTP(w, req)
	return w
}

func clusterIDs(t *testing.T, w *httptest.ResponseRecorder) []string {
	t.Helper()
	var reply struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatalf("%v: %s", err, w.Body.String())
	}
	ids := make([]string, 0, len(reply.Items))
	for _, item := range reply.Items {
		ids = append(ids, item.ID)
	}
	return ids
}

// An investigation's clusters_list reads the picker's route: its token has no
// account row, and its answer is the one cluster the token is for.
func TestInvestigatorTokenListsItsOwnCluster(t *testing.T) {
	api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, investigationOn, noSystemAccount, registeredClusters("alpha", "beta"))
	w := api.fetch(api.investigatorToken("alpha"), http.MethodGet, "/api/v1/clusters?accessibleOnly=true", "")
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s, want 200", w.Code, w.Body.String())
	}
	if got := clusterIDs(t, w); len(got) != 1 || got[0] != "alpha" {
		t.Errorf("listed %v, want only alpha", got)
	}
	if api.db.ran("SELECT token_version") {
		t.Error("asked the database for an account the investigator does not have")
	}
}

func TestInvestigatorTokenIsNotGivenTheRegistryView(t *testing.T) {
	api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, investigationOn, noSystemAccount, registeredClusters("alpha", "beta"))
	w := api.fetch(api.investigatorToken("alpha"), http.MethodGet, "/api/v1/clusters", "")
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "admin.clusters.list") {
		t.Fatalf("%d %s, want 403 naming admin.clusters.list", w.Code, w.Body.String())
	}
	if api.db.ran("FROM clusters ORDER BY") {
		t.Error("the registry was read")
	}
}

// Off, a token already out stops here as it stops at the token-version route.
func TestInvestigatorTokenStopsWhenInvestigationIsOff(t *testing.T) {
	api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, nil, noSystemAccount, registeredClusters("alpha"))
	w := api.fetch(api.investigatorToken("alpha"), http.MethodGet, "/api/v1/clusters?accessibleOnly=true", "")
	if w.Code != http.StatusForbidden {
		t.Fatalf("%d %s, want 403", w.Code, w.Body.String())
	}
	if api.db.ran("FROM clusters ORDER BY") {
		t.Error("the registry was read")
	}
}

// A person's token on that route is checked as on any other.
func TestPersonsTokenOnTheClusterListKeepsItsChecks(t *testing.T) {
	api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, investigationOn, registeredClusters("c", "d"))
	w := api.fetch(api.sessionToken(), http.MethodGet, "/api/v1/clusters?accessibleOnly=true", "")
	if w.Code != http.StatusOK {
		t.Fatalf("session: %d %s, want 200", w.Code, w.Body.String())
	}
	if got := clusterIDs(t, w); len(got) != 1 || got[0] != "c" {
		t.Errorf("session listed %v, want only c", got)
	}
	if !api.db.ran("SELECT token_version") {
		t.Error("the session's version was not read")
	}

	stale := newAuthAPIWith(t, pendingRequest{owner: "requester"}, investigationOn, pgRule{match: "SELECT token_version FROM auth_users", oids: []uint32{integerOID}, rows: [][]any{{5}}})
	if w := stale.fetch(stale.sessionToken(), http.MethodGet, "/api/v1/clusters?accessibleOnly=true", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("stale session: %d %s, want 401", w.Code, w.Body.String())
	}
}

// protectedRoutes lists every method and path the router answers that take a
// token: all it has but the public ones.
func protectedRoutes(t *testing.T, api *authAPI) [][2]string {
	t.Helper()
	public := map[string]bool{}
	r := chi.NewRouter()
	r.Route("/api/v1/auth", func(r chi.Router) {
		publicAuthRoutes(r, &handler.AuthHandler{}, &handler.SetupHandler{}, "internal-token-for-tests")
	})
	if err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		public[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var routes [][2]string
	if err := chi.Walk(api.router.(chi.Routes), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !public[method+" "+route] {
			routes = append(routes, [2]string{method, route})
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return routes
}

var routeParam = regexp.MustCompile(`\{[^}]+\}`)

// The cluster list is the only way in, whatever a new route adds and even were
// an account to carry that token's subject. The database rule answers one here.
func TestInvestigatorTokenOpensNoOtherRoute(t *testing.T) {
	api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, investigationOn)
	tok := api.investigatorToken("c")
	routes := protectedRoutes(t, api)
	if len(routes) < 50 {
		t.Fatalf("only %d routes were found: the walk lost some", len(routes))
	}
	for _, route := range routes {
		method, path := route[0], route[1]
		if method == http.MethodGet && path == "/api/v1/clusters" {
			continue
		}
		t.Run(method+" "+path, func(t *testing.T) {
			w := api.fetch(tok, method, routeParam.ReplaceAllString(path, "x"), "{}")
			if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "system token") {
				t.Errorf("%d %s, want 403 naming the system token", w.Code, w.Body.String())
			}
		})
	}
	for _, write := range []string{"INSERT ", "UPDATE ", "DELETE "} {
		if api.db.ran(write) {
			t.Errorf("a %q reached the database", write)
		}
	}
}
