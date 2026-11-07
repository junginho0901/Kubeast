package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// A kubeconfig may name its server with a user and keeps working by it; the cluster config answer names the server
// without them, as it says it holds no credentials.
func TestClusterConfigNamesTheServerWithoutItsUser(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/version" {
			_, _ = w.Write([]byte(`{"major":"1","minor":"37","gitVersion":"v1.37.0"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	host := strings.TrimPrefix(srv.URL, "http://")
	rc := &rest.Config{Host: "http://bob:fake-url-password@" + host}
	cs, err := kubernetes.NewForConfig(rc)
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs, discovery: cs.Discovery(), restConfig: rc})

	got, err := s.GetClusterConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got["server"] != "http://"+host {
		t.Errorf("server = %v", got["server"])
	}
	if got["version"] == nil {
		t.Errorf("the connection itself stopped working: %v", got)
	}
}
