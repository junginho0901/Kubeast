package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/routes"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// twoGroupsCluster serves one plural name in more than one group, and an object of each named "web" in the namespace
// "shop": a Service is core's and Knative's (which makes a core Service of the same name), a Gateway is the Gateway
// API's and Istio's. It counts the reads of each object.
type twoGroupsCluster struct {
	mu    sync.Mutex
	reads map[string]int
	srv   *httptest.Server
}

var twoGroupsServed = map[string][]map[string]interface{}{
	"v1": {
		{"name": "services", "singularName": "service", "kind": "Service", "shortNames": []string{"svc"}, "namespaced": true, "verbs": []string{"get", "patch"}},
		{"name": "configmaps", "singularName": "configmap", "kind": "ConfigMap", "namespaced": true, "verbs": []string{"get", "patch"}},
		{"name": "nodes", "singularName": "node", "kind": "Node", "namespaced": false, "verbs": []string{"get", "patch", "update"}},
		{"name": "namespaces", "singularName": "namespace", "kind": "Namespace", "namespaced": false, "verbs": []string{"get", "update"}},
	},
	"gateway.networking.k8s.io/v1": {
		{"name": "gateways", "singularName": "gateway", "kind": "Gateway", "namespaced": true, "verbs": []string{"get", "patch"}},
	},
	"networking.istio.io/v1": {
		{"name": "gateways", "singularName": "gateway", "kind": "Gateway", "namespaced": true, "verbs": []string{"get", "patch"}},
	},
	"serving.knative.dev/v1": {
		{"name": "services", "singularName": "service", "kind": "Service", "shortNames": []string{"ksvc"}, "namespaced": true, "verbs": []string{"get", "patch"}},
	},
}

func (c *twoGroupsCluster) serve(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch path {
	case "/version":
		writeJSON(w, 200, map[string]string{"major": "1", "minor": "34", "gitVersion": "v1.34.0"})
		return
	case "/api":
		writeJSON(w, 200, map[string]interface{}{"kind": "APIVersions", "versions": []string{"v1"}})
		return
	case "/apis":
		var groups []interface{}
		for _, gv := range []string{"gateway.networking.k8s.io/v1", "networking.istio.io/v1", "serving.knative.dev/v1"} {
			version := map[string]string{"groupVersion": gv, "version": "v1"}
			groups = append(groups, map[string]interface{}{"name": strings.TrimSuffix(gv, "/v1"), "versions": []interface{}{version}, "preferredVersion": version})
		}
		writeJSON(w, 200, map[string]interface{}{"kind": "APIGroupList", "apiVersion": "v1", "groups": groups})
		return
	}
	for gv, resources := range twoGroupsServed {
		root := "/apis/" + gv
		if gv == "v1" {
			root = "/api/v1"
		}
		if path == root {
			writeJSON(w, 200, map[string]interface{}{"kind": "APIResourceList", "apiVersion": "v1", "groupVersion": gv, "resources": resources})
			return
		}
		for _, res := range resources {
			at, object := root+"/namespaces/shop/"+res["name"].(string)+"/web", map[string]interface{}{"name": "web", "namespace": "shop", "resourceVersion": "7"}
			if res["namespaced"] == false {
				at, object = root+"/"+res["name"].(string)+"/shop", map[string]interface{}{"name": "shop", "resourceVersion": "7"}
			}
			if path == at {
				if r.Method == http.MethodGet {
					c.mu.Lock()
					c.reads[path]++
					c.mu.Unlock()
				}
				writeJSON(w, 200, map[string]interface{}{"apiVersion": gv, "kind": res["kind"], "metadata": object})
				return
			}
		}
	}
	writeJSON(w, 404, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404})
}

func (c *twoGroupsCluster) read(path string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.reads[path]
}

type twoGroupsRig struct {
	t       *testing.T
	cluster *twoGroupsCluster
	do      func(method, path string, body map[string]interface{}) *httptest.ResponseRecorder
}

func newTwoGroupsRig(t *testing.T) twoGroupsRig {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "false")
	c := &twoGroupsCluster{reads: map[string]int{}}
	c.srv = httptest.NewServer(http.HandlerFunc(c.serve))
	t.Cleanup(c.srv.Close)
	blob := strings.Replace(standInKubeconfig, "SERVER", c.srv.URL, 1)
	svc, err := k8s.NewService(context.Background(), standInRegistry{blob: blob}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{Impersonation: true})
	if err != nil {
		t.Fatal(err)
	}
	h := handler.New(svc, config.Config{ImpersonationEnabled: true}, &auditRows{})
	payload := auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"c": {"*"}}}
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
	return twoGroupsRig{t: t, cluster: c, do: func(method, path string, body map[string]interface{}) *httptest.ResponseRecorder {
		svc.MarkClusterUp("c")
		text := ""
		if body != nil {
			text = jsonBody(t, body)
		}
		req := httptest.NewRequest(method, path, strings.NewReader(text))
		ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
		defer cancel()
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req.WithContext(ctx))
		return w
	}}
}

