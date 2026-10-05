package internalauth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func serve(token, header string) *httptest.ResponseRecorder {
	h := Middleware(token)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	r := httptest.NewRequest(http.MethodGet, "/internal/clusters/x/kubeconfig", nil)
	if header != "" {
		r.Header.Set(Header, header)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestMiddleware(t *testing.T) {
	cases := []struct {
		name          string
		token, header string
		want          int
	}{
		{"match", "s3cret", "s3cret", http.StatusNoContent},
		{"match with surrounding spaces", " s3cret ", "s3cret", http.StatusNoContent},
		{"missing header", "s3cret", "", http.StatusUnauthorized},
		{"wrong token", "s3cret", "nope", http.StatusUnauthorized},
		{"prefix only", "s3cret", "s3c", http.StatusUnauthorized},
		{"unconfigured refuses even a matching empty header", "", "", http.StatusServiceUnavailable},
		{"unconfigured refuses any header", "", "anything", http.StatusServiceUnavailable},
	}
	for _, c := range cases {
		if got := serve(c.token, c.header).Code; got != c.want {
			t.Errorf("%s: %d, want %d", c.name, got, c.want)
		}
	}
}

func TestSet(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	Set(req, "")
	if req.Header.Get(Header) != "" {
		t.Fatal("an empty token must not set the header")
	}
	Set(req, " tok ")
	if req.Header.Get(Header) != "tok" {
		t.Fatalf("header = %q", req.Header.Get(Header))
	}
}
