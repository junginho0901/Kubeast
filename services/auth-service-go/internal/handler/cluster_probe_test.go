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
