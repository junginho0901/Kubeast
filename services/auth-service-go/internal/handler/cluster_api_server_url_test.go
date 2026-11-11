package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

const (
	fakeURLPassword = "fake-url-password"
	plainKubeconfig = "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://example:6443\ncontexts: []\nusers:\n- name: u\n  user:\n    token: abc\n"
)

// The addresses that hold a user or a password, each with something else making it hard to read.
var urlsWithAUser = []string{
	"https://bob:" + fakeURLPassword + "@10.0.0.1:6443",
	"https://bob@10.0.0.1:6443",
	"//bob:" + fakeURLPassword + "@10.0.0.1:6443",
	"bob:" + fakeURLPassword + "@10.0.0.1:6443",
	"https://bob:" + fakeURLPassword + " x@10.0.0.1:6443",
}

var urlsWithoutAUser = []string{"https://10.0.0.1:6443", "https://api.example.test", "http://10.0.0.1:6443/k8s/clusters/c", "10.0.0.1:6443"}

func clusterAdmin(r *http.Request) *http.Request {
	return r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{
		UserID: "a1", Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": {auth.PermClustersCreate, auth.PermClustersUpdate}},
	}))
}

func acceptingProbe(t *testing.T, server string) string {
	t.Helper()
	k8s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"server_version": "v1.37.0", "uid": "u-1", "server": server})
	}))
	t.Cleanup(k8s.Close)
	return k8s.URL
}

// reachedTheRegistry runs a handler whose registry is not set: getting as far as the store ends in a panic.
func reachedTheRegistry(f func()) (reached bool) {
	defer func() { reached = recover() != nil }()
	f()
	return false
}

func TestRegisteringAnAPIServerURLWithAUserIsRefused(t *testing.T) {
	for _, raw := range urlsWithAUser {
		t.Run(raw, func(t *testing.T) {
			store := &memAuditStore{}
			h := &ClustersHandler{auditStore: store, cfg: config.Config{K8sServiceURL: acceptingProbe(t, "https://10.0.0.1:6443")}}
			body, _ := json.Marshal(map[string]any{"mode": "external", "display_name": "prod", "kubeconfig": plainKubeconfig, "api_server_url": raw})
			w := httptest.NewRecorder()
			r := clusterAdmin(httptest.NewRequest(http.MethodPost, "/api/v1/clusters", strings.NewReader(string(body))))
			if reachedTheRegistry(func() { h.RegisterCluster(w, r) }) {
				t.Fatal("the address went on to be stored")
			}
			if w.Code != http.StatusBadRequest {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), fakeURLPassword) || strings.Contains(w.Body.String(), "bob") {
				t.Errorf("the answer repeats the address: %s", w.Body.String())
			}
			if len(store.written) != 1 || store.written[0].Action != "admin.cluster.register" || store.written[0].Result != audit.ResultFailure {
				t.Fatalf("rows %+v", store.written)
			}
			if row := string(store.written[0].After) + store.written[0].Error; strings.Contains(row, fakeURLPassword) || strings.Contains(row, "bob") {
				t.Errorf("the row repeats the address: %s", row)
			}
		})
	}
}

func TestUpdatingAnAPIServerURLWithAUserIsRefused(t *testing.T) {
	for _, raw := range urlsWithAUser {
		t.Run(raw, func(t *testing.T) {
			store := &memAuditStore{}
			h := &ClustersHandler{auditStore: store}
			body, _ := json.Marshal(map[string]any{"api_server_url": raw})
			r := clusterAdmin(httptest.NewRequest(http.MethodPatch, "/api/v1/clusters/b", strings.NewReader(string(body))))
			rc := chi.NewRouteContext()
			rc.URLParams.Add("id", "b")
			r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rc))
			w := httptest.NewRecorder()
			if reachedTheRegistry(func() { h.UpdateCluster(w, r) }) {
				t.Fatal("the address went on to be stored")
			}
			if w.Code != http.StatusBadRequest {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), fakeURLPassword) || strings.Contains(w.Body.String(), "bob") {
				t.Errorf("the answer repeats the address: %s", w.Body.String())
			}
			if len(store.written) != 1 || store.written[0].Action != "admin.cluster.update" || store.written[0].Result != audit.ResultFailure {
				t.Fatalf("rows %+v", store.written)
			}
			if row := string(store.written[0].After) + store.written[0].Error; strings.Contains(row, fakeURLPassword) || strings.Contains(row, "bob") {
				t.Errorf("the row repeats the address: %s", row)
			}
		})
	}
}

