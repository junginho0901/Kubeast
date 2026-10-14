package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// promExternal is a Prometheus-compatible store reached over HTTP instead of
// through the target cluster's API server proxy: a central store (Thanos,
// Mimir, VictoriaMetrics, …) or a Prometheus that lives elsewhere. When the
// store holds several clusters, labelValue picks this cluster's series.
type promExternal struct {
	baseURL    string
	authHeader string
	labelValue string
}

// promSource is where one cluster's metrics come from: an external store, or
// a Prometheus Service inside the cluster (proxy) — named in the settings
// (configured) or found by discovery.
type promSource struct {
	ext        *promExternal
	proxy      *promServiceInfo
	configured bool
}

// externalFromInfo resolves the cluster's external source: its own URL (with
// its own Authorization header) first, else the deployment-wide PROMETHEUS_URL
// (+ PROMETHEUS_AUTH_HEADER). The cluster label value is the cluster's own in
// both cases. nil = no external source, find Prometheus inside the cluster.
func externalFromInfo(info cluster.Info) *promExternal {
	base := strings.TrimRight(strings.TrimSpace(info.PrometheusURL), "/")
	auth := info.PrometheusAuthHeader
	if base == "" {
		base = strings.TrimRight(strings.TrimSpace(os.Getenv("PROMETHEUS_URL")), "/")
		auth = os.Getenv("PROMETHEUS_AUTH_HEADER")
	}
	if base == "" {
		return nil
	}
	return &promExternal{baseURL: base, authHeader: auth, labelValue: strings.TrimSpace(info.PrometheusClusterLabel)}
}

// promSourceFromInfo resolves a cluster's configured source, most specific
// first: its own URL, its own Service, the deployment-wide PROMETHEUS_URL, the
// deployment-wide PROMETHEUS_SERVICE. Both nil = discover (if on).
func promSourceFromInfo(info cluster.Info) (*promExternal, *promServiceInfo) {
	if strings.TrimSpace(info.PrometheusURL) != "" {
		return externalFromInfo(info), nil
	}
	if svc := parsePromService(info.PrometheusService, "cluster "+string(info.ID)); svc != nil {
		return nil, svc
	}
	if ext := externalFromInfo(info); ext != nil {
		return ext, nil
	}
	return nil, parsePromService(os.Getenv("PROMETHEUS_SERVICE"), "PROMETHEUS_SERVICE")
}

// parsePromService reads "namespace/service:port"; a malformed value is logged
// and ignored (the cluster then discovers, as if it were empty).
func parsePromService(ref, where string) *promServiceInfo {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil
	}
	ns, name, port, err := cluster.ParsePrometheusService(ref)
	if err != nil {
		slog.Warn("prometheus service ignored", "where", where, "err", err)
		return nil
	}
	return &promServiceInfo{Namespace: ns, Name: name, Port: port}
}

// PrometheusDiscoverEnabled reports whether a cluster without an external
// source is searched for a Prometheus Service (PROMETHEUS_DISCOVER, default on).
func PrometheusDiscoverEnabled() bool {
	raw := strings.TrimSpace(os.Getenv("PROMETHEUS_DISCOVER"))
	if raw == "" {
		return true
	}
	b, err := strconv.ParseBool(raw)
	return err != nil || b
}

// PrometheusClusterLabelName is the label a shared store carries per cluster
// (PROMETHEUS_CLUSTER_LABEL, default "cluster").
func PrometheusClusterLabelName() string {
	if v := strings.TrimSpace(os.Getenv("PROMETHEUS_CLUSTER_LABEL")); v != "" {
		return v
	}
	return "cluster"
}

// scoped narrows query to this cluster's series when the source is a shared
// store with a cluster label; otherwise the query is returned as it is.
func (src *promSource) scoped(query string) (string, error) {
	if src == nil || src.ext == nil || src.ext.labelValue == "" {
		return query, nil
	}
	return injectMatcher(query, PrometheusClusterLabelName(), src.ext.labelValue)
}

