// Package netflows reads network flows from a cluster's Hubble Relay (Cilium,
// or Microsoft Retina's Hubble control plane) for the pods of one namespace,
// one pod or one workload. The Relay is reached through the cluster's API
// server service proxy as the signed-in user (mode proxy, which needs Relay
// TLS), or at a registered address over TLS (mode address).
package netflows

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
)

// Relay is the Relay's Service: the proxy path in mode proxy, and in both
// modes the services/proxy permission a reader must hold.
type Relay struct {
	Namespace string
	Service   string
	Port      int
}

// ProxyName is the services/proxy resource name: https:<service>:<port>.
func (r Relay) ProxyName() string { return fmt.Sprintf("https:%s:%d", r.Service, r.Port) }

// ProxyPath is the GetFlows path through the API server.
func (r Relay) ProxyPath() string {
	return "/api/v1/namespaces/" + r.Namespace + "/services/" + r.ProxyName() + "/proxy" + getFlowsPath
}

func (r Relay) String() string { return fmt.Sprintf("%s/%s:%d", r.Namespace, r.Service, r.Port) }

const getFlowsPath = "/observer.Observer/GetFlows"

// Target is how one cluster's Relay is reached.
type Target struct {
	Mode  string // proxy or address
	Relay Relay
	URL   string // mode address: https://host:port
}

// Config is the network flows configuration (chart features.networkFlows).
type Config struct {
	Enabled          bool
	Clusters         map[string]Target
	DefaultRange     time.Duration
	MaxRange         time.Duration
	MaxFlows         int
	Timeout          time.Duration
	PerUserPerMinute int
	// TLS for mode address: a CA to trust (empty = system roots), an optional
	// client certificate, and a server name when it differs from the URL's host.
	CAFile, CertFile, KeyFile, ServerName string
}

