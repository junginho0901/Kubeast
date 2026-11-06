package handler_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
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
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// These run the real routes, middleware, handlers and client-go against a stand-in API server that holds objects in
// two namespaces, and that answers an all-namespaces list with both, as a cluster does for a group bound cluster-wide.

const (
	inside  = "shop"
	outside = "other"
	second  = "cart"
)

type apiCall struct {
	method, path, query, user string
}

// signedInUser is who a request goes out as; the informers watch as an identity of their own.
const signedInUser = "reader@example.com"

type standIn struct {
	mu      sync.Mutex
	calls   []apiCall
	refused map[string]bool // namespaces the cluster refuses to the caller
	review  []string        // the access reviews asked, as sent
	srv     *httptest.Server
}

func (a *standIn) reviews() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.review...)
}

// core and grouped are the kinds the stand-in serves, as discovery says: plural → kind, namespaced.
type kindInfo struct {
	kind       string
	namespaced bool
}

var standInKinds = map[string]map[string]kindInfo{
	"v1": {
		"pods": {"Pod", true}, "configmaps": {"ConfigMap", true}, "secrets": {"Secret", true}, "services": {"Service", true},
		"events": {"Event", true}, "persistentvolumeclaims": {"PersistentVolumeClaim", true}, "serviceaccounts": {"ServiceAccount", true},
		"endpoints": {"Endpoints", true}, "resourcequotas": {"ResourceQuota", true}, "limitranges": {"LimitRange", true},
		"namespaces": {"Namespace", false}, "nodes": {"Node", false}, "persistentvolumes": {"PersistentVolume", false},
	},
	"apps/v1": {
		"deployments": {"Deployment", true}, "replicasets": {"ReplicaSet", true}, "statefulsets": {"StatefulSet", true},
		"daemonsets": {"DaemonSet", true}, "controllerrevisions": {"ControllerRevision", true},
	},
	"batch/v1":               {"jobs": {"Job", true}, "cronjobs": {"CronJob", true}},
	"autoscaling/v2":         {"horizontalpodautoscalers": {"HorizontalPodAutoscaler", true}},
	"policy/v1":              {"poddisruptionbudgets": {"PodDisruptionBudget", true}},
	"discovery.k8s.io/v1":    {"endpointslices": {"EndpointSlice", true}},
	"coordination.k8s.io/v1": {"leases": {"Lease", true}},
	"rbac.authorization.k8s.io/v1": {
		"roles": {"Role", true}, "rolebindings": {"RoleBinding", true},
		"clusterroles": {"ClusterRole", false}, "clusterrolebindings": {"ClusterRoleBinding", false},
	},
	"networking.k8s.io/v1": {"ingresses": {"Ingress", true}, "networkpolicies": {"NetworkPolicy", true}, "ingressclasses": {"IngressClass", false}},
	"storage.k8s.io/v1":    {"storageclasses": {"StorageClass", false}},
	"metrics.k8s.io/v1beta1": {
		"pods": {"PodMetrics", true}, "nodes": {"NodeMetrics", false},
	},
	"example.com/v1": {"widgets": {"Widget", true}, "clusterwidgets": {"ClusterWidget", false}},
}

func newStandIn(t *testing.T) *standIn {
	t.Helper()
	a := &standIn{refused: map[string]bool{}}
	a.srv = httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(a.srv.Close)
	return a
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *standIn) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/version":
		writeJSON(w, 200, map[string]string{"major": "1", "minor": "34", "gitVersion": "v1.34.0"})
		return
	case "/api":
		writeJSON(w, 200, map[string]interface{}{"kind": "APIVersions", "versions": []string{"v1"}})
		return
	case "/apis":
		var groups []map[string]interface{}
		for gv := range standInKinds {
			if group, version, ok := strings.Cut(gv, "/"); ok {
				groups = append(groups, map[string]interface{}{"name": group, "versions": []map[string]string{{"groupVersion": gv, "version": version}},
					"preferredVersion": map[string]string{"groupVersion": gv, "version": version}})
			}
		}
		writeJSON(w, 200, map[string]interface{}{"kind": "APIGroupList", "apiVersion": "v1", "groups": groups})
		return
	}
	a.mu.Lock()
	a.calls = append(a.calls, apiCall{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Impersonate-User")})
	a.mu.Unlock()

	if r.URL.Path == "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" {
		body, _ := io.ReadAll(r.Body)
		a.mu.Lock()
		a.review = append(a.review, string(body))
		a.mu.Unlock()
		writeJSON(w, 201, map[string]interface{}{"kind": "SelfSubjectAccessReview", "apiVersion": "authorization.k8s.io/v1", "status": map[string]bool{"allowed": true}})
		return
	}
	gv, rest := splitGroupVersion(r.URL.Path)
	kinds, ok := standInKinds[gv]
	if !ok {
		writeJSON(w, 404, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404, "message": "not served"})
		return
	}
	if rest == "" {
		var list []map[string]interface{}
		for plural, k := range kinds {
			list = append(list, map[string]interface{}{"name": plural, "singularName": strings.ToLower(k.kind), "kind": k.kind, "namespaced": k.namespaced,
				"verbs": []string{"get", "list", "watch", "create", "patch", "delete"}})
		}
		writeJSON(w, 200, map[string]interface{}{"kind": "APIResourceList", "apiVersion": "v1", "groupVersion": gv, "resources": list})
		return
	}
	parts := strings.Split(rest, "/")
	namespace := ""
	if parts[0] == "namespaces" && len(parts) >= 3 {
		namespace, parts = parts[1], parts[2:]
	}
	if namespace != "" && a.isRefused(namespace) {
		writeJSON(w, 403, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "Forbidden", "code": 403, "message": "the cluster refuses namespace " + namespace})
		return
	}
	plural := parts[0]
	k, ok := kinds[plural]
	if !ok {
		writeJSON(w, 404, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404, "message": "no kind " + plural})
		return
	}
	if r.URL.Query().Get("watch") == "true" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
		return
	}
	switch r.Method {
	case http.MethodPost, http.MethodPatch, http.MethodDelete:
		name := "created"
		if len(parts) > 1 {
			name = parts[1]
		}
		writeJSON(w, 200, standInObject(gv, plural, k, namespace, name))
		return
	}
	if len(parts) > 1 {
		name := parts[1]
		if !k.namespaced && namespace != "" {
			writeJSON(w, 404, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404, "message": "cluster-scoped"})
			return
		}
		if k.namespaced && namespace == "" {
			writeJSON(w, 404, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404, "message": "needs a namespace"})
			return
		}
		writeJSON(w, 200, standInAnswer(r, gv, standInObject(gv, plural, k, namespace, name)))
		return
	}
	var items []map[string]interface{}
	if k.namespaced && namespace == "" {
		for _, ns := range []string{inside, second, outside} {
			items = append(items, standInObject(gv, plural, k, ns, plural+"-"+ns))
		}
	} else if k.namespaced {
		items = append(items, standInObject(gv, plural, k, namespace, plural+"-"+namespace))
	} else if plural == "namespaces" {
		for _, ns := range []string{inside, second, outside} {
			items = append(items, standInObject(gv, plural, k, "", ns))
		}
	} else {
		items = append(items, standInObject(gv, plural, k, "", plural+"-cluster"))
	}
	writeJSON(w, 200, standInAnswer(r, gv, map[string]interface{}{"kind": k.kind + "List", "apiVersion": gv, "metadata": map[string]string{"resourceVersion": "1"}, "items": items}))
}

