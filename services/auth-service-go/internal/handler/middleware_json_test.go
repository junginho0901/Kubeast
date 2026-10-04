package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequireJSON(t *testing.T) {
	h := RequireJSON(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	for ct, want := range map[string]int{
		"application/json":                  http.StatusNoContent,
		"application/json; charset=utf-8":   http.StatusNoContent,
		"text/plain":                        http.StatusUnsupportedMediaType,
		"application/x-www-form-urlencoded": http.StatusUnsupportedMediaType,
		"multipart/form-data; boundary=x":   http.StatusUnsupportedMediaType,
		"":                                  http.StatusUnsupportedMediaType,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"a","password":"b"}`))
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("Content-Type %q: got %d, want %d", ct, rec.Code, want)
		}
	}
}
