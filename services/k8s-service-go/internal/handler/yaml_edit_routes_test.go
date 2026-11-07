package handler_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"k8s.io/client-go/kubernetes/scheme"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/routes"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// openedOf is what the screen sends of the text an edit began from (frontend yamlOpenedOf).
func openedOf(opened, edited string) map[string]interface{} {
	a, b := strings.Split(opened, "\n"), strings.Split(edited, "\n")
	head := 0
	for head < len(a) && head < len(b) && a[head] == b[head] {
		head++
	}
	tail := 0
	for tail < len(a)-head && tail < len(b)-head && a[len(a)-1-tail] == b[len(b)-1-tail] {
		tail++
	}
	return map[string]interface{}{"head": head, "tail": tail, "lines": append([]string{}, a[head:len(a)-tail]...)}
}

type sentRequest struct{ method, path, contentType, body string }

// editCluster serves the discovery of a core kind, a Node, a Namespace and a custom resource, and keeps each write.
type editCluster struct {
	mu   sync.Mutex
	sent []sentRequest
	srv  *httptest.Server
}

func (c *editCluster) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/version":
		writeJSON(w, 200, map[string]string{"major": "1", "minor": "34", "gitVersion": "v1.34.0"})
		return
	case "/api":
		writeJSON(w, 200, map[string]interface{}{"kind": "APIVersions", "versions": []string{"v1"}})
		return
	case "/apis":
		version := map[string]string{"groupVersion": "example.test/v1", "version": "v1"}
		writeJSON(w, 200, map[string]interface{}{"kind": "APIGroupList", "apiVersion": "v1", "groups": []interface{}{
			map[string]interface{}{"name": "example.test", "versions": []interface{}{version}, "preferredVersion": version},
		}})
		return
	case "/api/v1":
		writeJSON(w, 200, map[string]interface{}{"kind": "APIResourceList", "apiVersion": "v1", "groupVersion": "v1", "resources": []map[string]interface{}{
			{"name": "configmaps", "singularName": "configmap", "kind": "ConfigMap", "namespaced": true, "verbs": []string{"get", "patch"}},
			{"name": "nodes", "singularName": "node", "kind": "Node", "namespaced": false, "verbs": []string{"get", "patch"}},
			{"name": "namespaces", "singularName": "namespace", "kind": "Namespace", "namespaced": false, "verbs": []string{"get", "update"}},
		}})
		return
	case "/apis/example.test/v1":
		writeJSON(w, 200, map[string]interface{}{"kind": "APIResourceList", "apiVersion": "v1", "groupVersion": "example.test/v1", "resources": []map[string]interface{}{
			{"name": "widgets", "singularName": "widget", "kind": "Widget", "namespaced": true, "verbs": []string{"get", "patch"}},
		}})
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/api/v1/namespaces/shop" {
		writeJSON(w, 200, map[string]interface{}{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]interface{}{
			"name":        "shop",
			"labels":      map[string]string{"kubernetes.io/metadata.name": "shop", "team": "a", "gone": "x"},
			"annotations": map[string]string{"note": "n", "gone": "y"},
		}})
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, 404, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404})
		return
	}
	body, _ := io.ReadAll(r.Body)
	// a typed client writes its object as protobuf
	if object, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, nil); r.Method == http.MethodPut && err == nil {
		body, _ = json.Marshal(object)
	}
	c.mu.Lock()
	c.sent = append(c.sent, sentRequest{r.Method, r.URL.Path, r.Header.Get("Content-Type"), string(body)})
	c.mu.Unlock()
	writeJSON(w, 200, map[string]interface{}{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]string{"name": "x"}})
}

func (c *editCluster) last(t *testing.T) (sentRequest, map[string]interface{}) {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.sent) == 0 {
		t.Fatal("nothing was written")
	}
	sent := c.sent[len(c.sent)-1]
	var object map[string]interface{}
	if err := json.Unmarshal([]byte(sent.body), &object); err != nil {
		t.Fatalf("%q: %v", sent.body, err)
	}
	return sent, object
}