// yaml is what GET path answers with as the YAML.
func (g twoGroupsRig) yaml(path string) string {
	g.t.Helper()
	w := g.do("GET", path, nil)
	var answer struct {
		YAML string `json:"yaml"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil || w.Code != 200 {
		g.t.Fatalf("GET %s: %d %s", path, w.Code, w.Body.String())
	}
	return answer.YAML
}

// yamlOf is the YAML of shop/web as a drawer asks for it (frontend objectResourceType).
func (g twoGroupsRig) yamlOf(resourceType string) string {
	g.t.Helper()
	return g.yaml("/api/v1/resources/yaml?" + url.Values{"resource_type": {resourceType}, "resource_name": {"web"}, "namespace": {"shop"}}.Encode())
}

// The YAML kept for an object is not another group's object of the same plural name, namespace and name, nor another
// kind's of its own group.
func TestTheYAMLKeptForOneGroupIsNotAnothers(t *testing.T) {
	for _, order := range [][]string{
		{"services", "services.serving.knative.dev"},
		{"services.serving.knative.dev", "services"},
		{"gateways.gateway.networking.k8s.io", "gateways.networking.istio.io"},
		{"gateways.networking.istio.io", "gateways.gateway.networking.k8s.io"},
		{"gateways", "gateways.networking.istio.io", "services", "ksvc", "svc"},
		{"services", "configmaps"},
	} {
		t.Run(strings.Join(order, ","), func(t *testing.T) {
			g := newTwoGroupsRig(t)
			want := map[string]string{
				"services": "v1\nkind: Service", "svc": "v1\nkind: Service", "configmaps": "v1\nkind: ConfigMap",
				"services.serving.knative.dev": "serving.knative.dev/v1\nkind: Service", "ksvc": "serving.knative.dev/v1\nkind: Service",
				"gateways": "gateway.networking.k8s.io/v1\nkind: Gateway", "gateways.gateway.networking.k8s.io": "gateway.networking.k8s.io/v1\nkind: Gateway",
				"gateways.networking.istio.io": "networking.istio.io/v1\nkind: Gateway",
			}
			for _, resourceType := range order {
				if text := g.yamlOf(resourceType); !strings.Contains(text, "apiVersion: "+want[resourceType]+"\n") {
					t.Errorf("%s: want the object of %s, got\n%s", resourceType, want[resourceType], text)
				}
			}
		})
	}
}

// The YAML is kept still: an object asked for again, by whatever name of its resource, is not read again until it is
// saved, and a save drops what was kept of that object and of no other group's.
func TestAYAMLIsKeptUntilItsObjectIsSaved(t *testing.T) {
	g := newTwoGroupsRig(t)
	core, knative := "/api/v1/namespaces/shop/services/web", "/apis/serving.knative.dev/v1/namespaces/shop/services/web"
	for _, resourceType := range []string{"services", "Service", "svc", "services.serving.knative.dev", "ksvc"} {
		g.yamlOf(resourceType)
	}
	if a, b := g.cluster.read(core), g.cluster.read(knative); a != 1 || b != 1 {
		t.Fatalf("read %d and %d times for five questions about two objects, want once each", a, b)
	}
	text := "apiVersion: serving.knative.dev/v1\nkind: Service\nmetadata:\n  name: web\n  namespace: shop\n  labels:\n    a: b\n"
	if w := g.do("POST", "/api/v1/resources/yaml/apply", map[string]interface{}{"resource_type": "services.serving.knative.dev", "namespace": "shop", "name": "web", "yaml": text}); w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	g.yamlOf("services")
	g.yamlOf("services.serving.knative.dev")
	if a, b := g.cluster.read(core), g.cluster.read(knative); a != 1 || b != 2 {
		t.Errorf("after Knative's Service was saved: core's read %d times, Knative's %d, want 1 and 2", a, b)
	}
}

// A write through a screen's own route drops the YAML its other routes kept: each names the object's key the same.
func TestASaveDropsTheYAMLItsOwnRouteKept(t *testing.T) {
	for _, tc := range []struct {
		name, object, method, save string
		reads                      []string
		body                       map[string]interface{}
	}{
		{"a ConfigMap", "/api/v1/namespaces/shop/configmaps/web", "POST", "/api/v1/resources/yaml/apply",
			[]string{"/api/v1/namespaces/shop/configmaps/web/yaml", "/api/v1/resources/yaml?resource_type=configmaps&resource_name=web&namespace=shop"},
			map[string]interface{}{"resource_type": "configmaps", "namespace": "shop", "name": "web", "yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web\ndata:\n  a: b\n"}},
		{"a Namespace", "/api/v1/namespaces/shop", "POST", "/api/v1/namespaces/shop/yaml/apply",
			[]string{"/api/v1/namespaces/shop/yaml", "/api/v1/resources/yaml?resource_type=namespaces&resource_name=shop"},
			map[string]interface{}{"yaml": "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shop\n  labels:\n    a: b\n"}},
		{"a Node", "/api/v1/nodes/shop", "POST", "/api/v1/nodes/shop/yaml/apply",
			[]string{"/api/v1/nodes/shop/yaml", "/api/v1/resources/yaml?resource_type=nodes&resource_name=shop"},
			map[string]interface{}{"yaml": "apiVersion: v1\nkind: Node\nmetadata:\n  name: shop\n  labels:\n    a: b\n"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newTwoGroupsRig(t)
			for _, path := range tc.reads {
				g.yaml(path)
			}
			if n := g.cluster.read(tc.object); n != 1 {
				t.Fatalf("read %d times by two routes, want once", n)
			}
			if w := g.do(tc.method, tc.save, tc.body); w.Code != 200 {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			before := g.cluster.read(tc.object) // a Namespace and a Node are read for the save itself
			for _, path := range tc.reads {
				g.yaml(path)
			}
			if n := g.cluster.read(tc.object) - before; n != 1 {
				t.Errorf("read %d times after the save, want once", n)
			}
		})
	}
}
