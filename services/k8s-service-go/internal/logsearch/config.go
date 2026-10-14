// Package logsearch searches a log store (Loki) for one cluster's container
// logs: by namespace, pod or workload, container, text and time range. The
// caller is authorized before a search; this package builds the store query
// from structured filters only (no query language from the user), so the
// cluster and namespace matchers it adds cannot be dropped.
package logsearch

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
)

// Labels are the store's label names for the cluster, namespace, pod and
// container of a stream. The defaults are the ones Loki gives logs sent over
// OTLP (k8s.namespace.name → k8s_namespace_name, …).
type Labels struct {
	Cluster   string
	Namespace string
	Pod       string
	Container string
	// Service is the OpenTelemetry service name (OTLP service.name → service_name);
	// read when present, never queried on.
	Service string
}

// Config is the deployment-wide log search configuration (chart
// features.logSearch).
type Config struct {
	Enabled    bool
	Backend    string
	URL        string
	AuthHeader string
	Tenant     string
	Labels     Labels
	// Clusters maps a Kubeast cluster ID to the value of Labels.Cluster its
	// streams carry. A cluster that is not listed has no log search. With an
	// empty Labels.Cluster the store holds one cluster: the single entry names
	// it and its value is unused.
	Clusters map[string]string
	// TraceID finds a line's trace ID in its labels or text (features.tracing);
	// nil leaves lines without one.
	TraceID          func(labels map[string]string, line string) string
	DefaultRange     time.Duration
	MaxRange         time.Duration
	MaxLines         int
	Timeout          time.Duration
	PerUserPerMinute int
}

// LoadConfig reads the LOG_SEARCH_* environment.
func LoadConfig() Config {
	return Config{
		Enabled:    pkgconfig.GetEnvBool("LOG_SEARCH_ENABLED", false),
		Backend:    pkgconfig.GetEnv("LOG_SEARCH_BACKEND", "loki"),
		URL:        strings.TrimRight(strings.TrimSpace(os.Getenv("LOG_SEARCH_URL")), "/"),
		AuthHeader: os.Getenv("LOG_SEARCH_AUTH_HEADER"),
		Tenant:     strings.TrimSpace(os.Getenv("LOG_SEARCH_TENANT")),
		Labels: Labels{
			Cluster:   envOr("LOG_SEARCH_LABEL_CLUSTER", "k8s_cluster_name"),
			Namespace: envOr("LOG_SEARCH_LABEL_NAMESPACE", "k8s_namespace_name"),
			Pod:       envOr("LOG_SEARCH_LABEL_POD", "k8s_pod_name"),
			Container: envOr("LOG_SEARCH_LABEL_CONTAINER", "k8s_container_name"),
			Service:   envOr("LOG_SEARCH_LABEL_SERVICE", "service_name"),
		},
		Clusters:         parseClusters(os.Getenv("LOG_SEARCH_CLUSTERS")),
		DefaultRange:     envDuration("LOG_SEARCH_DEFAULT_RANGE", time.Hour),
		MaxRange:         envDuration("LOG_SEARCH_MAX_RANGE", 24*time.Hour),
		MaxLines:         pkgconfig.GetEnvInt("LOG_SEARCH_MAX_LINES", 1000),
		Timeout:          envDuration("LOG_SEARCH_TIMEOUT", 15*time.Second),
		PerUserPerMinute: pkgconfig.GetEnvInt("LOG_SEARCH_PER_USER_PER_MINUTE", 20),
	}
}

// envOr is like GetEnv but keeps an explicitly empty value (LOG_SEARCH_LABEL_CLUSTER="" = one cluster per store).
func envOr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return strings.TrimSpace(v)
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return -1 // rejected by Validate
	}
	return d
}

// parseClusters reads "id=value,id2=value2"; "id" or "id=" alone maps to "".
func parseClusters(raw string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, value, _ := strings.Cut(part, "=")
		out[strings.TrimSpace(id)] = strings.TrimSpace(value)
	}
	return out
}

var labelName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// Validate rejects a configuration that could not search, or could search
// beyond one cluster's streams. Only called when Enabled.
func (c Config) Validate() error {
	if c.Backend != "loki" {
		return fmt.Errorf("LOG_SEARCH_BACKEND %q: only \"loki\" is supported", c.Backend)
	}
	if !strings.HasPrefix(c.URL, "http://") && !strings.HasPrefix(c.URL, "https://") {
		return fmt.Errorf("LOG_SEARCH_URL must be an http(s) URL")
	}
	for name, v := range map[string]string{"namespace": c.Labels.Namespace, "pod": c.Labels.Pod, "container": c.Labels.Container} {
		if !labelName.MatchString(v) {
			return fmt.Errorf("log search label for %s %q is not a label name", name, v)
		}
	}
	if c.Labels.Cluster != "" && !labelName.MatchString(c.Labels.Cluster) {
		return fmt.Errorf("log search cluster label %q is not a label name", c.Labels.Cluster)
	}
	if c.Labels.Service != "" && !labelName.MatchString(c.Labels.Service) {
		return fmt.Errorf("log search service label %q is not a label name", c.Labels.Service)
	}
	if len(c.Clusters) == 0 {
		return fmt.Errorf("LOG_SEARCH_CLUSTERS lists no cluster (Kubeast cluster ID → cluster label value)")
	}
	for id, v := range c.Clusters {
		if id == "" {
			return fmt.Errorf("LOG_SEARCH_CLUSTERS has an entry without a cluster ID")
		}
		if c.Labels.Cluster != "" && v == "" {
			return fmt.Errorf("LOG_SEARCH_CLUSTERS: cluster %q has no value for label %s", id, c.Labels.Cluster)
		}
	}
	if c.Labels.Cluster == "" && len(c.Clusters) > 1 {
		return fmt.Errorf("without a cluster label the store holds one cluster, but LOG_SEARCH_CLUSTERS lists %d", len(c.Clusters))
	}
	if c.DefaultRange <= 0 || c.MaxRange <= 0 || c.Timeout <= 0 {
		return fmt.Errorf("LOG_SEARCH_DEFAULT_RANGE, LOG_SEARCH_MAX_RANGE and LOG_SEARCH_TIMEOUT must be positive durations")
	}
	if c.DefaultRange > c.MaxRange {
		return fmt.Errorf("LOG_SEARCH_DEFAULT_RANGE %s is longer than LOG_SEARCH_MAX_RANGE %s", c.DefaultRange, c.MaxRange)
	}
	if c.MaxLines < 1 || c.MaxLines > 5000 {
		return fmt.Errorf("LOG_SEARCH_MAX_LINES must be 1..5000")
	}
	if c.PerUserPerMinute < 1 {
		return fmt.Errorf("LOG_SEARCH_PER_USER_PER_MINUTE must be at least 1")
	}
	return nil
}

// ClusterIDs lists the configured clusters, sorted.
func (c Config) ClusterIDs() []string {
	ids := make([]string, 0, len(c.Clusters))
	for id := range c.Clusters {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
