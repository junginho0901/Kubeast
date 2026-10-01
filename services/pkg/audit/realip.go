package audit

import "net/http"

// RealIP sets r.RemoteAddr to the address the gateway attributed the request
// to (X-Real-IP) so loggers and anything keyed on the remote address agree
// with the audit log. Unlike chi's middleware.RealIP it ignores
// True-Client-IP and X-Forwarded-For, which a client can set itself.
func RealIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if real := r.Header.Get("X-Real-IP"); real != "" {
			r.RemoteAddr = real
		}
		next.ServeHTTP(w, r)
	})
}
