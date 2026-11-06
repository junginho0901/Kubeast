package protectedns

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const (
	install   = "kubeast"
	nodeShell = "kubeast-node-shell"
	clusterID = "c"
)

var (
	rules       = Namespaces{Install: install, NodeShell: nodeShell}
	globalAdmin = auth.TokenPayload{Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": {"*"}}}
	writer      = auth.TokenPayload{Email: "write@example.com", Perms: auth.PermissionMatrix{"c": {"resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete", "resource.secret.reveal", "resource.pod.exec", "resource.pod.logfile", "ai.tool.*"}}, Roles: map[string]string{"c": "Write"}}
	clusterAll  = auth.TokenPayload{Email: "clusteradmin@example.com", Perms: auth.PermissionMatrix{"c": {"*"}}, Roles: map[string]string{"c": "Admin"}}
	shellHolder = auth.TokenPayload{Email: "shell@example.com", Perms: auth.PermissionMatrix{"c": {"resource.node.shell", "resource.pod.create"}}}
	narrowAdmin = auth.TokenPayload{Email: "narrow@example.com", Perms: auth.PermissionMatrix{"*": {"admin.users.read"}, "c": {"resource.*"}}}
)

func TestRefusalFollowsWhoAsksAndWhatTheyDo(t *testing.T) {
	cases := []struct {
		name      string
		p         auth.TokenPayload
		namespace string
		act       Act
		refused   bool
	}{
		{"a write role's Secret read in the install namespace", writer, install, ActSecretRead, true},
		{"a write role's write in the install namespace", writer, install, ActWrite, true},
		{"a write role's terminal in the install namespace", writer, install, ActExec, true},
		{"a write role's other reads in the install namespace", writer, install, ActRead, false},
		{"a drain's eviction in the install namespace", clusterAll, install, ActEvict, false},
		{"one cluster's whole grant is not a global admin", clusterAll, install, ActSecretRead, true},
		{"a global role without * is not a global admin", narrowAdmin, install, ActSecretRead, true},
		{"a global admin in the install namespace", globalAdmin, install, ActSecretRead, false},
		{"a global admin's write in the install namespace", globalAdmin, install, ActWrite, false},
		{"a global admin's terminal in the install namespace", globalAdmin, install, ActExec, false},
		{"a write role's write elsewhere", writer, "shop", ActWrite, false},
		{"a write role's Secret read elsewhere", writer, "shop", ActSecretRead, false},

		{"a write role's write in the node shell namespace", writer, nodeShell, ActWrite, true},
		{"a write role's terminal in the node shell namespace", writer, nodeShell, ActExec, true},
		{"a write role's read in the node shell namespace", writer, nodeShell, ActRead, false},
		{"a node shell holder's write in the node shell namespace", shellHolder, nodeShell, ActWrite, false},
		{"a node shell holder's terminal in the node shell namespace", shellHolder, nodeShell, ActExec, false},
		{"a global admin's write in the node shell namespace", globalAdmin, nodeShell, ActWrite, false},
		{"a whole-cluster grant holds the node shell", clusterAll, nodeShell, ActExec, false},

		{"no namespace named", writer, "", ActWrite, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := rules.Refusal(c.p, clusterID, c.namespace, c.act)
			if (err != nil) != c.refused {
				t.Fatalf("err = %v, want refused %v", err, c.refused)
			}
			if err != nil && !strings.Contains(err.Error(), c.namespace) {
				t.Errorf("the refusal does not name the namespace: %v", err)
			}
		})
	}
}

// On a cluster Kubeast does not run in, a namespace called the same is an ordinary one; the node shell's stays guarded.
func TestAnotherClusterHasNoInstallNamespace(t *testing.T) {
	other := Namespaces{NodeShell: nodeShell}
	if err := other.Refusal(writer, clusterID, install, ActSecretRead); err != nil {
		t.Errorf("Secret read: %v", err)
	}
	if err := other.Refusal(writer, clusterID, install, ActWrite); err != nil {
		t.Errorf("write: %v", err)
	}
	if err := other.Refusal(writer, clusterID, nodeShell, ActWrite); err == nil {
		t.Error("the node shell namespace is guarded on every cluster")
	}
}

