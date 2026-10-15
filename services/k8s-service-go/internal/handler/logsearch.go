package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// SetLogSearch turns on log search (chart features.logSearch).
func (h *Handler) SetLogSearch(s *logsearch.Searcher) { h.logSearch = s }

// LogSearchNamespace handles GET /api/v1/namespaces/{namespace}/logsearch.
func (h *Handler) LogSearchNamespace(w http.ResponseWriter, r *http.Request) {
	h.serveLogSearch(w, r, chi.URLParam(r, "namespace"))
}

// LogSearchAll handles GET /api/v1/logsearch (/api/v1/cluster/logsearch at the
// gateway) — every namespace, for a grant not limited to namespaces.
func (h *Handler) LogSearchAll(w http.ResponseWriter, r *http.Request) {
	h.serveLogSearch(w, r, "")
}

// serveLogSearch searches the log store for the request's cluster. The store
// is not Kubernetes, so the cluster is asked as the user whether they may read
// pod logs there (get pods/log) before anything is read.
func (h *Handler) serveLogSearch(w http.ResponseWriter, r *http.Request, namespace string) {
	id, _ := cluster.FromContext(r.Context())
	if !h.logSearch.Configured(r.Context(), string(id)) {
		response.Error(w, http.StatusNotFound, "log search is not configured for this cluster")
		return
	}
	if err := h.requirePermissionForCluster(r, "resource.pod.read"); err != nil {
		h.handleError(w, err)
		return
	}
	payload, _ := auth.FromContext(r.Context())
	if namespace == "" && len(payload.Namespaces[string(id)]) > 0 {
		response.Error(w, http.StatusForbidden, "your grant on this cluster is limited to namespaces: search one of them ("+strings.Join(payload.Namespaces[string(id)], ", ")+")")
		return
	}

	req, err := logSearchRequest(r, string(id), namespace)
	if err == nil {
		err = h.logSearch.Config().Normalize(&req, time.Now())
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
		_ = h.recordAuditWithPayload(r, "k8s.pod.logs.search", "namespace", namespace, namespace, denied, nil, logSearchAudit(req, nil))
		response.Error(w, http.StatusForbidden, denied.Error())
		return
	}
	if !h.logSearch.Allow(payload.UserID) {
		limited := fmt.Errorf("too many log searches: %d per minute", h.logSearch.Config().PerUserPerMinute)
		_ = h.recordAuditWithPayload(r, "k8s.pod.logs.search", "namespace", namespace, namespace, limited, nil, logSearchAudit(req, nil))
		response.Error(w, http.StatusTooManyRequests, limited.Error())
		return
	}
	// A sensitive read: not served while the audit store cannot record it.
	if rerr := h.auditReady(r); rerr != nil {
		h.refuseUnaudited(w, r, rerr)
		return
	}

	res, serr := h.logSearch.Search(r.Context(), req)
	if werr := h.recordAuditWithPayload(r, "k8s.pod.logs.search", "namespace", namespace, namespace, serr, nil, logSearchAudit(req, &res)); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	if serr != nil {
		status := http.StatusBadGateway
		if errors.Is(serr, logsearch.ErrTimeout) {
			status = http.StatusGatewayTimeout
		}
		response.Error(w, status, serr.Error())
		return
	}
	response.JSON(w, http.StatusOK, res)
}

// canReadPodLogs asks the cluster, as the signed-in user, for get pods/log in
// namespace ("" = every namespace).
func (h *Handler) canReadPodLogs(ctx context.Context, namespace string) (bool, error) {
	if h.logSearchCanI != nil {
		return h.logSearchCanI(ctx, namespace)
	}
	cs, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		return false, err
	}
	review, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{
			Verb: "get", Resource: "pods", Subresource: "log", Namespace: namespace,
		}},
	}, metav1.CreateOptions{})
	if err != nil {
		return false, err
	}
	return review.Status.Allowed, nil
}

