package handler_test

import (
	"context"
	"encoding/base64"
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

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/routes"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const (
	lastAppliedKey   = "kubectl.kubernetes.io/last-applied-configuration"
	fakeValueB64     = "ZmFrZS1zZWNyZXQtdmFsdWU=" // fake-secret-value
	fakeOtherB64     = "ZmFrZS1vdGhlci12YWx1ZQ==" // fake-other-value
	fakeLastApplied  = `{"kind":"Secret","stringData":{"password":"fake-secret-value"}}`
	maskSent         = "***"
	maskInBase64     = "Kioq"     // base64 of the mask, as the YAML window saves it
	quotedInBase64   = "JyoqKic=" // base64 of the mask with its quotes, as a window opened before it read YAML's quotes saves it
	secretApplyPath  = "/api/v1/resources/yaml/apply"
	secretCreatePath = "/api/v1/resources/yaml/create"
)

// secretCluster is an API server holding one Secret: a PATCH merges as the API server merges maps, so what stays after a
// save can be read back; every body it was sent is kept.
type secretCluster struct {
	mu     sync.Mutex
	object map[string]interface{}
	bodies []string
	made   []string
	srv    *httptest.Server
}

func newSecretCluster(t *testing.T) *secretCluster {
	t.Helper()
	c := &secretCluster{object: map[string]interface{}{
		"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
		"metadata": map[string]interface{}{"name": "db", "namespace": inside, "uid": "db-uid",
			"annotations": map[string]interface{}{lastAppliedKey: fakeLastApplied, "team": "shop"}},
		"data": map[string]interface{}{"password": fakeValueB64, "user": fakeOtherB64},
	}}
	c.srv = httptest.NewServer(http.HandlerFunc(c.serve))
	t.Cleanup(c.srv.Close)
	return c
}

func mergeMaps(into, patch map[string]interface{}) {
	for k, v := range patch {
		if v == nil {
			delete(into, k)
			continue
		}
		sub, isMap := v.(map[string]interface{})
		cur, curIsMap := into[k].(map[string]interface{})
		if isMap && curIsMap {
			mergeMaps(cur, sub)
			continue
		}
		into[k] = v
	}
}

// notBase64 is the API server's answer to a Secret's data that is not base64.
func notBase64(object map[string]interface{}) string {
	data, _ := object["data"].(map[string]interface{})
	for _, v := range data {
		if s, _ := v.(string); s != "" {
			if _, err := base64.StdEncoding.DecodeString(s); err != nil {
				return "illegal base64 data: " + err.Error()
			}
		}
	}
	return ""
}

func (c *secretCluster) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/version":
		writeJSON(w, 200, map[string]string{"major": "1", "minor": "34", "gitVersion": "v1.34.0"})
		return
	case "/api":
		writeJSON(w, 200, map[string]interface{}{"kind": "APIVersions", "versions": []string{"v1"}})
		return
	case "/apis":
		writeJSON(w, 200, map[string]interface{}{"kind": "APIGroupList", "apiVersion": "v1", "groups": []interface{}{}})
		return
	case "/api/v1":
		writeJSON(w, 200, map[string]interface{}{"kind": "APIResourceList", "apiVersion": "v1", "groupVersion": "v1", "resources": []map[string]interface{}{
			{"name": "secrets", "singularName": "secret", "kind": "Secret", "namespaced": true, "verbs": []string{"get", "list", "create", "patch"}},
			{"name": "configmaps", "singularName": "configmap", "kind": "ConfigMap", "namespaced": true, "verbs": []string{"get", "list", "create", "patch"}},
		}})
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/secrets/db"):
		writeJSON(w, 200, c.object)
	case r.Method == http.MethodPatch && strings.HasSuffix(r.URL.Path, "/secrets/db"):
		body, _ := io.ReadAll(r.Body)
		c.bodies = append(c.bodies, string(body))
		var patch map[string]interface{}
		if err := json.Unmarshal(body, &patch); err != nil {
			writeJSON(w, 400, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 400, "message": err.Error()})
			return
		}
		if refused := notBase64(patch); refused != "" {
			writeJSON(w, 400, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 400, "message": refused})
			return
		}
		mergeMaps(c.object, patch)
		writeJSON(w, 200, c.object)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/secrets"):
		body, _ := io.ReadAll(r.Body)
		var made map[string]interface{}
		_ = json.Unmarshal(body, &made)
		if refused := notBase64(made); refused != "" {
			writeJSON(w, 400, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 400, "message": refused})
			return
		}
		c.made = append(c.made, string(body))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		_, _ = w.Write(body)
	case strings.Contains(r.URL.Path, "/events"):
		writeJSON(w, 200, map[string]interface{}{"kind": "EventList", "apiVersion": "v1", "metadata": map[string]string{}, "items": []interface{}{}})
	default:
		writeJSON(w, 404, map[string]interface{}{"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": "NotFound", "code": 404})
	}
}

