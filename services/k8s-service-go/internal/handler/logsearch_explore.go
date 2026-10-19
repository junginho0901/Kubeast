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

// LogLabelsNamespace handles GET /api/v1/namespaces/{namespace}/logsearch/labels.
func (h *Handler) LogLabelsNamespace(w http.ResponseWriter, r *http.Request) {
	h.serveLogLabels(w, r, chi.URLParam(r, "namespace"))
}

// LogLabelsAll handles GET /api/v1/logsearch/labels.
func (h *Handler) LogLabelsAll(w http.ResponseWriter, r *http.Request) {
	h.serveLogLabels(w, r, "")
}

// LogPatternsNamespace handles GET /api/v1/namespaces/{namespace}/logsearch/patterns.
func (h *Handler) LogPatternsNamespace(w http.ResponseWriter, r *http.Request) {
	h.serveLogPatterns(w, r, chi.URLParam(r, "namespace"))
}

// LogPatternsAll handles GET /api/v1/logsearch/patterns.
func (h *Handler) LogPatternsAll(w http.ResponseWriter, r *http.Request) {
	h.serveLogPatterns(w, r, "")
}

// LogQLSearchNamespace handles GET /api/v1/namespaces/{namespace}/logsearch/logql.
func (h *Handler) LogQLSearchNamespace(w http.ResponseWriter, r *http.Request) {
	h.serveLogQLSearch(w, r, chi.URLParam(r, "namespace"))
}

// LogQLSearchAll handles GET /api/v1/logsearch/logql.
func (h *Handler) LogQLSearchAll(w http.ResponseWriter, r *http.Request) {
	h.serveLogQLSearch(w, r, "")
}

// openLogDoor is the structured search's door for the other log store reads
// (the AI's loki_* tools): log search on for the cluster, resource.pod.read, a
// namespace for a namespace-scoped grant, the request read (prepare, 400),
// get pods/log as the user and the per-user rate. Refusals past the request
// read are audited as action ("" = a read that is not audited).
func (h *Handler) openLogDoor(w http.ResponseWriter, r *http.Request, namespace, action string, prepare func() error, after func() json.RawMessage) bool {
	id, _ := cluster.FromContext(r.Context())
	if !h.logSearch.Configured(r.Context(), string(id)) {
		response.Error(w, http.StatusNotFound, "log search is not configured for this cluster")
		return false
	}
	if err := h.requirePermissionForCluster(r, "resource.pod.read"); err != nil {
		h.handleError(w, err)
		return false
	}
	payload, _ := auth.FromContext(r.Context())
	if namespace == "" && len(payload.Namespaces[string(id)]) > 0 {
		response.Error(w, http.StatusForbidden, "your grant on this cluster is limited to namespaces: ask one of them ("+strings.Join(payload.Namespaces[string(id)], ", ")+")")
		return false
	}
	if err := prepare(); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return false
	}
	refuse := func(status int, err error) bool {
		if action != "" {
			_ = h.recordAuditWithPayload(r, action, "namespace", namespace, namespace, err, nil, after())
		}
		response.Error(w, status, err.Error())
		return false
	}
	allowed, err := h.canReadPodLogs(r.Context(), namespace)
	if err != nil {
		h.handleError(w, err)
		return false
	}
	if !allowed {
		return refuse(http.StatusForbidden, fmt.Errorf("forbidden: the cluster does not let you read pod logs in %s", namespaceOrAll(namespace)))
	}
	if !h.logSearch.Allow(payload.UserID) {
		return refuse(http.StatusTooManyRequests, fmt.Errorf("too many log searches: %d per minute", h.logSearch.Config().PerUserPerMinute))
	}
	if action != "" {
		if rerr := h.auditReady(r); rerr != nil {
			h.refuseUnaudited(w, r, rerr)
			return false
		}
	}
	return true
}

// logReadWindow reads start/end/since (as a structured search does) and checks them.
func (h *Handler) logReadWindow(r *http.Request, clusterID, namespace string) (logsearch.Request, error) {
	req, err := logSearchRequest(r, clusterID, namespace)
	if err == nil {
		err = h.logSearch.Config().NormalizeRange(&req.Start, &req.End, &req.Limit, time.Now())
	}
	return req, err
}

// logReadStatus is the status for a failed store read.
func logReadStatus(err error) int {
	var se *logsearch.StoreError
	switch {
	case errors.Is(err, logsearch.ErrInvalidLogQL), errors.Is(err, logsearch.ErrNotLogQuery):
		return http.StatusBadRequest
	case errors.As(err, &se) && se.Status == http.StatusBadRequest:
		return http.StatusBadRequest // the store could not parse the query: the caller's to fix
	case errors.Is(err, logsearch.ErrNotServed):
		return http.StatusNotFound
	case errors.Is(err, logsearch.ErrTimeout):
		return http.StatusGatewayTimeout
	}
	return http.StatusBadGateway
}

