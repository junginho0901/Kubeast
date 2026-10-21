package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/internalauth"
)

// The cache-bust takes the internal token (auth-service sends it) and drops the
// cluster's cached kubeconfig file; without the token nothing is dropped.
func TestInvalidateTakesTheInternalToken(t *testing.T) {
	file := filepath.Join(os.TempDir(), "tool-server-kubeconfig-"+sanitizeID("c-inv"))
	call := func(token string) int {
		if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "/internal/invalidate?cluster=c-inv", nil)
		if token != "" {
			r.Header.Set(internalauth.Header, token)
		}
		w := httptest.NewRecorder()
		invalidateHandler("tok").ServeHTTP(w, r)
		return w.Code
	}
	if code := call(""); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", code)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("a refused call must not drop the cache")
	}
	if code := call("wrong"); code != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", code)
	}
	if code := call("tok"); code != http.StatusNoContent {
		t.Fatalf("token: %d", code)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("the cached kubeconfig file is dropped")
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/internal/invalidate", nil)
	r.Header.Set(internalauth.Header, "tok")
	invalidateHandler("tok").ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", w.Code)
	}
}
