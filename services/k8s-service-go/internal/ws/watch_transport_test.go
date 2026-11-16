package ws

import (
	"context"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// streamWindow is the HTTP/2 stream window of cfg's transport under client-go's wrappers, 0 for Go's default.
func streamWindow(t *testing.T, cfg *rest.Config) int {
	t.Helper()
	rt, err := rest.TransportFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	tr := baseTransport(rt)
	if tr == nil {
		t.Fatalf("no *http.Transport under %T", rt)
	}
	if tr.HTTP2 == nil {
		return 0
	}
	return tr.HTTP2.MaxReceiveBufferPerStream
}

// The watches' client asks the API server for at most its window unread a stream, through client-go's wrappers of its
// transport, and leaves the cluster's own client as it is.
func TestTheWatchClientsStreamsTakeTheirWindow(t *testing.T) {
	cfg := &rest.Config{Host: "https://127.0.0.1:6443", TLSClientConfig: rest.TLSClientConfig{Insecure: true}}
	if got := streamWindow(t, watchStreamConfig(cfg, 0)); got != defaultWatchStreamWindow {
		t.Errorf("the watch client's stream window is %d, want %d", got, defaultWatchStreamWindow)
	}
	if got := streamWindow(t, watchStreamConfig(cfg, 512<<10)); got != 512<<10 {
		t.Errorf("the watch client's stream window is %d, want the %d it was given", got, 512<<10)
	}
	if got := streamWindow(t, cfg); got != 0 {
		t.Errorf("the cluster's client's stream window is %d, want Go's default", got)
	}
	plain := &rest.Config{Host: "http://127.0.0.1:8080"}
	if rt, err := rest.TransportFor(watchStreamConfig(plain, 0)); err != nil || baseTransport(rt) == http.DefaultTransport {
		t.Errorf("a plain HTTP cluster's watch client took %T, %v; want a transport of its own", rt, err)
	}
}

// The window holds through the transports client-go makes for an in-cluster config (a CA file, read again when it
// changes) and for an exec credential plugin, and the watch client still lists with their credentials.
func TestTheWindowHoldsForACAFileAndAnExecPlugin(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"kind":"PodList","apiVersion":"v1","metadata":{"resourceVersion":"1"},"items":[]}`)
	}))
	t.Cleanup(srv.Close)
	caFile := filepath.Join(t.TempDir(), "ca.crt")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name string
		cfg  *rest.Config
	}{
		{"CA file", &rest.Config{Host: srv.URL, BearerToken: "t0k", TLSClientConfig: rest.TLSClientConfig{CAFile: caFile}}},
		{"exec plugin", &rest.Config{Host: srv.URL, TLSClientConfig: rest.TLSClientConfig{CAFile: caFile}, ExecProvider: &clientcmdapi.ExecConfig{
			APIVersion: "client.authentication.k8s.io/v1", Command: "/bin/sh",
			Args:            []string{"-c", `echo '{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"exec-t0k"}}'`},
			InteractiveMode: clientcmdapi.NeverExecInteractiveMode,
		}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := streamWindow(t, watchStreamConfig(c.cfg, 0)); got != defaultWatchStreamWindow {
				t.Errorf("stream window %d, want %d", got, defaultWatchStreamWindow)
			}
			d, err := dynamic.NewForConfig(watchStreamConfig(c.cfg, 0))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := d.Resource(schema.GroupVersionResource{Version: "v1", Resource: "pods"}).List(context.Background(), metav1.ListOptions{}); err != nil {
				t.Errorf("a list through the watch client: %v", err)
			}
		})
	}
}
