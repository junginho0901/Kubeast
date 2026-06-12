package handler

import (
	"bufio"
	"fmt"
	"net"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// ClusterMiddleware reads the ?cluster= query parameter and stores the target
// cluster ID in the request context. Cluster-aware service methods read it via
// the *Ctx accessors. When absent, no cluster is set and the service falls back
// to the registry's default cluster — so existing single-cluster callers keep
// working unchanged.
//
// Step 15 (failure isolation): a request to a cluster the health checker has
// marked down returns 503 immediately (fail-fast) instead of waiting out the
// API-server timeout — so one dead cluster can't tie up requests. The live
// response then feeds the health state back: a connectivity 503 marks the
// cluster down (so the next request fails fast before the periodic poll), any
// success clears it.
func (h *Handler) ClusterMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := r.URL.Query().Get("cluster")
		if c == "" {
			next.ServeHTTP(w, r)
			return
		}
		id := cluster.ID(c)
		r = r.WithContext(cluster.WithID(r.Context(), id))

		if h.svc.ClusterDown(id) {
			response.Error(w, http.StatusServiceUnavailable, "cluster "+c+" is currently unreachable")
			return
		}
		if !h.svc.AllowRequest(id) {
			response.Error(w, http.StatusTooManyRequests, "rate limit exceeded for cluster "+c)
			return
		}

		sr := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sr, r)

		switch {
		case sr.status == http.StatusServiceUnavailable:
			h.svc.MarkClusterDown(id)
		case sr.status < http.StatusInternalServerError:
			h.svc.MarkClusterUp(id)
		}
	})
}

// statusRecorder captures the response status for the health signal while
// transparently forwarding Hijacker (WebSocket exec/logs) and Flusher (SSE
// streams) so wrapping never breaks those long-lived connections.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := s.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("ResponseWriter does not support hijacking")
}