// logSearchRequest reads the query string; ranges are RFC 3339 or a "since" duration.
func logSearchRequest(r *http.Request, clusterID, namespace string) (logsearch.Request, error) {
	q := r.URL.Query()
	req := logsearch.Request{
		Cluster:      clusterID,
		Namespace:    namespace,
		Pod:          q.Get("pod"),
		Container:    q.Get("container"),
		WorkloadKind: q.Get("workload_kind"),
		WorkloadName: q.Get("workload_name"),
		Text:         q.Get("q"),
		IgnoreCase:   queryParamBool(r, "ignore_case", false),
		Limit:        queryParamInt(r, "limit", 0),
		Forward:      q.Get("direction") == "forward",
	}
	switch q.Get("match") {
	case "", "contains":
	case "regex":
		req.Regex = true
	default:
		return req, fmt.Errorf("match must be contains or regex")
	}
	if d := q.Get("direction"); d != "" && d != "forward" && d != "backward" {
		return req, fmt.Errorf("direction must be forward or backward")
	}
	for key, dst := range map[string]*time.Time{"start": &req.Start, "end": &req.End} {
		if v := q.Get(key); v != "" {
			t, err := time.Parse(time.RFC3339Nano, v)
			if err != nil {
				return req, fmt.Errorf("%s must be RFC 3339", key)
			}
			*dst = t
		}
	}
	if v := q.Get("since"); v != "" {
		if q.Get("start") != "" {
			return req, fmt.Errorf("since and start are exclusive")
		}
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return req, fmt.Errorf("since must be a positive duration")
		}
		end := req.End
		if end.IsZero() {
			end = time.Now()
		}
		req.Start = end.Add(-d)
	}
	return req, nil
}

// logSearchAudit is the after payload: the filters and how much came back, never the lines.
func logSearchAudit(req logsearch.Request, res *logsearch.Result) json.RawMessage {
	text := req.Text
	if r := []rune(text); len(r) > 200 {
		text = string(r[:200])
	}
	match := "contains"
	if req.Regex {
		match = "regex"
	}
	workload := ""
	if req.WorkloadKind != "" {
		workload = req.WorkloadKind + "/" + req.WorkloadName
	}
	after := map[string]interface{}{
		"q": text, "match": match, "ignore_case": req.IgnoreCase,
		"pod": req.Pod, "container": req.Container, "workload": workload,
		"range_seconds": int64(req.End.Sub(req.Start).Seconds()), "limit": req.Limit,
	}
	if res != nil {
		after["lines"] = len(res.Lines)
		after["truncated"] = res.Truncated
		after["bytes"] = res.Bytes
	}
	b, _ := json.Marshal(after)
	return b
}

func namespaceOrAll(ns string) string {
	if ns == "" {
		return "every namespace"
	}
	return "namespace " + ns
}

// logSearchFeature is features.logSearch for GET /api/v1/cluster/features.
// LogSearchStatus handles GET /api/v1/logsearch/status: where the request's
// cluster reads its logs from (its own store or the deployment-wide one) and
// whether that store answers.
func (h *Handler) LogSearchStatus(w http.ResponseWriter, r *http.Request) {
	if h.logSearch == nil {
		response.JSON(w, http.StatusOK, map[string]interface{}{"available": false, "source": "none", "message": "log search is off (features.logSearch.enabled=false)"})
		return
	}
	id, _ := cluster.FromContext(r.Context())
	response.JSON(w, http.StatusOK, h.logSearch.Status(r.Context(), string(id)))
}

func (h *Handler) logSearchFeature(ctx context.Context) map[string]interface{} {
	if h.logSearch == nil {
		return map[string]interface{}{"enabled": false, "clusters": []string{}}
	}
	c := h.logSearch.Config()
	return map[string]interface{}{
		"enabled":             true,
		"clusters":            h.logSearch.ClusterIDs(ctx),
		"logql":               c.LogQLEnabled,
		"defaultRangeMinutes": int(c.DefaultRange.Minutes()),
		"maxRangeMinutes":     int(c.MaxRange.Minutes()),
		"maxLines":            c.MaxLines,
	}
}
