package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nfm"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// SetNetworkFlowMonitor turns on Network Flow Monitor reads (chart features.networkFlowMonitor).
func (h *Handler) SetNetworkFlowMonitor(s *nfm.Store) { h.nfm = s }

// networkFlowMonitorFeature is the /cluster/features entry: the clusters with a monitor.
func (h *Handler) networkFlowMonitorFeature() map[string]interface{} {
	if h.nfm == nil {
		return map[string]interface{}{"enabled": false, "clusters": []string{}}
	}
	return map[string]interface{}{"enabled": true, "clusters": h.nfm.Config().ClusterIDs()}
}

// NetworkTopFlows handles GET /api/v1/namespaces/{namespace}/networktopflows?kind=&name=&metric=&view=&range=:
// the top contributors of the cluster's Network Flow Monitor monitor with the namespace, or one pod or
// workload in it, at either end. Kubeast reads AWS with its own identity, so the user must be able to list
// the namespace's pods, and peers in namespaces whose pods the user cannot list show no names.
func (h *Handler) NetworkTopFlows(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, _ := cluster.FromContext(ctx)
	namespace := chi.URLParam(r, "namespace")
	if h.nfm == nil {
		response.Error(w, http.StatusNotFound, "network flow monitor is not configured for this cluster")
		return
	}
	monitor, ok := h.nfm.Monitor(string(id))
	if !ok {
		response.Error(w, http.StatusNotFound, "network flow monitor is not configured for this cluster")
		return
	}
	if err := h.requirePermissionForCluster(r, "resource.networkflow.read"); err != nil {
		h.handleError(w, err)
		return
	}
	q := r.URL.Query()
	req := nfm.Request{Namespace: namespace, Kind: q.Get("kind"), Name: q.Get("name"), Metric: strings.ToUpper(q.Get("metric")), View: q.Get("view")}
	var err error
	if req.Range, err = parseSince(q.Get("range")); err != nil {
		response.Error(w, http.StatusBadRequest, strings.Replace(err.Error(), "since", "range", 1))
		return
	}
	payload, _ := auth.FromContext(ctx)
	if scope := payload.Namespaces[string(id)]; len(scope) > 0 {
		req.Scope = scope
	}
	req.Lookup = h.flowsLookup()
	if err := h.nfm.Normalize(&req); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	targetType, targetID := "namespace", namespace
	if req.Kind != "" {
		targetType, targetID = strings.ToLower(req.Kind), req.Name
	}
	var res *nfm.Result
	after := func() json.RawMessage { return nfmAudit(monitor, req, res) }
	refuse := func(status int, err error) {
		_ = h.recordAuditWithPayload(r, "k8s.networkflows.query", targetType, targetID, namespace, err, nil, after())
		response.Error(w, status, err.Error())
	}
	allowed, err := h.canListPods(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	if !allowed {
		refuse(http.StatusForbidden, fmt.Errorf("forbidden: the cluster does not let you list pods in %s (Network Flow Monitor rows name pods)", namespace))
		return
	}
	if !h.nfm.Allow(payload.UserID) {
		refuse(http.StatusTooManyRequests, fmt.Errorf("too many network flow monitor reads: %d per minute", h.nfm.Config().PerUserPerMinute))
		return
	}
	if rerr := h.auditReady(r); rerr != nil {
		h.refuseUnaudited(w, r, rerr)
		return
	}
	res, qerr := h.nfm.Read(ctx, string(id), req)
	if werr := h.recordAuditWithPayload(r, "k8s.networkflows.query", targetType, targetID, namespace, qerr, nil, after()); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	if qerr != nil {
		response.Error(w, nfmStatus(qerr), qerr.Error())
		return
	}
	response.JSON(w, http.StatusOK, res)
}

// canListPods asks the cluster, as the signed-in user, for list pods in the namespace.
func (h *Handler) canListPods(ctx context.Context, namespace string) (bool, error) {
	if h.nfmCanI != nil {
		return h.nfmCanI(ctx, namespace)
	}
	cs, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		return false, err
	}
	review, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{
			Verb: "list", Resource: "pods", Namespace: namespace,
		}},
	}, metav1.CreateOptions{})
	if err != nil {
		return false, err
	}
	return review.Status.Allowed, nil
}

// nfmStatus: AWS refusing Kubeast's own identity or not knowing the monitor is the install's configuration,
// not the user's request, so it is a bad gateway like an unreachable service.
func nfmStatus(err error) int {
	switch {
	case errors.Is(err, nfm.ErrInvalidRequest):
		return http.StatusBadRequest
	case errors.Is(err, nfm.ErrTimeout):
		return http.StatusGatewayTimeout
	case errors.Is(err, nfm.ErrBusy):
		return http.StatusServiceUnavailable
	}
	return http.StatusBadGateway
}

// nfmAudit is the after payload: what was asked and how much came back, never the rows.
func nfmAudit(monitor string, req nfm.Request, res *nfm.Result) json.RawMessage {
	after := map[string]interface{}{
		"provider":      "nfm",
		"monitor":       monitor,
		"metric":        req.Metric,
		"view":          req.View,
		"range_seconds": int64(req.Range.Seconds()),
	}
	if req.Kind != "" {
		after["kind"], after["name"] = req.Kind, req.Name
	}
	if res != nil {
		after["rows"], after["truncated"] = len(res.Rows), res.Truncated
		if res.Redacted {
			after["redacted"] = true
		}
	}
	b, _ := json.Marshal(after)
	return b
}