// injectMatcher adds name="value" to every vector selector of query (an
// existing matcher on name is replaced) — the prom-label-proxy approach, done
// on the parsed expression so functions, binary expressions and subqueries
// keep their shape. Invalid PromQL is returned unchanged with the parse error.
var promParser = parser.NewParser(parser.Options{})

func injectMatcher(query, name, value string) (string, error) {
	expr, err := promParser.ParseExpr(query)
	if err != nil {
		return query, fmt.Errorf("parse PromQL: %w", err)
	}
	m, err := labels.NewMatcher(labels.MatchEqual, name, value)
	if err != nil {
		return query, err
	}
	parser.Inspect(expr, func(node parser.Node, _ []parser.Node) error {
		vs, ok := node.(*parser.VectorSelector)
		if !ok {
			return nil
		}
		kept := vs.LabelMatchers[:0]
		for _, lm := range vs.LabelMatchers {
			if lm.Name != name {
				kept = append(kept, lm)
			}
		}
		vs.LabelMatchers = append(kept, m)
		return nil
	})
	return expr.String(), nil
}

var promHTTP = &http.Client{Timeout: 15 * time.Second}

// do performs one GET against the store; the body is capped at 32 MiB.
func (e *promExternal) do(ctx context.Context, promPath string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.baseURL+promPath, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	if e.authHeader != "" {
		req.Header.Set("Authorization", e.authHeader)
	}
	resp, err := promHTTP.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

// healthy checks /-/healthy; a store without that endpoint (404) is probed
// with a trivial instant query instead.
func (e *promExternal) healthy(ctx context.Context) (bool, string) {
	body, code, err := e.do(ctx, "/-/healthy")
	if err != nil {
		return false, err.Error()
	}
	if code == http.StatusOK {
		return true, ""
	}
	if code == http.StatusNotFound {
		if _, code2, err2 := e.do(ctx, "/api/v1/query?query=1"); err2 == nil && code2 == http.StatusOK {
			return true, ""
		} else if err2 != nil {
			return false, err2.Error()
		} else {
			return false, fmt.Sprintf("status %d", code2)
		}
	}
	return false, fmt.Sprintf("status %d: %s", code, strings.TrimSpace(string(body[:min(len(body), 200)])))
}

// prometheusExternal runs one API call against the external store and
// returns the result list, like prometheusViaProxyUncached does for the proxy.
func (s *Service) prometheusExternal(ctx context.Context, e *promExternal, promPath string) ([]map[string]interface{}, error) {
	body, code, err := e.do(ctx, promPath)
	if err != nil {
		return nil, fmt.Errorf("prometheus request failed: %w", err)
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("prometheus request failed (status %d): %s", code, strings.TrimSpace(string(body[:min(len(body), 200)])))
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

// getPromSource is the per-request entry point: the bundle's external source
// if one is registered, else the Prometheus Service discovered in the cluster
// (when discovery is on). nil = no metrics for this cluster.
func (s *Service) getPromSource(ctx context.Context) *promSource {
	b := s.bundleForCtx(ctx)
	if b == nil {
		return nil
	}
	if b.promExt != nil {
		return &promSource{ext: b.promExt}
	}
	if b.promSvc != nil {
		return &promSource{proxy: b.promSvc, configured: true}
	}
	if !PrometheusDiscoverEnabled() {
		return nil
	}
	if svc := s.getPromService(ctx); svc != nil {
		return &promSource{proxy: svc}
	}
	return nil
}

// promFetch coalesces + caches identical calls per cluster (as the proxy path
// always did) and sends them to whichever source the cluster has.
func (s *Service) promFetch(ctx context.Context, src *promSource, promPath string) ([]map[string]interface{}, error) {
	key := string(ctxClusterID(ctx)) + "|" + promPath
	return s.promQ.do(key, func() ([]map[string]interface{}, error) {
		if src.ext != nil {
			return s.prometheusExternal(ctx, src.ext, promPath)
		}
		return s.prometheusViaProxyUncached(ctx, src.proxy, promPath)
	})
}
