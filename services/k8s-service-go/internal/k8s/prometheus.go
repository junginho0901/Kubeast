package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// ========== Prometheus Client ==========
//
// Discovers Prometheus in the TARGET cluster (the one pointed to by kubeconfig)
// and queries it via the K8s API server service proxy. This works regardless of
// whether this service runs inside or outside the target cluster.
//
// Path format: /api/v1/namespaces/{ns}/services/{svc}:{port}/proxy/...
//
// If Prometheus is not found, all queries gracefully return empty results.

// PrometheusQueryResult represents a single result from a Prometheus instant query.
type PrometheusQueryResult struct {
	Metric map[string]interface{} // label set
	Value  float64                // scalar value
}

// prometheusResponse represents the JSON response from Prometheus query API.
type prometheusResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string                   `json:"resultType"`
		Result     []map[string]interface{} `json:"result"`
	} `json:"data"`
}

// promServiceInfo holds the discovered Prometheus service location.
type promServiceInfo struct {
	Namespace string
	Name      string
	Port      int32
}

// promCache holds Prometheus discovery state for a single cluster. One lives on
// each clientBundle, so one cluster's discovered Prometheus location can never
// leak into another (a real bug when the picker switches to a cluster without
// Prometheus: the stale location 500s against the new cluster's API proxy).
type promCache struct {
	mu       sync.RWMutex
	svc      *promServiceInfo
	probed   bool
	probedAt time.Time
}

// A cluster's promCache lives on its clientBundle, so a kubeconfig rotation that
// rebuilds the bundle (see Service.Invalidate) drops the cache automatically —
// the next query re-discovers Prometheus in the fresh cluster.

const promCacheTTL = 10 * time.Minute

// PrometheusFeatureEnabled reports whether the operator has explicitly
// enabled Prometheus integration via the PROMETHEUS_ENABLED env var
// (wired through the helm ConfigMap). When unset the integration is
// considered enabled so local-dev (no helm) keeps auto-discovery.
func PrometheusFeatureEnabled() bool {
	raw := strings.TrimSpace(os.Getenv("PROMETHEUS_ENABLED"))
	if raw == "" {
		return true
	}
	b, err := strconv.ParseBool(raw)
	if err != nil {
		return true
	}
	return b
}

// PrometheusAvailable returns true if a Prometheus service was discovered
// AND the integration has been enabled by the operator. When disabled all
// query methods short-circuit so the UI never sees Prometheus data.
func (s *Service) PrometheusAvailable(ctx context.Context) bool {
	if !PrometheusFeatureEnabled() {
		return false
	}
	return s.getPromSource(ctx) != nil
}

// PrometheusStatus says where this cluster's metrics come from and whether
// that source answers: external (URL, auth set, cluster label) or proxy
// (Service found in the cluster), or none.
func (s *Service) PrometheusStatus(ctx context.Context) map[string]interface{} {
	if !PrometheusFeatureEnabled() {
		return map[string]interface{}{
			"available": false,
			"source":    "none",
			"message":   "Prometheus integration disabled (features.prometheus.enabled=false)",
		}
	}
	src := s.getPromSource(ctx)
	if src == nil {
		msg := "Prometheus not found in target cluster"
		if !PrometheusDiscoverEnabled() {
			msg = "No Prometheus URL registered for this cluster (features.prometheus.discover=false)"
		}
		return map[string]interface{}{"available": false, "source": "none", "message": msg}
	}
	if src.ext != nil {
		ok, msg := src.ext.healthy(ctx)
		out := map[string]interface{}{
			"available":     ok,
			"source":        "external",
			"endpoint":      src.ext.baseURL,
			"auth":          src.ext.authHeader != "",
			"cluster_label": src.ext.labelValue,
			"label_name":    PrometheusClusterLabelName(),
		}
		if !ok {
			out["message"] = msg
		}
		return out
	}
	out := map[string]interface{}{
		"available":  true,
		"source":     "proxy",
		"endpoint":   fmt.Sprintf("%s/%s:%d (via K8s API proxy)", src.proxy.Namespace, src.proxy.Name, src.proxy.Port),
		"configured": src.configured,
	}
	// A discovered Service was verified when found; a named one is checked here,
	// so a typo shows up instead of empty charts.
	if src.configured {
		if ok, msg := checkConfiguredService(ctx, s.discoveryClient(ctx), src.proxy); !ok {
			out["available"] = false
			out["message"] = msg
		}
	}
	return out
}