func TestActOfReadsAKubernetesRequest(t *testing.T) {
	cases := []struct {
		group, verb, resource, subresource string
		want                               Act
	}{
		{"", "get", "secrets", "", ActSecretRead},
		{"", "list", "secrets", "", ActSecretRead},
		{"", "watch", "secrets", "", ActSecretRead},
		{"", "delete", "secrets", "", ActWrite},
		{"example.com", "get", "secrets", "", ActRead},
		{"", "get", "configmaps", "", ActRead},
		{"", "get", "pods", "log", ActRead},
		{"", "create", "pods", "", ActWrite},
		{"apps", "patch", "deployments", "", ActWrite},
		{"apps", "update", "deployments", "scale", ActWrite},
		{"", "create", "serviceaccounts", "token", ActWrite},
		{"", "create", "pods", "exec", ActExec},
		{"", "get", "pods", "exec", ActExec},
		{"", "create", "pods", "attach", ActExec},
		{"", "get", "pods", "attach", ActExec},
		{"", "create", "pods", "portforward", ActExec},
		{"", "create", "pods", "eviction", ActEvict},
		{"", "patch", "pods", "ephemeralcontainers", ActWrite},
		{"", "get", "services", "proxy", ActExec},
		{"", "create", "services", "proxy", ActExec},
		{"", "get", "pods", "proxy", ActExec},
	}
	for _, c := range cases {
		if got := ActOf(c.group, c.verb, c.resource, c.subresource); got != c.want {
			t.Errorf("%s %s/%s in %q: %d, want %d", c.verb, c.resource, c.subresource, c.group, got, c.want)
		}
	}
}

func request(method, target string) *http.Request {
	return httptest.NewRequest(method, target, nil)
}

func TestCheckReadsTheRequestItself(t *testing.T) {
	refused := []struct {
		p              auth.TokenPayload
		method, target string
	}{
		{writer, "GET", "/api/v1/namespaces/kubeast/secrets/kubeast-auth-keys"},
		{writer, "GET", "/api/v1/namespaces/kubeast/secrets"},
		{writer, "GET", "/api/v1/namespaces/kubeast/secrets?watch=true"},
		{writer, "POST", "/api/v1/namespaces/kubeast/pods"},
		{writer, "POST", "/api/v1/namespaces/kubeast/pods/p/exec?command=sh"},
		{writer, "GET", "/api/v1/namespaces/kubeast/pods/p/exec?command=sh"},
		{writer, "POST", "/api/v1/namespaces/kubeast/pods/p/attach"},
		{writer, "GET", "/api/v1/namespaces/kubeast/services/k8s-service:8002/proxy/metrics"},
		{writer, "GET", "/api/v1/namespaces/kubeast/pods/p:8000/proxy/"},
		{writer, "POST", "/api/v1/namespaces/kubeast/services/https:k8s-service:8002/proxy/internal/clusters/c/validate"},
		{writer, "POST", "/api/v1/namespaces/kubeast/serviceaccounts/k8s-service/token"},
		{writer, "PATCH", "/apis/apps/v1/namespaces/kubeast/deployments/k8s-service"},
		{writer, "DELETE", "/api/v1/namespaces/kubeast"},
		{writer, "PATCH", "/api/v1/namespaces/kubeast"},
		{writer, "POST", "/api/v1/namespaces/kubeast-node-shell/pods"},
		{writer, "POST", "/api/v1/namespaces/kubeast-node-shell/pods/p/exec"},
		{writer, "POST", "/apis/apps/v1/namespaces/kubeast-node-shell/deployments"},
	}
	for _, c := range refused {
		if err := rules.Check(c.p, clusterID, request(c.method, c.target)); err == nil {
			t.Errorf("%s %s went through", c.method, c.target)
		}
	}
	passes := []struct {
		p              auth.TokenPayload
		method, target string
	}{
		{writer, "GET", "/api/v1/namespaces/kubeast/pods"},
		{writer, "GET", "/api/v1/namespaces/kubeast/pods/p/log"},
		{writer, "GET", "/api/v1/namespaces/kubeast"},
		{writer, "GET", "/api/v1/namespaces/kubeast-node-shell/pods"},
		{writer, "GET", "/api/v1/namespaces/shop/secrets/s"},
		{writer, "GET", "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query"},
		{writer, "POST", "/api/v1/namespaces/shop/pods"},
		{clusterAll, "POST", "/api/v1/namespaces/kubeast/pods/p/eviction"},
		{writer, "GET", "/version"},
		{shellHolder, "POST", "/api/v1/namespaces/kubeast-node-shell/pods"},
		{shellHolder, "POST", "/api/v1/namespaces/kubeast-node-shell/pods/p/attach"},
		{globalAdmin, "GET", "/api/v1/namespaces/kubeast/secrets/kubeast-auth-keys"},
		{globalAdmin, "POST", "/api/v1/namespaces/kubeast/pods/p/exec"},
	}
	for _, c := range passes {
		if err := rules.Check(c.p, clusterID, request(c.method, c.target)); err != nil {
			t.Errorf("%s %s: %v", c.method, c.target, err)
		}
	}
}