func newEditRig(t *testing.T) (*editCluster, func(path string, body map[string]interface{}) *httptest.ResponseRecorder) {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "false")
	c := &editCluster{}
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
	return c, func(path string, body map[string]interface{}) *httptest.ResponseRecorder {
		svc.MarkClusterUp("c")
		req := httptest.NewRequest("POST", path, strings.NewReader(jsonBody(t, body)))
		ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
		defer cancel()
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req.WithContext(ctx))
		return w
	}
}

func metadataOf(t *testing.T, object map[string]interface{}) map[string]interface{} {
	t.Helper()
	meta, ok := object["metadata"].(map[string]interface{})
	if !ok {
		t.Fatalf("no metadata: %v", object)
	}
	return meta
}

const (
	strategicPatch = "application/strategic-merge-patch+json"
	jsonMergePatch = "application/merge-patch+json"
)

func TestAResourceSaveWithTheTextItBeganFromTakesOutWhatLeftIt(t *testing.T) {
	cluster, post := newEditRig(t)
	opened := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: shop\n  resourceVersion: \"7\"\n  labels:\n    team: a\n    gone: x\ndata:\n  keep: \"1\"\n"
	edited := strings.Replace(opened, "    gone: x\n", "", 1)
	w := post("/api/v1/resources/yaml/apply", map[string]interface{}{"resource_type": "configmaps", "namespace": "shop", "name": "app", "yaml": edited, "opened": openedOf(opened, edited)})
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	sent, patch := cluster.last(t)
	if sent.contentType != strategicPatch {
		t.Errorf("patch type %s", sent.contentType)
	}
	meta := metadataOf(t, patch)
	labels, _ := meta["labels"].(map[string]interface{})
	if value, named := labels["gone"]; !named || value != nil {
		t.Errorf("labels = %v, want gone null", labels)
	}
	if meta["resourceVersion"] != "7" {
		t.Errorf("metadata = %v, want the version the text was read at", meta)
	}
	if patch["data"] != nil || labels["team"] != nil {
		t.Errorf("the patch names what did not change: %s", sent.body)
	}
}

// Other callers of the API send a document and no text: what it does not name stays.
func TestAResourceSaveWithoutThatTextIsAWholeDocument(t *testing.T) {
	cluster, post := newEditRig(t)
	doc := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  labels:\n    team: a\n"
	if w := post("/api/v1/resources/yaml/apply", map[string]interface{}{"resource_type": "configmaps", "namespace": "shop", "name": "app", "yaml": doc}); w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	sent, patch := cluster.last(t)
	if sent.contentType != strategicPatch || patch["kind"] != "ConfigMap" {
		t.Errorf("%s %s", sent.contentType, sent.body)
	}
}

func TestAWindowLeftEmptyTakesNothingOut(t *testing.T) {
	cluster, post := newEditRig(t)
	opened := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\ndata:\n  keep: \"1\"\n"
	for _, edited := range []string{"", "# nothing here\n", "{}\n"} {
		post("/api/v1/resources/yaml/apply", map[string]interface{}{"resource_type": "configmaps", "namespace": "shop", "name": "app", "yaml": edited, "opened": openedOf(opened, edited)})
		cluster.mu.Lock()
		for _, sent := range cluster.sent {
			if strings.Contains(sent.body, "keep") || strings.Contains(sent.body, "data") || strings.Contains(sent.body, "metadata") {
				t.Errorf("%q sent %s", edited, sent.body)
			}
		}
		cluster.mu.Unlock()
	}
}

func TestANodeSaveTakesOutALabelLine(t *testing.T) {
	cluster, post := newEditRig(t)
	opened := "apiVersion: v1\nkind: Node\nmetadata:\n  name: n1\n  labels:\n    team: a\n    gone: x\nspec:\n  taints:\n  - key: k\n    effect: NoSchedule\n"
	edited := strings.Replace(opened, "    gone: x\n", "", 1)
	if w := post("/api/v1/nodes/n1/yaml/apply", map[string]interface{}{"yaml": edited, "opened": openedOf(opened, edited)}); w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	sent, patch := cluster.last(t)
	if sent.contentType != strategicPatch || !strings.HasSuffix(sent.path, "/nodes/n1") {
		t.Errorf("%s %s", sent.contentType, sent.path)
	}
	labels, _ := metadataOf(t, patch)["labels"].(map[string]interface{})
	if value, named := labels["gone"]; !named || value != nil {
		t.Errorf("labels = %v", labels)
	}
	if patch["spec"] != nil {
		t.Errorf("the patch names what did not change: %s", sent.body)
	}
}

