package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
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
	"github.com/junginho0901/kubeast/services/pkg/gitops"
)

// These run the real routes, middleware, handlers and client-go against a stand-in API server whose objects Argo CD
// tracks or not, by name, as the annotation it leaves on them says.

type argoKind struct {
	kind       string
	namespaced bool
	short      string
}

// argoKinds is every kind a write route of the console names.
var argoKinds = map[string]map[string]argoKind{
	"v1": {
		"pods": {"Pod", true, ""}, "configmaps": {"ConfigMap", true, ""}, "secrets": {"Secret", true, ""}, "services": {"Service", true, ""},
		"endpoints": {"Endpoints", true, ""}, "serviceaccounts": {"ServiceAccount", true, ""}, "resourcequotas": {"ResourceQuota", true, ""},
		"limitranges": {"LimitRange", true, ""}, "persistentvolumeclaims": {"PersistentVolumeClaim", true, "pvc"},
		"persistentvolumes": {"PersistentVolume", false, "pv"}, "namespaces": {"Namespace", false, ""}, "nodes": {"Node", false, ""},
	},
	"apps/v1": {
		"deployments": {"Deployment", true, ""}, "statefulsets": {"StatefulSet", true, ""}, "daemonsets": {"DaemonSet", true, ""}, "replicasets": {"ReplicaSet", true, ""},
	},
	"batch/v1":                {"jobs": {"Job", true, ""}, "cronjobs": {"CronJob", true, ""}},
	"autoscaling/v2":          {"horizontalpodautoscalers": {"HorizontalPodAutoscaler", true, "hpa"}},
	"autoscaling.k8s.io/v1":   {"verticalpodautoscalers": {"VerticalPodAutoscaler", true, "vpa"}},
	"policy/v1":               {"poddisruptionbudgets": {"PodDisruptionBudget", true, "pdb"}},
	"discovery.k8s.io/v1":     {"endpointslices": {"EndpointSlice", true, ""}},
	"coordination.k8s.io/v1":  {"leases": {"Lease", true, ""}},
	"scheduling.k8s.io/v1":    {"priorityclasses": {"PriorityClass", false, ""}},
	"node.k8s.io/v1":          {"runtimeclasses": {"RuntimeClass", false, ""}},
	"apiextensions.k8s.io/v1": {"customresourcedefinitions": {"CustomResourceDefinition", false, "crd"}},
	"networking.k8s.io/v1":    {"ingresses": {"Ingress", true, ""}, "networkpolicies": {"NetworkPolicy", true, ""}, "ingressclasses": {"IngressClass", false, ""}},
	"storage.k8s.io/v1":       {"storageclasses": {"StorageClass", false, ""}, "volumeattachments": {"VolumeAttachment", false, ""}},
	"resource.k8s.io/v1":      {"deviceclasses": {"DeviceClass", false, ""}, "resourceslices": {"ResourceSlice", false, ""}, "resourceclaims": {"ResourceClaim", true, ""}, "resourceclaimtemplates": {"ResourceClaimTemplate", true, ""}},
	"example.com/v1":          {"widgets": {"Widget", true, ""}},
	"metrics.k8s.io/v1beta1":  {"podmetricses": {"PodMetrics", true, ""}},
	"admissionregistration.k8s.io/v1": {
		"mutatingwebhookconfigurations": {"MutatingWebhookConfiguration", false, ""}, "validatingwebhookconfigurations": {"ValidatingWebhookConfiguration", false, ""},
		"validatingadmissionpolicies": {"ValidatingAdmissionPolicy", false, ""},
	},
	"rbac.authorization.k8s.io/v1": {
		"roles": {"Role", true, ""}, "rolebindings": {"RoleBinding", true, ""}, "clusterroles": {"ClusterRole", false, ""}, "clusterrolebindings": {"ClusterRoleBinding", false, ""},
	},
	"gateway.networking.k8s.io/v1": {
		"gateways": {"Gateway", true, ""}, "gatewayclasses": {"GatewayClass", false, ""}, "httproutes": {"HTTPRoute", true, ""}, "grpcroutes": {"GRPCRoute", true, ""},
		"referencegrants": {"ReferenceGrant", true, ""}, "backendtlspolicies": {"BackendTLSPolicy", true, ""},
	},
}

type argoCluster struct {
	mu            sync.Mutex
	srv           *httptest.Server
	trackedBy     map[string]string // "<plural>/<name>" or a name → the Application that tracks it; "*" tracks every name
	absent        map[string]bool   // object names the cluster does not have
	readFails     map[string]int    // object name → the status a read of it answers
	writeFails    map[string]int    // plural → the status a create or change of that kind answers
	unserved      map[string]bool   // group versions the cluster does not serve
	brokenGroups  map[string]bool   // group versions whose discovery fails, as an aggregated API that is down does
	discoveryDown bool              // the group list itself fails
	reads         []string          // reads of one object by name
	writes        []string          // every call that would change something
}

