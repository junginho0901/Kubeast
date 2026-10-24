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
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// SetNetworkFlows turns on network flow reads (chart features.networkFlows).
func (h *Handler) SetNetworkFlows(s *netflows.Store) { h.netflows = s }

// networkFlowsFeature is the /cluster/features entry: the clusters with flow reads.
func (h *Handler) networkFlowsFeature() map[string]interface{} {
	if h.netflows == nil {
		return map[string]interface{}{"enabled": false, "clusters": []string{}}
	}
	return map[string]interface{}{"enabled": true, "clusters": h.netflows.Config().ClusterIDs()}
}

// NetworkFlows handles GET /api/v1/namespaces/{namespace}/networkflows?kind=&name=&since=&verdict=&limit=:
// the recent flows of the namespace, or of one pod or workload in it, from
// the cluster's Hubble Relay. A sensitive read: who talks to whom.
func (h *Handler) NetworkFlows(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, _ := cluster.FromContext(ctx)
	namespace := chi.URLParam(r, "namespace")
	if !h.netflows.Configured(ctx, string(id)) {
		response.Error(w, http.StatusNotFound, "network flows are not configured for this cluster")
		return
	}
	if err := h.requirePermissionForCluster(r, "resource.networkflow.read"); err != nil {
		h.handleError(w, err)
		return
	}
	q := r.URL.Query()
	req := netflows.Request{Namespace: namespace, Kind: q.Get("kind"), Name: q.Get("name"), Limit: queryParamInt(r, "limit", 0)}
	if v := strings.TrimSpace(q.Get("verdict")); v != "" {
		req.Verdicts = strings.Split(v, ",")
	}
	if v := q.Get("since"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			response.Error(w, http.StatusBadRequest, "since must be a positive duration such as 15m")
			return
		}
		req.Since = d
	}
	payload, _ := auth.FromContext(ctx)
	if scope := payload.Namespaces[string(id)]; len(scope) > 0 {
		req.Scope = scope
	}
	if err := h.netflows.Normalize(&req); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	target, _ := h.netflows.Target(string(id))
	targetType, targetID := "namespace", namespace
	if req.Kind != "" {
		targetType, targetID = strings.ToLower(req.Kind), req.Name
	}
	var res *netflows.Result
	after := func() json.RawMessage { return netflowsAudit(target, req, res) }
	refuse := func(status int, err error) {
		_ = h.recordAuditWithPayload(r, "k8s.networkflows.query", targetType, targetID, namespace, err, nil, after())
		response.Error(w, status, err.Error())
	}
	allowed, err := h.canReadRelay(ctx, target.Relay)
	if err != nil {
		h.handleError(w, err)
		return
	}
	if !allowed {
		refuse(http.StatusForbidden, fmt.Errorf("forbidden: the cluster does not let you read the Hubble Relay (create on services/proxy %s in %s)", target.Relay.ProxyName(), target.Relay.Namespace))
		return
	}
	if !h.netflows.Allow(payload.UserID) {
		refuse(http.StatusTooManyRequests, fmt.Errorf("too many network flow reads: %d per minute", h.netflows.Config().PerUserPerMinute))
		return
	}
	if rerr := h.auditReady(r); rerr != nil {
		h.refuseUnaudited(w, r, rerr)
		return
	}
	url, client, err := h.relayClient(ctx, target)
	var qerr error
	if err != nil {
		qerr = err
	} else {
		now := time.Now()
		if h.netflowsNow != nil {
			now = h.netflowsNow()
		}
		res, qerr = h.netflows.Query(ctx, client, url, req, now)
	}
	if res != nil {
		res.Cluster, res.Mode, res.Relay = string(id), target.Mode, target.Relay.String()
		if target.Mode == "address" {
			res.Relay = target.URL
		}
	}
	if werr := h.recordAuditWithPayload(r, "k8s.networkflows.query", targetType, targetID, namespace, qerr, nil, after()); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	if qerr != nil {
		response.Error(w, netflowsStatus(qerr), qerr.Error())
		return
	}
	response.JSON(w, http.StatusOK, res)
}

// canReadRelay asks the cluster whether the user may use the Relay's
// services/proxy — what the API server checks in mode proxy, and what
// Kubeast holds a reader to in mode address.
func (h *Handler) canReadRelay(ctx context.Context, relay netflows.Relay) (bool, error) {
	if h.netflowsCanI != nil {
		return h.netflowsCanI(ctx, relay)
	}
	cs, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		return false, err
	}
	review, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{
			Verb: "create", Resource: "services", Subresource: "proxy", Name: relay.ProxyName(), Namespace: relay.Namespace,
		}},
	}, metav1.CreateOptions{})
	if err != nil {
		return false, err
	}
	return review.Status.Allowed, nil
}

// relayClient is where and how GetFlows goes: the API server as the user
// (its transport records the request for the call's trail), or the address.
func (h *Handler) relayClient(ctx context.Context, t netflows.Target) (string, *http.Client, error) {
	if h.netflowsDial != nil {
		return h.netflowsDial(ctx, t)
	}
	if t.Mode == "address" {
		return t.Endpoint(""), h.netflows.AddressClient(), nil
	}
	cfg, err := h.svc.UserRESTConfigFor(ctx)
	if err != nil {
		return "", nil, err
	}
	client, err := rest.HTTPClientFor(cfg)
	if err != nil {
		return "", nil, err
	}
	return t.Endpoint(cfg.Host), client, nil
}

func netflowsStatus(err error) int {
	switch {
	case errors.Is(err, netflows.ErrInvalidRequest):
		return http.StatusBadRequest
	case errors.Is(err, netflows.ErrForbidden):
		return http.StatusForbidden
	case errors.Is(err, netflows.ErrTimeout):
		return http.StatusGatewayTimeout
	}
	return http.StatusBadGateway
}

// netflowsAudit is the after payload: what was asked and how much came back, never the flows.
func netflowsAudit(t netflows.Target, req netflows.Request, res *netflows.Result) json.RawMessage {
	after := map[string]interface{}{
		"mode":          t.Mode,
		"relay":         t.Relay.String(),
		"since_seconds": int64(req.Since.Seconds()),
		"limit":         req.Limit,
	}
	if t.Mode == "address" {
		after["relay"] = t.URL
	}
	if req.Kind != "" {
		after["kind"], after["name"] = req.Kind, req.Name
	}
	if len(req.Verdicts) > 0 {
		after["verdicts"] = req.Verdicts
	}
	if res != nil {
		after["flows"], after["groups"], after["truncated"] = len(res.Flows), len(res.Groups), res.Truncated
		if res.Lost > 0 {
			after["lost_events"] = res.Lost
		}
		if res.Redacted {
			after["redacted"] = true
		}
	}
	b, _ := json.Marshal(after)
	return b
}
