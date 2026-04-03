package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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

// Prometheus endpoint discovery cache.
var (
	promMu       sync.RWMutex
	promSvc      *promServiceInfo
	promProbed   bool
	promProbedAt time.Time
)

const promCacheTTL = 10 * time.Minute

// PrometheusAvailable returns true if a Prometheus service was discovered.
func (s *Service) PrometheusAvailable(ctx context.Context) bool {
	return s.getPromService(ctx) != nil
}

// PrometheusStatus returns status information about the Prometheus integration.
func (s *Service) PrometheusStatus(ctx context.Context) map[string]interface{} {
	svc := s.getPromService(ctx)
	if svc == nil {
		return map[string]interface{}{
			"available": false,
			"message":   "Prometheus not found in target cluster",
		}
	}
	return map[string]interface{}{
		"available": true,
		"endpoint":  fmt.Sprintf("%s/%s:%d (via K8s API proxy)", svc.Namespace, svc.Name, svc.Port),
	}
}

// PrometheusQuery runs an instant query and returns parsed results.
// Returns (nil, nil) if Prometheus is unavailable.
func (s *Service) PrometheusQuery(ctx context.Context, query string) ([]PrometheusQueryResult, error) {
	svc := s.getPromService(ctx)
	if svc == nil {
		return nil, nil
	}

	raw, err := s.prometheusViaProxy(ctx, svc, "/api/v1/query?query="+url.QueryEscape(query))
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
	svc := s.getPromService(ctx)
	if svc == nil {
		return nil, nil
	}
	return s.prometheusViaProxy(ctx, svc, "/api/v1/query?query="+url.QueryEscape(query))
}

// ========== Internal ==========

// getPromService returns the cached Prometheus service info or triggers discovery.
func (s *Service) getPromService(ctx context.Context) *promServiceInfo {
	promMu.RLock()
	if promProbed && time.Since(promProbedAt) < promCacheTTL {
		cached := promSvc
		promMu.RUnlock()
		return cached
	}
	promMu.RUnlock()

	promMu.Lock()
	defer promMu.Unlock()

	if promProbed && time.Since(promProbedAt) < promCacheTTL {
		return promSvc
	}

	promProbed = true
	promProbedAt = time.Now()
	promSvc = s.discoverPrometheus(ctx)
	return promSvc
}

// discoverPrometheus scans the TARGET cluster for a Prometheus service.
func (s *Service) discoverPrometheus(ctx context.Context) *promServiceInfo {
	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	// Common namespaces where Prometheus might live
	namespaces := []string{
		"monitoring",
		"prometheus",
		"jupyterhub",
		"kube-system",
		"gpu-operator",
		"observability",
		"default",
	}

	for _, ns := range namespaces {
		svcList, err := s.clientset.CoreV1().Services(ns).List(probeCtx, metav1.ListOptions{})
		if err != nil {
			continue
		}
		for _, svc := range svcList.Items {
			name := strings.ToLower(svc.Name)
			if !strings.Contains(name, "prometheus") {
				continue
			}
			for _, port := range svc.Spec.Ports {
				if port.Port == 9090 {
					info := &promServiceInfo{
						Namespace: svc.Namespace,
						Name:      svc.Name,
						Port:      port.Port,
					}
					// Verify via K8s API proxy
					if s.verifyPrometheusProxy(probeCtx, info) {
						slog.Info("Prometheus discovered via K8s API proxy",
							"namespace", info.Namespace,
							"service", info.Name,
							"port", info.Port,
						)
						return info
					}
				}
			}
		}
	}

	slog.Warn("Prometheus not found in target cluster")
	return nil
}

// verifyPrometheusProxy checks if a service is Prometheus by hitting /-/healthy via K8s API proxy.
func (s *Service) verifyPrometheusProxy(ctx context.Context, info *promServiceInfo) bool {
	proxyBase := fmt.Sprintf("/api/v1/namespaces/%s/services/%s:%d/proxy",
		info.Namespace, info.Name, info.Port)

	result := s.clientset.CoreV1().RESTClient().Get().
		AbsPath(proxyBase).
		Suffix("-", "healthy").
		Do(ctx)

	body, err := result.Raw()
	if err != nil {
		slog.Debug("Prometheus verify failed", "err", err)
		return false
	}
	var statusCode int
	result.StatusCode(&statusCode)
	if statusCode != 200 {
		slog.Debug("Prometheus verify non-200", "status", statusCode, "body", string(body))
		return false
	}
	return true
}

// prometheusViaProxy queries Prometheus through the K8s API server service proxy.
// We use restConfig + http.Client directly because the K8s RESTClient's AbsPath
// does not handle query parameters correctly for service proxy URLs.
func (s *Service) prometheusViaProxy(ctx context.Context, info *promServiceInfo, promPath string) ([]map[string]interface{}, error) {
	// Build the proxy base path (without query string)
	proxyBase := fmt.Sprintf("/api/v1/namespaces/%s/services/%s:%d/proxy",
		info.Namespace, info.Name, info.Port)

	// Use the K8s RESTClient with proper param handling
	req := s.clientset.CoreV1().RESTClient().Get().
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
