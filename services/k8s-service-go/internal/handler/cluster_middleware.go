package handler

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// ClusterMiddleware reads the ?cluster= query parameter and stores the target
// cluster ID in the request context. Cluster-aware service methods read it via
// the *Ctx accessors. When absent, the registry's default cluster is resolved
// once here and used for the access check, the data and the audit/recording
// cluster alike — so existing single-cluster callers keep working unchanged.
//
// Step 15 (failure isolation): a request to a cluster the health checker has
// marked down returns 503 immediately (fail-fast) instead of waiting out the
// API-server timeout — so one dead cluster can't tie up requests. The live
// response then feeds the health state back: a connectivity 503 marks the
// cluster down (so the next request fails fast before the periodic poll), any
// success clears it.
func (h *Handler) ClusterMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, ok := auth.FromContext(r.Context())
		if !ok {
			response.Error(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		id := cluster.ID(r.URL.Query().Get("cluster"))
		if id == "" {
			def, err := h.svc.DefaultClusterID(r.Context())
			if errors.Is(err, cluster.ErrNotFound) {
				response.Error(w, http.StatusNotFound, "cluster not found")
				return
			}
			if err != nil {
				response.Error(w, http.StatusServiceUnavailable, "cluster registry unavailable")
				return
			}
			id = def
		}
		c := string(id)

		// Per-cluster access gate. Ordinary read handlers (overview, lists, detail)
		// do not each call requirePermissionForCluster, so without this baseline
		// check any authenticated user could read a cluster's data just by hitting
		// the endpoint. Require a per-cluster grant (Perms[id]) or the global admin
		// entry (Perms["*"]); deny-by-default (00-COMMON §2-3).
		r = r.WithContext(cluster.WithID(r.Context(), id))
		if len(payload.Perms["*"]) == 0 && len(payload.Perms[c]) == 0 {
			err := errors.New("forbidden: no access to cluster " + c)
			// A write or a terminal is a refused attempt worth a row; reads are not (see denied).
			if r.Method != http.MethodGet || strings.HasSuffix(r.URL.Path, "/ws") {
				_ = h.recordAuditWithPayload(r, "k8s.access.denied", "cluster", c, "", err, nil,
					audit.MustJSON(map[string]interface{}{"permission": "cluster access", "method": r.Method, "path": r.URL.Path}))
			}
			response.Error(w, http.StatusForbidden, err.Error())
			return
		}

		// An id the registry does not know is 404 here, once, instead of each
		// handler answering differently (500, or 200 with an empty list).
		if _, err := h.svc.For(r.Context(), id); errors.Is(err, cluster.ErrNotFound) {
			response.Error(w, http.StatusNotFound, "cluster not found")
			return
		}
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