// The API server answers 415 to a strategic patch of a custom resource, so its window could not save at all.
func TestACustomResourceSaveIsAJSONMergePatch(t *testing.T) {
	cluster, post := newEditRig(t)
	apply := func(body map[string]interface{}) {
		t.Helper()
		body["resource_type"], body["namespace"], body["name"] = "widgets", "shop", "w"
		if w := post("/api/v1/resources/yaml/apply", body); w.Code != 200 {
			t.Fatalf("status %d: %s", w.Code, w.Body)
		}
	}
	opened := "apiVersion: example.test/v1\nkind: Widget\nmetadata:\n  name: w\n  namespace: shop\nspec:\n  gone: 1\n  keep: 2\n  items:\n  - a\n  - b\n"
	edited := strings.NewReplacer("  gone: 1\n", "", "  - b\n", "").Replace(opened)
	apply(map[string]interface{}{"yaml": edited, "opened": openedOf(opened, edited)})
	sent, patch := cluster.last(t)
	if sent.contentType != jsonMergePatch || !strings.HasSuffix(sent.path, "/apis/example.test/v1/namespaces/shop/widgets/w") {
		t.Errorf("%s %s", sent.contentType, sent.path)
	}
	spec, _ := patch["spec"].(map[string]interface{})
	if value, named := spec["gone"]; !named || value != nil {
		t.Errorf("spec = %v, want gone null", spec)
	}
	if items, _ := spec["items"].([]interface{}); len(items) != 1 || items[0] != "a" {
		t.Errorf("spec = %v, want the list as edited", spec)
	}

	apply(map[string]interface{}{"yaml": edited})
	sent, _ = cluster.last(t)
	if sent.contentType != jsonMergePatch {
		t.Errorf("a whole document: patch type %s", sent.contentType)
	}
}

func TestANamespaceSaveTakesOutWhatLeftTheTextAndNotAProtectedKey(t *testing.T) {
	cluster, post := newEditRig(t)
	opened := "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shop\n  labels:\n    kubernetes.io/metadata.name: shop\n    team: a\n    gone: x\n  annotations:\n    note: n\n    gone: y\n"
	edited := "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shop\n  labels:\n    team: b\n  annotations:\n    note: n\n"
	if w := post("/api/v1/namespaces/shop/yaml/apply", map[string]interface{}{"yaml": edited, "opened": openedOf(opened, edited)}); w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	sent, object := cluster.last(t)
	if sent.method != http.MethodPut {
		t.Errorf("method %s", sent.method)
	}
	meta := metadataOf(t, object)
	labels, _ := meta["labels"].(map[string]interface{})
	if len(labels) != 2 || labels["team"] != "b" || labels["kubernetes.io/metadata.name"] != "shop" {
		t.Errorf("labels = %v", labels)
	}
	annotations, _ := meta["annotations"].(map[string]interface{})
	if len(annotations) != 1 || annotations["note"] != "n" {
		t.Errorf("annotations = %v", annotations)
	}
}

func TestANamespaceSaveWithoutThatTextTakesOutOnlyAKeyWithNoValue(t *testing.T) {
	cluster, post := newEditRig(t)
	edited := "metadata:\n  labels:\n    team: b\n    gone:\n"
	if w := post("/api/v1/namespaces/shop/yaml/apply", map[string]interface{}{"yaml": edited}); w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	_, object := cluster.last(t)
	meta := metadataOf(t, object)
	labels, _ := meta["labels"].(map[string]interface{})
	if len(labels) != 2 || labels["team"] != "b" {
		t.Errorf("labels = %v", labels)
	}
	annotations, _ := meta["annotations"].(map[string]interface{})
	if len(annotations) != 2 {
		t.Errorf("annotations = %v", annotations)
	}
}