func (c *secretCluster) data() map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.object["data"].(map[string]interface{})
}

func (c *secretCluster) annotations() map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.object["metadata"].(map[string]interface{})["annotations"].(map[string]interface{})
}

func (c *secretCluster) sent() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(append(append([]string{}, c.bodies...), c.made...), "\n")
}

type secretRig struct {
	cluster *secretCluster
	audit   *auditRows
	svc     *k8s.Service
	router  chi.Router
	payload auth.TokenPayload
}

func newSecretRig(t *testing.T, payload auth.TokenPayload) *secretRig {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "false")
	c := newSecretCluster(t)
	blob := strings.Replace(standInKubeconfig, "SERVER", c.srv.URL, 1)
	svc, err := k8s.NewService(context.Background(), standInRegistry{blob: blob}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{Impersonation: true})
	if err != nil {
		t.Fatal(err)
	}
	store := &auditRows{}
	h := handler.New(svc, config.Config{ImpersonationEnabled: true}, store)
	rig := &secretRig{cluster: c, audit: store, svc: svc, payload: payload}
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
		routes.Register(g, h, ws.NewMultiplexer(nil))
	})
	rig.router = r
	return rig
}

func (r *secretRig) do(method, target, body string) *httptest.ResponseRecorder {
	r.svc.MarkClusterUp("c")
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
	defer cancel()
	w := httptest.NewRecorder()
	r.router.ServeHTTP(w, req.WithContext(ctx))
	return w
}

func (r *secretRig) apply(t *testing.T, doc string) *httptest.ResponseRecorder {
	t.Helper()
	return r.do("POST", secretApplyPath, jsonBody(t, map[string]string{"resource_type": "secrets", "namespace": inside, "name": "db", "yaml": doc}))
}

// applyEdited is a save of the YAML window: the text saved and where its edit began.
func (r *secretRig) applyEdited(t *testing.T, opened, edited string) *httptest.ResponseRecorder {
	t.Helper()
	return r.do("POST", secretApplyPath, jsonBody(t, map[string]interface{}{"resource_type": "secrets", "namespace": inside, "name": "db", "yaml": edited, "opened": openedOf(opened, edited)}))
}

func (r *secretRig) create(t *testing.T, doc string) *httptest.ResponseRecorder {
	t.Helper()
	return r.do("POST", secretCreatePath, jsonBody(t, map[string]string{"namespace": inside, "yaml": doc}))
}

func (r *secretRig) rowAfter(t *testing.T, action string) map[string]interface{} {
	t.Helper()
	r.audit.mu.Lock()
	defer r.audit.mu.Unlock()
	for i := len(r.audit.rows) - 1; i >= 0; i-- {
		if r.audit.rows[i].Action == action {
			after := map[string]interface{}{}
			if err := json.Unmarshal(r.audit.rows[i].After, &after); err != nil {
				t.Fatal(err)
			}
			after["result"], after["error"] = r.audit.rows[i].Result, r.audit.rows[i].Error
			return after
		}
	}
	t.Fatalf("no %s row: %v", action, r.audit.actions())
	return nil
}

// A Secret editor without resource.secret.reveal, and one holding it.
func secretEditor() auth.TokenPayload {
	return auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"c": {"resource.secret.read", "resource.secret.edit", "resource.secret.create"}}, Roles: map[string]string{"c": "editor"}}
}

func secretRevealer() auth.TokenPayload {
	p := secretEditor()
	p.Perms = auth.PermissionMatrix{"c": {"resource.secret.read", "resource.secret.edit", "resource.secret.create", "resource.secret.reveal"}}
	return p
}

// A YAML of the object as the reader was shown it, with a label added, saved as the YAML window saves it.
func maskedDoc(body string) string {
	return "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: " + inside + "\n  annotations:\n    " + lastAppliedKey + ": '***'\n    team: shop\n  labels:\n    tier: edited\n" + body + "type: Opaque\n"
}