// serveLogLabels lists the label names, or one label's values (?label=), on
// the streams of the cluster (and namespace) only. Label names and values are
// not log lines, so the read is not audited.
func (h *Handler) serveLogLabels(w http.ResponseWriter, r *http.Request, namespace string) {
	id, _ := cluster.FromContext(r.Context())
	var window logsearch.Request
	prepare := func() (err error) {
		if window, err = h.logReadWindow(r, string(id), namespace); err == nil {
			err = logsearch.CheckLabelName(r.URL.Query().Get("label"))
		}
		return err
	}
	if !h.openLogDoor(w, r, namespace, "", prepare, nil) {
		return
	}
	res, err := h.logSearch.Labels(r.Context(), logsearch.LabelsRequest{
		Cluster: string(id), Namespace: namespace, Label: r.URL.Query().Get("label"), Start: window.Start, End: window.End,
	})
	if err != nil {
		if errors.Is(err, logsearch.ErrNotServed) {
			err = fmt.Errorf("label lists %w", err)
		}
		response.Error(w, logReadStatus(err), err.Error())
		return
	}
	response.JSON(w, http.StatusOK, res)
}

// serveLogPatterns returns the log patterns (Loki's pattern ingester) of the
// streams ?q= selects, with the cluster and namespace matchers added.
func (h *Handler) serveLogPatterns(w http.ResponseWriter, r *http.Request, namespace string) {
	id, _ := cluster.FromContext(r.Context())
	req := logsearch.QueryRequest{Cluster: string(id), Namespace: namespace, Query: r.URL.Query().Get("q")}
	var res *logsearch.PatternsResult
	after := func() json.RawMessage { return logReadAudit("patterns", req, res, nil) }
	prepare := func() error {
		window, err := h.logReadWindow(r, string(id), namespace)
		if err == nil && strings.TrimSpace(req.Query) == "" {
			err = fmt.Errorf("q (a stream selector) is required")
		}
		req.Start, req.End = window.Start, window.End
		return err
	}
	if !h.openLogDoor(w, r, namespace, "k8s.pod.logs.logql", prepare, after) {
		return
	}
	out, perr := h.logSearch.Patterns(r.Context(), req)
	if perr == nil {
		res = &out
	} else if errors.Is(perr, logsearch.ErrNotServed) {
		perr = fmt.Errorf("log patterns %w (Loki needs pattern_ingester.enabled)", perr)
	}
	if werr := h.recordAuditWithPayload(r, "k8s.pod.logs.logql", "namespace", namespace, namespace, perr, nil, after()); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	if perr != nil {
		response.Error(w, logReadStatus(perr), perr.Error())
		return
	}
	response.JSON(w, http.StatusOK, out)
}

// serveLogQLSearch runs LogQL through the structured search's door: a log
// query answers lines, a metric query series (?step= seconds). The cluster
// and namespace matchers go into every selector, as for an admin's query
// (/logsearch/query, admin.logsearch.query), so it reads no more than a
// structured search would.
func (h *Handler) serveLogQLSearch(w http.ResponseWriter, r *http.Request, namespace string) {
	id, _ := cluster.FromContext(r.Context())
	req := logsearch.QueryRequest{Cluster: string(id), Namespace: namespace, Query: r.URL.Query().Get("q"), Metric: true}
	var res *logsearch.Result
	after := func() json.RawMessage { return logReadAudit("", req, nil, res) }
	prepare := func() error {
		window, err := h.logReadWindow(r, string(id), namespace)
		if err == nil && strings.TrimSpace(req.Query) == "" {
			err = fmt.Errorf("q (LogQL) is required")
		}
		if step := queryParamInt(r, "step", 0); err == nil && step > 0 {
			req.Step = time.Duration(step) * time.Second
			if req.Step > window.End.Sub(window.Start) {
				err = fmt.Errorf("step is longer than the range")
			}
		}
		req.Start, req.End, req.Limit, req.Forward = window.Start, window.End, window.Limit, window.Forward
		return err
	}
	if !h.openLogDoor(w, r, namespace, "k8s.pod.logs.logql", prepare, after) {
		return
	}
	out, qerr := h.logSearch.Query(r.Context(), req)
	if qerr == nil {
		res = &out
	}
	if werr := h.recordAuditWithPayload(r, "k8s.pod.logs.logql", "namespace", namespace, namespace, qerr, nil, after()); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	if qerr != nil {
		response.Error(w, logReadStatus(qerr), qerr.Error())
		return
	}
	response.JSON(w, http.StatusOK, out)
}

// logReadAudit is the after payload of a LogQL or patterns read: the query as
// written and as sent, the range, the kind of answer and how much came back,
// never the lines or patterns.
func logReadAudit(kind string, req logsearch.QueryRequest, patterns *logsearch.PatternsResult, res *logsearch.Result) json.RawMessage {
	var after map[string]interface{}
	_ = json.Unmarshal(logQLAudit(req, res), &after)
	switch {
	case patterns != nil:
		after["effective"] = patterns.EffectiveQuery
		after["patterns"] = len(patterns.Patterns)
	case res != nil && res.ResultType == "matrix":
		kind = "metric"
		after["series"] = len(res.Series)
		delete(after, "lines")
	case res != nil:
		kind = "log"
	}
	if kind != "" {
		after["kind"] = kind
	}
	b, _ := json.Marshal(after)
	return b
}