func newArgoCluster(t *testing.T) *argoCluster {
	t.Helper()
	a := &argoCluster{trackedBy: map[string]string{}, absent: map[string]bool{}, readFails: map[string]int{}, writeFails: map[string]int{}, unserved: map[string]bool{}, brokenGroups: map[string]bool{}}
	a.srv = httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(a.srv.Close)
	return a
}

func (a *argoCluster) serve(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch r.URL.Path {
	case "/version":
		writeJSON(w, 200, map[string]string{"major": "1", "minor": "35", "gitVersion": "v1.35.0"})
		return
	case "/api":
		writeJSON(w, 200, map[string]interface{}{"kind": "APIVersions", "versions": []string{"v1"}})
		return
	case "/apis":
		if a.discoveryDown {
			writeJSON(w, 500, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "InternalError", "code": 500, "message": "discovery is down"})
			return
		}
		var groups []map[string]interface{}
		for gv := range argoKinds {
			if group, version, ok := strings.Cut(gv, "/"); ok && !a.unserved[gv] {
				groups = append(groups, map[string]interface{}{"name": group, "versions": []map[string]string{{"groupVersion": gv, "version": version}},
					"preferredVersion": map[string]string{"groupVersion": gv, "version": version}})
			}
		}
		writeJSON(w, 200, map[string]interface{}{"kind": "APIGroupList", "apiVersion": "v1", "groups": groups})
		return
	}
	gv, rest := splitGroupVersion(r.URL.Path)
	kinds, ok := argoKinds[gv]
	if !ok || a.unserved[gv] {
		writeJSON(w, 404, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404, "message": "not served"})
		return
	}
	if rest == "" {
		if a.brokenGroups[gv] {
			writeJSON(w, 503, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "ServiceUnavailable", "code": 503, "message": "the aggregated API is down"})
			return
		}
		var list []map[string]interface{}
		for plural, k := range kinds {
			res := map[string]interface{}{"name": plural, "singularName": strings.ToLower(k.kind), "kind": k.kind, "namespaced": k.namespaced,
				"verbs": []string{"get", "list", "watch", "create", "patch", "update", "delete"}}
			if k.short != "" {
				res["shortNames"] = []string{k.short}
			}
			list = append(list, res)
		}
		writeJSON(w, 200, map[string]interface{}{"kind": "APIResourceList", "apiVersion": "v1", "groupVersion": gv, "resources": list})
		return
	}
	parts := strings.Split(rest, "/")
	namespace := ""
	if parts[0] == "namespaces" && len(parts) >= 3 {
		namespace, parts = parts[1], parts[2:]
	}
	k, ok := kinds[parts[0]]
	if !ok {
		writeJSON(w, 404, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404, "message": "no kind " + parts[0]})
		return
	}
	if r.Method != http.MethodGet {
		if status, failing := a.writeFails[parts[0]]; failing {
			reason := map[int]string{403: "Forbidden", 409: "AlreadyExists", 422: "Invalid"}[status]
			writeJSON(w, status, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": reason, "code": status, "message": "this write fails: " + reason})
			return
		}
		a.writes = append(a.writes, r.Method+" "+r.URL.Path)
		name := "created"
		if len(parts) > 1 {
			name = parts[1]
		}
		writeJSON(w, 200, a.object(gv, parts[0], k, namespace, name))
		return
	}
	if len(parts) == 1 {
		writeJSON(w, 200, map[string]interface{}{"kind": k.kind + "List", "apiVersion": gv, "metadata": map[string]string{"resourceVersion": "1"}, "items": []interface{}{}})
		return
	}
	name := parts[1]
	a.reads = append(a.reads, r.URL.Path)
	if status, failing := a.readFails[name]; failing {
		reason := map[int]string{403: "Forbidden", 500: "InternalError", 503: "ServiceUnavailable"}[status]
		writeJSON(w, status, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": reason, "code": status, "message": "this read fails: " + reason})
		return
	}
	if a.absent[name] {
		writeJSON(w, 404, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404, "message": parts[0] + " \"" + name + "\" not found"})
		return
	}
	writeJSON(w, 200, a.object(gv, parts[0], k, namespace, name))
}

// object is one object as the API server answers it, with the tracking annotation when Argo CD tracks that name.
func (a *argoCluster) object(gv, plural string, k argoKind, namespace, name string) map[string]interface{} {
	meta := map[string]interface{}{"name": name, "uid": name + "-uid", "resourceVersion": "1"}
	if namespace != "" {
		meta["namespace"] = namespace
	}
	app := a.trackedBy[plural+"/"+name]
	if app == "" {
		app = a.trackedBy[name]
	}
	if app == "" {
		app = a.trackedBy["*"]
	}
	if app != "" {
		group, _, _ := strings.Cut(gv, "/")
		if !strings.Contains(gv, "/") {
			group = ""
		}
		meta["annotations"] = map[string]string{gitops.DefaultTrackingAnnotation: app + ":" + group + "/" + k.kind + ":" + namespace + "/" + name}
	}
	return map[string]interface{}{"apiVersion": gv, "kind": k.kind, "metadata": meta}
}

