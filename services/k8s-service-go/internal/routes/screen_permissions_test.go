package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// The AI's table (services/tool-server/screen_permissions.go, written out in this file) says what a screen asks. These
// hold it to the routes behind those screens, for a role with the AI tools and no resource permission.
const toolScreenCasesFile = "../../../ai-service/tests/fixtures/tool_screen_permission_cases.json"

// A cluster nothing answers on: a route that gets past its permission check fails on the connection, not a 403.
type unreachableCluster struct{}

func (unreachableCluster) List(context.Context) ([]cluster.Info, error) { return nil, nil }
func (unreachableCluster) Default(context.Context) (cluster.ID, error)  { return "alpha", nil }
func (unreachableCluster) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	return &cluster.Info{ID: id, Mode: cluster.ModeExternal, KubeconfigBlob: `apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: {server: "http://127.0.0.1:1"}
users:
- name: u
  user: {}
contexts:
- name: c
  context: {cluster: c, user: u}
current-context: c
`}, nil
}

func screenRouter(t *testing.T) chi.Router {
	t.Helper()
	// the Timeline's routes read their cache before the cluster: no host is the in-memory one, nothing to reach
	svc, err := k8s.NewService(context.Background(), unreachableCluster{}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h := handler.New(svc, config.Config{LogFilesEnabled: true}, nil)
	r := chi.NewRouter()
	// As in main.go: a group, so the route is matched when the gate reads it.
	r.Group(func(g chi.Router) {
		g.Use(h.ReadGateMiddleware)
		RegisterCluster(g, h)
		RegisterPods(g, h)
		RegisterWorkloads(g, h)
		RegisterNetwork(g, h)
		RegisterGateway(g, h)
		RegisterStorage(g, h)
		RegisterSecurity(g, h)
		RegisterConfiguration(g, h)
		RegisterHelm(g, h)
		RegisterGPU(g, h)
		RegisterCustomResources(g, h)
		RegisterMetrics(g, h)
		RegisterStreams(g, h)
	})
	return r
}

func askAsToolsOnly(r http.Handler, method, path string) *httptest.ResponseRecorder {
	payload := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"alpha": {"ai.tool.*", "ai.mcp.use"}}}
	req := httptest.NewRequest(method, path, strings.NewReader("{}"))
	req = req.WithContext(cluster.WithID(auth.WithPayload(req.Context(), payload), "alpha"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

var routeParam = regexp.MustCompile(`\{[^}]*\}`)

// Every delete route asks resource.<name>.delete with a name the table can answer, so the AI's delete asks the same.
func TestEveryDeleteRouteAsksAPermissionNameTheTableKnows(t *testing.T) {
	r := screenRouter(t)
	names := map[string]bool{}
	for _, name := range auth.PermResourceNames() {
		names[name] = true
	}
	asks := regexp.MustCompile(`requires resource\.([a-z]+)\.delete permission`)
	seen := 0
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		// A silence is the alert store's and a release Helm's: their permissions are their own.
		if method != http.MethodDelete || strings.Contains(route, "/alertstore/") || strings.Contains(route, "/helm/") {
			return nil
		}
		seen++
		rec := askAsToolsOnly(r, method, routeParam.ReplaceAllString(route, "x"))
		m := asks.FindStringSubmatch(rec.Body.String())
		if rec.Code != http.StatusForbidden || m == nil {
			t.Errorf("DELETE %s: status %d body %s, want 403 naming resource.<name>.delete", route, rec.Code, rec.Body.String())
			return nil
		}
		if !names[m[1]] {
			t.Errorf("DELETE %s asks resource.%s.delete, a name the table does not know", route, m[1])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen < 40 {
		t.Fatalf("%d delete routes: the routes were not read", seen)
	}
}

type screenFixtureCase struct {
	Tool string                 `json:"tool"`
	Args map[string]interface{} `json:"args"`
	Want []string               `json:"want"`
}

// The route behind each tool that asks one permission refuses with that permission.
func TestTheRouteBehindAToolAsksWhatTheTableSays(t *testing.T) {
	raw, err := os.ReadFile(toolScreenCasesFile)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []screenFixtureCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	wantFor := func(tool string, args map[string]interface{}) []string {
		for _, c := range fixture.Cases {
			if c.Tool != tool {
				continue
			}
			matches := true
			for k, v := range args {
				matches = matches && reflect.DeepEqual(c.Args[k], v)
			}
			if matches {
				return c.Want
			}
		}
		t.Fatalf("no case of %s with %v", tool, args)
		return nil
	}
	r := screenRouter(t)
	for _, c := range []struct {
		tool         string
		args         map[string]interface{}
		method, path string
	}{
		{"k8s_get_pod_logs", nil, http.MethodGet, "/api/v1/namespaces/x/pods/y/logs"},
		{"helm_read", nil, http.MethodGet, "/api/v1/helm/releases"},
		{"cost", nil, http.MethodGet, "/api/v1/cost"},
		{"policy_reports", nil, http.MethodGet, "/api/v1/policyreports/results"},
		{"network_policy_check", nil, http.MethodGet, "/api/v1/networkpolicies/check"},
		{"network_drops", nil, http.MethodGet, "/api/v1/namespaces/x/networkdrops"},
		{"network_policy_effective", nil, http.MethodGet, "/api/v1/namespaces/x/networkpolicies/effective?name=y"},
		{"logfiles", map[string]interface{}{"pod_name": "web"}, http.MethodGet, "/api/v1/namespaces/x/pods/y/logfiles"},
		{"logfiles", map[string]interface{}{"path": "/var/log/app/app.log"}, http.MethodGet, "/api/v1/namespaces/x/pods/y/logfiles/content?path=/var/log/app/app.log"},
		{"k8s_rollout", map[string]interface{}{"action": "undo"}, http.MethodPost, "/api/v1/namespaces/x/deployments/y/rollback"},
		{"k8s_rollout", map[string]interface{}{"action": "status"}, http.MethodGet, "/api/v1/namespaces/x/deployments/y/revisions"},
		{"k8s_get_resources", nil, http.MethodGet, "/api/v1/namespaces/x/configmaps"},
		{"k8s_get_resource_yaml", nil, http.MethodGet, "/api/v1/resources/yaml?resource_type=configmaps&namespace=x&resource_name=y"},
		{"k8s_describe_resource", nil, http.MethodGet, "/api/v1/resources/describe?resource_type=configmaps&namespace=x&resource_name=y"},
		{"k8s_get_events", nil, http.MethodGet, "/api/v1/events?namespace=x"},
		{"get_cluster_overview", nil, http.MethodGet, "/api/v1/overview"},
		{"get_node_metrics", nil, http.MethodGet, "/api/v1/metrics/nodes"},
		{"get_pod_metrics", nil, http.MethodGet, "/api/v1/metrics/pods?namespace=x"},
		{"prometheus_query", nil, http.MethodGet, "/api/v1/prometheus/query?query=up"},
		{"traces_search", nil, http.MethodGet, "/api/v1/traces/search"},
		{"issues", nil, http.MethodGet, "/api/v1/issues?namespace=x"},
		{"optimization", nil, http.MethodGet, "/api/v1/optimization?namespace=x"},
		{"resource_graph", nil, http.MethodGet, "/api/v1/namespaces/x/resource-graph"},
		{"timeline", nil, http.MethodGet, "/api/v1/timeline"},
		{"gpu", nil, http.MethodGet, "/api/v1/gpu/dashboard"},
		{"pod_rbac", nil, http.MethodGet, "/api/v1/namespaces/x/pods/y/rbac"},
		{"storage_summary", nil, http.MethodGet, "/api/v1/pvcs?usage=true"},
		{"limit_range_violations", nil, http.MethodGet, "/api/v1/namespaces/x/limitranges/y/violations"},
	} {
		want := wantFor(c.tool, c.args)
		if len(want) != 1 {
			t.Fatalf("%s %v asks %v, want one permission", c.tool, c.args, want)
		}
		rec := askAsToolsOnly(r, c.method, c.path)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "requires "+want[0]+" permission") {
			t.Errorf("%s: %s %s: status %d body %s, want 403 naming %s", c.tool, c.method, c.path, rec.Code, rec.Body.String(), want[0])
		}
	}
}

// What the table leaves to the cluster asks nothing here either: it is the can-i and facts the screens read with no object.
func TestAReadTheTableLeavesToTheClusterAsksNoPermission(t *testing.T) {
	r := screenRouter(t)
	for _, path := range []string{
		"/api/v1/api-resources",
		"/api/v1/cluster-config",
		"/api/v1/can-i?verb=get&resource=pods",
	} {
		if rec := askAsToolsOnly(r, http.MethodGet, path); rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
			t.Errorf("GET %s: status %d body %s, want no refusal by the app", path, rec.Code, rec.Body.String())
		}
	}
}

// A read with no permission of its own asks the key and, with it, is the cluster's to answer.
func TestAReadWithNoPermissionOfItsOwnIsTheClustersToAnswerForAHolderOfTheKey(t *testing.T) {
	r := screenRouter(t)
	for _, path := range []string{
		"/api/v1/namespaces/x/configmaps",
		"/api/v1/namespaces/x/secrets",
		"/api/v1/namespaces/x/deployments",
		"/api/v1/nodes",
		"/api/v1/resources?resource_type=configmaps&namespace=x",
		"/api/v1/resources/yaml?resource_type=configmaps&namespace=x&resource_name=y",
		"/api/v1/resources/describe?resource_type=configmaps&namespace=x&resource_name=y",
		"/api/v1/events?namespace=x",
		"/api/v1/issues?namespace=x",
		"/api/v1/metrics/pods?namespace=x",
		"/api/v1/metrics/nodes",
		"/api/v1/optimization?namespace=x",
		"/api/v1/overview",
		"/api/v1/prometheus/query?query=up",
		"/api/v1/namespaces/x/pods/y/rbac",
		"/api/v1/namespaces/x/limitranges/y/violations",
		"/api/v1/topology/storage",
		"/api/v1/pvcs?usage=true",
		"/api/v1/pvs",
		"/api/v1/timeline",
		"/api/v1/namespaces/x/timeline",
		"/api/v1/namespaces/x/timeline/Deployment/y",
		"/api/v1/gpu/dashboard",
		"/api/v1/gpu/metrics",
		"/api/v1/deviceclasses",
		"/api/v1/resourceclaimtemplates/all",
	} {
		if rec := askAsToolsOnly(r, http.MethodGet, path); !refusedForTheKey(rec) {
			t.Errorf("GET %s without the key: status %d body %.120s, want 403 naming it", path, rec.Code, rec.Body.String())
		}
		if rec := askHolding(r, []string{auth.PermObjectsRead}, http.MethodGet, path); rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
			t.Errorf("GET %s with the key: status %d body %.120s, want no refusal by the app", path, rec.Code, rec.Body.String())
		}
	}
}