// standInAnswer prints a custom resource's answer as the Table kubectl asks for; other kinds answer without one.
func standInAnswer(r *http.Request, gv string, answer map[string]interface{}) map[string]interface{} {
	if gv != "example.com/v1" || !strings.Contains(r.Header.Get("Accept"), "as=Table") {
		return answer
	}
	items, listed := answer["items"].([]map[string]interface{})
	if !listed {
		items = []map[string]interface{}{answer}
	}
	rows := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		name, _ := item["metadata"].(map[string]interface{})["name"].(string)
		rows = append(rows, map[string]interface{}{"cells": []string{name}, "object": item})
	}
	return map[string]interface{}{"kind": "Table", "apiVersion": "meta.k8s.io/v1",
		"columnDefinitions": []map[string]string{{"name": "Name", "type": "string", "format": "name"}}, "rows": rows}
}

func (a *standIn) isRefused(ns string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.refused[ns]
}

func splitGroupVersion(path string) (gv, rest string) {
	if p, ok := strings.CutPrefix(path, "/api/v1"); ok {
		return "v1", strings.TrimPrefix(p, "/")
	}
	if p, ok := strings.CutPrefix(path, "/apis/"); ok {
		segs := strings.SplitN(p, "/", 3)
		if len(segs) < 2 {
			return p, ""
		}
		gv = segs[0] + "/" + segs[1]
		if len(segs) == 3 {
			rest = segs[2]
		}
		return gv, rest
	}
	return "", ""
}

func standInObject(gv, plural string, k kindInfo, namespace, name string) map[string]interface{} {
	now := time.Now().UTC().Format(time.RFC3339)
	meta := map[string]interface{}{"name": name, "uid": name + "-uid", "creationTimestamp": now}
	if namespace != "" {
		meta["namespace"] = namespace
	}
	obj := map[string]interface{}{"apiVersion": gv, "kind": k.kind, "metadata": meta}
	switch plural {
	case "events":
		obj["type"] = "Normal"
		obj["reason"] = "Seen"
		obj["message"] = "event of " + namespace
		obj["lastTimestamp"] = now
		obj["involvedObject"] = map[string]string{"kind": "Pod", "name": "p", "namespace": namespace}
	case "pods":
		if gv == "metrics.k8s.io/v1beta1" {
			obj["timestamp"] = now
			obj["containers"] = []map[string]interface{}{{"name": "c", "usage": map[string]string{"cpu": "1m", "memory": "1Mi"}}}
			break
		}
		// asks for a GPU, so the GPU dashboard lists it
		obj["spec"] = map[string]interface{}{"nodeName": "n1", "containers": []map[string]interface{}{{"name": "c", "image": "i",
			"resources": map[string]interface{}{"requests": map[string]string{"nvidia.com/gpu": "1"}, "limits": map[string]string{"nvidia.com/gpu": "1"}}}}}
	case "secrets":
		obj["type"] = "helm.sh/release.v1"
		meta["labels"] = map[string]string{"owner": "helm", "name": "rel-" + namespace, "status": "deployed", "version": "1"}
		obj["data"] = map[string]string{"release": helmSecretValue("rel-"+namespace, namespace)}
	case "persistentvolumes":
		obj["spec"] = map[string]interface{}{"storageClassName": "probe", "claimRef": map[string]string{"namespace": outside, "name": "the-claim"}}
	case "persistentvolumeclaims":
		obj["spec"] = map[string]interface{}{"storageClassName": "probe"}
	case "ingresses":
		obj["spec"] = map[string]interface{}{"ingressClassName": "probe"}
	}
	return obj
}

