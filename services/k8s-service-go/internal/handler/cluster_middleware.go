package handler

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
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
// API-server timeout — so one dead cluster can't tie up requests. The calls a
// request made then feed the health state back: calls that could not reach the
// cluster, with no response to any, count a failure (so the next request fails
// fast before the periodic poll), whatever the handler answered; an answer of
// the API server clears the count. Open, among requests only the one let through after MC_BREAKER_OPEN_SEC closes it.
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
		// ("*"), deny-by-default (00-COMMON §2-3); a global admin.* key opens only the
		// routes its page reads (globalKeyOpens).
		r = r.WithContext(cluster.WithID(r.Context(), id))
		if !payload.ReachesCluster(c) && !globalKeyOpens(payload, r.URL.Path) {
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
		admitted, trial := h.svc.AdmitToCluster(id)
		if !admitted {
			response.Error(w, http.StatusServiceUnavailable, "cluster "+c+" is currently unreachable")
			return
		}
		if !h.svc.AllowRequest(id) {
			h.svc.TrialAskedNothing(id, trial)
			response.Error(w, http.StatusTooManyRequests, "rate limit exceeded for cluster "+c)
			return
		}

		// The identity this request's cluster calls go out as, which the AI
		// chat shows next to a tool call that came through here.
		w.Header().Set(auth.HeaderAccess, payload.Access(c, h.cfg.ImpersonationEnabled).Header())
		sr := &statusRecorder{ResponseWriter: w}
		// An AI tool call asks for the cluster requests it caused, each with its Audit-ID.
		if r.Header.Get(accesstrail.HeaderRecord) != "" {
			sr.trail = &accesstrail.Recorder{}
			r = r.WithContext(accesstrail.NewContext(r.Context(), sr.trail))
		}
		// The API server's first answer decides at once, so a terminal or a followed log trying the cluster closes it.
		var answered atomic.Bool
		ctx, calls := k8s.WithClusterCalls(r.Context(), id, func() {
			answered.Store(true)
			if trial.IsZero() {
				h.svc.ClusterAnswered(id)
			} else {
				h.svc.MarkClusterUp(id)
			}
		})
		r = r.WithContext(ctx)
		defer func() {
			switch {
			case calls.Unreached():
				h.svc.MarkClusterDown(id)
			case trial.IsZero() || answered.Load():
			case calls.Unanswered():
				h.svc.TrialUnanswered(id, trial)
			default:
				h.svc.TrialAskedNothing(id, trial)
			}
		}()
		next.ServeHTTP(sr, r)
	})
}

// statusRecorder stamps the access trail on the answer while transparently
// forwarding Hijacker (WebSocket exec/logs) and Flusher (SSE streams) so
// wrapping never breaks those long-lived connections.
type statusRecorder struct {
	http.ResponseWriter
	// trail, when set, goes out in HeaderRequests with the response headers:
	// the cluster requests made before the handler started its answer.
	trail   *accesstrail.Recorder
	stamped bool
}

func (s *statusRecorder) stamp() {
	if s.trail == nil || s.stamped {
		return
	}
	s.stamped = true
	s.Header().Set(accesstrail.HeaderRequests, s.trail.Snapshot().Header())
}

func (s *statusRecorder) WriteHeader(code int) {
	s.stamp()
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	s.stamp()
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) Flush() {
	s.stamp()
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