func (r *secretRig) wantKept(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	data := r.cluster.data()
	if data["password"] != fakeValueB64 || data["user"] != fakeOtherB64 {
		t.Errorf("the values changed: %v", data)
	}
	if ann := r.cluster.annotations(); ann[lastAppliedKey] != fakeLastApplied || ann["team"] != "shop" {
		t.Errorf("the annotations changed: %v", ann)
	}
	sent := r.cluster.sent()
	for _, mask := range []string{maskSent, maskInBase64, quotedInBase64} {
		if strings.Contains(sent, mask) {
			t.Errorf("the cluster was sent the mask %q: %s", mask, sent)
		}
	}
	if !strings.Contains(sent, `"tier":"edited"`) {
		t.Errorf("the edit itself was not sent: %s", sent)
	}
	for _, leak := range []string{fakeValueB64, fakeOtherB64, "fake-secret-value"} {
		if strings.Contains(w.Body.String(), leak) {
			t.Errorf("the answer holds a value: %s", w.Body)
		}
		if strings.Contains(sent, leak) {
			t.Errorf("the save sent a value it was never shown: %s", sent)
		}
		if row := r.rowAfter(t, "k8s.yaml.apply"); strings.Contains(jsonBody(t, row), leak) {
			t.Errorf("the audit row holds a value: %v", row)
		}
	}
}

// What a caller without reveal was shown as the mask stands for the value it hides: whichever way the save writes it,
// the value in the cluster stays and the edit around it goes through.
func TestSecretApplyWithoutRevealKeepsWhatWasMasked(t *testing.T) {
	for title, body := range map[string]string{
		"data removed, as the only save the API server took":   "",
		"the masks under data":                                 "data:\n  password: '***'\n  user: '***'\n",
		"the masks a window opened earlier encoded":            "data:\n  password: " + quotedInBase64 + "\n  user: " + quotedInBase64 + "\n",
		"the masks the window encodes":                         "data:\n  password: " + maskInBase64 + "\n  user: " + maskInBase64 + "\n",
		"the masks under stringData":                           "stringData:\n  password: '***'\n  user: '***'\n",
		"the masks under data and stringData, one key of each": "data:\n  password: '***'\nstringData:\n  user: '***'\n",
	} {
		t.Run(title, func(t *testing.T) {
			rig := newSecretRig(t, secretEditor())
			rig.wantKept(t, rig.apply(t, maskedDoc(body)))
		})
	}
}

// The caller is shown the mask as the YAML window's save writes it back: the line this test file's bytes come from.
func TestSecretYAMLWithoutRevealPrintsTheMaskTheWindowSaves(t *testing.T) {
	rig := newSecretRig(t, secretEditor())
	w := rig.do("GET", "/api/v1/namespaces/"+inside+"/secrets/db/yaml", "")
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var answer map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{"password: '***'\n", "user: '***'\n", lastAppliedKey + ": '***'\n"} {
		if !strings.Contains(answer["yaml"], line) {
			t.Errorf("no line %q in\n%s", line, answer["yaml"])
		}
	}
	for _, leak := range []string{fakeValueB64, fakeOtherB64, "fake-secret-value"} {
		if strings.Contains(answer["yaml"], leak) {
			t.Errorf("the YAML holds a value: %s", answer["yaml"])
		}
	}
}

// As the window shows the Secret to one without reveal and saves it (encodeSecretYaml): each mask as its base64.
func windowSecret(keys ...string) string {
	text := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: " + inside + "\n  annotations:\n    " + lastAppliedKey + ": '***'\n    team: shop\ndata:\n"
	for _, key := range keys {
		text += "  " + key + ": " + maskInBase64 + "\n"
	}
	return text + "type: Opaque\n"
}

func TestAMaskWhoseLineLeftTheWindowTakesOutItsKeyAndNoOther(t *testing.T) {
	rig := newSecretRig(t, secretEditor())
	w := rig.applyEdited(t, windowSecret("password", "user"), windowSecret("password"))
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	data := rig.cluster.data()
	if _, there := data["user"]; there {
		t.Errorf("user is still there: %v", data)
	}
	if data["password"] != fakeValueB64 {
		t.Errorf("the value beside it changed: %v", data)
	}
	if ann := rig.cluster.annotations(); ann[lastAppliedKey] != fakeLastApplied || ann["team"] != "shop" {
		t.Errorf("the annotations changed: %v", ann)
	}
	row := rig.rowAfter(t, "k8s.yaml.apply")
	kept, _ := row["kept_masked"].([]interface{})
	if len(kept) != 2 {
		t.Errorf("kept_masked = %v", row["kept_masked"])
	}
}