// helmSecretValue is a release as Helm's Secret driver stores it: base64 of gzip of the JSON, and the API's base64 over it.
func helmSecretValue(name, namespace string) string {
	raw, _ := json.Marshal(map[string]interface{}{"name": name, "namespace": namespace, "version": 1,
		"info": map[string]string{"status": "deployed"}, "chart": map[string]interface{}{"metadata": map[string]string{"name": "c", "version": "1.0.0"}}})
	var zipped bytes.Buffer
	gz := gzip.NewWriter(&zipped)
	_, _ = gz.Write(raw)
	_ = gz.Close()
	return base64.StdEncoding.EncodeToString([]byte(base64.StdEncoding.EncodeToString(zipped.Bytes())))
}

// callerCalls are the calls that went out as the signed-in user.
func (a *standIn) callerCalls() []apiCall {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []apiCall
	for _, c := range a.calls {
		if c.user == signedInUser {
			out = append(out, c)
		}
	}
	return out
}

func (a *standIn) reset() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = nil
	a.review = nil
}

// wideLists are the caller's lists of a namespaced kind across every namespace. The events about one cluster-scoped
// object, which kubectl describe reads the same way, are about that object and no namespace.
func wideLists(calls []apiCall) []string {
	var out []string
	for _, c := range calls {
		gv, rest := splitGroupVersion(c.path)
		kinds := standInKinds[gv]
		if rest == "" || strings.HasPrefix(rest, "namespaces/") || strings.Contains(rest, "/") {
			continue
		}
		if rest == "events" && strings.Contains(c.query, "involvedObject.kind") {
			continue
		}
		if k, ok := kinds[rest]; ok && k.namespaced {
			out = append(out, c.path)
		}
	}
	return out
}

var namespacePath = regexp.MustCompile(`/namespaces/([^/]+)`)

// namespacesReached are the namespaces the caller's calls went into, the namespace objects read by name among them.
func namespacesReached(calls []apiCall) map[string]bool {
	out := map[string]bool{}
	for _, c := range calls {
		if m := namespacePath.FindStringSubmatch(c.path); m != nil {
			out[m[1]] = true
		}
	}
	return out
}

type standInRegistry struct{ blob string }

func (standInRegistry) List(context.Context) ([]cluster.Info, error) { return nil, nil }
func (r standInRegistry) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	return &cluster.Info{ID: id, Mode: cluster.ModeExternal, KubeconfigBlob: r.blob}, nil
}
func (standInRegistry) Default(context.Context) (cluster.ID, error) { return "c", nil }

type auditRows struct {
	mu   sync.Mutex
	rows []audit.Record
}

func (s *auditRows) Write(_ context.Context, rec audit.Record) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows = append(s.rows, rec)
	return int64(len(s.rows)), nil
}

func (s *auditRows) actions() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, r := range s.rows {
		out = append(out, r.Action)
	}
	return out
}

const standInKubeconfig = `apiVersion: v1
kind: Config
clusters:
- name: test
  cluster:
    server: SERVER
contexts:
- name: test
  context:
    cluster: test
    user: test
current-context: test
users:
- name: test
  user:
    token: test-token
`

type scopeRig struct {
	api    *standIn
	audit  *auditRows
	svc    *k8s.Service
	router chi.Router
}

// newScopeRig wires the protected group as main.go does; the group is inline, so its middleware sees the matched route.
func newScopeRig(t *testing.T, payload auth.TokenPayload, extra func(chi.Router)) *scopeRig {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "false")
	api := newStandIn(t)
	blob := strings.Replace(standInKubeconfig, "SERVER", api.srv.URL, 1)
	svc, err := k8s.NewService(context.Background(), standInRegistry{blob: blob}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{Impersonation: true})
	if err != nil {
		t.Fatal(err)
	}
	store := &auditRows{}
	h := handler.New(svc, config.Config{ImpersonationEnabled: true, HygieneEnabled: true, NodeShellEnabled: true, HygieneIntervalDays: 30}, store)
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
		if extra != nil {
			extra(g)
		}
	})
	return &scopeRig{api: api, audit: store, svc: svc, router: r}
}

// do answers one request. A stand-in that does not serve what a handler wanted may answer 503, which marks the cluster
// down for the next request: each request starts with the cluster up.
func (s *scopeRig) do(method, target, body string) *httptest.ResponseRecorder {
	s.svc.MarkClusterUp("c")
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
	defer cancel()
	w := httptest.NewRecorder()
	s.router.ServeHTTP(w, req.WithContext(ctx))
	return w
}

func payloadFor(namespaces ...string) auth.TokenPayload {
	p := auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"*": {"admin.hygiene.*"}, "c": {"*"}}, Roles: map[string]string{"c": "Write"}}
	if len(namespaces) > 0 {
		p.Namespaces = map[string][]string{"c": namespaces}
	}
	return p
}

func jsonBody(t *testing.T, v interface{}) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func yamlDoc(kind, apiVersion, name, namespace string) string {
	meta := "metadata:\n  name: " + name + "\n"
	if namespace != "" {
		meta += "  namespace: " + namespace + "\n"
	}
	return "apiVersion: " + apiVersion + "\nkind: " + kind + "\n" + meta
}

