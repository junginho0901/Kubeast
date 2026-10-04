package limits

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMaxBody_RejectsOversizedBody(t *testing.T) {
	var readErr error
	h := MaxBody(16)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, readErr = io.ReadAll(r.Body)
		if TooLarge(readErr) {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(strings.Repeat("x", 17))))
	if rec.Code != http.StatusRequestEntityTooLarge || !TooLarge(readErr) {
		t.Fatalf("17 bytes with a 16-byte cap: code %d, err %v", rec.Code, readErr)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(strings.Repeat("x", 16))))
	if rec.Code != http.StatusOK {
		t.Fatalf("16 bytes with a 16-byte cap: code %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET without body: code %d", rec.Code)
	}
}