func (a *argoCluster) seenWrites() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.writes...)
}

func (a *argoCluster) seenReads() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.reads...)
}

func (a *argoCluster) forget() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.reads, a.writes = nil, nil
}

type argoRig struct {
	cluster *argoCluster
	audit   *auditRows
	svc     *k8s.Service
	router  chi.Router
	payload auth.TokenPayload
}

var (
	argoBlock = gitops.Config{Enabled: true, Mode: gitops.ModeBlock, TrackingAnnotation: gitops.DefaultTrackingAnnotation}
	argoWarn  = gitops.Config{Enabled: true, Mode: gitops.ModeWarn, TrackingAnnotation: gitops.DefaultTrackingAnnotation}
	argoOff   = gitops.Config{}
)

// newArgoRig wires the protected group as main.go does: the guard is on the routes only when it is enabled.
func newArgoRig(t *testing.T, a *argoCluster, cfg gitops.Config, payload auth.TokenPayload) *argoRig {
	t.Helper()
	return newArgoRigWith(t, a, cfg, payload, config.Config{})
}

func newArgoRigWith(t *testing.T, a *argoCluster, cfg gitops.Config, payload auth.TokenPayload, base config.Config) *argoRig {
	t.Helper()
	base.InPlaceResizeEnabled = true
	return newArgoRigAsSet(t, a, cfg, payload, base)
}

// newArgoRigAsSet leaves the feature switches a test turned off as they are.
func newArgoRigAsSet(t *testing.T, a *argoCluster, cfg gitops.Config, payload auth.TokenPayload, base config.Config) *argoRig {
	t.Helper()
	base.ImpersonationEnabled, base.HygieneEnabled, base.HygieneIntervalDays = true, true, 30
	t.Setenv("PROMETHEUS_ENABLED", "false")
	blob := strings.Replace(standInKubeconfig, "SERVER", a.srv.URL, 1)
	svc, err := k8s.NewService(context.Background(), standInRegistry{blob: blob}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{Impersonation: true, Gitops: cfg})
	if err != nil {
		t.Fatal(err)
	}
	store := &auditRows{}
	h := handler.New(svc, base, store)
	rig := &argoRig{cluster: a, audit: store, svc: svc, payload: payload}
	r := chi.NewRouter()
	r.Use(chimiddleware.Recoverer)
	r.Group(func(g chi.Router) {
		g.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				next.ServeHTTP(w, req.WithContext(auth.WithPayload(req.Context(), rig.payload)))
			})
		})
		g.Use(h.ClusterMiddleware)
		g.Use(h.NamespaceScopeMiddleware)
		if cfg.Enabled {
			g.Use(h.GitopsGuard)
		}
		routes.Register(g, h, ws.NewMultiplexer(nil))
	})
	rig.router = r
	return rig
}

func (r *argoRig) do(method, target, body string) *httptest.ResponseRecorder {
	r.svc.MarkClusterUp("c")
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
	defer cancel()
	w := httptest.NewRecorder()
	r.router.ServeHTTP(w, req.WithContext(ctx))
	return w
}

// refusals are the guard's audit rows.
func (r *argoRig) refusals() []map[string]interface{} {
	r.audit.mu.Lock()
	defer r.audit.mu.Unlock()
	var out []map[string]interface{}
	for _, row := range r.audit.rows {
		if row.Action != "k8s.gitops.refuse" {
			continue
		}
		after := map[string]interface{}{}
		_ = json.Unmarshal(row.After, &after)
		after["target_type"], after["target_id"], after["namespace"], after["result"] = row.TargetType, row.TargetID, row.Namespace, row.Result
		out = append(out, after)
	}
	return out
}

func (r *argoRig) rowsOf(action string) int {
	n := 0
	for _, a := range r.audit.actions() {
		if a == action {
			n++
		}
	}
	return n
}

func argoWriter() auth.TokenPayload {
	return auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"c": {"*"}}, Roles: map[string]string{"c": "Write"}}
}

func argoHolding(perms ...string) auth.TokenPayload {
	return auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"c": perms}, Roles: map[string]string{"c": "Read"}}
}

func applyBody(t *testing.T, resourceType, name, doc string) string {
	t.Helper()
	return jsonBody(t, map[string]string{"resource_type": resourceType, "namespace": "shop", "name": name, "yaml": doc})
}

const (
	replicasOnly = "spec:\n  replicas: 0\n"
	labelsOnly   = "metadata:\n  labels:\n    team: a\n"
)