// Whatever way a request names a namespace outside the grant, it is refused before the cluster is asked.
func TestScopedGrantIsRefusedOutsideItsNamespacesOnEveryWay(t *testing.T) {
	cm := func(namespace string) string { return yamlDoc("ConfigMap", "v1", "cm", namespace) }
	cases := []struct {
		name, method, target, body string
	}{
		{"generic list by query", "GET", "/api/v1/resources?resource_type=configmaps&namespace=" + outside, ""},
		{"generic list, Advanced Search form", "GET", "/api/v1/resources?resource_type=configmaps&output=json&namespace=" + outside, ""},
		{"generic list, the namespace repeated", "GET", "/api/v1/resources?resource_type=configmaps&namespace=" + inside + "&namespace=" + outside, ""},
		{"generic object as JSON", "GET", "/api/v1/resources/json?resource_type=configmaps&resource_name=x&namespace=" + outside, ""},
		{"generic object as YAML", "GET", "/api/v1/resources/yaml?resource_type=configmaps&resource_name=x&namespace=" + outside, ""},
		{"generic object described", "GET", "/api/v1/resources/describe?resource_type=configmaps&resource_name=x&namespace=" + outside, ""},
		{"a Secret as YAML", "GET", "/api/v1/resources/yaml?resource_type=secrets&name=x&namespace=" + outside, ""},
		{"a namespaced kind with no namespace", "GET", "/api/v1/resources/json?resource_type=configmaps&resource_name=x", ""},
		{"a namespace object by the generic route", "GET", "/api/v1/resources/yaml?resource_type=namespaces&name=" + outside, ""},
		{"events by query", "GET", "/api/v1/events?namespace=" + outside, ""},
		{"pod metrics by query", "GET", "/api/v1/metrics/pods?namespace=" + outside, ""},
		{"optimization by query", "GET", "/api/v1/optimization?namespace=" + outside, ""},
		{"pod page by query", "GET", "/api/v1/pods/page?namespace=" + outside, ""},
		{"pods per node by query", "GET", "/api/v1/pods/nodes?namespace=" + outside, ""},
		{"pods on a node by query", "GET", "/api/v1/pods/on-node?node=n1&namespace=" + outside, ""},
		{"policy report summary by query", "GET", "/api/v1/policyreports/summary?namespace=" + outside, ""},
		{"policy report rows by query", "GET", "/api/v1/policyreports/results?namespace=" + outside, ""},
		{"resource graph by query list", "GET", "/api/v1/resource-graph?namespaces=" + inside + "," + outside, ""},
		{"helm list by query", "GET", "/api/v1/helm/releases?namespace=" + outside, ""},
		{"helm stream by query", "GET", "/api/v1/helm/releases/stream?namespace=" + outside, ""},
		{"helm release by path", "GET", "/api/v1/helm/releases/" + outside + "/rel", ""},
		{"helm history by path", "GET", "/api/v1/helm/releases/" + outside + "/rel/history", ""},
		{"helm section by path", "GET", "/api/v1/helm/releases/" + outside + "/rel/values", ""},
		{"helm diff by path", "POST", "/api/v1/helm/releases/" + outside + "/rel/diff", `{}`},
		{"helm rollback by path", "POST", "/api/v1/helm/releases/" + outside + "/rel/rollback", `{"revision":1}`},
		{"helm test by path", "POST", "/api/v1/helm/releases/" + outside + "/rel/test", `{}`},
		{"helm upgrade by path", "PUT", "/api/v1/helm/releases/" + outside + "/rel/values", `{"values":"a: 1"}`},
		{"helm uninstall by path", "DELETE", "/api/v1/helm/releases/" + outside + "/rel", ""},
		{"namespace topology by path", "GET", "/api/v1/topology/namespace/" + outside, ""},
		{"service topology by path", "GET", "/api/v1/topology/service/" + outside + "/s", ""},
		{"deployment topology by path", "GET", "/api/v1/topology/deployment/" + outside + "/d", ""},
		{"custom resource described by path", "GET", "/api/v1/custom-resources/example.com/v1/widgets/" + outside + "/w/describe", ""},
		{"custom resource deleted by path", "DELETE", "/api/v1/custom-resources/example.com/v1/widgets/" + outside + "/w", ""},
		{"a namespaced path with an empty namespace", "GET", "/api/v1/namespaces//configmaps", ""},
		{"a namespaced object path with an empty namespace", "GET", "/api/v1/namespaces//configmaps/x/yaml", ""},
		{"a namespace written with an escape", "GET", "/api/v1/namespaces/oth%65r/configmaps", ""},
		{"an escaped slash after an own namespace", "GET", "/api/v1/namespaces/" + inside + "%2F..%2F" + outside + "/configmaps", ""},
		{"apply by the body's namespace", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "configmaps", "name": "cm", "namespace": outside, "yaml": cm("")})},
		{"apply with no namespace, namespaced kind", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "configmaps", "name": "cm", "yaml": cm("")})},
		{"apply naming another namespace in the YAML", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "configmaps", "name": "cm", "namespace": inside, "yaml": cm(outside)})},
		{"apply with another namespace in a later document", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "configmaps", "name": "cm", "namespace": inside, "yaml": cm(inside) + "---\n" + cm(outside)})},
		{"apply to a namespace object", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "namespaces", "name": outside, "yaml": yamlDoc("Namespace", "v1", outside, "")})},
		{"create by the default namespace", "POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"namespace": outside, "yaml": cm("")})},
		{"create by the YAML's namespace", "POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"namespace": inside, "yaml": cm(outside)})},
		{"create falling back to the default namespace", "POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": cm("")})},
		{"create with one document outside, none created", "POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"namespace": inside, "yaml": cm(inside) + "---\n" + cm(outside)})},
		{"create of a namespace outside", "POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("Namespace", "v1", outside, "")})},
		{"new namespace by name", "POST", "/api/v1/namespaces", jsonBody(t, map[string]string{"name": outside})},
		{"hygiene report", "GET", "/api/v1/hygiene", ""},
		{"hygiene sign-off", "POST", "/api/v1/hygiene/signoff", `{"note":"n"}`},
		{"hygiene history", "GET", "/api/v1/hygiene/history", ""},
		{"hygiene snapshot", "GET", "/api/v1/hygiene/snapshot/1", ""},
		{"node drain", "POST", "/api/v1/nodes/n1/drain", ""},
		{"node drain status", "GET", "/api/v1/nodes/n1/drain/status?drain_id=x", ""},
		{"node shell", "GET", "/api/v1/nodes/n1/debug-shell/ws", ""},
	}
	rig := newScopeRig(t, payloadFor(inside), nil)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rig.api.reset()
			w := rig.do(tc.method, tc.target, tc.body)
			if w.Code != http.StatusForbidden {
				t.Errorf("status %d, want 403: %.200s", w.Code, w.Body.String())
			}
			if calls := rig.api.callerCalls(); len(calls) != 0 {
				t.Errorf("the cluster was asked: %+v", calls)
			}
			if strings.Contains(w.Body.String(), "configmaps-"+outside) {
				t.Errorf("the other namespace's object is in the answer: %.200s", w.Body.String())
			}
		})
	}
}