// checkConfiguredService tells whether a Service named in the settings exists
// with that port and answers /-/healthy. Existence comes first: the proxy check
// alone counts a refusal (403) as "there", which only holds for a Service the
// discovery listed.
func checkConfiguredService(ctx context.Context, cs kubernetes.Interface, info *promServiceInfo) (bool, string) {
	ref := fmt.Sprintf("%s/%s:%d", info.Namespace, info.Name, info.Port)
	if cs == nil {
		return false, "no client for this cluster"
	}
	svc, err := cs.CoreV1().Services(info.Namespace).Get(ctx, info.Name, metav1.GetOptions{})
	if err != nil {
		return false, fmt.Sprintf("Prometheus Service %s: %v", ref, err)
	}
	hasPort := false
	for _, p := range svc.Spec.Ports {
		hasPort = hasPort || p.Port == info.Port
	}
	if !hasPort {
		return false, fmt.Sprintf("Prometheus Service %s/%s has no port %d", info.Namespace, info.Name, info.Port)
	}
	if !verifyPrometheusProxy(ctx, cs, info) {
		return false, fmt.Sprintf("Prometheus Service %s does not answer through the API server proxy", ref)
	}
	return true, ""
}

// PrometheusQuery runs an instant query and returns parsed results.
// Returns (nil, nil) if Prometheus is unavailable.
func (s *Service) PrometheusQuery(ctx context.Context, query string) ([]PrometheusQueryResult, error) {
	if !PrometheusFeatureEnabled() {
		return nil, nil
	}
	src := s.getPromSource(ctx)
	if src == nil {
		return nil, nil
	}
	query, err := src.scoped(query)
	if err != nil {
		return nil, err
	}
	raw, err := s.promFetch(ctx, src, "/api/v1/query?query="+url.QueryEscape(query))
	if err != nil {
		return nil, err
	}

	results := make([]PrometheusQueryResult, 0, len(raw))
	for _, r := range raw {
		metric, _ := r["metric"].(map[string]interface{})
		value := extractPrometheusValue(r)
		results = append(results, PrometheusQueryResult{
			Metric: metric,
			Value:  value,
		})
	}
	return results, nil
}

// PrometheusQueryRaw runs an instant query and returns raw Prometheus result maps.
func (s *Service) PrometheusQueryRaw(ctx context.Context, query string) ([]map[string]interface{}, error) {
	if !PrometheusFeatureEnabled() {
		return nil, nil
	}
	src := s.getPromSource(ctx)
	if src == nil {
		return nil, nil
	}
	query, err := src.scoped(query)
	if err != nil {
		return nil, err
	}
	return s.promFetch(ctx, src, "/api/v1/query?query="+url.QueryEscape(query))
}

// PrometheusRangeSeries is one labelled time series returned by a range query.
// Points are ordered chronologically; each pair is (unix_seconds, value).
type PrometheusRangeSeries struct {
	Metric map[string]interface{} `json:"metric"`
	Points []PrometheusRangePoint `json:"points"`
}

// PrometheusRangePoint is a single (timestamp, value) sample.
type PrometheusRangePoint struct {
	T float64 `json:"t"` // unix seconds (Prometheus native)
	V float64 `json:"v"`
}

// PrometheusQueryRange runs a Prometheus /api/v1/query_range request and
// returns one PrometheusRangeSeries per label set. Returns (nil, nil) if
// the feature is disabled or Prometheus was not discovered.
//
// step is the resolution in seconds (e.g. 300 = one sample every 5 minutes).
func (s *Service) PrometheusQueryRange(ctx context.Context, query string, start, end time.Time, stepSeconds int) ([]PrometheusRangeSeries, error) {
	if !PrometheusFeatureEnabled() {
		return nil, nil
	}
	src := s.getPromSource(ctx)
	if src == nil {
		return nil, nil
	}
	query, err := src.scoped(query)
	if err != nil {
		return nil, err
	}
	if stepSeconds <= 0 {
		stepSeconds = 60
	}
	params := url.Values{}
	params.Set("query", query)
	params.Set("start", strconv.FormatInt(start.Unix(), 10))
	params.Set("end", strconv.FormatInt(end.Unix(), 10))
	params.Set("step", strconv.Itoa(stepSeconds))
	raw, err := s.promFetch(ctx, src, "/api/v1/query_range?"+params.Encode())
	if err != nil {
		return nil, err
	}
	results := make([]PrometheusRangeSeries, 0, len(raw))
	for _, r := range raw {
		metric, _ := r["metric"].(map[string]interface{})
		values, _ := r["values"].([]interface{})
		points := make([]PrometheusRangePoint, 0, len(values))
		for _, pt := range values {
			pair, ok := pt.([]interface{})
			if !ok || len(pair) < 2 {
				continue
			}
			t, _ := pair[0].(float64)
			strVal, _ := pair[1].(string)
			var v float64
			fmt.Sscanf(strVal, "%f", &v)
			points = append(points, PrometheusRangePoint{T: t, V: v})
		}
		results = append(results, PrometheusRangeSeries{Metric: metric, Points: points})
	}
	return results, nil
}

