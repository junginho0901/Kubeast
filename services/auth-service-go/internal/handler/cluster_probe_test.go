package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// Re-QA #40: the probe's API server address reaches registration and the
// connection test, which fill a cluster's empty api_server_url with it.
func TestProbeReturnsTheAPIServer(t *testing.T) {
	k8s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/clusters/b/validate" {
			http.Error(w, `{"detail":"unexpected path"}`, http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"server_version":"v1.37.0","uid":"u-1","server":"https://10.0.0.1:6443"}`))
	}))
	defer k8s.Close()
	h := &ClustersHandler{cfg: config.Config{K8sServiceURL: k8s.URL}}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/clusters/b/test", nil)

	got := h.checkInfo(r, &cluster.Info{ID: "b", Mode: cluster.ModeExternal})
	if !got.Healthy || got.ServerVersion != "v1.37.0" || got.Server != "https://10.0.0.1:6443" {
		t.Fatalf("checkInfo = %+v", got)
	}
	probe, err := probeCluster(r, h.cfg, "b")
	if err != nil || probe.UID != "u-1" || probe.Server != "https://10.0.0.1:6443" {
		t.Fatalf("probeCluster = %+v %v", probe, err)
	}
}

// A registered self cluster's Test dials it as an external one is (it used to answer healthy without asking): the
// version it reads, or why it could not; the in-cluster Service address is not the API server column's.
func TestARegisteredSelfClusterIsDialed(t *testing.T) {
	answer := `{"server_version":"v1.35.0","uid":"u-self","server":"https://10.96.0.1:443"}`
	status := http.StatusOK
	asked := 0
	k8s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked++
		if r.URL.Path != "/internal/clusters/self/validate" {
			http.Error(w, `{"detail":"unexpected path"}`, http.StatusNotFound)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(answer))
	}))
	defer k8s.Close()
	h := &ClustersHandler{cfg: config.Config{K8sServiceURL: k8s.URL}}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/clusters/self/test", nil)
	self := &cluster.Info{ID: "self", Mode: cluster.ModeInCluster, InCluster: true}

	got := h.checkInfo(r, self)
	if !got.Healthy || got.ServerVersion != "v1.35.0" || got.Server != "" || asked != 1 {
		t.Fatalf("reachable: checkInfo = %+v, asked %d", got, asked)
	}

	status, answer = http.StatusBadRequest, `{"detail":"connection failed: the server has asked for the client to provide credentials"}`
	got = h.checkInfo(r, self)
	if got.Healthy || got.Message != "connection failed: the server has asked for the client to provide credentials" {
		t.Fatalf("refused: checkInfo = %+v", got)
	}

	// k8s-service refusing this caller (403) is no answer about the cluster: marked so the health is not written
	status, answer = http.StatusForbidden, `{"detail":"forbidden: no access to cluster self"}`
	got = h.checkInfo(r, self)
	if got.Healthy || !got.Refused || got.Message != "forbidden: no access to cluster self" {
		t.Fatalf("refused: checkInfo = %+v", got)
	}
	status = http.StatusBadRequest
	if got = h.checkInfo(r, self); got.Refused {
		t.Fatalf("a cluster that does not answer is not a refusal: %+v", got)
	}

	// before registration there is no id to dial by
	asked = 0
	got = h.checkInfo(r, &cluster.Info{Mode: cluster.ModeInCluster, InCluster: true})
	if !got.Healthy || asked != 0 {
		t.Fatalf("not registered: checkInfo = %+v, asked %d", got, asked)
	}
	h.cfg.DeploymentMode = "docker"
	if got = h.checkInfo(r, self); got.Healthy || asked != 0 {
		t.Fatalf("docker mode: checkInfo = %+v, asked %d", got, asked)
	}
}