// The same ways, inside the grant, keep working and go to the cluster as before.
func TestScopedGrantKeepsItsOwnNamespaces(t *testing.T) {
	cm := func(namespace string) string { return yamlDoc("ConfigMap", "v1", "cm", namespace) }
	cases := []struct {
		name, method, target, body string
		want                       string // a call the cluster gets, method and path
	}{
		{"generic list by query", "GET", "/api/v1/resources?resource_type=configmaps&namespace=" + inside, "", "GET /api/v1/namespaces/" + inside + "/configmaps"},
		{"generic object as JSON", "GET", "/api/v1/resources/json?resource_type=configmaps&resource_name=x&namespace=" + inside, "", "GET /api/v1/namespaces/" + inside + "/configmaps/x"},
		{"generic object as YAML", "GET", "/api/v1/resources/yaml?resource_type=configmaps&resource_name=x&namespace=" + inside, "", "GET /api/v1/namespaces/" + inside + "/configmaps/x"},
		{"generic object described", "GET", "/api/v1/resources/describe?resource_type=configmaps&resource_name=x&namespace=" + inside, "", "GET /api/v1/namespaces/" + inside + "/configmaps/x"},
		{"a cluster-scoped kind by the generic route", "GET", "/api/v1/resources/yaml?resource_type=nodes&resource_name=n1", "", "GET /api/v1/nodes/n1"},
		{"its own namespace object by the generic route", "GET", "/api/v1/resources/yaml?resource_type=namespaces&name=" + inside, "", "GET /api/v1/namespaces/" + inside},
		{"events by query", "GET", "/api/v1/events?namespace=" + inside, "", "GET /api/v1/namespaces/" + inside + "/events"},
		{"pod metrics by query", "GET", "/api/v1/metrics/pods?namespace=" + inside, "", "GET /apis/metrics.k8s.io/v1beta1/namespaces/" + inside + "/pods"},
		{"namespaced path", "GET", "/api/v1/namespaces/" + inside + "/configmaps", "", "GET /api/v1/namespaces/" + inside + "/configmaps"},
		{"namespace object by path", "GET", "/api/v1/namespaces/" + inside + "/yaml?force_refresh=true", "", "GET /api/v1/namespaces/" + inside},
		{"nodes stay the cluster's to answer", "GET", "/api/v1/nodes", "", "GET /api/v1/nodes"},
		{"helm list by query", "GET", "/api/v1/helm/releases?namespace=" + inside, "", "GET /api/v1/namespaces/" + inside + "/secrets"},
		{"helm release by path", "GET", "/api/v1/helm/releases/" + inside + "/rel-" + inside, "", "GET /api/v1/namespaces/" + inside + "/secrets"},
		{"namespace topology by path", "GET", "/api/v1/topology/namespace/" + inside, "", "GET /api/v1/namespaces/" + inside + "/pods"},
		{"resource graph by query list", "GET", "/api/v1/resource-graph?namespaces=" + inside, "", "GET /api/v1/namespaces/" + inside + "/pods"},
		{"a cluster-scoped custom resource", "GET", "/api/v1/custom-resources/example.com/v1/clusterwidgets/-/w/describe", "", "GET /apis/example.com/v1/clusterwidgets/w"},
		{"a namespaced custom resource", "GET", "/api/v1/custom-resources/example.com/v1/widgets/" + inside + "/w/describe", "", "GET /apis/example.com/v1/namespaces/" + inside + "/widgets/w"},
		{"delete of a cluster-scoped custom resource", "DELETE", "/api/v1/custom-resources/example.com/v1/clusterwidgets/-/w", "", "DELETE /apis/example.com/v1/clusterwidgets/w"},
		{"apply in its namespace", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "configmaps", "name": "cm", "namespace": inside, "yaml": cm("")}), "PATCH /api/v1/namespaces/" + inside + "/configmaps/cm"},
		{"apply with its namespace in the YAML", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "configmaps", "name": "cm", "namespace": inside, "yaml": cm(inside)}), "PATCH /api/v1/namespaces/" + inside + "/configmaps/cm"},
		{"apply to a cluster-scoped kind", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "nodes", "name": "n1", "yaml": yamlDoc("Node", "v1", "n1", "")}), "PATCH /api/v1/nodes/n1"},
		{"create by the default namespace", "POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"namespace": inside, "yaml": cm("")}), "POST /api/v1/namespaces/" + inside + "/configmaps"},
		{"create by the YAML's namespace", "POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": cm(inside)}), "POST /api/v1/namespaces/" + inside + "/configmaps"},
		{"create of two documents inside", "POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"namespace": inside, "yaml": cm("") + "---\n" + cm(inside)}), "POST /api/v1/namespaces/" + inside + "/configmaps"},
		{"new namespace the grant names", "POST", "/api/v1/namespaces", jsonBody(t, map[string]string{"name": inside}), "POST /api/v1/namespaces"},
	}
	rig := newScopeRig(t, payloadFor(inside), nil)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rig.api.reset()
			w := rig.do(tc.method, tc.target, tc.body)
			if w.Code == http.StatusForbidden {
				t.Fatalf("refused inside the grant: %.300s", w.Body.String())
			}
			if tc.want != "" {
				var got []string
				for _, c := range rig.api.callerCalls() {
					got = append(got, c.method+" "+c.path)
				}
				if !slices.Contains(got, tc.want) {
					t.Errorf("status %d, the cluster got %v, want %s: %.200s", w.Code, got, tc.want, w.Body.String())
				}
			}
			if reached := namespacesReached(rig.api.callerCalls()); reached[outside] {
				t.Errorf("reached the namespace outside: %+v", rig.api.callerCalls())
			}
		})
	}
}