// ========== Internal ==========

// getPromService returns the cached Prometheus service info or triggers
// discovery. The cache is per-cluster (on the ctx's clientBundle), so a
// Prometheus discovered in one cluster is never reused against another.
func (s *Service) getPromService(ctx context.Context) *promServiceInfo {
	b := s.bundleForCtx(ctx)
	if b == nil || b.prom == nil {
		return nil
	}
	c := b.prom
	c.mu.RLock()
	if c.probed && time.Since(c.probedAt) < promCacheTTL {
		cached := c.svc
		c.mu.RUnlock()
		return cached
	}
	c.mu.RUnlock()

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.probed && time.Since(c.probedAt) < promCacheTTL {
		return c.svc
	}

	c.probed = true
	c.probedAt = time.Now()
	c.svc = s.discoverPrometheus(ctx)
	return c.svc
}

// discoverPrometheus scans the TARGET cluster for a Prometheus service. The
// candidate namespaces are probed concurrently so a cluster WITHOUT Prometheus
// costs one round-trip, not the sum of all of them (this runs at most once per
// cluster per promCacheTTL, but a remote cluster makes even one slow). Hits are
// written by index so the namespace preference order is still honoured.
// It runs as the discovery identity (client.go discoveryClient), not the
// caller: the result is remembered for the whole cluster, so a caller who may
// not list a namespace or proxy to the Service must not turn it into "not
// found" for everyone. The queries themselves still go out as the caller.
func (s *Service) discoverPrometheus(ctx context.Context) *promServiceInfo {
	cs := s.discoveryClient(ctx)
	if cs == nil {
		return nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	// Labels first, in every namespace (Headlamp's order): a Service marked for
	// Kubeast, the prometheus chart's server, the Operator's prometheus-operated.
	if info := probePrometheusLabels(probeCtx, cs); info != nil {
		slog.Info("Prometheus discovered by label via K8s API proxy",
			"namespace", info.Namespace, "service", info.Name, "port", info.Port)
		return info
	}

	// Then the common namespaces, in preference order.
	namespaces := []string{
		"monitoring",
		"prometheus",
		"jupyterhub",
		"kube-system",
		"gpu-operator",
		"observability",
		"default",
	}

	hits := make([]*promServiceInfo, len(namespaces))
	var wg sync.WaitGroup
	for i, ns := range namespaces {
		wg.Add(1)
		go func(i int, ns string) {
			defer wg.Done()
			hits[i] = probePrometheusNamespace(probeCtx, cs, ns)
		}(i, ns)
	}
	wg.Wait()

	for _, info := range hits {
		if info != nil {
			slog.Info("Prometheus discovered via K8s API proxy",
				"namespace", info.Namespace, "service", info.Name, "port", info.Port)
			return info
		}
	}

	slog.Warn("Prometheus not found in target cluster")
	return nil
}

// PrometheusServiceLabels are the label selectors discovery tries, in order,
// across all namespaces.
var PrometheusServiceLabels = []string{
	"kubeast.io/prometheus=true",
	"app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server",
	"operated-prometheus=true",
}

// probePrometheusLabels returns the first Service matching PrometheusServiceLabels
// that answers on one of its ports, or nil (listing every namespace refused
// counts as nothing found: the namespace probe follows).
func probePrometheusLabels(ctx context.Context, cs kubernetes.Interface) *promServiceInfo {
	for _, selector := range PrometheusServiceLabels {
		list, err := cs.CoreV1().Services("").List(ctx, metav1.ListOptions{LabelSelector: selector})
		if err != nil {
			slog.Debug("Prometheus label discovery: list failed", "selector", selector, "err", err)
			continue
		}
		for _, svc := range list.Items {
			for _, port := range svc.Spec.Ports {
				info := &promServiceInfo{Namespace: svc.Namespace, Name: svc.Name, Port: port.Port}
				if verifyPrometheusProxy(ctx, cs, info) {
					return info
				}
			}
		}
	}
	return nil
}

// probePrometheusNamespace returns the first verified Prometheus :9090 service in
// ns, or nil (a missing namespace / RBAC denial / no match all map to nil).
func probePrometheusNamespace(ctx context.Context, cs kubernetes.Interface, ns string) *promServiceInfo {
	svcList, err := cs.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil
	}
	for _, svc := range svcList.Items {
		if !strings.Contains(strings.ToLower(svc.Name), "prometheus") {
			continue
		}
		for _, port := range svc.Spec.Ports {
			if port.Port == 9090 {
				info := &promServiceInfo{Namespace: svc.Namespace, Name: svc.Name, Port: port.Port}
				if verifyPrometheusProxy(ctx, cs, info) {
					return info
				}
			}
		}
	}
	return nil
}