// LoadConfig reads the NETWORK_FLOWS_* environment.
func LoadConfig() Config {
	relay, relayErr := parseRelay(pkgconfig.GetEnv("NETWORK_FLOWS_RELAY", "kube-system/hubble-relay:443"))
	c := Config{
		Enabled:          pkgconfig.GetEnvBool("NETWORK_FLOWS_ENABLED", false),
		DefaultRange:     envDuration("NETWORK_FLOWS_DEFAULT_RANGE", 15*time.Minute),
		MaxRange:         envDuration("NETWORK_FLOWS_MAX_RANGE", time.Hour),
		MaxFlows:         pkgconfig.GetEnvInt("NETWORK_FLOWS_MAX_FLOWS", 200),
		Timeout:          envDuration("NETWORK_FLOWS_TIMEOUT", 10*time.Second),
		PerUserPerMinute: pkgconfig.GetEnvInt("NETWORK_FLOWS_PER_USER_PER_MINUTE", 20),
		CAFile:           strings.TrimSpace(os.Getenv("NETWORK_FLOWS_TLS_CA_FILE")),
		CertFile:         strings.TrimSpace(os.Getenv("NETWORK_FLOWS_TLS_CERT_FILE")),
		KeyFile:          strings.TrimSpace(os.Getenv("NETWORK_FLOWS_TLS_KEY_FILE")),
		ServerName:       strings.TrimSpace(os.Getenv("NETWORK_FLOWS_TLS_SERVER_NAME")),
	}
	c.Clusters = parseClusters(os.Getenv("NETWORK_FLOWS_CLUSTERS"), relay)
	if relayErr != nil {
		c.Clusters["NETWORK_FLOWS_RELAY"] = Target{Mode: "invalid: " + relayErr.Error()}
	}
	return c
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

// parseRelay reads "namespace/service:port".
func parseRelay(s string) (Relay, error) {
	ns, rest, ok := strings.Cut(strings.TrimSpace(s), "/")
	svc, port, ok2 := strings.Cut(rest, ":")
	p, err := strconv.Atoi(port)
	if !ok || !ok2 || ns == "" || svc == "" || err != nil || p < 1 || p > 65535 {
		return Relay{}, fmt.Errorf("%q is not namespace/service:port", s)
	}
	return Relay{Namespace: ns, Service: svc, Port: p}, nil
}

// parseClusters reads "id=proxy", "id=proxy:namespace/service:port" and
// "id=https://host:port", comma-separated.
func parseClusters(raw string, relay Relay) map[string]Target {
	out := map[string]Target{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, value, _ := strings.Cut(part, "=")
		id, value = strings.TrimSpace(id), strings.TrimSpace(value)
		switch {
		case value == "proxy":
			out[id] = Target{Mode: "proxy", Relay: relay}
		case strings.HasPrefix(value, "proxy:"):
			r, err := parseRelay(strings.TrimPrefix(value, "proxy:"))
			if err != nil {
				out[id] = Target{Mode: "invalid: " + err.Error()}
				continue
			}
			out[id] = Target{Mode: "proxy", Relay: r}
		case strings.HasPrefix(value, "https://"):
			out[id] = Target{Mode: "address", Relay: relay, URL: strings.TrimRight(value, "/")}
		default:
			out[id] = Target{Mode: "invalid: " + fmt.Sprintf("%q is not proxy, proxy:namespace/service:port or an https:// address", value)}
		}
	}
	return out
}

// Validate rejects a configuration that could not read. Only called when Enabled.
func (c Config) Validate() error {
	if len(c.Clusters) == 0 {
		return fmt.Errorf("NETWORK_FLOWS_CLUSTERS lists no cluster (cluster ID = proxy, proxy:namespace/service:port or https://address)")
	}
	address := false
	for id, t := range c.Clusters {
		if id == "" {
			return fmt.Errorf("NETWORK_FLOWS_CLUSTERS: an entry has no cluster ID")
		}
		switch t.Mode {
		case "proxy":
		case "address":
			address = true
		default:
			return fmt.Errorf("NETWORK_FLOWS_CLUSTERS %s: %s", id, strings.TrimPrefix(t.Mode, "invalid: "))
		}
	}
	if (c.CertFile == "") != (c.KeyFile == "") {
		return fmt.Errorf("NETWORK_FLOWS_TLS_CERT_FILE and NETWORK_FLOWS_TLS_KEY_FILE go together")
	}
	if !address && (c.CAFile != "" || c.CertFile != "") {
		return fmt.Errorf("the NETWORK_FLOWS_TLS_* files are for a cluster with an https:// address; none is listed")
	}
	if c.DefaultRange <= 0 || c.MaxRange <= 0 || c.Timeout <= 0 {
		return fmt.Errorf("NETWORK_FLOWS_DEFAULT_RANGE, NETWORK_FLOWS_MAX_RANGE and NETWORK_FLOWS_TIMEOUT must be positive durations")
	}
	if c.DefaultRange > c.MaxRange {
		return fmt.Errorf("NETWORK_FLOWS_DEFAULT_RANGE %s is longer than NETWORK_FLOWS_MAX_RANGE %s", c.DefaultRange, c.MaxRange)
	}
	if c.MaxFlows < 1 || c.MaxFlows > 1000 {
		return fmt.Errorf("NETWORK_FLOWS_MAX_FLOWS must be 1..1000")
	}
	if c.PerUserPerMinute < 1 {
		return fmt.Errorf("NETWORK_FLOWS_PER_USER_PER_MINUTE must be at least 1")
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

// Endpoint is the GetFlows URL: through the API server at apiHost (mode
// proxy) or at the registered address.
func (t Target) Endpoint(apiHost string) string {
	if t.Mode == "address" {
		return t.URL + getFlowsPath
	}
	host := strings.TrimRight(apiHost, "/")
	if !strings.Contains(host, "://") {
		host = "https://" + host
	}
	return host + t.Relay.ProxyPath()
}
