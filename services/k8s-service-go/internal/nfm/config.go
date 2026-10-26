// Package nfm reads the top contributors of an Amazon CloudWatch Network Flow Monitor monitor — what EKS
// Container Network Observability creates for a cluster — and keeps the rows of one namespace, pod or
// workload: who it exchanges the most data with, where retransmissions, retransmission timeouts or round
// trip time are worst. NFM answers for the whole monitor (its queries take no namespace or pod), with
// Kubernetes names on each row, so Kubeast filters. Kubeast reads with its own AWS identity (IRSA).
package nfm

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
)

// Config is the Network Flow Monitor configuration (chart features.networkFlowMonitor).
type Config struct {
	Enabled bool
	// Region of the monitors; Endpoint replaces the service's (the dev stand-in), empty for AWS.
	Region   string
	Endpoint string
	// Clusters maps a Kubeast cluster ID to the name of its monitor.
	Clusters     map[string]string
	DefaultRange time.Duration
	MaxRange     time.Duration
	// Limit is the rows asked of NFM per category; the namespace's are kept from those.
	Limit            int
	Timeout          time.Duration
	PerUserPerMinute int
	// SecretDir holds accessKeyId and secretAccessKey for keys instead of IRSA (empty files: IRSA).
	SecretDir string
}

// LoadConfig reads the NETWORK_FLOW_MONITOR_* environment.
func LoadConfig() Config {
	return Config{
		Enabled:          pkgconfig.GetEnvBool("NETWORK_FLOW_MONITOR_ENABLED", false),
		Region:           strings.TrimSpace(os.Getenv("NETWORK_FLOW_MONITOR_REGION")),
		Endpoint:         strings.TrimRight(strings.TrimSpace(os.Getenv("NETWORK_FLOW_MONITOR_ENDPOINT")), "/"),
		Clusters:         parseClusters(os.Getenv("NETWORK_FLOW_MONITOR_CLUSTERS")),
		DefaultRange:     envDuration("NETWORK_FLOW_MONITOR_DEFAULT_RANGE", time.Hour),
		MaxRange:         envDuration("NETWORK_FLOW_MONITOR_MAX_RANGE", 2*time.Hour),
		Limit:            pkgconfig.GetEnvInt("NETWORK_FLOW_MONITOR_LIMIT", 500),
		Timeout:          envDuration("NETWORK_FLOW_MONITOR_TIMEOUT", 15*time.Second),
		PerUserPerMinute: pkgconfig.GetEnvInt("NETWORK_FLOW_MONITOR_PER_USER_PER_MINUTE", 20),
		SecretDir:        strings.TrimSpace(os.Getenv("NETWORK_FLOW_MONITOR_SECRET_DIR")),
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

// parseClusters reads "id=monitor-name", comma-separated.
func parseClusters(raw string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(raw, ",") {
		id, monitor, _ := strings.Cut(strings.TrimSpace(part), "=")
		if id = strings.TrimSpace(id); id != "" {
			out[id] = strings.TrimSpace(monitor)
		}
	}
	return out
}

// Validate rejects a configuration that could not read. Only called when Enabled.
func (c Config) Validate() error {
	if c.Region == "" {
		return fmt.Errorf("NETWORK_FLOW_MONITOR_REGION is required (the monitors' AWS Region)")
	}
	if len(c.Clusters) == 0 {
		return fmt.Errorf("NETWORK_FLOW_MONITOR_CLUSTERS lists no cluster (cluster ID = monitor name)")
	}
	for id, m := range c.Clusters {
		if m == "" {
			return fmt.Errorf("NETWORK_FLOW_MONITOR_CLUSTERS %s: no monitor name", id)
		}
	}
	if c.DefaultRange <= 0 || c.MaxRange <= 0 || c.Timeout <= 0 {
		return fmt.Errorf("NETWORK_FLOW_MONITOR_DEFAULT_RANGE, _MAX_RANGE and _TIMEOUT must be positive durations")
	}
	if c.DefaultRange > c.MaxRange {
		return fmt.Errorf("NETWORK_FLOW_MONITOR_DEFAULT_RANGE %s is longer than NETWORK_FLOW_MONITOR_MAX_RANGE %s", c.DefaultRange, c.MaxRange)
	}
	if c.Limit < 1 || c.Limit > 500 {
		return fmt.Errorf("NETWORK_FLOW_MONITOR_LIMIT must be 1..500")
	}
	if c.PerUserPerMinute < 1 {
		return fmt.Errorf("NETWORK_FLOW_MONITOR_PER_USER_PER_MINUTE must be at least 1")
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
