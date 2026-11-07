package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/routes"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
)

const (
	installNS   = "kubeast"
	nodeShellNS = "kubeast-node-shell"
)

// protectedRegistry says whether cluster c is the one Kubeast runs in. The stand-in serves it either way.
type protectedRegistry struct {
	blob string
	self bool
}

func (protectedRegistry) List(context.Context) ([]cluster.Info, error) { return nil, nil }
func (r protectedRegistry) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	info := &cluster.Info{ID: id, Mode: cluster.ModeExternal, KubeconfigBlob: r.blob}
	if r.self {
		info.Mode, info.IsSelfCluster = cluster.ModeInCluster, true
	}
	return info, nil
}
func (protectedRegistry) Default(context.Context) (cluster.ID, error) { return "c", nil }

// newProtectedRig wires the protected group as main.go does, for a cluster that is or is not the install cluster.
func newProtectedRig(t *testing.T, payload auth.TokenPayload, self bool) *scopeRig {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "false")
	api := newStandIn(t)
	blob := strings.Replace(standInKubeconfig, "SERVER", api.srv.URL, 1)
	svc, err := k8s.NewService(context.Background(), protectedRegistry{blob: blob, self: self}, false, cache.New("", 0, 0, ""),
		k8s.ServiceOptions{Impersonation: true, InstallNamespace: installNS, NodeShellNamespace: nodeShellNS})
	if err != nil {
		t.Fatal(err)
	}
	store := &auditRows{}
	h := handler.New(svc, config.Config{ImpersonationEnabled: true, HygieneEnabled: true, NodeShellEnabled: true, HygieneIntervalDays: 30,
		PodNamespace: installNS, NodeShellNamespace: nodeShellNS, LogFilesEnabled: true}, store)
	r := chi.NewRouter()
	r.Use(chimiddleware.Recoverer)
	r.Group(func(g chi.Router) {
		g.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				next.ServeHTTP(w, req.WithContext(auth.WithPayload(req.Context(), payload)))
			})
		})
		g.Use(h.ClusterMiddleware)
		g.Use(h.NamespaceScopeMiddleware)
		routes.Register(g, h, ws.NewMultiplexer(nil))
	})
	r.Group(func(g chi.Router) {
		g.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				next.ServeHTTP(w, req.WithContext(auth.WithPayload(req.Context(), payload)))
			})
		})
		g.Get("/internal/clusters/{id}/kubeconfig", h.GetClusterKubeconfig)
	})
	return &scopeRig{api: api, audit: store, svc: svc, router: r}
}

// A cluster's Write and the Admin-only permissions beside it, bound to edit on that cluster, without the node shell:
// what refuses here is the rule under test, not a permission the caller lacks.
func writeOnCluster() auth.TokenPayload {
	return auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"c": {
		"resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete", "resource.secret.reveal", "resource.pod.exec", "resource.pod.logfile",
		"resource.workload.rollback", "resource.cronjob.suspend", "resource.cronjob.trigger", "resource.helm.rollback", "resource.helm.upgrade", "resource.helm.test", "resource.helm.uninstall",
	}}, Roles: map[string]string{"c": "Write"}}
}

// A cluster's Admin: everything on that one cluster, and nothing global.
func adminOnCluster() auth.TokenPayload {
	return auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"c": {"*"}}, Roles: map[string]string{"c": "Admin"}}
}

func globalAdminPayload() auth.TokenPayload {
	return auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"*": {"*"}}}
}

// The cluster calls that went into a namespace, Secrets or anything else.
func callsInto(calls []apiCall, namespace string) []string {
	var out []string
	for _, c := range calls {
		if strings.Contains(c.path, "/namespaces/"+namespace+"/") || strings.HasSuffix(c.path, "/namespaces/"+namespace) {
			out = append(out, c.method+" "+c.path)
		}
	}
	return out
}

type protectedCase struct{ method, target, body string }