func TestAWindowSaveLeavingEveryMaskKeepsEveryValueAndNamesThem(t *testing.T) {
	rig := newSecretRig(t, secretEditor())
	text := windowSecret("password", "user")
	if w := rig.applyEdited(t, text, text+"# edited in the window\n"); w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if data := rig.cluster.data(); data["password"] != fakeValueB64 || data["user"] != fakeOtherB64 {
		t.Errorf("the values changed: %v", data)
	}
	if sent := rig.cluster.sent(); strings.Contains(sent, `"data"`) || strings.Contains(sent, lastAppliedKey) {
		t.Errorf("the patch names what did not change: %s", sent)
	}
	row := rig.rowAfter(t, "k8s.yaml.apply")
	if kept, _ := row["kept_masked"].([]interface{}); len(kept) != 3 {
		t.Errorf("kept_masked = %v", row["kept_masked"])
	}
}

func TestAValueWrittenOverAMaskIsSavedBesideTheOneThatStays(t *testing.T) {
	rig := newSecretRig(t, secretEditor())
	newValue := base64.StdEncoding.EncodeToString([]byte("fake-new-value"))
	edited := strings.Replace(windowSecret("password", "user"), "  user: "+maskInBase64, "  user: "+newValue, 1)
	if w := rig.applyEdited(t, windowSecret("password", "user"), edited); w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	data := rig.cluster.data()
	if data["user"] != newValue || data["password"] != fakeValueB64 {
		t.Errorf("data = %v", data)
	}
}

func TestOneWhoReadsTheValuesTakesOutAKeyByItsLine(t *testing.T) {
	rig := newSecretRig(t, secretRevealer())
	opened := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: " + inside + "\ndata:\n  password: " + fakeValueB64 + "\n  user: " + fakeOtherB64 + "\n"
	if w := rig.applyEdited(t, opened, strings.Replace(opened, "  user: "+fakeOtherB64+"\n", "", 1)); w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	data := rig.cluster.data()
	if _, there := data["user"]; there || data["password"] != fakeValueB64 {
		t.Errorf("data = %v", data)
	}
}

func TestTheWholeDataSectionLeavingTheWindowTakesOutEveryKey(t *testing.T) {
	rig := newSecretRig(t, secretRevealer())
	opened := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: " + inside + "\ndata:\n  password: " + fakeValueB64 + "\n  user: " + fakeOtherB64 + "\ntype: Opaque\n"
	edited := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: " + inside + "\ntype: Opaque\n"
	if w := rig.applyEdited(t, opened, edited); w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	rig.cluster.mu.Lock()
	defer rig.cluster.mu.Unlock()
	if data, there := rig.cluster.object["data"]; there {
		t.Errorf("data = %v", data)
	}
}

// The audit row says what was kept by name, which the reader could read anyway, and never by value.
func TestSecretApplyWithoutRevealNamesWhatItKeptInTheRow(t *testing.T) {
	rig := newSecretRig(t, secretEditor())
	w := rig.apply(t, maskedDoc("data:\n  password: '***'\n"))
	rig.wantKept(t, w)
	row := rig.rowAfter(t, "k8s.yaml.apply")
	kept, _ := row["kept_masked"].([]interface{})
	want := map[string]bool{"data.password": true, "metadata.annotations." + lastAppliedKey: true}
	if len(kept) != len(want) {
		t.Fatalf("kept_masked = %v, want %v", row["kept_masked"], want)
	}
	for _, k := range kept {
		if !want[k.(string)] {
			t.Errorf("kept_masked = %v, want %v", kept, want)
		}
	}
	var answer map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if got, _ := answer["kept_masked"].([]interface{}); len(got) != len(want) {
		t.Errorf("the answer's kept_masked = %v, want %v", answer["kept_masked"], want)
	}
}

// A real change goes through beside what stayed masked, a new key too, and the reader still reads masks afterwards.
func TestSecretApplyWithoutRevealWritesWhatWasChanged(t *testing.T) {
	const newValue = "bmV3LXZhbHVl" // new-value
	rig := newSecretRig(t, secretEditor())
	w := rig.apply(t, maskedDoc("data:\n  password: "+newValue+"\n  user: '***'\n  added: "+newValue+"\n"))
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	data := rig.cluster.data()
	if data["password"] != newValue || data["added"] != newValue || data["user"] != fakeOtherB64 {
		t.Errorf("data = %v", data)
	}
	read := rig.do("GET", "/api/v1/namespaces/"+inside+"/secrets/db/yaml", "")
	if read.Code != 200 {
		t.Fatalf("read: %d %s", read.Code, read.Body)
	}
	for _, leak := range []string{fakeOtherB64, newValue, "fake-secret-value"} {
		if strings.Contains(read.Body.String(), leak) {
			t.Errorf("the reader without reveal reads a value: %s", read.Body)
		}
	}
}