// The object a write changes is the one its address names. What the YAML in the body says about itself does not move
// that address, so a managed object is refused whatever the body holds, with the row and the wording of any refusal.
func TestManagedObjectIsRefusedWhateverTheBodySaysOfItself(t *testing.T) {
	cases := []struct {
		name, method, target, body string
		targetType, id, namespace  string
	}{
		{"a body of just a spec", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "web", replicasOnly), "deployments", "web", "shop"},
		{"a body with a kind and no name", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "web", "kind: Deployment\n"+replicasOnly), "deployments", "web", "shop"},
		{"a body with a name and no kind", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "web", "metadata:\n  name: web\n"+replicasOnly), "deployments", "web", "shop"},
		{"a body naming another object", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "web", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: free\n"), "deployments", "web", "shop"},
		{"a body naming another kind", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "web", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web\n"), "deployments", "web", "shop"},
		{"the object's own YAML", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "web", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: shop\n"), "Deployment", "web", "shop"},
		{"the name given as resource_name", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "deployments", "namespace": "shop", "resource_name": "web", "yaml": replicasOnly}), "deployments", "web", "shop"},
		{"more bytes after the JSON the handler reads", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "web", replicasOnly) + " more", "deployments", "web", "shop"},
		{"the kind in place of the plural", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "Deployment", "web", replicasOnly), "Deployment", "web", "shop"},
		{"a node's labels", "POST", "/api/v1/nodes/n1/yaml/apply", jsonBody(t, map[string]string{"yaml": labelsOnly}), "nodes", "n1", ""},
		{"a node's labels, the body naming another node", "POST", "/api/v1/nodes/n1/yaml/apply", jsonBody(t, map[string]string{"yaml": "apiVersion: v1\nkind: Node\nmetadata:\n  name: free\n"}), "nodes", "n1", ""},
		{"a namespace's labels", "POST", "/api/v1/namespaces/team/yaml/apply", jsonBody(t, map[string]string{"yaml": labelsOnly}), "namespaces", "team", ""},
		{"a resize, more bytes after its JSON", "POST", "/api/v1/namespaces/shop/optimization/resize", `{"kind":"Deployment","name":"web","container":"c","cpu_request_m":100} more`, "Deployment", "web", "shop"},
		{"a delete", "DELETE", "/api/v1/namespaces/shop/deployments/web", "", "deployments", "web", "shop"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := newArgoCluster(t)
			a.trackedBy = map[string]string{"deployments/web": "the-app", "nodes/n1": "the-app", "namespaces/team": "the-app"}
			rig := newArgoRig(t, a, argoBlock, argoWriter())
			w := rig.do(tc.method, tc.target, tc.body)
			if w.Code != http.StatusConflict {
				t.Fatalf("status %d, want 409: %s (writes %v)", w.Code, w.Body.String(), a.seenWrites())
			}
			if want := "managed by Argo CD application the-app; change it in Git"; !strings.Contains(w.Body.String(), want) {
				t.Errorf("answer %s, want %q", w.Body.String(), want)
			}
			if got := a.seenWrites(); len(got) != 0 {
				t.Errorf("the write went out: %v", got)
			}
			rows := rig.refusals()
			if len(rows) != 1 {
				t.Fatalf("refusal rows %+v, want one", rows)
			}
			row := rows[0]
			if row["target_type"] != tc.targetType || row["target_id"] != tc.id || row["namespace"] != tc.namespace || row["result"] != "failure" ||
				row["app"] != "the-app" || row["method"] != tc.method || row["path"] != strings.SplitN(tc.target, "?", 2)[0] || row["by"] != "annotation" {
				t.Errorf("row %+v", row)
			}
		})
	}
}

// A body may still name a managed object at an address that is free: that write is refused as it always was.
func TestBodyNamingAManagedObjectIsRefusedAtAFreeAddress(t *testing.T) {
	a := newArgoCluster(t)
	a.trackedBy = map[string]string{"web": "the-app"}
	rig := newArgoRig(t, a, argoBlock, argoWriter())
	doc := "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: shop\n"
	for _, target := range []string{"/api/v1/namespaces/shop/yaml/apply", "/api/v1/nodes/free/yaml/apply"} {
		w := rig.do("POST", target, jsonBody(t, map[string]string{"namespace": "shop", "yaml": doc}))
		if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "managed by Argo CD application the-app") {
			t.Errorf("%s: status %d %s", target, w.Code, w.Body.String())
		}
	}
	if got := a.seenWrites(); len(got) != 0 {
		t.Errorf("the write went out: %v", got)
	}
	rows := rig.refusals()
	if len(rows) != 2 || rows[0]["target_type"] != "Deployment" || rows[0]["target_id"] != "web" || rows[0]["namespace"] != "shop" || rows[0]["app"] != "the-app" {
		t.Errorf("rows %+v", rows)
	}
}

