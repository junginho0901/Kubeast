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

const (
	getFlowsPath = "/observer.Observer/GetFlows"
	// whiskerFlowsPath is the Whisker backend's flow list behind Whisker's nginx (tigera-operator pkg/render/whisker).
	whiskerFlowsPath = "/whisker-backend/flows"
)

// Sources of flows: a Hubble Relay (Cilium, Retina), or Calico's Whisker backend, which reads Goldmane.
const (
	SourceHubble = "hubble"
	SourceCalico = "calico"
)

// DefaultWhisker is the Whisker Service the Tigera operator creates.
var DefaultWhisker = Relay{Namespace: "calico-system", Service: "whisker", Port: 8443}

// Target is how one cluster's flows are reached.
type Target struct {
	Mode string // proxy or address
	// Source is what Relay names: a Hubble Relay ("" or SourceHubble) or Calico's Whisker (SourceCalico).
	Source string
	Relay  Relay
	URL    string // mode address: https://host:port
}

// Calico tells a Whisker target from a Hubble Relay.
func (t Target) Calico() bool { return t.Source == SourceCalico }

// ProxyVerb is the services/proxy verb the read takes: a GetFlows POST, or a GET of Whisker's flows.
func (t Target) ProxyVerb() string {
	if t.Calico() {
		return "get"
	}
	return "create"
}

// What names the flow source for messages.
func (t Target) What() string {
	if t.Calico() {
		return "Calico's Whisker"
	}
	return "the Hubble Relay"
}

// Config is the network flows configuration (chart features.networkFlows).
type Config struct {
	Enabled      bool
	Clusters     map[string]Target
	DefaultRange time.Duration
	MaxRange     time.Duration
	MaxFlows     int
	// GraphMaxFlows caps a Resource Graph read, which covers several namespaces.
	GraphMaxFlows    int
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
		GraphMaxFlows:    pkgconfig.GetEnvInt("NETWORK_FLOWS_GRAPH_MAX_FLOWS", 2000),
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

// parseClusters reads "id=proxy", "id=proxy:namespace/service:port",
// "id=https://host:port", "id=calico" and "id=calico:namespace/service:port",
// comma-separated.
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
		case value == "calico":
			out[id] = Target{Mode: "proxy", Source: SourceCalico, Relay: DefaultWhisker}
		case strings.HasPrefix(value, "calico:"):
			r, err := parseRelay(strings.TrimPrefix(value, "calico:"))
			if err != nil {
				out[id] = Target{Mode: "invalid: " + err.Error()}
				continue
			}
			out[id] = Target{Mode: "proxy", Source: SourceCalico, Relay: r}
		default:
			out[id] = Target{Mode: "invalid: " + fmt.Sprintf("%q is not proxy, proxy:namespace/service:port, an https:// address, calico or calico:namespace/service:port", value)}
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
	if c.GraphMaxFlows < 1 || c.GraphMaxFlows > 10000 {
		return fmt.Errorf("NETWORK_FLOWS_GRAPH_MAX_FLOWS must be 1..10000")
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

// Endpoint is the GetFlows URL (Whisker's flow list for Calico): through the
// API server at apiHost (mode proxy) or at the registered address.
func (t Target) Endpoint(apiHost string) string {
	if t.Mode == "address" {
		return t.URL + getFlowsPath
	}
	host := strings.TrimRight(apiHost, "/")
	if !strings.Contains(host, "://") {
		host = "https://" + host
	}
	if t.Calico() {
		return host + "/api/v1/namespaces/" + t.Relay.Namespace + "/services/" + t.Relay.ProxyName() + "/proxy" + whiskerFlowsPath
	}
	return host + t.Relay.ProxyPath()
}
