package netflows

import (
	"context"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// In mode address Kubeast reaches the Relay itself, with a client certificate when one is set: its client follows no
// redirect, to another address or its own, and the read is the Relay not answering, without the Location it named.
func TestAnAddressFollowsNoRedirect(t *testing.T) {
	var reached atomic.Int32
	other := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Add(1) }))
	defer other.Close()
	relay := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != getFlowsPath {
			reached.Add(1)
			return
		}
		to := other.URL + getFlowsPath
		if r.URL.Query().Get("here") != "" {
			to = "/elsewhere"
		}
		w.Header().Set("Location", to)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer relay.Close()
	ca := filepath.Join(t.TempDir(), "ca.crt")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: relay.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{
		Clusters: map[string]Target{"c": {Mode: "address", URL: relay.URL}}, CAFile: ca,
		DefaultRange: 15 * time.Minute, MaxRange: time.Hour, MaxFlows: 20, GraphMaxFlows: 300, Timeout: 2 * time.Second, PerUserPerMinute: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	req := Request{Namespace: "demo"}
	_ = s.Normalize(&req)
	for _, url := range []string{relay.URL + getFlowsPath, relay.URL + getFlowsPath + "?here=1"} {
		_, err := s.Query(context.Background(), s.AddressClient(), url, req, fixtureNow)
		if !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "redirect not followed") || strings.Contains(err.Error(), other.URL) {
			t.Errorf("%s: %v", url, err)
		}
	}
	if n := reached.Load(); n != 0 {
		t.Fatalf("the redirect was followed %d times", n)
	}
}
