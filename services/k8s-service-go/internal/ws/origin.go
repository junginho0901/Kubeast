package ws

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
)

var (
	allowedOnce sync.Once
	allowed     []string
)

// allowedOrigins is the ALLOWED_ORIGINS list the CORS middleware also uses.
func allowedOrigins() []string {
	allowedOnce.Do(func() {
		for _, o := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
			if o = strings.TrimSpace(strings.TrimRight(o, "/")); o != "" {
				allowed = append(allowed, o)
			}
		}
	})
	return allowed
}

func hostOnly(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		return host
	}
	return h
}

// CheckOrigin is the Upgrader.CheckOrigin for every WebSocket endpoint: the
// Origin must be same-host as the request (the gateway forwards Host without
// the port, so ports are not compared) or listed in ALLOWED_ORIGINS. Requests
// without an Origin header (non-browser clients) pass; the JWT still applies.
func CheckOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	if strings.EqualFold(hostOnly(u.Host), hostOnly(r.Host)) {
		return true
	}
	for _, a := range allowedOrigins() {
		if a == "*" || strings.EqualFold(a, strings.TrimRight(origin, "/")) {
			return true
		}
	}
	return false
}