// With the guard on block, what Argo CD does not manage is written exactly as before.
// With the read-only switch on, the screens' YAML create makes no policy, as the AI's create and the YAML apply do not.
func TestYAMLCreateFollowsTheAdmissionPolicySwitch(t *testing.T) {
	policy := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: first\n  namespace: shop\n---\napiVersion: admissionregistration.k8s.io/v1\nkind: ValidatingAdmissionPolicy\nmetadata:\n  name: p\n"
	configMap := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: first\n  namespace: shop\n"
	create := func(t *testing.T, readOnly bool, doc string) (*argoCluster, *argoRig, *httptest.ResponseRecorder) {
		t.Helper()
		a := newArgoCluster(t)
		rig := newArgoRigWith(t, a, argoOff, argoWriter(), config.Config{AdmissionPoliciesReadOnly: readOnly})
		return a, rig, rig.do("POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": doc}))
	}

	a, rig, w := create(t, true, policy)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "admission policies are read-only") {
		t.Fatalf("switch on, a policy in the YAML: %d %s", w.Code, w.Body.String())
	}
	if got := a.seenWrites(); len(got) != 0 {
		t.Fatalf("switch on, a policy in the YAML wrote %v", got)
	}
	if rig.rowsOf("k8s.yaml.create") != 1 {
		t.Fatalf("rows %v", rig.audit.actions())
	}

	a, _, w = create(t, true, configMap)
	if got := a.seenWrites(); w.Code != http.StatusOK || len(got) != 1 {
		t.Fatalf("switch on, no policy: %d %v %s", w.Code, got, w.Body.String())
	}
	a, _, w = create(t, false, policy)
	if got := a.seenWrites(); w.Code != http.StatusOK || len(got) != 2 {
		t.Fatalf("switch off: %d %v %s", w.Code, got, w.Body.String())
	}
}

func TestFreeObjectIsWrittenWithTheGuardOnBlock(t *testing.T) {
	cases := []struct {
		name, method, target, body, write string
	}{
		{"its own YAML", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "free", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: free\n  namespace: shop\n"), "PATCH /apis/apps/v1/namespaces/shop/deployments/free"},
		{"just a spec", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "free", replicasOnly), "PATCH /apis/apps/v1/namespaces/shop/deployments/free"},
		{"a cluster-scoped kind", "POST", "/api/v1/resources/yaml/apply", jsonBody(t, map[string]string{"resource_type": "clusterroles", "name": "free", "yaml": labelsOnly}), "PATCH /apis/rbac.authorization.k8s.io/v1/clusterroles/free"},
		{"a body naming a kind the cluster does not serve", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "free", "apiVersion: nowhere.example.com/v1\nkind: Nothing\nmetadata:\n  name: free\n"), "PATCH /apis/apps/v1/namespaces/shop/deployments/free"},
		{"a body with a bad apiVersion", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "free", "apiVersion: a/b/c\nkind: Deployment\nmetadata:\n  name: free\n"), "PATCH /apis/apps/v1/namespaces/shop/deployments/free"},
		{"an object the cluster does not have", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "gone", replicasOnly), "PATCH /apis/apps/v1/namespaces/shop/deployments/gone"},
		{"a node's labels", "POST", "/api/v1/nodes/free/yaml/apply", jsonBody(t, map[string]string{"yaml": labelsOnly}), "PATCH /api/v1/nodes/free"},
		{"a namespace's labels", "POST", "/api/v1/namespaces/free/yaml/apply", jsonBody(t, map[string]string{"yaml": labelsOnly}), "PUT /api/v1/namespaces/free"},
		{"a delete", "DELETE", "/api/v1/namespaces/shop/deployments/free", "", "DELETE /apis/apps/v1/namespaces/shop/deployments/free"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := newArgoCluster(t)
			a.trackedBy = map[string]string{"web": "the-app"}
			a.absent = map[string]bool{"gone": true}
			rig := newArgoRig(t, a, argoBlock, argoWriter())
			w := rig.do(tc.method, tc.target, tc.body)
			if w.Code != http.StatusOK {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			if got := a.seenWrites(); len(got) != 1 || got[0] != tc.write {
				t.Errorf("writes %v, want %s", got, tc.write)
			}
			if rows := rig.refusals(); len(rows) != 0 {
				t.Errorf("refusal rows %+v", rows)
			}
		})
	}
}

// A request that cannot be read is the handler's to answer, and nothing is written.
func TestUnreadableBodyIsTheHandlersAnswer(t *testing.T) {
	a := newArgoCluster(t)
	rig := newArgoRig(t, a, argoBlock, argoWriter())
	w := rig.do("POST", "/api/v1/resources/yaml/apply", "not json")
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid request body") {
		t.Fatalf("status %d %s", w.Code, w.Body.String())
	}
	if len(a.seenWrites()) != 0 || len(rig.refusals()) != 0 {
		t.Fatalf("writes %v, rows %+v", a.seenWrites(), rig.refusals())
	}
}

