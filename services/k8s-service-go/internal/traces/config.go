// Package traces reads a trace store (Grafana Tempo's HTTP API, directly or
// through a Grafana data source proxy) for one cluster's spans: TraceQL
// search and metrics, a trace by ID, attribute names and values. Every query
// gets the cluster's (and, for a namespace-scoped caller, the namespace's)
// resource attribute in each spanset filter (InjectScope); a trace read by ID
// keeps only the spans of that cluster and namespace.
package traces

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
)

// Config is the trace store configuration (chart features.traceStore).
type Config struct {
	Enabled    bool
	URL        string
	AuthHeader string
	Tenant     string
	// ClusterAttribute and NamespaceAttribute are the resource attributes
	// (without the "resource." scope) the store's spans carry.
	ClusterAttribute   string
	NamespaceAttribute string
	// Clusters maps a Kubeast cluster ID to the value of ClusterAttribute its
	// spans carry. A cluster that is not listed has no trace reads.
	Clusters         map[string]string
	DefaultRange     time.Duration
	MaxRange         time.Duration
	MaxTraces        int
	Timeout          time.Duration
	PerUserPerMinute int
}

// LoadConfig reads the TRACE_STORE_* environment.
func LoadConfig() Config {
	return Config{
		Enabled:            pkgconfig.GetEnvBool("TRACE_STORE_ENABLED", false),
		URL:                strings.TrimRight(strings.TrimSpace(os.Getenv("TRACE_STORE_URL")), "/"),
		AuthHeader:         os.Getenv("TRACE_STORE_AUTH_HEADER"),
		Tenant:             strings.TrimSpace(os.Getenv("TRACE_STORE_TENANT")),
		ClusterAttribute:   pkgconfig.GetEnv("TRACE_STORE_ATTRIBUTE_CLUSTER", "k8s.cluster.name"),
		NamespaceAttribute: pkgconfig.GetEnv("TRACE_STORE_ATTRIBUTE_NAMESPACE", "k8s.namespace.name"),
		Clusters:           parseClusters(os.Getenv("TRACE_STORE_CLUSTERS")),
		DefaultRange:       envDuration("TRACE_STORE_DEFAULT_RANGE", time.Hour),
		MaxRange:           envDuration("TRACE_STORE_MAX_RANGE", 24*time.Hour),
		MaxTraces:          pkgconfig.GetEnvInt("TRACE_STORE_MAX_TRACES", 50),
		Timeout:            envDuration("TRACE_STORE_TIMEOUT", 15*time.Second),
		PerUserPerMinute:   pkgconfig.GetEnvInt("TRACE_STORE_PER_USER_PER_MINUTE", 20),
	}
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

// parseClusters reads "id=value,id2=value2".
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

var attributeName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.\-]*$`)

// Validate rejects a configuration that could not read, or could read beyond
// one cluster's spans. Only called when Enabled.
func (c Config) Validate() error {
	if !strings.HasPrefix(c.URL, "http://") && !strings.HasPrefix(c.URL, "https://") {
		return fmt.Errorf("TRACE_STORE_URL must be an http(s) URL")
	}
	for name, v := range map[string]string{"cluster": c.ClusterAttribute, "namespace": c.NamespaceAttribute} {
		if !attributeName.MatchString(v) {
			return fmt.Errorf("trace store %s attribute %q is not an attribute name", name, v)
		}
	}
	if len(c.Clusters) == 0 {
		return fmt.Errorf("TRACE_STORE_CLUSTERS lists no cluster (Kubeast cluster ID → value of the cluster attribute)")
	}
	for id, v := range c.Clusters {
		if id == "" || v == "" {
			return fmt.Errorf("TRACE_STORE_CLUSTERS: each entry needs a cluster ID and a value (%q=%q)", id, v)
		}
	}
	if c.DefaultRange <= 0 || c.MaxRange <= 0 || c.Timeout <= 0 {
		return fmt.Errorf("TRACE_STORE_DEFAULT_RANGE, TRACE_STORE_MAX_RANGE and TRACE_STORE_TIMEOUT must be positive durations")
	}
	if c.DefaultRange > c.MaxRange {
		return fmt.Errorf("TRACE_STORE_DEFAULT_RANGE %s is longer than TRACE_STORE_MAX_RANGE %s", c.DefaultRange, c.MaxRange)
	}
	if c.MaxTraces < 1 || c.MaxTraces > 500 {
		return fmt.Errorf("TRACE_STORE_MAX_TRACES must be 1..500")
	}
	if c.PerUserPerMinute < 1 {
		return fmt.Errorf("TRACE_STORE_PER_USER_PER_MINUTE must be at least 1")
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

// NormalizeRange fills and checks a window: end not in the future (default
// now), start default end - DefaultRange, at most MaxRange.
func (c Config) NormalizeRange(start, end *time.Time, now time.Time) error {
	if end.IsZero() || end.After(now) {
		*end = now
	}
	if start.IsZero() {
		*start = end.Add(-c.DefaultRange)
	}
	if !start.Before(*end) {
		return fmt.Errorf("start must be before end")
	}
	if end.Sub(*start) > c.MaxRange {
		return fmt.Errorf("the range is longer than %s", c.MaxRange)
	}
	return nil
}