func TestAWideSecretListLeavesOutTheInstallNamespace(t *testing.T) {
	cases := []struct {
		p                  auth.TokenPayload
		target, wantFields string
	}{
		{writer, "/api/v1/secrets", "metadata.namespace!=kubeast"},
		{writer, "/api/v1/secrets?limit=500", "metadata.namespace!=kubeast"},
		{writer, "/api/v1/secrets?watch=true", "metadata.namespace!=kubeast"},
		{writer, "/api/v1/secrets?fieldSelector=type%3Dkubernetes.io%2Ftls", "type=kubernetes.io/tls,metadata.namespace!=kubeast"},
		{globalAdmin, "/api/v1/secrets", ""},
		{writer, "/api/v1/configmaps", ""},
	}
	for _, c := range cases {
		r := request("GET", c.target)
		if err := rules.Check(c.p, clusterID, r); err != nil {
			t.Errorf("%s: %v", c.target, err)
		}
		if got := r.URL.Query().Get("fieldSelector"); got != c.wantFields {
			if c.wantFields != "" || got != "" {
				t.Errorf("%s: fieldSelector %q, want %q", c.target, got, c.wantFields)
			}
		}
	}
	// the other query parameters survive
	r := request("GET", "/api/v1/secrets?limit=500&includeObject=Object")
	if err := rules.Check(writer, clusterID, r); err != nil {
		t.Fatal(err)
	}
	if q := r.URL.Query(); q.Get("limit") != "500" || q.Get("includeObject") != "Object" {
		t.Errorf("query %q", r.URL.RawQuery)
	}
	// nothing to leave out on a cluster without the install namespace
	r = request("GET", "/api/v1/secrets")
	if err := (Namespaces{NodeShell: nodeShell}).Check(writer, clusterID, r); err != nil || r.URL.RawQuery != "" {
		t.Errorf("err %v, query %q", err, r.URL.RawQuery)
	}
}

// A client and a stand-in API server: what a refusal looks like to client-go, and that the server is not asked.
func guardedClient(t *testing.T, wrap func(http.RoundTripper) http.RoundTripper) (*kubernetes.Clientset, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"SecretList","apiVersion":"v1","items":[]}`))
	}))
	t.Cleanup(srv.Close)
	cfg := &rest.Config{Host: srv.URL}
	cfg.Wrap(wrap)
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return cs, func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), seen...) }
}

func TestRoundTripperRefusesAsTheClusterWould(t *testing.T) {
	cs, seen := guardedClient(t, func(rt http.RoundTripper) http.RoundTripper { return RoundTripper(rt, rules, clusterID) })
	ctx := auth.WithPayload(context.Background(), writer)

	_, err := cs.CoreV1().Secrets(install).Get(ctx, "kubeast-auth-keys", metav1.GetOptions{})
	if !apierrors.IsForbidden(err) {
		t.Fatalf("err = %v, want Forbidden", err)
	}
	if !strings.Contains(err.Error(), install) {
		t.Errorf("no reason in %v", err)
	}
	if len(seen()) != 0 {
		t.Errorf("the cluster was asked: %v", seen())
	}

	if _, err := cs.CoreV1().Secrets("").List(ctx, metav1.ListOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := seen(); len(got) != 1 || !strings.Contains(got[0], "fieldSelector=metadata.namespace%21%3Dkubeast") {
		t.Errorf("wide list went out as %v", got)
	}
}

// A call with no signed-in user in its context is Kubeast's own: the informers and the registry.
func TestRoundTripperLeavesACallWithNoUser(t *testing.T) {
	cs, seen := guardedClient(t, func(rt http.RoundTripper) http.RoundTripper { return RoundTripper(rt, rules, clusterID) })
	if _, err := cs.CoreV1().Secrets(install).List(context.Background(), metav1.ListOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(seen()) != 1 {
		t.Errorf("calls %v", seen())
	}
}

// The Helm SDK and the exec stream send their calls with a context of their own, so the identity is on the config.
func TestPinnedHoldsACallWhoseContextHasNoUser(t *testing.T) {
	cs, seen := guardedClient(t, func(rt http.RoundTripper) http.RoundTripper { return Pinned(rt, rules, clusterID, writer) })
	_, err := cs.CoreV1().Secrets(install).List(context.Background(), metav1.ListOptions{})
	if !apierrors.IsForbidden(err) {
		t.Fatalf("err = %v, want Forbidden", err)
	}
	if len(seen()) != 0 {
		t.Errorf("the cluster was asked: %v", seen())
	}
}

func TestWriteForbiddenAnswersAsAnAPIServer(t *testing.T) {
	w := httptest.NewRecorder()
	WriteForbidden(w, rules.Refusal(writer, clusterID, install, ActSecretRead))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status %d", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{`"kind":"Status"`, `"reason":"Forbidden"`, `"code":403`, install} {
		if !strings.Contains(body, want) {
			t.Errorf("%s not in %s", want, body)
		}
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content type %q", ct)
	}
}