// On block, a target the guard could not read is refused and recorded; on warn and off the write goes as it did.
func TestTargetThatCannotBeReadIsRefusedOnlyOnBlock(t *testing.T) {
	for _, tc := range []struct {
		name, method, target, body, write string
	}{
		{"YAML apply", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "web", replicasOnly), "PATCH /apis/apps/v1/namespaces/shop/deployments/web"},
		{"delete", "DELETE", "/api/v1/namespaces/shop/deployments/web", "", "DELETE /apis/apps/v1/namespaces/shop/deployments/web"},
	} {
		for status, reason := range map[int]string{403: "this read fails: Forbidden", 500: "this read fails: InternalError"} {
			t.Run(tc.name+" read answers "+reason, func(t *testing.T) {
				a := newArgoCluster(t)
				a.readFails = map[string]int{"web": status}
				rig := newArgoRig(t, a, argoBlock, argoWriter())
				w := rig.do(tc.method, tc.target, tc.body)
				if w.Code != status {
					t.Fatalf("block: status %d, want %d: %s (writes %v)", w.Code, status, w.Body.String(), a.seenWrites())
				}
				if !strings.Contains(w.Body.String(), "could not check whether Argo CD manages") || !strings.Contains(w.Body.String(), reason) {
					t.Errorf("block: answer %s", w.Body.String())
				}
				if got := a.seenWrites(); len(got) != 0 {
					t.Errorf("block: the write went out: %v", got)
				}
				rows := rig.refusals()
				if len(rows) != 1 || rows[0]["lookup_failed"] != true || rows[0]["target_id"] != "web" || rows[0]["result"] != "failure" {
					t.Errorf("block: rows %+v", rows)
				}

				for mode, cfg := range map[string]gitops.Config{"warn": argoWarn, "off": argoOff} {
					a := newArgoCluster(t)
					a.readFails = map[string]int{"web": status}
					rig := newArgoRig(t, a, cfg, argoWriter())
					w := rig.do(tc.method, tc.target, tc.body)
					if w.Code != http.StatusOK {
						t.Errorf("%s: status %d: %s", mode, w.Code, w.Body.String())
					}
					if got := a.seenWrites(); len(got) != 1 || got[0] != tc.write {
						t.Errorf("%s: writes %v", mode, got)
					}
					if len(rig.refusals()) != 0 {
						t.Errorf("%s: refusal rows %+v", mode, rig.refusals())
					}
				}
			})
		}
	}
}

// Discovery that fails altogether leaves nothing to tell a kind by: on block the write does not go.
func TestDiscoveryDownRefusesOnBlock(t *testing.T) {
	a := newArgoCluster(t)
	a.discoveryDown = true
	rig := newArgoRig(t, a, argoBlock, argoWriter())
	w := rig.do("DELETE", "/api/v1/namespaces/shop/deployments/web", "")
	if w.Code < 400 || w.Code == http.StatusConflict || !strings.Contains(w.Body.String(), "could not check whether Argo CD manages") {
		t.Fatalf("status %d %s", w.Code, w.Body.String())
	}
	if got := a.seenWrites(); len(got) != 0 {
		t.Fatalf("the write went out: %v", got)
	}
}

// One aggregated API that is down does not stop the writes the rest of the cluster serves, and does not hide a managed object.
func TestAggregatedAPIDownKeepsTheGuardWorking(t *testing.T) {
	a := newArgoCluster(t)
	a.trackedBy = map[string]string{"web": "the-app"}
	a.brokenGroups = map[string]bool{"metrics.k8s.io/v1beta1": true}
	rig := newArgoRig(t, a, argoBlock, argoWriter())

	w := rig.do("DELETE", "/api/v1/namespaces/shop/deployments/free", "")
	if w.Code != http.StatusOK {
		t.Fatalf("free object: status %d %s", w.Code, w.Body.String())
	}
	if got := a.seenWrites(); len(got) != 1 {
		t.Fatalf("free object: writes %v", got)
	}
	a.forget()
	w = rig.do("DELETE", "/api/v1/namespaces/shop/deployments/web", "")
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "managed by Argo CD application the-app") {
		t.Fatalf("managed object: status %d %s", w.Code, w.Body.String())
	}
	if got := a.seenWrites(); len(got) != 0 {
		t.Fatalf("managed object: the write went out: %v", got)
	}
}

// A kind the cluster does not serve has no object Argo CD could manage: the route answers as it does with the guard off.
func TestKindTheClusterDoesNotServeAnswersAsWithTheGuardOff(t *testing.T) {
	answer := func(cfg gitops.Config) (int, string, []string, int) {
		a := newArgoCluster(t)
		a.unserved = map[string]bool{"autoscaling.k8s.io/v1": true}
		rig := newArgoRig(t, a, cfg, argoWriter())
		w := rig.do("DELETE", "/api/v1/namespaces/shop/vpas/v", "")
		return w.Code, w.Body.String(), a.seenWrites(), len(rig.refusals())
	}
	offStatus, offBody, offWrites, _ := answer(argoOff)
	status, body, writes, rows := answer(argoBlock)
	if status != offStatus || body != offBody || len(writes) != len(offWrites) || rows != 0 {
		t.Fatalf("block answered %d %s, writes %v, rows %d; off answered %d %s, writes %v", status, body, writes, rows, offStatus, offBody, offWrites)
	}
}

var deniedPermission = regexp.MustCompile(`requires (\S+) permission`)