func installNamespaceSecretReads() []protectedCase {
	ns := installNS
	return []protectedCase{
		{"GET", "/api/v1/namespaces/" + ns + "/secrets", ""},
		{"GET", "/api/v1/namespaces/" + ns + "/secrets/kubeast-auth-keys/describe", ""},
		{"GET", "/api/v1/namespaces/" + ns + "/secrets/kubeast-auth-keys/yaml", ""},
		{"GET", "/api/v1/resources?resource_type=secrets&namespace=" + ns, ""},
		{"GET", "/api/v1/resources?resource_type=secret&namespace=" + ns + "&output=json", ""},
		{"GET", "/api/v1/resources/yaml?resource_type=secrets&resource_name=kubeast-auth-keys&namespace=" + ns, ""},
		{"GET", "/api/v1/resources/json?resource_type=secrets&resource_name=kubeast-auth-keys&namespace=" + ns, ""},
		{"GET", "/api/v1/resources/describe?resource_type=Secret&resource_name=kubeast-auth-keys&namespace=" + ns, ""},
		{"GET", "/api/v1/helm/releases?namespace=" + ns, ""},
		{"GET", "/api/v1/helm/releases/stream?namespace=" + ns, ""},
		{"GET", "/api/v1/helm/releases/" + ns + "/kubeast", ""},
		{"GET", "/api/v1/helm/releases/" + ns + "/kubeast/values", ""},
		{"GET", "/api/v1/helm/releases/" + ns + "/kubeast/manifest", ""},
		{"GET", "/api/v1/helm/releases/" + ns + "/kubeast/history", ""},
		{"GET", "/api/v1/helm/releases/" + ns + "/kubeast/resources", ""},
		{"GET", "/api/v1/helm/releases/" + ns + "/kubeast/images", ""},
		{"GET", "/api/v1/helm/releases/" + ns + "/kubeast/revisions/1/values", ""},
	}
}

