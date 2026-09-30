package audit

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFromHTTPRequest_ClientIPComesFromTheGateway(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		remote  string
		want    string
	}{
		{"gateway's X-Real-IP wins", map[string]string{"X-Real-IP": "203.0.113.9", "X-Forwarded-For": "1.2.3.4, 203.0.113.9"}, "10.0.0.5:4321", "203.0.113.9"},
		{"a client-supplied X-Forwarded-For is ignored", map[string]string{"X-Forwarded-For": "1.2.3.4"}, "10.0.0.5:4321", "10.0.0.5"},
		{"a client-supplied True-Client-IP is ignored", map[string]string{"True-Client-IP": "1.2.3.4"}, "10.0.0.5:4321", "10.0.0.5"},
		{"peer address without the port", nil, "[fd00::7]:5555", "fd00::7"},
		{"peer address as is when it has no port", nil, "10.0.0.5", "10.0.0.5"},
	}
	for _, tc := range cases {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
		r.RemoteAddr = tc.remote
		for k, v := range tc.headers {
			r.Header.Set(k, v)
		}
		if got := FromHTTPRequest(r).RequestIP; got != tc.want {
			t.Errorf("%s: RequestIP = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestRealIP_OnlyTrustsXRealIP(t *testing.T) {
	var seen string
	h := RealIP(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { seen = r.RemoteAddr }))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.5:4321"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	r.Header.Set("True-Client-IP", "5.6.7.8")
	h.ServeHTTP(httptest.NewRecorder(), r)
	if seen != "10.0.0.5:4321" {
		t.Fatalf("spoofable headers must not change RemoteAddr: %q", seen)
	}

	r.Header.Set("X-Real-IP", "203.0.113.9")
	h.ServeHTTP(httptest.NewRecorder(), r)
	if seen != "203.0.113.9" {
		t.Fatalf("X-Real-IP from the gateway must set RemoteAddr: %q", seen)
	}
}