// /can-i answers for the buttons: outside the grant it is "no" and the cluster is not asked, since a failed call shows
// the button; inside, and for every namespace, the cluster answers.
func TestCanIStaysWithinALimitedGrant(t *testing.T) {
	rig := newScopeRig(t, payloadFor(inside), nil)
	for target, want := range map[string]string{
		"/api/v1/can-i?verb=get&resource=pods&namespace=" + outside: `{"allowed":false}`,
		"/api/v1/can-i?verb=get&resource=pods&namespace=" + inside:  `{"allowed":true}`,
		"/api/v1/can-i?verb=get&resource=pods":                      `{"allowed":true}`,
	} {
		rig.api.reset()
		w := rig.do("GET", target, "")
		if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != want {
			t.Errorf("%s: status %d, %s, want %s", target, w.Code, w.Body, want)
		}
		if asked := len(rig.api.callerCalls()) > 0; asked == strings.Contains(target, outside) {
			t.Errorf("%s: the cluster asked: %v", target, asked)
		}
	}
}

// A create with one document outside the grant creates none of them: the check comes before the first create.
func TestScopedCreateWithADocumentOutsideCreatesNothing(t *testing.T) {
	rig := newScopeRig(t, payloadFor(inside), nil)
	w := rig.do("POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"namespace": inside,
		"yaml": yamlDoc("ConfigMap", "v1", "first", inside) + "---\n" + yamlDoc("ConfigMap", "v1", "second", outside)}))
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "outside your grant") {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	for _, c := range rig.api.callerCalls() {
		if c.method == http.MethodPost {
			t.Fatalf("created: %+v", c)
		}
	}
}

// Asked with no namespace, a list answers what the grant covers, namespace by namespace, and nothing beside it.
func TestScopedListsNarrowToTheGrant(t *testing.T) {
	cases := []struct {
		name, target string
		want         []string // in the answer
		notWant      string   // not in the answer; empty: the namespace outside
	}{
		{"events", "/api/v1/events", []string{"event of " + inside, "event of " + second}, ""},
		{"generic list", "/api/v1/resources?resource_type=configmaps", []string{"configmaps-" + inside, "configmaps-" + second}, ""},
		{"generic list, all namespaces flag", "/api/v1/resources?resource_type=configmaps&all_namespaces=true", []string{"configmaps-" + inside, "configmaps-" + second}, ""},
		{"Advanced Search", "/api/v1/resources?resource_type=configmaps&output=json&all_namespaces=true", []string{"configmaps-" + inside, "configmaps-" + second}, ""},
		{"namespaces by the generic list", "/api/v1/resources?resource_type=namespaces", []string{inside, second}, ""},
		{"namespaces by Advanced Search", "/api/v1/resources?resource_type=namespaces&output=json&all_namespaces=true", []string{inside, second}, ""},
		{"pod metrics", "/api/v1/metrics/pods", []string{"pods-" + inside, "pods-" + second}, ""},
		{"top pods", "/api/v1/metrics/top-resources", []string{"pods-" + inside, "pods-" + second}, ""},
		{"helm releases", "/api/v1/helm/releases", []string{"rel-" + inside, "rel-" + second}, ""},
		{"resource graph", "/api/v1/resource-graph", []string{"pods-" + inside, "pods-" + second}, "pods-" + outside},
		{"timeline", "/api/v1/timeline", []string{"event of " + inside, "event of " + second}, ""},
		{"custom resources of one kind", "/api/v1/custom-resources/example.com/v1/widgets", []string{"widgets-" + inside, "widgets-" + second}, ""},
		{"ingresses of a class", "/api/v1/ingressclasses/probe/ingresses", []string{"ingresses-" + inside, "ingresses-" + second}, ""},
		{"GPU pods", "/api/v1/gpu/dashboard", []string{"pods-" + inside, "pods-" + second}, ""},
		{"PVCs of a storage class", "/api/v1/storageclasses/probe/describe", []string{"persistentvolumeclaims-" + inside, "persistentvolumeclaims-" + second}, "persistentvolumeclaims-" + outside},
	}
	rig := newScopeRig(t, payloadFor(inside, second), nil)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rig.api.reset()
			w := rig.do("GET", tc.target, "")
			if w.Code != http.StatusOK {
				t.Fatalf("status %d: %.300s", w.Code, w.Body.String())
			}
			for _, want := range tc.want {
				if !strings.Contains(w.Body.String(), want) {
					t.Errorf("%q is missing from the answer: %.400s", want, w.Body.String())
				}
			}
			notWant := tc.notWant
			if notWant == "" {
				notWant = outside
			}
			if strings.Contains(w.Body.String(), notWant) {
				t.Errorf("%q is in the answer: %.400s", notWant, w.Body.String())
			}
			if wide := wideLists(rig.api.callerCalls()); len(wide) != 0 {
				t.Errorf("listed across namespaces: %v", wide)
			}
		})
	}
}

