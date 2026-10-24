package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

type seenRequest struct {
	path, auth, user, auditID string
	groups, extra             []string
	upgrade                   bool
}

// fakeAPIServer answers like an API server, on TLS (client-go sends a token
// only there): it echoes Audit-ID and answers an upgrade (exec) on the
// hijacked connection.
func fakeAPIServer(t *testing.T) (*httptest.Server, func() []seenRequest) {
	var mu sync.Mutex
	var seen []seenRequest
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, seenRequest{path: r.URL.Path, auth: r.Header.Get("Authorization"), user: r.Header.Get("Impersonate-User"),
			groups: r.Header.Values("Impersonate-Group"), auditID: r.Header.Get("Audit-ID"), upgrade: r.Header.Get("Upgrade") != ""})
		for k := range r.Header {
			if strings.HasPrefix(strings.ToLower(k), "impersonate-extra-") {
				seen[len(seen)-1].extra = append(seen[len(seen)-1].extra, k)
			}
		}
		mu.Unlock()
		if r.Header.Get("Upgrade") != "" {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_, _ = conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: SPDY/3.1\r\n\r\n"))
			_ = conn.Close()
			return
		}
		w.Header().Set("Audit-Id", r.Header.Get("Audit-ID"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"PodList","apiVersion":"v1","items":[]}`))
	}))
	t.Cleanup(srv.Close)
	return srv, func() []seenRequest { mu.Lock(); defer mu.Unlock(); return append([]seenRequest(nil), seen...) }
}

func clusterKubeconfig(t *testing.T, server string) string {
	path := t.TempDir() + "/kc"
	if err := os.WriteFile(path, []byte(fmt.Sprintf(`apiVersion: v1
kind: Config
clusters: [{name: c, cluster: {server: %s, insecure-skip-tls-verify: true}}]
contexts: [{name: c, context: {cluster: c, user: u}}]
current-context: c
users: [{name: u, user: {token: real-cred}}]
`, server)), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func proxyRoots(t *testing.T, p *kubeProxy) *x509.CertPool {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(p.caPEM) {
		t.Fatal("proxy certificate")
	}
	return pool
}

// proxyClient trusts the proxy as kubectl does, through the run kubeconfig's certificate.
func proxyClient(t *testing.T, p *kubeProxy) *http.Client {
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: proxyRoots(t, p)}}}
}

// The token kubectl was given, read back from the kubeconfig the proxy wrote.
// client-go reads a token only for a TLS server: the proxy must be https.
func runToken(t *testing.T, path string) (server, token string) {
	cfg, err := clientcmd.BuildConfigFromFlags("", path)
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Host, cfg.BearerToken
}

func TestKubeProxySendsTheClusterCredentialTheUserAndAnAuditID(t *testing.T) {
	api, seen := fakeAPIServer(t)
	p, err := startKubeProxy()
	if err != nil {
		t.Fatal(err)
	}
	rec := &accesstrail.Recorder{}
	imp := rest.ImpersonationConfig{UserName: "a@example.com", Groups: []string{"kubeast:authenticated", "kubeast:viewer"}}
	path, done, err := p.prepare("prod", clusterKubeconfig(t, api.URL), imp, rec)
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("run kubeconfig %v %v", info, err)
	}
	server, token := runToken(t, path)
	if !strings.HasPrefix(server, "https://127.0.0.1:") || !strings.HasSuffix(server, "/c/prod") || len(token) != 64 {
		t.Fatalf("kubectl is pointed at %q with token length %d", server, len(token))
	}

	get := func(url, token string, extra map[string]string) int {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		for k, v := range extra {
			req.Header.Add(k, v)
		}
		resp, err := proxyClient(t, p).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	// what kubectl (or arguments smuggled into it) sends as identity is dropped
	forged := map[string]string{"Impersonate-User": "admin", "Impersonate-Group": "system:masters", "Impersonate-Extra-Scopes": "x", "Audit-ID": "forged"}
	if code := get(server+"/api/v1/namespaces/shop/pods", token, forged); code != 200 {
		t.Fatalf("status %d", code)
	}
	if code := get(server+"/api", token, nil); code != 200 { // discovery: proxied, not listed
		t.Fatalf("discovery status %d", code)
	}
	s := seen()
	if len(s) != 2 {
		t.Fatalf("api server saw %+v", s)
	}
	got := s[0]
	if got.path != "/api/v1/namespaces/shop/pods" || got.auth != "Bearer real-cred" || got.user != "a@example.com" || len(got.extra) != 0 ||
		!reflect.DeepEqual(got.groups, imp.Groups) || !regexp.MustCompile(`^kubeast-[0-9a-f]{32}$`).MatchString(got.auditID) {
		t.Fatalf("api server saw %+v", got)
	}
	trail := rec.Snapshot()
	if trail.Total != 1 {
		t.Fatalf("listed %+v", trail)
	}
	if r := trail.Requests[0]; r.Verb != "list" || r.Resource != "pods" || r.Namespace != "shop" || r.Status != 200 || !r.Echoed || r.AuditID != got.auditID {
		t.Fatalf("listed %+v, sent %s", r, got.auditID)
	}

	// a token opens only its own cluster, and only until the run ends
	other := strings.Replace(server, "/c/prod", "/c/dev", 1)
	if code := get(other+"/api/v1/pods", token, nil); code != http.StatusUnauthorized {
		t.Fatalf("other cluster: %d", code)
	}
	if code := get(server+"/api/v1/pods", "not-the-token", nil); code != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", code)
	}
	done()
	if code := get(server+"/api/v1/pods", token, nil); code != http.StatusUnauthorized {
		t.Fatalf("after the run: %d", code)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("run kubeconfig left behind: %v", err)
	}
	if len(seen()) != 2 {
		t.Fatal("a refused request reached the api server")
	}
}

// An upgrading request (exec, attach, port-forward) goes through the upgrade
// transport with the same credential, user and Audit-ID.
func TestKubeProxyUpgradeCarriesTheIdentity(t *testing.T) {
	api, seen := fakeAPIServer(t)
	p, err := startKubeProxy()
	if err != nil {
		t.Fatal(err)
	}
	rec := &accesstrail.Recorder{}
	path, done, err := p.prepare("prod", clusterKubeconfig(t, api.URL), rest.ImpersonationConfig{UserName: "a@example.com", Groups: []string{"kubeast:operator"}}, rec)
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	server, token := runToken(t, path)
	conn, err := tls.Dial("tcp", strings.TrimPrefix(strings.Split(server, "/c/")[0], "https://"), &tls.Config{RootCAs: proxyRoots(t, p)})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "POST /c/prod/api/v1/namespaces/shop/pods/web-1/exec?command=ls HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer %s\r\nImpersonate-User: admin\r\nConnection: Upgrade\r\nUpgrade: SPDY/3.1\r\n\r\n", token)
	status, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatalf("status line %q %v", status, err)
	}
	s := seen()
	if len(s) != 1 || !s[0].upgrade || s[0].auth != "Bearer real-cred" || s[0].user != "a@example.com" || !strings.HasPrefix(s[0].auditID, "kubeast-") {
		t.Fatalf("api server saw %+v", s)
	}
	// the request is listed when the upgraded connection ends, as an exec run ends before its tool answers
	_ = conn.Close()
	var trail accesstrail.Trail
	for i := 0; i < 100; i++ {
		if trail = rec.Snapshot(); trail.Total > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if trail.Total != 1 || trail.Requests[0].Subresource != "exec" || trail.Requests[0].Status != 101 || trail.Requests[0].AuditID != s[0].auditID {
		t.Fatalf("listed %+v", trail)
	}
}

// A kubectl run names only the proxy: a kubeconfig of its own, no --as flags,
// removed when the run ends.
func TestKubectlGoesThroughTheProxy(t *testing.T) {
	api, _ := fakeAPIServer(t)
	p, err := startKubeProxy()
	if err != nil {
		t.Fatal(err)
	}
	prevProxy, prevExec, prevImp := kubectlProxy, kubectlExec, impersonationEnabled
	kubectlProxy, impersonationEnabled = p, true
	defer func() { kubectlProxy, kubectlExec, impersonationEnabled = prevProxy, prevExec, prevImp }()
	var argv []string
	var server string
	kubectlExec = func(_ context.Context, args []string, _ *string) ([]byte, error) {
		argv = args
		server, _ = runToken(t, args[1])
		return []byte("ok"), nil
	}
	ctx := withClusterID(withKubeconfigPath(context.Background(), clusterKubeconfig(t, api.URL)), "prod")
	ctx = auth.WithPayload(ctx, auth.TokenPayload{Email: "a@example.com", Roles: map[string]string{"prod": "Read"}})
	if _, err := runKubectl(ctx, http.Header{}, "get", "pods", "-n", "shop"); err != nil {
		t.Fatal(err)
	}
	if len(argv) != 6 || argv[0] != "--kubeconfig" || !reflect.DeepEqual(argv[2:], []string{"get", "pods", "-n", "shop"}) {
		t.Fatalf("argv %v", argv)
	}
	if !strings.HasSuffix(server, "/c/prod") {
		t.Fatalf("kubectl pointed at %q", server)
	}
	if _, err := os.Stat(argv[1]); !os.IsNotExist(err) {
		t.Fatalf("run kubeconfig left behind: %v", err)
	}
}
