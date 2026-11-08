package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
)

const (
	protectedInstall   = "kubeast"
	protectedNodeShell = "kubeast-node-shell"
)

var (
	onInstallCluster = protectedns.Namespaces{Install: protectedInstall, NodeShell: protectedNodeShell}
	onAnotherCluster = protectedns.Namespaces{NodeShell: protectedNodeShell}

	writeCaller = auth.TokenPayload{UserID: "u1", Email: "write@example.com",
		Perms: auth.PermissionMatrix{"c": {"ai.tool.*", "resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete", "resource.secret.reveal", "resource.pod.exec", "resource.pod.logfile"}}, Roles: map[string]string{"c": "Write"}}
	shellCaller = auth.TokenPayload{UserID: "u1", Email: "shell@example.com",
		Perms: auth.PermissionMatrix{"c": {"ai.tool.*", "resource.node.shell"}}, Roles: map[string]string{"c": "Write"}}
	globalCaller = auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": {"*"}}}
)

func manifestIn(namespace string) string {
	return "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n  namespace: " + namespace + "\n"
}

func TestAToolCallIsHeldToTheProtectedNamespaces(t *testing.T) {
	args := func(kv ...string) map[string]interface{} {
		out := map[string]interface{}{}
		for i := 0; i+1 < len(kv); i += 2 {
			out[kv[i]] = kv[i+1]
		}
		return out
	}
	const list = "apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Pod\n  metadata:\n    name: p\n    namespace: kubeast\n"
	const namespaceObject = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: kubeast\n"
	refused := []struct {
		name string
		p    auth.TokenPayload
		n    protectedns.Namespaces
		tool string
		args map[string]interface{}
	}{
		{"Secret list", writeCaller, onInstallCluster, "k8s_get_resources", args("resource_type", "secrets", "namespace", protectedInstall)},
		{"Secret yaml", writeCaller, onInstallCluster, "k8s_get_resource_yaml", args("resource_type", "secret", "resource_name", "s", "namespace", protectedInstall)},
		{"Secret describe", writeCaller, onInstallCluster, "k8s_describe_resource", args("resource_type", "Secret", "resource_name", "s", "namespace", protectedInstall)},
		{"Secret with a query", writeCaller, onInstallCluster, "k8s_jq_query", args("resource_type", "secrets", "namespace", protectedInstall, "jq", ".items")},
		{"Secret columns", writeCaller, onInstallCluster, "k8s_tabular_query", args("resource_type", "secrets.v1", "namespace", protectedInstall)},
		{"Secret count", writeCaller, onInstallCluster, "k8s_count", args("resource_type", "secrets", "namespace", protectedInstall)},
		{"Helm values", writeCaller, onInstallCluster, "helm_read", args("release", "kubeast", "namespace", protectedInstall, "section", "values")},
		{"delete", writeCaller, onInstallCluster, "k8s_delete_resource", args("resource_type", "pod", "resource_name", "p", "namespace", protectedInstall)},
		{"patch", writeCaller, onInstallCluster, "k8s_patch_resource", args("resource_type", "deployment", "resource_name", "d", "namespace", protectedInstall)},
		{"annotate", writeCaller, onInstallCluster, "k8s_annotate_resource", args("resource_type", "pod", "resource_name", "p", "namespace", protectedInstall)},
		{"label", writeCaller, onInstallCluster, "k8s_label_resource", args("resource_type", "pod", "resource_name", "p", "namespace", protectedInstall)},
		{"scale", writeCaller, onInstallCluster, "k8s_scale", args("resource_type", "deployment", "resource_name", "d", "namespace", protectedInstall)},
		{"rollout", writeCaller, onInstallCluster, "k8s_rollout", args("resource_type", "deployment", "resource_name", "d", "namespace", protectedInstall)},
		{"exec", writeCaller, onInstallCluster, "k8s_execute_command", args("pod_name", "p", "namespace", protectedInstall)},
		{"apply", writeCaller, onInstallCluster, "k8s_apply_manifest", args("yaml_content", manifestIn(protectedInstall))},
		{"create", writeCaller, onInstallCluster, "k8s_create_resource", args("manifest", manifestIn(protectedInstall))},
		{"diff", writeCaller, onInstallCluster, "k8s_diff", args("yaml_content", manifestIn(protectedInstall))},
		{"the second document", writeCaller, onInstallCluster, "k8s_apply_manifest", args("yaml_content", manifestIn("shop")+"---\n"+manifestIn(protectedInstall))},
		{"an item of a List", writeCaller, onInstallCluster, "k8s_apply_manifest", args("yaml_content", list)},
		{"the Namespace object", writeCaller, onInstallCluster, "k8s_apply_manifest", args("yaml_content", namespaceObject)},

		{"exec in the node shell's", writeCaller, onAnotherCluster, "k8s_execute_command", args("pod_name", "p", "namespace", protectedNodeShell)},
		{"a pod in the node shell's", writeCaller, onAnotherCluster, "k8s_create_resource", args("yaml_content", manifestIn(protectedNodeShell))},
		{"a patch in the node shell's", writeCaller, onInstallCluster, "k8s_patch_resource", args("resource_type", "pod", "resource_name", "p", "namespace", protectedNodeShell)},
	}
	for _, c := range refused {
		t.Run(c.name, func(t *testing.T) {
			if err := protectedToolGate(c.p, "c", c.n, c.tool, c.args); err == nil {
				t.Fatal("not refused")
			}
		})
	}
	passes := []struct {
		name string
		p    auth.TokenPayload
		n    protectedns.Namespaces
		tool string
		args map[string]interface{}
	}{
		{"pods in the install namespace", writeCaller, onInstallCluster, "k8s_get_resources", args("resource_type", "pods", "namespace", protectedInstall)},
		{"a pod's logs", writeCaller, onInstallCluster, "k8s_get_pod_logs", args("pod_name", "p", "namespace", protectedInstall)},
		{"Secrets elsewhere", writeCaller, onInstallCluster, "k8s_get_resources", args("resource_type", "secrets", "namespace", "shop")},
		{"a write elsewhere", writeCaller, onInstallCluster, "k8s_delete_resource", args("resource_type", "pod", "resource_name", "p", "namespace", "shop")},
		{"a manifest elsewhere", writeCaller, onInstallCluster, "k8s_apply_manifest", args("yaml_content", manifestIn("shop"))},
		{"a manifest with no namespace", writeCaller, onInstallCluster, "k8s_apply_manifest", args("yaml_content", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n")},
		{"a namespace of that name on another cluster", writeCaller, onAnotherCluster, "k8s_get_resources", args("resource_type", "secrets", "namespace", protectedInstall)},
		{"a write of that name on another cluster", writeCaller, onAnotherCluster, "k8s_delete_resource", args("resource_type", "pod", "resource_name", "p", "namespace", protectedInstall)},
		{"a global admin", globalCaller, onInstallCluster, "k8s_get_resource_yaml", args("resource_type", "secret", "resource_name", "s", "namespace", protectedInstall)},
		{"a global admin's exec", globalCaller, onInstallCluster, "k8s_execute_command", args("pod_name", "p", "namespace", protectedInstall)},
		{"holding the node shell", shellCaller, onAnotherCluster, "k8s_execute_command", args("pod_name", "p", "namespace", protectedNodeShell)},
		{"a manifest kubectl will refuse by itself", writeCaller, onInstallCluster, "k8s_apply_manifest", args("yaml_content", "{not yaml")},
	}
	for _, c := range passes {
		t.Run(c.name, func(t *testing.T) {
			if err := protectedToolGate(c.p, "c", c.n, c.tool, c.args); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// The kubectl tools go through the proxy, which reads each request as the API server would: whatever a tool's arguments
// looked like, what goes out is held to the rule.
func TestTheKubectlProxyHoldsEachRequest(t *testing.T) {
	api, seen := fakeAPIServer(t)
	p, err := startKubeProxy()
	if err != nil {
		t.Fatal(err)
	}
	prevProxy, prevImp := kubectlProxy, impersonationEnabled
	kubectlProxy, impersonationEnabled = p, true
	defer func() { kubectlProxy, impersonationEnabled = prevProxy, prevImp }()

	rec := &accesstrail.Recorder{}
	ctx := withClusterID(withKubeconfigPath(context.Background(), clusterKubeconfig(t, api.URL)), "c")
	ctx = withProtectedNamespaces(auth.WithPayload(ctx, writeCaller), onInstallCluster)
	ctx = accesstrail.NewContext(ctx, rec)
	argv, done, err := kubectlCommand(ctx, []string{"get", "pods"})
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	server, token := runToken(t, argv[1])
	client := proxyClient(t, p)
	send := func(method, path string, upgrade bool) *http.Response {
		req, err := http.NewRequest(method, server+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if upgrade {
			req.Header.Set("Connection", "Upgrade")
			req.Header.Set("Upgrade", "SPDY/3.1")
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	for _, c := range []struct {
		method, path string
		upgrade      bool
	}{
		{"GET", "/api/v1/namespaces/kubeast/secrets/kubeast-auth-keys", false},
		{"GET", "/api/v1/namespaces/kubeast/secrets", false},
		{"POST", "/api/v1/namespaces/kubeast/pods", false},
		{"POST", "/api/v1/namespaces/kubeast/serviceaccounts/k8s-service/token", false},
		{"POST", "/api/v1/namespaces/kubeast/pods/p/exec?command=sh", true},
		{"POST", "/api/v1/namespaces/kubeast-node-shell/pods", false},
		{"POST", "/api/v1/namespaces/kubeast-node-shell/pods/p/attach", true},
	} {
		before := len(seen())
		resp := send(c.method, c.path, c.upgrade)
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden || !strings.Contains(string(body), `"reason":"Forbidden"`) {
			t.Errorf("%s %s: status %d: %s", c.method, c.path, resp.StatusCode, body)
		}
		if len(seen()) != before {
			t.Errorf("%s %s: the cluster was asked", c.method, c.path)
		}
	}
	trail := rec.Snapshot()
	if trail.Total != 7 || trail.Requests[0].Status != http.StatusForbidden || trail.Requests[0].Namespace != "kubeast" {
		t.Errorf("trail %+v", trail)
	}

	// what passes goes out as before
	for _, path := range []string{"/api/v1/namespaces/kubeast/pods", "/api/v1/namespaces/shop/secrets/s"} {
		resp := send("GET", path, false)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status %d", path, resp.StatusCode)
		}
	}

	// a list of every namespace's Secrets leaves the install namespace out
	resp := send("GET", "/api/v1/secrets?limit=500", false)
	_ = resp.Body.Close()
	got := seen()
	if q := got[len(got)-1].query; !strings.Contains(q, "metadata.namespace%21%3Dkubeast") || !strings.Contains(q, "limit=500") {
		t.Errorf("wide list went out with %q", q)
	}
}

func TestTheProxyLeavesAGlobalAdminAlone(t *testing.T) {
	api, seen := fakeAPIServer(t)
	p, err := startKubeProxy()
	if err != nil {
		t.Fatal(err)
	}
	prevProxy, prevImp := kubectlProxy, impersonationEnabled
	kubectlProxy, impersonationEnabled = p, true
	defer func() { kubectlProxy, impersonationEnabled = prevProxy, prevImp }()
	ctx := withClusterID(withKubeconfigPath(context.Background(), clusterKubeconfig(t, api.URL)), "c")
	ctx = withProtectedNamespaces(auth.WithPayload(ctx, globalCaller), onInstallCluster)
	argv, done, err := kubectlCommand(ctx, []string{"get", "pods"})
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	server, token := runToken(t, argv[1])
	req, _ := http.NewRequest("GET", server+"/api/v1/namespaces/kubeast/secrets/s", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := proxyClient(t, p).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || len(seen()) != 1 {
		t.Fatalf("status %d, cluster saw %d", resp.StatusCode, len(seen()))
	}
}

// With the proxy turned off (TOOL_SERVER_KUBECTL_PROXY=false) nothing reads the requests, so kubectl's arguments are held instead.
func TestKubectlWithoutTheProxyIsHeldByItsArguments(t *testing.T) {
	prevProxy, prevExec := kubectlProxy, kubectlExec
	kubectlProxy = nil
	defer func() { kubectlProxy, kubectlExec = prevProxy, prevExec }()
	ran := 0
	kubectlExec = func(context.Context, []string, *string) ([]byte, error) {
		ran++
		return []byte("ok"), nil
	}
	ctxFor := func(p auth.TokenPayload, n protectedns.Namespaces) context.Context {
		return withProtectedNamespaces(auth.WithPayload(withClusterID(context.Background(), "c"), p), n)
	}
	refused := []struct {
		p    auth.TokenPayload
		n    protectedns.Namespaces
		args []string
	}{
		{writeCaller, onInstallCluster, []string{"get", "secret", "s", "-n", protectedInstall}},
		{writeCaller, onInstallCluster, []string{"get", "secrets", "--namespace", protectedInstall, "-o", "json"}},
		{writeCaller, onInstallCluster, []string{"get", "secrets.v1.", "--namespace=" + protectedInstall}},
		{writeCaller, onInstallCluster, []string{"get", "secret/s", "-n" + protectedInstall}},
		{writeCaller, onInstallCluster, []string{"describe", "secret", "s", "-n", protectedInstall}},
		{writeCaller, onInstallCluster, []string{"get", "secrets", "-A"}},
		{writeCaller, onInstallCluster, []string{"get", "secrets", "--all-namespaces", "-o", "json"}},
		{writeCaller, onInstallCluster, []string{"delete", "pod", "p", "-n", protectedInstall}},
		{writeCaller, onInstallCluster, []string{"patch", "deployment", "d", "-n", protectedInstall, "-p", "{}"}},
		{writeCaller, onInstallCluster, []string{"scale", "deployment", "d", "-n", protectedInstall, "--replicas=2"}},
		{writeCaller, onInstallCluster, []string{"rollout", "restart", "deployment/d", "-n", protectedInstall}},
		{writeCaller, onInstallCluster, []string{"exec", "p", "-n", protectedInstall, "--", "sh"}},
		{writeCaller, onAnotherCluster, []string{"exec", "p", "-n", protectedNodeShell, "--", "sh"}},
		{writeCaller, onAnotherCluster, []string{"delete", "pod", "p", "-n", protectedNodeShell}},
	}
	for _, c := range refused {
		ran = 0
		if _, err := runKubectl(ctxFor(c.p, c.n), http.Header{}, c.args...); err == nil || ran != 0 {
			t.Errorf("%v: err %v, ran %d", c.args, err, ran)
		}
	}
	passes := []struct {
		p    auth.TokenPayload
		n    protectedns.Namespaces
		args []string
	}{
		{writeCaller, onInstallCluster, []string{"get", "pods", "-n", protectedInstall}},
		{writeCaller, onInstallCluster, []string{"logs", "p", "-n", protectedInstall}},
		{writeCaller, onInstallCluster, []string{"get", "pods", "-A"}},
		{writeCaller, onInstallCluster, []string{"get", "secrets", "-n", "shop"}},
		{writeCaller, onInstallCluster, []string{"exec", "p", "-n", "shop", "--", "cat", "secret", "-n", protectedInstall}},
		{writeCaller, onInstallCluster, []string{"version", "-o", "json"}},
		{writeCaller, onAnotherCluster, []string{"get", "secrets", "-n", protectedInstall}},
		{writeCaller, onAnotherCluster, []string{"get", "secrets", "-A"}},
		{globalCaller, onInstallCluster, []string{"get", "secrets", "-A"}},
		{globalCaller, onInstallCluster, []string{"exec", "p", "-n", protectedInstall, "--", "sh"}},
		{shellCaller, onAnotherCluster, []string{"exec", "p", "-n", protectedNodeShell, "--", "sh"}},
	}
	for _, c := range passes {
		ran = 0
		if _, err := runKubectl(ctxFor(c.p, c.n), http.Header{}, c.args...); err != nil || ran != 1 {
			t.Errorf("%v: err %v, ran %d", c.args, err, ran)
		}
	}
}

// A proxy that was to run and did not start leaves no request read on its way: the kubectl tools say so and run nothing,
// while one the operator turned off keeps the direct path held by kubectl's arguments.
func TestAKubectlProxyThatDidNotStartRefusesTheKubectlTools(t *testing.T) {
	prevProxy, prevExec, prevRefusal := kubectlProxy, kubectlExec, kubectlProxyRefusal
	defer func() { kubectlProxy, kubectlExec, kubectlProxyRefusal = prevProxy, prevExec, prevRefusal }()
	ran := 0
	kubectlExec = func(context.Context, []string, *string) ([]byte, error) {
		ran++
		return []byte("ok"), nil
	}
	ctx := withProtectedNamespaces(auth.WithPayload(withClusterID(context.Background(), "c"), writeCaller), onInstallCluster)

	kubectlProxy, kubectlProxyRefusal = nil, errKubectlProxyNotStarted
	for _, args := range [][]string{{"get", "pods", "-n", "shop"}, {"get", "secrets", "-n", "shop"}} {
		if _, err := runKubectl(ctx, http.Header{}, args...); err == nil || ran != 0 || !strings.Contains(err.Error(), "kubectl proxy") {
			t.Fatalf("%v after a failed start: err %v, ran %d", args, err, ran)
		}
	}
	if _, _, err := runKubectlKeepingEnd(ctx, "logs", "p", "-n", "shop"); err == nil || ran != 0 {
		t.Fatalf("logs after a failed start: err %v, ran %d", err, ran)
	}

	kubectlProxyRefusal = nil // TOOL_SERVER_KUBECTL_PROXY=false
	if _, err := runKubectl(ctx, http.Header{}, "get", "pods", "-n", "shop"); err != nil || ran != 1 {
		t.Fatalf("with the proxy turned off: err %v, ran %d", err, ran)
	}
}

// kubectl reads a comma list of kinds one by one, so a list naming Secrets is a Secret read, on the tool's arguments and
// on kubectl's with the proxy off.
func TestAKindListNamingSecretsIsHeldAsASecretRead(t *testing.T) {
	for _, kinds := range []string{"pods,secrets", "configmaps, Secret", "pods,secrets.v1"} {
		args := map[string]interface{}{"resource_type": kinds, "namespace": protectedInstall}
		if err := protectedToolGate(writeCaller, "c", onInstallCluster, "k8s_get_resources", args); !errors.Is(err, protectedns.ErrRefused) {
			t.Errorf("tool %q: %v", kinds, err)
		}
	}
	prevProxy, prevExec := kubectlProxy, kubectlExec
	kubectlProxy = nil
	defer func() { kubectlProxy, kubectlExec = prevProxy, prevExec }()
	ran := 0
	kubectlExec = func(context.Context, []string, *string) ([]byte, error) {
		ran++
		return []byte("ok"), nil
	}
	ctx := withProtectedNamespaces(auth.WithPayload(withClusterID(context.Background(), "c"), writeCaller), onInstallCluster)
	for _, args := range [][]string{
		{"get", "pods,secrets", "-n", protectedInstall},
		{"describe", "configmaps,Secrets", "-n", protectedInstall},
		{"get", "pods,secrets", "-A"},
	} {
		ran = 0
		if _, err := runKubectl(ctx, http.Header{}, args...); err == nil || ran != 0 {
			t.Errorf("kubectl %v: err %v, ran %d", args, err, ran)
		}
	}
	// a list without Secrets reads the install namespace as before
	ran = 0
	if _, err := runKubectl(ctx, http.Header{}, "get", "pods,configmaps", "-n", protectedInstall); err != nil || ran != 1 {
		t.Errorf("pods,configmaps: err %v, ran %d", err, ran)
	}
	if err := protectedToolGate(writeCaller, "c", onInstallCluster, "k8s_get_resources", map[string]interface{}{"resource_type": "pods,configmaps", "namespace": protectedInstall}); err != nil {
		t.Errorf("tool pods,configmaps: %v", err)
	}
}

// k8s-service names the two namespaces with the kubeconfig, and a refused call answers 403 before anything runs, the
// model's and an MCP client's alike.
func TestHandleCallTakesTheNamespacesFromK8sService(t *testing.T) {
	resetKubeconfigCache()
	fetches := 0
	_, restore := mockK8sService(t, func(w http.ResponseWriter, _ *http.Request) {
		fetches++
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"kubeconfig": "", "in_cluster": true,
			"protected_namespaces": map[string]string{"install": protectedInstall, "node_shell": protectedNodeShell}})
	})
	defer restore()
	prevAuth := toolAuth
	toolAuth = fakeValidator{payload: writeCaller}
	defer func() { toolAuth = prevAuth }()
	var seen protectedns.Namespaces
	ran := 0
	tool := func(ctx context.Context, _ map[string]interface{}, _ http.Header) (string, error) {
		ran++
		seen = protectedFromCtx(ctx)
		return "ok", nil
	}
	tools := map[string]ToolDefinition{"k8s_get_resources": {Name: "k8s_get_resources", Handler: tool}}
	call := func(arguments string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/call", strings.NewReader(`{"name":"k8s_get_resources","arguments":`+arguments+`}`))
		req.Header.Set("Authorization", "Bearer t")
		rec := httptest.NewRecorder()
		handleCall(rec, req, tools)
		return rec
	}
	rec := call(`{"cluster":"c","resource_type":"secrets","namespace":"kubeast"}`)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), protectedInstall) || ran != 0 {
		t.Fatalf("status %d: %s, ran %d", rec.Code, rec.Body.String(), ran)
	}
	rec = call(`{"cluster":"c","resource_type":"pods","namespace":"kubeast"}`)
	if rec.Code != http.StatusOK || ran != 1 {
		t.Fatalf("status %d: %s, ran %d", rec.Code, rec.Body.String(), ran)
	}
	if seen != onInstallCluster {
		t.Errorf("the tool sees %+v", seen)
	}
	if fetches != 1 {
		t.Errorf("fetched %d times: the answer is kept with the kubeconfig", fetches)
	}
}

func TestANodeShellPodsLogIsHeldOnTheAIPathToo(t *testing.T) {
	logs := map[string]interface{}{"namespace": protectedNodeShell, "pod_name": "node-debugger-a"}
	if err := protectedToolGate(writeCaller, "c", onInstallCluster, "k8s_get_pod_logs", logs); !errors.Is(err, protectedns.ErrRefused) {
		t.Fatalf("Write: %v", err)
	}
	if err := protectedToolGate(shellCaller, "c", onInstallCluster, "k8s_get_pod_logs", logs); err != nil {
		t.Fatalf("holder: %v", err)
	}
	installLogs := map[string]interface{}{"namespace": protectedInstall, "pod_name": "kubeast-0"}
	if err := protectedToolGate(writeCaller, "c", onInstallCluster, "k8s_get_pod_logs", installLogs); err != nil {
		t.Fatalf("install namespace: %v", err)
	}
	ctx := withProtectedNamespaces(auth.WithPayload(withClusterID(context.Background(), "c"), writeCaller), onInstallCluster)
	if err := directKubectlRefusal(ctx, []string{"logs", "-n", protectedNodeShell, "node-debugger-a"}); !errors.Is(err, protectedns.ErrRefused) {
		t.Fatalf("kubectl logs with the proxy off: %v", err)
	}
}