// A narrowed list with one namespace the cluster refuses shows the others; with all refused it is the cluster's refusal.
func TestScopedListsSkipARefusedNamespaceUnlessAllAre(t *testing.T) {
	for _, target := range []string{"/api/v1/events", "/api/v1/timeline", "/api/v1/resources?resource_type=configmaps", "/api/v1/metrics/pods", "/api/v1/helm/releases?force_refresh=true", "/api/v1/custom-resources/example.com/v1/widgets"} {
		t.Run(target, func(t *testing.T) {
			rig := newScopeRig(t, payloadFor(inside, second), nil)
			rig.api.refused[second] = true
			w := rig.do("GET", target, "")
			if w.Code != http.StatusOK {
				t.Fatalf("one refused: status %d: %.300s", w.Code, w.Body.String())
			}
			rig.api.refused[inside] = true
			w = rig.do("GET", target+map[bool]string{true: "&", false: "?"}[strings.Contains(target, "?")]+"again=1", "")
			if w.Code != http.StatusForbidden {
				t.Fatalf("all refused: status %d, want the cluster's 403: %.300s", w.Code, w.Body.String())
			}
		})
	}
}

// A caller with no limit on the cluster asks and gets what it did before.
func TestUnscopedCallerIsUnchanged(t *testing.T) {
	rig := newScopeRig(t, payloadFor(), nil)
	cases := []struct {
		name, method, target, body string
		want                       string
	}{
		{"generic list across namespaces", "GET", "/api/v1/resources?resource_type=configmaps", "", "GET /api/v1/configmaps"},
		{"generic list by query", "GET", "/api/v1/resources?resource_type=configmaps&namespace=" + outside, "", "GET /api/v1/namespaces/" + outside + "/configmaps"},
		{"events across namespaces", "GET", "/api/v1/events", "", "GET /api/v1/events"},
		{"pod metrics across namespaces", "GET", "/api/v1/metrics/pods", "", "GET /apis/metrics.k8s.io/v1beta1/pods"},
		{"apply anywhere", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "configmaps", "name": "cm", "namespace": outside, "yaml": yamlDoc("ConfigMap", "v1", "cm", "")}), "PATCH /api/v1/namespaces/" + outside + "/configmaps/cm"},
		{"create anywhere", "POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": yamlDoc("ConfigMap", "v1", "cm", outside)}), "POST /api/v1/namespaces/" + outside + "/configmaps"},
		{"topology anywhere", "GET", "/api/v1/topology/namespace/" + outside, "", "GET /api/v1/namespaces/" + outside + "/pods"},
		{"an empty namespace in a path reads every namespace, as the cluster answers it", "GET", "/api/v1/namespaces//configmaps", "", "GET /api/v1/configmaps"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rig.api.reset()
			w := rig.do(tc.method, tc.target, tc.body)
			if w.Code == http.StatusForbidden {
				t.Fatalf("refused: %.300s", w.Body.String())
			}
			var got []string
			for _, c := range rig.api.callerCalls() {
				got = append(got, c.method+" "+c.path)
			}
			if !slices.Contains(got, tc.want) {
				t.Errorf("status %d, the cluster got %v, want %s", w.Code, got, tc.want)
			}
		})
	}
	w := rig.do("GET", "/api/v1/events", "")
	if !strings.Contains(w.Body.String(), "event of "+outside) {
		t.Errorf("the whole cluster's events: %.300s", w.Body.String())
	}
}

// A grant limited on one cluster is not limited on another.
func TestAGrantLimitedOnAnotherClusterPasses(t *testing.T) {
	p := payloadFor()
	p.Namespaces = map[string][]string{"elsewhere": {inside}}
	rig := newScopeRig(t, p, nil)
	if w := rig.do("GET", "/api/v1/resources?resource_type=configmaps&namespace="+outside, ""); w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
}