func TestAnAPIServerURLWithoutAUserGoesOn(t *testing.T) {
	for _, raw := range urlsWithoutAUser {
		t.Run(raw, func(t *testing.T) {
			h := &ClustersHandler{auditStore: &memAuditStore{}, cfg: config.Config{K8sServiceURL: acceptingProbe(t, "https://10.0.0.1:6443")}}
			body, _ := json.Marshal(map[string]any{"mode": "external", "display_name": "prod", "kubeconfig": plainKubeconfig, "api_server_url": raw})
			w := httptest.NewRecorder()
			r := clusterAdmin(httptest.NewRequest(http.MethodPost, "/api/v1/clusters", strings.NewReader(string(body))))
			if !reachedTheRegistry(func() { h.RegisterCluster(w, r) }) {
				t.Errorf("refused: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

// A kubeconfig may name its server with a user. It keeps working, as the kubeconfig is what connects; only what the
// probe reports for the screen, the row and api_server_url leaves the user out.
func TestAProbeOfAKubeconfigServerWithAUserReportsItWithout(t *testing.T) {
	h := &ClustersHandler{cfg: config.Config{K8sServiceURL: acceptingProbe(t, "https://bob:"+fakeURLPassword+"@10.0.0.1:6443/k8s")}}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/clusters/b/test", nil)

	got := h.checkInfo(r, &cluster.Info{ID: "b", Mode: cluster.ModeExternal})
	if !got.Healthy || got.Server != "https://10.0.0.1:6443/k8s" {
		t.Errorf("checkInfo = %+v", got)
	}
	probe, err := probeKubeconfig(r, h.cfg, plainKubeconfig)
	if err != nil || probe.Server != "https://10.0.0.1:6443/k8s" {
		t.Errorf("probeKubeconfig = %+v %v", probe, err)
	}
}

func TestAProbeOfAnOrdinaryServerReportsItAsItIs(t *testing.T) {
	h := &ClustersHandler{cfg: config.Config{K8sServiceURL: acceptingProbe(t, "https://10.0.0.1:6443")}}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/clusters/b/test", nil)
	if got := h.checkInfo(r, &cluster.Info{ID: "b", Mode: cluster.ModeExternal}); got.Server != "https://10.0.0.1:6443" {
		t.Errorf("checkInfo = %+v", got)
	}
}

// Text that is no server address is refused on both paths before anything is stored, with the form the field takes.
func TestAnAPIServerURLThatIsNoAddressIsRefused(t *testing.T) {
	for _, raw := range []string{"not an address", "ftp://10.0.0.1:6443", "https://", "http://:6443"} {
		t.Run(raw, func(t *testing.T) {
			h := &ClustersHandler{auditStore: &memAuditStore{}, cfg: config.Config{K8sServiceURL: acceptingProbe(t, "https://10.0.0.1:6443")}}
			body, _ := json.Marshal(map[string]any{"mode": "external", "display_name": "prod", "kubeconfig": plainKubeconfig, "api_server_url": raw})
			w := httptest.NewRecorder()
			r := clusterAdmin(httptest.NewRequest(http.MethodPost, "/api/v1/clusters", strings.NewReader(string(body))))
			if reachedTheRegistry(func() { h.RegisterCluster(w, r) }) {
				t.Fatal("registered")
			}
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "api_server_url: not a server address (https://host:port, or host:port)") {
				t.Errorf("register: %d %s", w.Code, w.Body.String())
			}

			body, _ = json.Marshal(map[string]any{"api_server_url": raw})
			r = clusterAdmin(httptest.NewRequest(http.MethodPatch, "/api/v1/clusters/b", strings.NewReader(string(body))))
			rc := chi.NewRouteContext()
			rc.URLParams.Add("id", "b")
			r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rc))
			w = httptest.NewRecorder()
			if reachedTheRegistry(func() { h.UpdateCluster(w, r) }) {
				t.Fatal("updated")
			}
			if w.Code != http.StatusBadRequest {
				t.Errorf("update: %d %s", w.Code, w.Body.String())
			}
		})
	}
}
