package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// LogQLNamespace handles GET /api/v1/namespaces/{namespace}/logsearch/query.
func (h *Handler) LogQLNamespace(w http.ResponseWriter, r *http.Request) {
	h.serveLogQL(w, r, chi.URLParam(r, "namespace"))
}

// LogQLAll handles GET /api/v1/logsearch/query (/api/v1/cluster/logsearch/query
// at the gateway) — every namespace, for a grant not limited to namespaces.
func (h *Handler) LogQLAll(w http.ResponseWriter, r *http.Request) {
	h.serveLogQL(w, r, "")
}

// serveLogQL runs a LogQL query an admin wrote (features.logSearch.logql,
// admin.logsearch.query) on the request's cluster. The cluster and namespace
// matchers are added to every stream selector before it leaves (so the query
// cannot reach past them); the rest of the door is the structured search's:
// resource.pod.read, get pods/log as the user, the per-user rate, the audit.
func (h *Handler) serveLogQL(w http.ResponseWriter, r *http.Request, namespace string) {
	id, _ := cluster.FromContext(r.Context())
	if h.logSearch == nil || !h.logSearch.Config().LogQLEnabled {
		response.Error(w, http.StatusNotFound, "LogQL queries are off (features.logSearch.logql)")
		return
	}
	if !h.logSearch.Configured(r.Context(), string(id)) {
		response.Error(w, http.StatusNotFound, "log search is not configured for this cluster")
		return
	}
	if err := h.requirePermissionForCluster(r, auth.PermLogSearchQuery); err != nil {
		h.handleError(w, err)
		return
	}
	if err := h.requirePermissionForCluster(r, "resource.pod.read"); err != nil {
		h.handleError(w, err)
		return
	}
	payload, _ := auth.FromContext(r.Context())
	if namespace == "" && len(payload.Namespaces[string(id)]) > 0 {
		response.Error(w, http.StatusForbidden, "your grant on this cluster is limited to namespaces: query one of them ("+strings.Join(payload.Namespaces[string(id)], ", ")+")")
		return
	}

	// the range, limit and direction are read the way a structured search's are
	base, err := logSearchRequest(r, string(id), namespace)
	req := logsearch.QueryRequest{Cluster: string(id), Namespace: namespace, Query: r.URL.Query().Get("q"), Start: base.Start, End: base.End, Limit: base.Limit, Forward: base.Forward}
	if err == nil {
		err = h.logSearch.Config().NormalizeRange(&req.Start, &req.End, &req.Limit, time.Now())
	}
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	allowed, err := h.canReadPodLogs(r.Context(), namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	if !allowed {
		denied := fmt.Errorf("forbidden: the cluster does not let you read pod logs in %s", namespaceOrAll(namespace))
		_ = h.recordAuditWithPayload(r, "k8s.pod.logs.logql", "namespace", namespace, namespace, denied, nil, logQLAudit(req, nil))
		response.Error(w, http.StatusForbidden, denied.Error())
		return
	}
	if !h.logSearch.Allow(payload.UserID) {
		limited := fmt.Errorf("too many log searches: %d per minute", h.logSearch.Config().PerUserPerMinute)
		_ = h.recordAuditWithPayload(r, "k8s.pod.logs.logql", "namespace", namespace, namespace, limited, nil, logQLAudit(req, nil))
		response.Error(w, http.StatusTooManyRequests, limited.Error())
		return
	}
	if rerr := h.auditReady(r); rerr != nil {
		h.refuseUnaudited(w, r, rerr)
		return
	}

	res, qerr := h.logSearch.Query(r.Context(), req)
	if werr := h.recordAuditWithPayload(r, "k8s.pod.logs.logql", "namespace", namespace, namespace, qerr, nil, logQLAudit(req, &res)); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	if qerr != nil {
		status := http.StatusBadGateway
		switch {
		case errors.Is(qerr, logsearch.ErrInvalidLogQL), errors.Is(qerr, logsearch.ErrNotLogQuery):
			status = http.StatusBadRequest
		case errors.Is(qerr, logsearch.ErrTimeout):
			status = http.StatusGatewayTimeout
		}
		response.Error(w, status, qerr.Error())
		return
	}
	response.JSON(w, http.StatusOK, res)
}

// logQLAudit is the after payload: the query as written and as sent, the
// range and how much came back, never the lines.
func logQLAudit(req logsearch.QueryRequest, res *logsearch.Result) json.RawMessage {
	cut := func(s string, n int) string {
		if r := []rune(s); len(r) > n {
			return string(r[:n])
		}
		return s
	}
	after := map[string]interface{}{
		"logql": cut(req.Query, 1000), "range_seconds": int64(req.End.Sub(req.Start).Seconds()), "limit": req.Limit,
	}
	if res != nil {
		if res.EffectiveQuery != "" {
			after["effective"] = cut(res.EffectiveQuery, 1200)
		}
		after["lines"] = len(res.Lines)
		after["truncated"] = res.Truncated
		after["bytes"] = res.Bytes
	}
	b, _ := json.Marshal(after)
	return b
}