func writesAndTerminalsIn(t *testing.T, ns string) []protectedCase {
	return []protectedCase{
		{"DELETE", "/api/v1/namespaces/" + ns + "/secrets/s", ""},
		{"DELETE", "/api/v1/namespaces/" + ns + "/pods/p", ""},
		{"DELETE", "/api/v1/namespaces/" + ns + "/configmaps/cm", ""},
		{"DELETE", "/api/v1/namespaces/" + ns + "/deployments/d", ""},
		{"DELETE", "/api/v1/namespaces/" + ns + "/serviceaccounts/sa", ""},
		{"DELETE", "/api/v1/namespaces/" + ns + "/rolebindings/rb", ""},
		{"DELETE", "/api/v1/custom-resources/example.com/v1/widgets/" + ns + "/w", ""},
		{"POST", "/api/v1/namespaces/" + ns + "/deployments/d/rollback", `{"revision":1}`},
		{"POST", "/api/v1/namespaces/" + ns + "/cronjobs/c/trigger", `{}`},
		{"PATCH", "/api/v1/namespaces/" + ns + "/cronjobs/c/suspend", `{"suspend":true}`},
		{"POST", "/api/v1/namespaces/" + ns + "/optimization/resize", `{}`},
		{"POST", "/api/v1/namespaces/" + ns + "/yaml/apply", jsonBody(t, map[string]string{"yaml": yamlDoc("Namespace", "v1", ns, "")})},
		{"DELETE", "/api/v1/namespaces/" + ns, ""},
		{"POST", "/api/v1/namespaces", jsonBody(t, map[string]string{"name": ns})},
		{"POST", "/api/v1/helm/releases/" + ns + "/rel/rollback", `{"revision":1}`},
		{"POST", "/api/v1/helm/releases/" + ns + "/rel/test", `{}`},
		{"POST", "/api/v1/helm/releases/" + ns + "/rel/diff", `{}`},
		{"PUT", "/api/v1/helm/releases/" + ns + "/rel/values", `{}`},
		{"DELETE", "/api/v1/helm/releases/" + ns + "/rel", ""},
		{"POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "secrets", "name": "s", "namespace": ns, "yaml": yamlDoc("Secret", "v1", "s", "")})},
		{"POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "configmaps", "name": "cm", "namespace": ns, "yaml": yamlDoc("ConfigMap", "v1", "cm", "")})},
		{"POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "configmaps", "name": "cm", "namespace": inside, "yaml": yamlDoc("ConfigMap", "v1", "cm", ns)})},
		{"POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "namespaces", "name": ns, "yaml": yamlDoc("Namespace", "v1", ns, "")})},
		{"POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("Pod", "v1", "p", ns)})},
		{"POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"namespace": ns, "yaml": yamlDoc("Pod", "v1", "p", "")})},
		{"POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("Deployment", "apps/v1", "d", ns)})},
		{"POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("CronJob", "batch/v1", "c", ns)})},
		{"POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("RoleBinding", "rbac.authorization.k8s.io/v1", "rb", ns)})},
		{"POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("Secret", "v1", "token", ns)})},
		{"POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("Namespace", "v1", ns, "")})},
		{"POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"namespace": inside, "yaml": yamlDoc("ConfigMap", "v1", "first", inside) + "---\n" + yamlDoc("Pod", "v1", "second", ns)})},
		{"GET", "/api/v1/namespaces/" + ns + "/pods/p/exec/ws?command=/bin/sh", ""},
		{"GET", "/api/v1/namespaces/" + ns + "/pods/p/logfiles", ""},
		{"GET", "/api/v1/namespaces/" + ns + "/pods/p/logfiles/content?path=/var/log/app/a.log", ""},
		{"GET", "/api/v1/namespaces/" + ns + "/pods/p/logfiles/stream?path=/var/log/app/a.log", ""},
	}
}

// The features answer, which every screen already holds, says where this caller's writes are refused, so a button
// follows without a question of its own.
func TestFeaturesNameWhereTheCallersWritesAreRefused(t *testing.T) {
	limited := func(namespaces ...string) auth.TokenPayload {
		p := writeOnCluster()
		p.Namespaces = map[string][]string{"c": namespaces}
		return p
	}
	holdingTheShell := writeOnCluster()
	holdingTheShell.Perms["c"] = append(holdingTheShell.Perms["c"], "resource.node.shell")
	for _, c := range []struct {
		name    string
		payload auth.TokenPayload
		self    bool
		want    []string
	}{
		{"write on the install cluster", writeOnCluster(), true, []string{installNS, nodeShellNS}},
		{"write on another cluster", writeOnCluster(), false, []string{nodeShellNS}},
		{"holding the node shell", holdingTheShell, true, []string{installNS}},
		{"a cluster's admin", adminOnCluster(), true, []string{installNS}},
		{"a global admin", globalAdminPayload(), true, []string{}},
		{"a grant limited to other namespaces is told nothing of them", limited("shop"), true, []string{}},
		{"a grant limited to the guarded one", limited(installNS), true, []string{installNS}},
	} {
		t.Run(c.name, func(t *testing.T) {
			rig := newProtectedRig(t, c.payload, c.self)
			w := rig.do("GET", "/api/v1/features?cluster=c", "")
			if w.Code != http.StatusOK {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			var answer struct {
				Refused *[]string `json:"writeGuardedNamespaces"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
				t.Fatal(err)
			}
			if answer.Refused == nil || !slices.Equal(*answer.Refused, c.want) {
				t.Fatalf("writeGuardedNamespaces = %v, want %v", answer.Refused, c.want)
			}
			for _, call := range rig.api.calls {
				t.Errorf("the answer asked the cluster: %s %s", call.method, call.path)
			}
		})
	}
}

// Whichever way a request names the install namespace, the path, the query, the body or a YAML document, one
// cluster's Write or Admin reaches none of its Secrets, writes nothing there and opens no terminal, and the cluster is not asked.
func TestTheInstallNamespaceIsClosedToAnyoneButAGlobalAdmin(t *testing.T) {
	for who, payload := range map[string]auth.TokenPayload{"write": writeOnCluster(), "cluster admin": adminOnCluster()} {
		rig := newProtectedRig(t, payload, true)
		cases := append(installNamespaceSecretReads(), writesAndTerminalsIn(t, installNS)...)
		for _, c := range cases {
			t.Run(who+" "+c.method+" "+c.target+" "+c.body, func(t *testing.T) {
				rig.api.reset()
				w := rig.do(c.method, c.target, c.body)
				if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), installNS) || !strings.Contains(w.Body.String(), `"reason":"protected_namespace"`) {
					t.Errorf("status %d: %.300s", w.Code, w.Body.String())
				}
				if got := callsInto(rig.api.callerCalls(), installNS); len(got) != 0 {
					t.Errorf("the cluster was asked: %v", got)
				}
				for _, call := range rig.api.callerCalls() {
					if call.method != http.MethodGet {
						t.Errorf("wrote before refusing: %+v", call)
					}
				}
			})
		}
	}
}

// What a person looks at to see how Kubeast is doing stays: pods, logs, events, ConfigMaps, the namespace itself.
func TestTheInstallNamespaceKeepsItsOtherReads(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), true)
	for _, target := range []string{
		"/api/v1/namespaces/" + installNS + "/pods",
		"/api/v1/namespaces/" + installNS + "/pods/p/describe",
		"/api/v1/namespaces/" + installNS + "/pods/p/yaml",
		"/api/v1/namespaces/" + installNS + "/configmaps",
		"/api/v1/namespaces/" + installNS + "/events",
		"/api/v1/namespaces/" + installNS + "/serviceaccounts",
		"/api/v1/namespaces/" + installNS + "/describe",
		"/api/v1/resources?resource_type=configmaps&namespace=" + installNS,
		"/api/v1/resources/yaml?resource_type=configmaps&resource_name=cm&namespace=" + installNS,
		"/api/v1/resources/describe?resource_type=namespaces&resource_name=" + installNS,
	} {
		rig.api.reset()
		w := rig.do("GET", target, "")
		if w.Code == http.StatusForbidden {
			t.Errorf("%s: 403: %.200s", target, w.Body.String())
		}
		if len(rig.api.callerCalls()) == 0 {
			t.Errorf("%s: status %d, the cluster was not asked", target, w.Code)
		}
	}
}

// A global admin is not touched by any of it.
func TestAGlobalAdminKeepsTheInstallNamespace(t *testing.T) {
	rig := newProtectedRig(t, globalAdminPayload(), true)
	for _, c := range []protectedCase{
		{"GET", "/api/v1/namespaces/" + installNS + "/secrets", ""},
		{"GET", "/api/v1/namespaces/" + installNS + "/secrets/s/describe", ""},
		{"GET", "/api/v1/resources/yaml?resource_type=secrets&resource_name=s&namespace=" + installNS, ""},
		{"DELETE", "/api/v1/namespaces/" + installNS + "/pods/p", ""},
		{"POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("Pod", "v1", "p", installNS)})},
	} {
		rig.api.reset()
		w := rig.do(c.method, c.target, c.body)
		if w.Code == http.StatusForbidden {
			t.Errorf("%s %s: 403: %.200s", c.method, c.target, w.Body.String())
		}
		if len(callsInto(rig.api.callerCalls(), installNS)) == 0 {
			t.Errorf("%s %s: status %d, the cluster was not asked", c.method, c.target, w.Code)
		}
	}
	rig.api.reset()
	if w := rig.do("GET", "/api/v1/secrets/all", ""); w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	for _, c := range rig.api.callerCalls() {
		if strings.Contains(c.query, "metadata.namespace") {
			t.Errorf("a global admin's list was narrowed: %+v", c)
		}
	}
}

// A registered cluster that has a namespace of that name is an ordinary cluster.
func TestAnotherClustersNamespaceOfThatNameIsOrdinary(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), false)
	for _, c := range []protectedCase{
		{"GET", "/api/v1/namespaces/" + installNS + "/secrets", ""},
		{"GET", "/api/v1/namespaces/" + installNS + "/secrets/s/describe", ""},
		{"GET", "/api/v1/helm/releases/" + installNS + "/rel/history", ""},
		{"DELETE", "/api/v1/namespaces/" + installNS + "/pods/p", ""},
		{"POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("Pod", "v1", "p", installNS)})},
	} {
		rig.api.reset()
		w := rig.do(c.method, c.target, c.body)
		if w.Code == http.StatusForbidden {
			t.Errorf("%s %s: 403: %.200s", c.method, c.target, w.Body.String())
		}
		if len(callsInto(rig.api.callerCalls(), installNS)) == 0 {
			t.Errorf("%s %s: status %d, the cluster was not asked", c.method, c.target, w.Code)
		}
	}
	rig.api.reset()
	if w := rig.do("GET", "/api/v1/secrets/all", ""); w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	for _, c := range rig.api.callerCalls() {
		if strings.Contains(c.query, "metadata.namespace") {
			t.Errorf("the list was narrowed: %+v", c)
		}
	}
}

// A list across namespaces asks the cluster to leave the install namespace's Secrets out, every door to such a list.
func TestWideSecretListsLeaveOutTheInstallNamespace(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), true)
	for _, target := range []string{
		"/api/v1/secrets/all",
		"/api/v1/resources?resource_type=secrets",
		"/api/v1/resources?resource_type=secrets&all_namespaces=true",
		"/api/v1/resources?resource_type=secrets&output=json",
		"/api/v1/helm/releases",
	} {
		rig.api.reset()
		w := rig.do("GET", target, "")
		if w.Code != http.StatusOK {
			t.Errorf("%s: status %d: %.200s", target, w.Code, w.Body.String())
		}
		wide := 0
		for _, c := range rig.api.callerCalls() {
			if c.path == "/api/v1/secrets" {
				wide++
				if !strings.Contains(c.query, "metadata.namespace%21%3D"+installNS) && !strings.Contains(c.query, "metadata.namespace!="+installNS) {
					t.Errorf("%s: the list went out as %s", target, c.query)
				}
			}
		}
		if wide == 0 {
			t.Errorf("%s: no list across namespaces went out: %+v", target, rig.api.callerCalls())
		}
	}
}

// Whatever a GET route does with the namespace it names, it reads no Secret of the install namespace as the caller.
func TestNoRouteReadsTheInstallNamespacesSecrets(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), true)
	skip := map[string]bool{"/api/v1/ws": true, "/api/v1/wsMultiplexer": true}
	fill := strings.NewReplacer("{namespace}", installNS, "{name}", "probe", "{id}", "1", "{group}", "example.com", "{version}", "v1", "{plural}", "widgets",
		"{traceID}", "abc", "{silenceID}", "s", "{section}", "values", "{revision}", "1", "{kind}", "Pod", "{pod_name}", "probe", "{deployment_name}", "probe", "{service_name}", "probe")
	checked := 0
	err := chi.Walk(rig.router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method != http.MethodGet || skip[route] || strings.HasPrefix(route, "/internal") {
			return nil
		}
		checked++
		t.Run(route, func(t *testing.T) {
			rig.api.reset()
			w := rig.do("GET", fill.Replace(route)+"?namespace="+installNS, "")
			for _, c := range rig.api.callerCalls() {
				if strings.HasPrefix(c.path, "/api/v1/namespaces/"+installNS+"/secrets") {
					t.Errorf("status %d, read %+v", w.Code, c)
				}
				if c.path == "/api/v1/secrets" && !strings.Contains(c.query, "metadata.namespace") {
					t.Errorf("status %d, listed every namespace's Secrets: %+v", w.Code, c)
				}
			}
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 150 {
		t.Fatalf("only %d routes walked", checked)
	}
}

// Every route that reads a Secret, or what is kept in one, or runs a process in a container says so: a new such route
// has to be added here on purpose, and the transport holds it until then.
func TestRoutesSayWhatTheyDo(t *testing.T) {
	r := chi.NewRouter()
	r.Group(func(g chi.Router) { routes.Register(g, &handler.Handler{}, ws.NewMultiplexer(nil)) })
	var secretReads, terminals, logReads []string
	writes := 0
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		switch handler.RouteAct(method, route) {
		case protectedns.ActSecretRead:
			secretReads = append(secretReads, method+" "+route)
		case protectedns.ActExec:
			terminals = append(terminals, method+" "+route)
		case protectedns.ActLog:
			logReads = append(logReads, method+" "+route)
		case protectedns.ActWrite:
			if method == http.MethodGet {
				t.Errorf("a GET route counts as a write: %s", route)
			}
			writes++
		case protectedns.ActRead:
			if method != http.MethodGet {
				t.Errorf("%s %s counts as a read", method, route)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(secretReads)
	slices.Sort(terminals)
	slices.Sort(logReads)
	wantLogReads := []string{
		"GET /api/v1/logsearch",
		"GET /api/v1/logsearch/labels",
		"GET /api/v1/logsearch/logql",
		"GET /api/v1/logsearch/patterns",
		"GET /api/v1/logsearch/query",
		"GET /api/v1/logsearch/status",
		"GET /api/v1/namespaces/{namespace}/logsearch",
		"GET /api/v1/namespaces/{namespace}/logsearch/labels",
		"GET /api/v1/namespaces/{namespace}/logsearch/logql",
		"GET /api/v1/namespaces/{namespace}/logsearch/patterns",
		"GET /api/v1/namespaces/{namespace}/logsearch/query",
		"GET /api/v1/namespaces/{namespace}/pods/{name}/logs",
		"GET /api/v1/namespaces/{namespace}/pods/{name}/logs/stream",
	}
	if !slices.Equal(logReads, wantLogReads) {
		t.Errorf("routes that read a pod's output:\n got %v\nwant %v", logReads, wantLogReads)
	}
	wantSecretReads := []string{
		"GET /api/v1/helm/releases",
		"GET /api/v1/helm/releases/stream",
		"GET /api/v1/helm/releases/{namespace}/{name}",
		"GET /api/v1/helm/releases/{namespace}/{name}/history",
		"GET /api/v1/helm/releases/{namespace}/{name}/images",
		"GET /api/v1/helm/releases/{namespace}/{name}/resources",
		"GET /api/v1/helm/releases/{namespace}/{name}/revisions/{revision}/{section}",
		"GET /api/v1/helm/releases/{namespace}/{name}/{section}",
		"GET /api/v1/namespaces/{namespace}/secrets",
		"GET /api/v1/namespaces/{namespace}/secrets/{name}/describe",
		"GET /api/v1/namespaces/{namespace}/secrets/{name}/yaml",
		"GET /api/v1/secrets/all",
	}
	if !slices.Equal(secretReads, wantSecretReads) {
		t.Errorf("Secret reads:\n%s\nwant:\n%s", strings.Join(secretReads, "\n"), strings.Join(wantSecretReads, "\n"))
	}
	wantTerminals := []string{
		"GET /api/v1/namespaces/{namespace}/pods/{name}/exec/ws",
		"GET /api/v1/namespaces/{namespace}/pods/{name}/logfiles",
		"GET /api/v1/namespaces/{namespace}/pods/{name}/logfiles/content",
		"GET /api/v1/namespaces/{namespace}/pods/{name}/logfiles/stream",
	}
	if !slices.Equal(terminals, wantTerminals) {
		t.Errorf("terminals: %v", terminals)
	}
	if writes < 60 {
		t.Errorf("only %d writes", writes)
	}
}

// Node shell's namespace, on any cluster: without resource.node.shell no pod goes in and no terminal opens.
func TestTheNodeShellNamespaceIsForThoseHoldingTheNodeShell(t *testing.T) {
	for _, self := range []bool{true, false} {
		rig := newProtectedRig(t, writeOnCluster(), self)
		for _, c := range writesAndTerminalsIn(t, nodeShellNS) {
			t.Run(fmt.Sprintf("self=%v %s %s %s", self, c.method, c.target, c.body), func(t *testing.T) {
				rig.api.reset()
				w := rig.do(c.method, c.target, c.body)
				if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), nodeShellNS) {
					t.Errorf("status %d: %.300s", w.Code, w.Body.String())
				}
				if got := callsInto(rig.api.callerCalls(), nodeShellNS); len(got) != 0 {
					t.Errorf("the cluster was asked: %v", got)
				}
			})
		}
	}
}

func TestTheNodeShellNamespaceKeepsItsReads(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), false)
	for _, target := range []string{
		"/api/v1/namespaces/" + nodeShellNS + "/pods",
		"/api/v1/namespaces/" + nodeShellNS + "/pods/p/describe",
		"/api/v1/namespaces/" + nodeShellNS + "/events",
	} {
		rig.api.reset()
		if w := rig.do("GET", target, ""); w.Code == http.StatusForbidden || len(rig.api.callerCalls()) == 0 {
			t.Errorf("%s: status %d: %.200s", target, w.Code, w.Body.String())
		}
	}
}

// Those holding the node shell keep it: the debug pod's namespace is theirs and the shell route is not refused.
func TestAHolderOfTheNodeShellKeepsItsNamespace(t *testing.T) {
	holder := auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"c": {"resource.*.create", "resource.node.shell"}}, Roles: map[string]string{"c": "Write"}}
	for _, self := range []bool{true, false} {
		rig := newProtectedRig(t, holder, self)
		rig.api.reset()
		w := rig.do("POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("Pod", "v1", "p", nodeShellNS)}))
		if w.Code == http.StatusForbidden {
			t.Errorf("self=%v: create: 403: %.200s", self, w.Body.String())
		}
		if len(callsInto(rig.api.callerCalls(), nodeShellNS)) == 0 {
			t.Errorf("self=%v: create: status %d, the cluster was not asked", self, w.Code)
		}
		// Past the checks, the shell route wants a real WebSocket upgrade: 400 here, as the namespace scope tests see.
		w = rig.do("GET", "/api/v1/nodes/n1/debug-shell/ws", "")
		if w.Code == http.StatusForbidden {
			t.Errorf("self=%v: shell: 403: %.200s", self, w.Body.String())
		}
	}
}

// can-i answers no without asking the cluster where the app would refuse, so the buttons go with it.
func TestCanIAnswersForTheProtectedNamespaces(t *testing.T) {
	cases := []struct {
		name   string
		p      auth.TokenPayload
		self   bool
		target string
		want   string
		asked  bool
	}{
		{"Secret read in the install namespace", writeOnCluster(), true, "verb=get&resource=secrets&namespace=" + installNS, `{"allowed":false}`, false},
		{"Secret list in the install namespace", writeOnCluster(), true, "verb=list&resource=secrets&namespace=" + installNS, `{"allowed":false}`, false},
		{"a delete in the install namespace", writeOnCluster(), true, "verb=delete&group=apps&resource=deployments&namespace=" + installNS + "&name=d", `{"allowed":false}`, false},
		{"a pod create in the install namespace", writeOnCluster(), true, "verb=create&resource=pods&namespace=" + installNS, `{"allowed":false}`, false},
		{"exec in the install namespace", writeOnCluster(), true, "verb=create&resource=pods&subresource=exec&namespace=" + installNS, `{"allowed":false}`, false},
		{"deleting the install namespace, as the drawer asks", writeOnCluster(), true, "verb=delete&resource=namespaces&name=" + installNS, `{"allowed":false}`, false},
		{"deleting the install namespace, named as its own namespace", writeOnCluster(), true, "verb=delete&resource=namespaces&namespace=" + installNS + "&name=" + installNS, `{"allowed":false}`, false},
		{"a read in the install namespace", writeOnCluster(), true, "verb=get&resource=pods&namespace=" + installNS, `{"allowed":true}`, true},
		{"a write elsewhere", writeOnCluster(), true, "verb=delete&resource=pods&namespace=" + inside, `{"allowed":true}`, true},
		{"exec elsewhere", writeOnCluster(), true, "verb=create&resource=pods&subresource=exec&namespace=" + inside, `{"allowed":true}`, true},
		{"a global admin", globalAdminPayload(), true, "verb=get&resource=secrets&namespace=" + installNS, `{"allowed":true}`, true},
		{"a global admin's exec", globalAdminPayload(), true, "verb=create&resource=pods&subresource=exec&namespace=" + installNS, `{"allowed":true}`, true},
		{"another cluster", writeOnCluster(), false, "verb=get&resource=secrets&namespace=" + installNS, `{"allowed":true}`, true},
		{"the node shell namespace without it", writeOnCluster(), false, "verb=create&resource=pods&namespace=" + nodeShellNS, `{"allowed":false}`, false},
		{"exec in the node shell namespace without it", writeOnCluster(), false, "verb=create&resource=pods&subresource=exec&namespace=" + nodeShellNS, `{"allowed":false}`, false},
		{"reading the node shell namespace", writeOnCluster(), false, "verb=list&resource=pods&namespace=" + nodeShellNS, `{"allowed":true}`, true},
		{"holding the node shell", adminOnCluster(), false, "verb=create&resource=pods&namespace=" + nodeShellNS, `{"allowed":true}`, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rig := newProtectedRig(t, c.p, c.self)
			rig.api.reset()
			w := rig.do("GET", "/api/v1/can-i?"+c.target, "")
			if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != c.want {
				t.Errorf("status %d: %s, want %s", w.Code, w.Body, c.want)
			}
			if asked := len(rig.api.callerCalls()) > 0; asked != c.asked {
				t.Errorf("the cluster was asked: %v, want %v", asked, c.asked)
			}
		})
	}
}

// The cluster is asked about the subresource, as kubectl auth can-i does.
func TestCanIAsksAboutTheSubresource(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), true)
	rig.api.reset()
	if w := rig.do("GET", "/api/v1/can-i?verb=create&resource=pods&subresource=exec&namespace="+inside, ""); w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if len(rig.api.reviews()) != 1 || !strings.Contains(rig.api.reviews()[0], "exec") {
		t.Fatalf("review %v", rig.api.reviews())
	}
}

func TestProtectedRefusalsLeaveARowForWritesOnly(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), true)
	if w := rig.do("GET", "/api/v1/namespaces/"+installNS+"/secrets/s/describe", ""); w.Code != http.StatusForbidden {
		t.Fatalf("read: %d", w.Code)
	}
	if got := rig.audit.actions(); len(got) != 0 {
		t.Fatalf("a refused read left rows: %v", got)
	}
	w := rig.do("POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("Pod", "v1", "p", installNS)}))
	if w.Code != http.StatusForbidden {
		t.Fatalf("write: %d", w.Code)
	}
	if got := rig.audit.actions(); !slices.Equal(got, []string{"k8s.access.denied"}) {
		t.Fatalf("rows %v", got)
	}
	row := rig.audit.rows[0]
	if row.Result != "failure" || row.TargetType != "namespace" || row.TargetID != installNS || !strings.Contains(row.Error, installNS) ||
		!strings.Contains(string(row.After), `"permission":"protected namespace"`) || !strings.Contains(string(row.After), `"method":"POST"`) {
		t.Fatalf("row %+v after %s", row, row.After)
	}
	if w := rig.do("GET", "/api/v1/namespaces/"+installNS+"/pods/p/exec/ws", ""); w.Code != http.StatusForbidden {
		t.Fatalf("terminal: %d", w.Code)
	}
	if got := rig.audit.actions(); len(got) != 2 {
		t.Fatalf("rows %v", got)
	}
}

// tool-server takes the two namespaces from k8s-service with the cluster's kubeconfig, so the AI path holds the same ones.
func TestTheKubeconfigAnswerNamesTheProtectedNamespaces(t *testing.T) {
	for _, c := range []struct {
		self bool
		want map[string]string
	}{
		{true, map[string]string{"install": installNS, "node_shell": nodeShellNS}},
		{false, map[string]string{"node_shell": nodeShellNS}},
	} {
		rig := newProtectedRig(t, writeOnCluster(), c.self)
		w := rig.do("GET", "/internal/clusters/c/kubeconfig", "")
		if w.Code != http.StatusOK {
			t.Fatalf("status %d: %s", w.Code, w.Body)
		}
		var body struct {
			Protected map[string]string `json:"protected_namespaces"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if fmt.Sprint(body.Protected) != fmt.Sprint(c.want) {
			t.Errorf("self=%v: %v, want %v", c.self, body.Protected, c.want)
		}
	}
}

// A YAML create's row says what it was asked to make, as a list next to the length: the text itself stays out of the row.
func TestAYAMLCreateNamesItsObjectsInTheRow(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), false)
	yaml := yamlDoc("Pod", "v1", "first", inside) + "---\n" + yamlDoc("ConfigMap", "v1", "second", "") + "---\n" + yamlDoc("Namespace", "v1", "third", "")
	w := rig.do("POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"namespace": second, "yaml": yaml}))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var after struct {
		YAMLLen int                 `json:"yaml_len"`
		Objects []map[string]string `json:"objects"`
	}
	if len(rig.audit.rows) != 1 {
		t.Fatalf("rows %v", rig.audit.actions())
	}
	if err := json.Unmarshal(rig.audit.rows[0].After, &after); err != nil {
		t.Fatal(err)
	}
	if after.YAMLLen != len(yaml) {
		t.Errorf("yaml_len %d, want %d", after.YAMLLen, len(yaml))
	}
	want := []map[string]string{
		{"kind": "Pod", "name": "first", "namespace": inside},
		{"kind": "ConfigMap", "name": "second", "namespace": second},
		{"kind": "Namespace", "name": "third"},
	}
	if fmt.Sprint(after.Objects) != fmt.Sprint(want) {
		t.Errorf("objects %v, want %v", after.Objects, want)
	}
	if strings.Contains(string(rig.audit.rows[0].After), "apiVersion") {
		t.Errorf("the YAML is in the row: %s", rig.audit.rows[0].After)
	}
}

// A name nothing has validated yet is kept to the length a Kubernetes name can have, so the row stays small.
func TestAYAMLCreatesRowKeepsALongNameShort(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), false)
	long := strings.Repeat("n", 2000)
	if w := rig.do("POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("ConfigMap", "v1", long, inside)})); w.Code == 0 {
		t.Fatal("no answer")
	}
	if len(rig.audit.rows) != 1 {
		t.Fatalf("rows %v", rig.audit.actions())
	}
	if after := string(rig.audit.rows[0].After); strings.Contains(after, long) || !strings.Contains(after, strings.Repeat("n", 253)) {
		t.Errorf("after %.400s", after)
	}
}

// The list has a limit: a long create says how many there were.
func TestAYAMLCreatesObjectListIsCapped(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), false)
	var docs []string
	for i := 0; i < 130; i++ {
		docs = append(docs, yamlDoc("ConfigMap", "v1", fmt.Sprintf("cm-%d", i), inside))
	}
	w := rig.do("POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": strings.Join(docs, "---\n")}))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var after struct {
		Objects []map[string]string `json:"objects"`
		Total   int                 `json:"objects_total"`
	}
	if err := json.Unmarshal(rig.audit.rows[0].After, &after); err != nil {
		t.Fatal(err)
	}
	if len(after.Objects) != 100 || after.Total != 130 {
		t.Errorf("%d objects of %d", len(after.Objects), after.Total)
	}
}

// A node shell's pod has a TTY, so its log is the shell's whole screen.
func TestANodeShellPodsLogIsForThoseHoldingTheNodeShell(t *testing.T) {
	paths := []string{
		"/api/v1/namespaces/" + nodeShellNS + "/pods/node-debugger-a/logs?container=debugger",
		"/api/v1/namespaces/" + nodeShellNS + "/pods/node-debugger-a/logs/stream?container=debugger",
	}
	rig := newProtectedRig(t, writeOnCluster(), false)
	for _, path := range paths {
		if w := rig.do(http.MethodGet, path+"&cluster=c", ""); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "protected_namespace") {
			t.Errorf("Write on %s: %d %s", path, w.Code, w.Body)
		}
	}
	if got := callsInto(rig.api.calls, nodeShellNS); len(got) != 0 {
		t.Errorf("the cluster was asked: %v", got)
	}
}

func TestAHolderOfTheNodeShellKeepsItsPodsLog(t *testing.T) {
	holder := writeOnCluster()
	holder.Perms["c"] = append(holder.Perms["c"], "resource.node.shell")
	rig := newProtectedRig(t, holder, false)
	path := "/api/v1/namespaces/" + nodeShellNS + "/pods/node-debugger-a/logs?container=debugger&cluster=c"
	if w := rig.do(http.MethodGet, path, ""); w.Code == http.StatusForbidden {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestPodLogsStayReadableInTheInstallNamespace(t *testing.T) {
	rig := newProtectedRig(t, writeOnCluster(), true)
	path := "/api/v1/namespaces/" + installNS + "/pods/kubeast-0/logs?container=app&cluster=c"
	if w := rig.do(http.MethodGet, path, ""); w.Code == http.StatusForbidden {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if got := callsInto(rig.api.calls, installNS); len(got) == 0 {
		t.Fatal("the cluster was not asked for the log")
	}
}
