package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// SetNetworkFlows turns on network flow reads (chart features.networkFlows).
func (h *Handler) SetNetworkFlows(s *netflows.Store) { h.netflows = s }

// networkFlowsFeature is the /cluster/features entry: the clusters with flow reads, and what serves each
// (hubble or calico).
func (h *Handler) networkFlowsFeature() map[string]interface{} {
	if h.netflows == nil {
		return map[string]interface{}{"enabled": false, "clusters": []string{}, "providers": map[string]string{}}
	}
	providers := map[string]string{}
	for id, t := range h.netflows.Config().Clusters {
		providers[id] = netflows.SourceHubble
		if t.Calico() {
			providers[id] = netflows.SourceCalico
		}
	}
	return map[string]interface{}{"enabled": true, "clusters": h.netflows.Config().ClusterIDs(), "providers": providers}
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
	var err error
	if req.Since, err = parseSince(q.Get("since")); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	payload, _ := auth.FromContext(ctx)
	if scope := payload.Namespaces[string(id)]; len(scope) > 0 {
		req.Scope = scope
	}
	if req.Lookup = h.flowsLookup(); req.Lookup != nil && req.Kind != "" && req.Kind != "Pod" {
		req.Pods = workloadPods(ctx, req.Lookup, namespace, req.Kind, req.Name)
	}
	if t, _ := h.netflows.Target(string(id)); t.Calico() && req.Kind == "Pod" && req.Lookup != nil {
		req.PodSet, _ = req.Lookup.PodSet(ctx, namespace, req.Name) // Calico names the pods of one GenerateName together
	}
	if err := h.netflows.Normalize(&req); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	targetType, targetID := "namespace", namespace
	if req.Kind != "" {
		targetType, targetID = strings.ToLower(req.Kind), req.Name
	}
	if res := h.relayRead(w, r, req, targetType, targetID, namespace); res != nil {
		response.JSON(w, http.StatusOK, res)
	}
}

// flowsLookup fills in a flow read as the signed-in user (netflowsLook in tests; nil without a cluster service).
func (h *Handler) flowsLookup() netflows.Lookup {
	if h.netflowsLook != nil {
		return h.netflowsLook
	}
	if h.svc == nil {
		return nil
	}
	return svcLookup{h.svc}
}

type svcLookup struct{ s *k8s.Service }

func (l svcLookup) Workloads(ctx context.Context, namespace string) (map[string]netflows.Workload, error) {
	return l.s.NetflowsWorkloads(ctx, namespace)
}

func (l svcLookup) ServiceIPs(ctx context.Context, namespace string) (map[string]bool, error) {
	return l.s.NetflowsServiceIPs(ctx, namespace)
}

func (l svcLookup) PodSet(ctx context.Context, namespace, pod string) (string, error) {
	return l.s.NetflowsPodSet(ctx, namespace, pod)
}

// workloadPods are the current pods of a workload, by name, for flows that name no workload; none when the
// namespace cannot be listed.
func workloadPods(ctx context.Context, l netflows.Lookup, namespace, kind, name string) []string {
	pods, _ := l.Workloads(ctx, namespace)
	var out []string
	for pod, w := range pods {
		if w.Kind == kind && w.Name == name {
			out = append(out, pod)
		}
	}
	sort.Strings(out)
	return out
}

// parseSince reads the since parameter of a flow read; empty is the configured default.
func parseSince(v string) (time.Duration, error) {
	if v == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, errors.New("since must be a positive duration such as 15m")
	}
	return d, nil
}

// relayRead reads the flows of a normalized request from the cluster's Relay as the user, after a flow
// read's checks (the cluster's services/proxy answer, the user's budget, the audit store) and with its
// audit row k8s.networkflows.query on the given target. It answers the request itself and returns nil when
// a check or the read fails.
func (h *Handler) relayRead(w http.ResponseWriter, r *http.Request, req netflows.Request, targetType, targetID, namespace string) *netflows.Result {
	ctx := r.Context()
	id, _ := cluster.FromContext(ctx)
	payload, _ := auth.FromContext(ctx)
	target, _ := h.netflows.Target(string(id))
	var res *netflows.Result
	after := func() json.RawMessage { return netflowsAudit(target, req, res) }
	refuse := func(status int, err error) {
		_ = h.recordAuditWithPayload(r, "k8s.networkflows.query", targetType, targetID, namespace, err, nil, after())
		response.Error(w, status, err.Error())
	}
	allowed, err := h.canReadRelay(ctx, target)
	if err != nil {
		h.handleError(w, err)
		return nil
	}
	if !allowed {
		refuse(http.StatusForbidden, fmt.Errorf("forbidden: the cluster does not let you read %s (%s on services/proxy %s in %s)", target.What(), target.ProxyVerb(), target.Relay.ProxyName(), target.Relay.Namespace))
		return nil
	}
	if !h.netflows.Allow(payload.UserID) {
		refuse(http.StatusTooManyRequests, fmt.Errorf("too many network flow reads: %d per minute", h.netflows.Config().PerUserPerMinute))
		return nil
	}
	if rerr := h.auditReady(r); rerr != nil {
		h.refuseUnaudited(w, r, rerr)
		return nil
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
		res, qerr = h.netflows.Read(ctx, target, client, url, req, now)
	}
	if res != nil {
		res.Cluster, res.Mode, res.Relay = string(id), target.Mode, target.Relay.String()
		if target.Mode == "address" {
			res.Relay = target.URL
		}
	}
	if werr := h.recordAuditWithPayload(r, "k8s.networkflows.query", targetType, targetID, namespace, qerr, nil, after()); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return nil
	}
	if qerr != nil {
		response.Error(w, netflowsStatus(qerr), qerr.Error())
		return nil
	}
	return res
}

// canReadRelay asks the cluster whether the user may use the flow source's
// services/proxy (create for the Relay's GetFlows, get for Whisker) — what the
// API server checks in mode proxy, and what Kubeast holds a reader to in mode
// address.
func (h *Handler) canReadRelay(ctx context.Context, t netflows.Target) (bool, error) {
	if h.netflowsCanI != nil {
		return h.netflowsCanI(ctx, t)
	}
	relay := t.Relay
	cs, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		return false, err
	}
	review, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{
			Verb: t.ProxyVerb(), Resource: "services", Subresource: "proxy", Name: relay.ProxyName(), Namespace: relay.Namespace,
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
	provider := netflows.SourceHubble
	if t.Calico() {
		provider = netflows.SourceCalico
	}
	after := map[string]interface{}{
		"mode":          t.Mode,
		"provider":      provider,
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
	if req.Graph {
		after["graph"], after["namespaces"] = true, req.Namespaces()
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