// verifyPrometheusProxy checks if a service is Prometheus by hitting /-/healthy
// via the K8s API proxy. A refusal (403) still counts as found: the Service is
// there, and the cluster decides on each caller's own query, not on the
// discovery identity's.
func verifyPrometheusProxy(ctx context.Context, cs kubernetes.Interface, info *promServiceInfo) bool {
	proxyBase := fmt.Sprintf("/api/v1/namespaces/%s/services/%s:%d/proxy",
		info.Namespace, info.Name, info.Port)

	result := cs.CoreV1().RESTClient().Get().
		AbsPath(proxyBase).
		Suffix("-", "healthy").
		Do(ctx)

	var statusCode int
	result.StatusCode(&statusCode)
	body, err := result.Raw()
	if err != nil {
		if statusCode == http.StatusForbidden {
			return true
		}
		slog.Debug("Prometheus verify failed", "status", statusCode, "err", err)
		return false
	}
	if statusCode != http.StatusOK {
		slog.Debug("Prometheus verify non-200", "status", statusCode, "body", string(body))
		return false
	}
	return true
}

// prometheusViaProxyUncached queries Prometheus through the K8s API server service
// proxy. We use restConfig + http.Client directly because the K8s RESTClient's
// AbsPath does not handle query parameters correctly for service proxy URLs.
func (s *Service) prometheusViaProxyUncached(ctx context.Context, info *promServiceInfo, promPath string) ([]map[string]interface{}, error) {
	// Build the proxy base path (without query string)
	proxyBase := fmt.Sprintf("/api/v1/namespaces/%s/services/%s:%d/proxy",
		info.Namespace, info.Name, info.Port)

	// Use the K8s RESTClient with proper param handling
	req := s.clientsetCtx(ctx).CoreV1().RESTClient().Get().
		AbsPath(proxyBase)

	// Parse promPath to separate the path and query parts
	// e.g. "/api/v1/query?query=up" → subpath="/api/v1/query", params={"query": "up"}
	if idx := strings.Index(promPath, "?"); idx >= 0 {
		subPath := promPath[:idx]
		queryStr := promPath[idx+1:]
		req = req.Suffix(subPath)
		// Parse and add each query parameter
		params, _ := url.ParseQuery(queryStr)
		for k, vals := range params {
			for _, v := range vals {
				req = req.Param(k, v)
			}
		}
	} else {
		req = req.Suffix(promPath)
	}

	result := req.Do(ctx)
	body, err := result.Raw()
	if err != nil {
		var statusCode int
		result.StatusCode(&statusCode)
		return nil, fmt.Errorf("prometheus proxy request failed (status %d): %w", statusCode, err)
	}

	var resp prometheusResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("parse prometheus response: %w (body: %s)", err, string(body[:min(len(body), 200)]))
	}

	if resp.Status != "success" {
		return nil, fmt.Errorf("prometheus query returned status: %s", resp.Status)
	}

	return resp.Data.Result, nil
}

// extractPrometheusValue extracts the float64 value from a Prometheus instant query result.
func extractPrometheusValue(result map[string]interface{}) float64 {
	value, _ := result["value"].([]interface{})
	if len(value) < 2 {
		return 0
	}
	strVal, _ := value[1].(string)
	var f float64
	fmt.Sscanf(strVal, "%f", &f)
	return f
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