// routesNamingNoObject write nothing Argo CD could track: a Helm release, a new object, the console's own records.
var routesNamingNoObject = map[string]bool{
	"POST /api/v1/namespaces":                                true,
	"POST /api/v1/resources/yaml/create":                     true,
	"POST /api/v1/hygiene/signoff":                           true,
	"POST /api/v1/alertstore/silences":                       true,
	"DELETE /api/v1/alertstore/silences/{silenceID}":         true,
	"POST /api/v1/helm/releases/{namespace}/{name}/diff":     true,
	"POST /api/v1/helm/releases/{namespace}/{name}/rollback": true,
	"POST /api/v1/helm/releases/{namespace}/{name}/test":     true,
	"PUT /api/v1/helm/releases/{namespace}/{name}/values":    true,
	"DELETE /api/v1/helm/releases/{namespace}/{name}":        true,
}

// Every write route on the router, whichever a new one turns out to be. Asked by someone without the permission, the
// guard answers what the handler answers, reads nothing and leaves no refusal. Asked with exactly the permission the
// handler names, a route that addresses an object is refused for a managed one and any other route goes on past it.
func TestEveryWriteRouteAsksItsPermissionBeforeTheGuardLooks(t *testing.T) {
	bodies := map[string]string{
		"POST /api/v1/resources/yaml/apply":                       applyBody(t, "deployments", "probe", replicasOnly),
		"POST /api/v1/namespaces/{namespace}/yaml/apply":          jsonBody(t, map[string]string{"yaml": labelsOnly}),
		"POST /api/v1/nodes/{name}/yaml/apply":                    jsonBody(t, map[string]string{"yaml": labelsOnly}),
		"POST /api/v1/namespaces/{namespace}/optimization/resize": `{"kind":"Deployment","name":"probe","container":"c","cpu_request_m":100}`,
	}
	fill := strings.NewReplacer("{namespace}", "shop", "{name}", "probe", "{deployment_name}", "probe", "{pod_name}", "probe", "{id}", "1",
		"{group}", "example.com", "{version}", "v1", "{plural}", "widgets", "{silenceID}", "s")
	nobody := argoHolding("menu.dashboard")

	offCluster := newArgoCluster(t)
	off := newArgoRig(t, offCluster, argoOff, nobody)
	onCluster := newArgoCluster(t)
	onCluster.trackedBy = map[string]string{"*": "the-app"}
	on := newArgoRig(t, onCluster, argoBlock, nobody)

	walked, guarded := 0, 0
	err := chi.Walk(on.router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions {
			return nil
		}
		walked++
		key := method + " " + route
		t.Run(key, func(t *testing.T) {
			target, body := fill.Replace(route), bodies[key]
			if body == "" {
				body = "{}"
			}
			on.payload = nobody
			onCluster.forget()
			refusedBefore := len(on.refusals())
			offAnswer := off.do(method, target, body)
			onAnswer := on.do(method, target, body)
			if onAnswer.Code != offAnswer.Code || onAnswer.Body.String() != offAnswer.Body.String() {
				t.Errorf("no permission: guard on answers %d %s, guard off %d %s", onAnswer.Code, onAnswer.Body.String(), offAnswer.Code, offAnswer.Body.String())
			}
			if got := onCluster.seenReads(); offAnswer.Code == http.StatusForbidden && len(got) != 0 {
				t.Errorf("no permission: objects read before the permission: %v", got)
			}
			if n := len(on.refusals()) - refusedBefore; n != 0 {
				t.Errorf("no permission: %d refusal rows", n)
			}

			m := deniedPermission.FindStringSubmatch(offAnswer.Body.String())
			if routesNamingNoObject[key] {
				if onAnswer.Code == http.StatusConflict {
					t.Errorf("a route naming no object answered 409: %s", onAnswer.Body.String())
				}
				return
			}
			if m == nil {
				t.Fatalf("the handler named no permission: %d %s", offAnswer.Code, offAnswer.Body.String())
			}
			on.payload = argoHolding(m[1])
			w := on.do(method, target, body)
			if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "managed by Argo CD application the-app") {
				t.Errorf("holding %s: status %d %s", m[1], w.Code, w.Body.String())
			}
			if got := onCluster.seenWrites(); len(got) != 0 {
				t.Errorf("holding %s: the write went out: %v", m[1], got)
			}
			if n := len(on.refusals()) - refusedBefore; n != 1 {
				t.Errorf("holding %s: %d refusal rows, want one", m[1], n)
			}
			guarded++
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if walked < 60 || guarded < 50 {
		t.Fatalf("walked %d write routes, %d of them guarded", walked, guarded)
	}
	t.Logf("%d write routes walked, %d address an object", walked, guarded)
}

// The rule above spelled out for the two kinds of person the guard could tell something to.
func TestSomeoneWhoCannotWriteLearnsNothingFromTheGuard(t *testing.T) {
	for _, tc := range []struct {
		name, method, target, body, perm string
	}{
		{"YAML apply", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "web", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: shop\n"), "resource.deployment.edit"},
		{"YAML apply, a kind with a permission of its own", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "hpa", "web", replicasOnly), "resource.hpa.edit"},
		{"YAML apply, a custom resource", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "widgets", "web", replicasOnly), "resource.customresource.edit"},
		{"delete", "DELETE", "/api/v1/namespaces/shop/deployments/web", "", "resource.deployment.delete"},
		{"rollback", "POST", "/api/v1/namespaces/shop/deployments/web/rollback", "{}", "resource.workload.rollback"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := newArgoCluster(t)
			a.trackedBy = map[string]string{"web": "the-secret-app"}
			rig := newArgoRig(t, a, argoBlock, argoHolding("resource.deployment.read", "resource.pod.read"))
			w := rig.do(tc.method, tc.target, tc.body)
			if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "requires "+tc.perm+" permission") {
				t.Fatalf("status %d %s", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "the-secret-app") {
				t.Errorf("the answer names the Application: %s", w.Body.String())
			}
			if got := a.seenReads(); len(got) != 0 {
				t.Errorf("the object was read: %v", got)
			}
			if len(rig.refusals()) != 0 || rig.rowsOf("k8s.access.denied") != 1 {
				t.Errorf("rows %v, want one k8s.access.denied", rig.audit.actions())
			}

			// The permission alone is enough to reach the refusal.
			rig.payload = argoHolding(tc.perm)
			if w := rig.do(tc.method, tc.target, tc.body); w.Code != http.StatusConflict {
				t.Errorf("holding %s: status %d %s", tc.perm, w.Code, w.Body.String())
			}
		})
	}
}

