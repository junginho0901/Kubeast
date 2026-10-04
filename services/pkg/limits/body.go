// Package limits holds request-size guards shared by the Go services.
package limits

import (
	"errors"
	"net/http"
)

// DefaultMaxBody is the request body cap when a service sets none: 1 MiB
// covers every JSON body the UI sends (the YAML editors post at most a few
// hundred KB).
const DefaultMaxBody = 1 << 20

// MaxBody caps every request body at n bytes with http.MaxBytesReader: a read
// past the limit fails with *http.MaxBytesError and the connection is closed
// after the response, so an oversized or endless body cannot hold memory or a
// handler goroutine (second review M30).
func MaxBody(n int64) func(http.Handler) http.Handler {
	if n <= 0 {
		n = DefaultMaxBody
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil && r.Body != http.NoBody {
				r.Body = http.MaxBytesReader(w, r.Body, n)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// TooLarge reports whether err came from a body that exceeded MaxBody.
func TooLarge(err error) bool {
	var mbe *http.MaxBytesError
	return errors.As(err, &mbe)
}