// Who holds reveal was shown the values: what they save is what they wrote, also the characters of the mask.
func TestSecretApplyWithRevealWritesWhatItSays(t *testing.T) {
	rig := newSecretRig(t, secretRevealer())
	w := rig.apply(t, "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: "+inside+"\n  annotations:\n    "+lastAppliedKey+": '***'\ndata:\n  password: "+maskInBase64+"\n")
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if got := rig.cluster.data()["password"]; got != maskInBase64 {
		t.Errorf("password = %v, want the value written", got)
	}
	if got := rig.cluster.annotations()[lastAppliedKey]; got != "***" {
		t.Errorf("annotation = %v, want the value written", got)
	}
	if row := rig.rowAfter(t, "k8s.yaml.apply"); row["kept_masked"] != nil {
		t.Errorf("kept_masked = %v, want none", row["kept_masked"])
	}
}

// A ConfigMap has no mask: its values are what they say, for a caller without reveal too.
func TestConfigMapApplyWithoutRevealWritesWhatItSays(t *testing.T) {
	rig := newSecretRig(t, auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"c": {"resource.configmap.edit"}}, Roles: map[string]string{"c": "editor"}})
	w := rig.do("POST", secretApplyPath, jsonBody(t, map[string]string{"resource_type": "configmaps", "namespace": inside, "name": "cm",
		"yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n  annotations:\n    " + lastAppliedKey + ": '***'\ndata:\n  password: '***'\n"}))
	if strings.Contains(w.Body.String(), "kept_masked") {
		t.Errorf("a ConfigMap's value was taken for a mask: %s", w.Body)
	}
	if row := rig.rowAfter(t, "k8s.yaml.apply"); row["kept_masked"] != nil {
		t.Errorf("kept_masked = %v, want none", row["kept_masked"])
	}
}

// YAML the service cannot read stays the service's to answer.
func TestSecretApplyWithoutRevealLeavesUnreadableYAMLToTheService(t *testing.T) {
	rig := newSecretRig(t, secretEditor())
	w := rig.apply(t, "data: [unclosed")
	if w.Code == 200 || !strings.Contains(w.Body.String(), "YAML") {
		t.Errorf("status %d: %s", w.Code, w.Body)
	}
	if sent := rig.cluster.sent(); sent != "" {
		t.Errorf("sent %s", sent)
	}
}

// A new Secret has no value for the mask to stand for: the caller is told, with the audit row, and nothing is made.
func TestSecretCreateWithoutRevealRefusesTheMask(t *testing.T) {
	head := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: made\n  namespace: " + inside + "\n"
	for title, doc := range map[string]string{
		"under data":          head + "data:\n  password: '***'\n",
		"under stringData":    head + "stringData:\n  password: '***'\n",
		"in the annotation":   "apiVersion: v1\nkind: Secret\nmetadata:\n  name: made\n  namespace: " + inside + "\n  annotations:\n    " + lastAppliedKey + ": '***'\nstringData:\n  password: fake-value\n",
		"the second document": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fine\n---\n" + head + "stringData:\n  password: '***'\n",
	} {
		t.Run(title, func(t *testing.T) {
			rig := newSecretRig(t, auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"c": {"resource.secret.create", "resource.configmap.create"}}, Roles: map[string]string{"c": "editor"}})
			w := rig.create(t, doc)
			if w.Code != 400 || !strings.Contains(w.Body.String(), "***") {
				t.Errorf("status %d: %s, want 400 saying why", w.Code, w.Body)
			}
			if sent := rig.cluster.sent(); sent != "" {
				t.Errorf("made: %s", sent)
			}
			if row := rig.rowAfter(t, "k8s.yaml.create"); row["result"] != "failure" {
				t.Errorf("row = %v, want a failure", row)
			}
		})
	}
}

// A new Secret with values of its own is made, and who holds reveal writes what they say.
func TestSecretCreateMakesWhatIsWritten(t *testing.T) {
	head := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: made\n  namespace: " + inside + "\n"
	rig := newSecretRig(t, auth.TokenPayload{UserID: "u1", Email: signedInUser, Perms: auth.PermissionMatrix{"c": {"resource.secret.create"}}, Roles: map[string]string{"c": "editor"}})
	if w := rig.create(t, head+"stringData:\n  password: fake-value\n"); w.Code != 200 {
		t.Errorf("without reveal: %d %s", w.Code, w.Body)
	}
	revealer := newSecretRig(t, secretRevealer())
	if w := revealer.create(t, head+"stringData:\n  password: '***'\n"); w.Code != 200 {
		t.Errorf("with reveal: %d %s", w.Code, w.Body)
	}
}
