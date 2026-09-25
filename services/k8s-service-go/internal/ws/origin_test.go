package ws

import (
	"net/http/httptest"
	"testing"
)

func TestCheckOrigin(t *testing.T) {
	allowedOnce.Do(func() {})
	allowed = []string{"https://console.example.com"}

	cases := []struct {
		name   string
		host   string
		origin string
		want   bool
	}{
		{"same host and port", "kubeast.local:30080", "http://kubeast.local:30080", true},
		{"same host, gateway stripped the port", "kubeast.local", "http://kubeast.local:30080", true},
		{"no Origin header (non-browser client)", "kubeast.local", "", true},
		{"listed origin", "10.0.0.5", "https://console.example.com", true},
		{"listed origin with trailing slash", "10.0.0.5", "https://console.example.com/", true},
		{"foreign origin", "kubeast.local", "https://evil.example", false},
		{"foreign origin, same prefix", "kubeast.local", "http://kubeast.local.evil.example", false},
		{"garbage origin", "kubeast.local", "::not a url", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/v1/cluster/wsMultiplexer", nil)
			r.Host = c.host
			if c.origin != "" {
				r.Header.Set("Origin", c.origin)
			}
			if got := CheckOrigin(r); got != c.want {
				t.Fatalf("CheckOrigin(host=%q origin=%q) = %v, want %v", c.host, c.origin, got, c.want)
			}
		})
	}
}