// A route nobody has classified is closed to a limited grant and open to the rest: a new route is safe by default.
func TestANewRouteIsClosedToALimitedGrant(t *testing.T) {
	added := func(g chi.Router) {
		g.Get("/api/v1/brand-new", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
		g.Get("/api/v1/brand-new/{namespace}/thing", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	}
	scoped := newScopeRig(t, payloadFor(inside), added)
	if w := scoped.do("GET", "/api/v1/brand-new", ""); w.Code != http.StatusForbidden {
		t.Errorf("a new route for a limited grant: status %d", w.Code)
	}
	if w := scoped.do("GET", "/api/v1/brand-new/"+outside+"/thing", ""); w.Code != http.StatusForbidden {
		t.Errorf("a new route naming a namespace outside: status %d", w.Code)
	}
	if w := scoped.do("GET", "/api/v1/brand-new/"+inside+"/thing", ""); w.Code != http.StatusOK {
		t.Errorf("a new route naming a namespace inside: status %d", w.Code)
	}
	whole := newScopeRig(t, payloadFor(), added)
	if w := whole.do("GET", "/api/v1/brand-new", ""); w.Code != http.StatusOK {
		t.Errorf("a new route for a caller with no limit: status %d", w.Code)
	}
}

// A refused write or terminal leaves an audit row with the attempt, a refused read does not.
func TestScopeRefusalsLeaveARowForWritesOnly(t *testing.T) {
	rig := newScopeRig(t, payloadFor(inside), nil)
	if w := rig.do("GET", "/api/v1/resources?resource_type=configmaps&namespace="+outside, ""); w.Code != http.StatusForbidden {
		t.Fatalf("read: %d", w.Code)
	}
	if got := rig.audit.actions(); len(got) != 0 {
		t.Fatalf("a refused read left rows: %v", got)
	}
	body := jsonBody(t, map[string]string{"resource_type": "configmaps", "name": "cm", "namespace": outside, "yaml": yamlDoc("ConfigMap", "v1", "cm", "")})
	if w := rig.do("POST", "/api/v1/resources/yaml/apply", body); w.Code != http.StatusForbidden {
		t.Fatalf("write: %d", w.Code)
	}
	if got := rig.audit.actions(); !slices.Equal(got, []string{"k8s.access.denied"}) {
		t.Fatalf("rows %v", got)
	}
}

// No route, asked with no namespace by a limited grant, goes out as the caller to list a namespaced kind across
// namespaces or to read inside a namespace the grant does not name. Every GET route without a namespace in its path.
func TestNoRouteReadsBeyondTheGrant(t *testing.T) {
	rig := newScopeRig(t, payloadFor(inside), nil)
	skip := map[string]bool{"/api/v1/ws": true, "/api/v1/wsMultiplexer": true}
	// OpenCost is looked for by its Service's usual names; what the screen gets is the rows of the grant's namespaces.
	findsItsService := map[string]bool{"/api/v1/cost": true, "/api/v1/cost/status": true}
	fill := strings.NewReplacer("{name}", "probe", "{id}", "1", "{group}", "example.com", "{version}", "v1", "{plural}", "widgets", "{traceID}", "abc", "{silenceID}", "s")
	checked := 0
	err := chi.Walk(rig.router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method != http.MethodGet || strings.Contains(route, "{namespace}") || skip[route] {
			return nil
		}
		checked++
		t.Run(route, func(t *testing.T) {
			rig.api.reset()
			w := rig.do("GET", fill.Replace(route), "")
			calls := rig.api.callerCalls()
			if wide := wideLists(calls); len(wide) != 0 {
				t.Errorf("status %d, listed across namespaces: %v", w.Code, wide)
			}
			reached := namespacesReached(calls)
			delete(reached, inside)
			if len(reached) > 0 && !findsItsService[route] {
				t.Errorf("status %d, read in %v: %+v", w.Code, reached, calls)
			}
			if strings.Contains(w.Body.String(), "-"+outside) {
				t.Errorf("status %d, an object of the namespace outside is in the answer: %.300s", w.Code, w.Body.String())
			}
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 100 {
		t.Fatalf("only %d routes walked", checked)
	}
	t.Logf("%d routes checked", checked)
}

// Every route has the rule this file says. A new route fails here until it is classified: add it to namespaceRoutes
// (handler/namespace_scope_routes.go) unless {namespace} in its path says it all, then to testdata/namespace-scope-routes.txt.
func TestNamespaceRouteTable(t *testing.T) {
	r := chi.NewRouter()
	r.Group(func(g chi.Router) { routes.Register(g, &handler.Handler{}, ws.NewMultiplexer(nil)) })
	var got []string
	registered := map[string]bool{}
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		got = append(got, method+" "+route+" "+handler.NamespaceRuleName(method, route))
		registered[method+" "+route] = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(got)
	raw, err := os.ReadFile("testdata/namespace-scope-routes.txt")
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if !slices.Equal(got, want) {
		for _, line := range got {
			if !slices.Contains(want, line) {
				t.Errorf("not in the table file: %s", line)
			}
		}
		for _, line := range want {
			if !slices.Contains(got, line) {
				t.Errorf("in the table file, not on the router: %s", line)
			}
		}
	}
	for _, line := range got {
		if strings.HasSuffix(line, " unclassified") {
			t.Errorf("no rule: %s", line)
		}
	}
	for _, key := range handler.NamespaceRouteKeys() {
		if !registered[key] {
			t.Errorf("namespaceRoutes names a route the router does not have: %s", key)
		}
	}
}