// warn and off write what they wrote before, managed or not, and the guard reads nothing for it.
// A route that is switched off answers as it does with the guard off, whoever asks and whatever the object is.
func TestResizeWithTheFeatureOffAnswersNotFoundBeforeTheGuardLooks(t *testing.T) {
	body := `{"kind":"Deployment","name":"web","container":"c","cpu_request_m":100}`
	for name, who := range map[string]auth.TokenPayload{"a writer": argoWriter(), "someone without the permission": argoHolding("menu.dashboard")} {
		t.Run(name, func(t *testing.T) {
			a := newArgoCluster(t)
			a.trackedBy = map[string]string{"web": "the-app"}
			rig := newArgoRigAsSet(t, a, argoBlock, who, config.Config{})
			w := rig.do("POST", "/api/v1/namespaces/shop/optimization/resize", body)
			if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "in-place resize is off") {
				t.Errorf("%d %s", w.Code, w.Body.String())
			}
			if rows := rig.refusals(); len(rows) != 0 {
				t.Errorf("refusal rows %+v", rows)
			}
			if got := a.seenWrites(); len(got) != 0 {
				t.Errorf("writes %v", got)
			}
		})
	}
}

func TestResizeWithTheFeatureOnIsStillRefusedForAManagedObject(t *testing.T) {
	a := newArgoCluster(t)
	a.trackedBy = map[string]string{"deployments/web": "the-app", "web": "the-app"}
	rig := newArgoRig(t, a, argoBlock, argoWriter())
	w := rig.do("POST", "/api/v1/namespaces/shop/optimization/resize", `{"kind":"Deployment","name":"web","container":"c","cpu_request_m":100}`)
	if w.Code != http.StatusConflict || len(rig.refusals()) != 1 {
		t.Errorf("%d %s, rows %+v", w.Code, w.Body.String(), rig.refusals())
	}
}

func TestWarnAndOffLeaveEveryWriteAlone(t *testing.T) {
	for mode, cfg := range map[string]gitops.Config{"warn": argoWarn, "off": argoOff} {
		for _, tc := range []struct {
			name, method, target, body, write string
		}{
			{"YAML apply", "POST", "/api/v1/resources/yaml/apply", applyBody(t, "deployments", "web", replicasOnly), "PATCH /apis/apps/v1/namespaces/shop/deployments/web"},
			{"delete", "DELETE", "/api/v1/namespaces/shop/deployments/web", "", "DELETE /apis/apps/v1/namespaces/shop/deployments/web"},
			{"a node's labels", "POST", "/api/v1/nodes/web/yaml/apply", jsonBody(t, map[string]string{"yaml": labelsOnly}), "PATCH /api/v1/nodes/web"},
		} {
			t.Run(mode+" "+tc.name, func(t *testing.T) {
				a := newArgoCluster(t)
				a.trackedBy = map[string]string{"web": "the-app"}
				rig := newArgoRig(t, a, cfg, argoWriter())
				w := rig.do(tc.method, tc.target, tc.body)
				if w.Code != http.StatusOK {
					t.Fatalf("status %d %s", w.Code, w.Body.String())
				}
				if got := a.seenWrites(); len(got) != 1 || got[0] != tc.write {
					t.Errorf("writes %v", got)
				}
				if len(rig.refusals()) != 0 {
					t.Errorf("rows %+v", rig.refusals())
				}
			})
		}
	}
}
