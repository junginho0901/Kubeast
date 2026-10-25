package netflows

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLoadConfig(t *testing.T) {
	t.Setenv("NETWORK_FLOWS_ENABLED", "true")
	t.Setenv("NETWORK_FLOWS_CLUSTERS", "self=proxy, cilium=proxy:monitoring/relay:4245 ,edge=https://relay.example:4245/,cal=calico,cal2=calico:tigera/whisker2:9443")
	t.Setenv("NETWORK_FLOWS_MAX_FLOWS", "300")
	t.Setenv("NETWORK_FLOWS_GRAPH_MAX_FLOWS", "3000")
	c := LoadConfig()
	want := map[string]Target{
		"self":   {Mode: "proxy", Relay: Relay{Namespace: "kube-system", Service: "hubble-relay", Port: 443}},
		"cilium": {Mode: "proxy", Relay: Relay{Namespace: "monitoring", Service: "relay", Port: 4245}},
		"edge":   {Mode: "address", Relay: Relay{Namespace: "kube-system", Service: "hubble-relay", Port: 443}, URL: "https://relay.example:4245"},
		"cal":    {Mode: "proxy", Source: SourceCalico, Relay: Relay{Namespace: "calico-system", Service: "whisker", Port: 8443}},
		"cal2":   {Mode: "proxy", Source: SourceCalico, Relay: Relay{Namespace: "tigera", Service: "whisker2", Port: 9443}},
	}
	if !c.Enabled || !reflect.DeepEqual(c.Clusters, want) || c.MaxFlows != 300 || c.GraphMaxFlows != 3000 || c.DefaultRange != 15*time.Minute || c.MaxRange != time.Hour {
		t.Fatalf("config %+v", c)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(c.ClusterIDs(), ","); got != "cal,cal2,cilium,edge,self" {
		t.Fatalf("ids %s", got)
	}
	// Whisker is read with GET; the Relay's GetFlows is a POST
	if c.Clusters["cal"].ProxyVerb() != "get" || c.Clusters["self"].ProxyVerb() != "create" || c.Clusters["cal"].What() != "Calico's Whisker" {
		t.Fatal("verbs")
	}
}

func TestEndpoint(t *testing.T) {
	p := Target{Mode: "proxy", Relay: Relay{Namespace: "kube-system", Service: "hubble-relay", Port: 443}}
	for host, want := range map[string]string{
		"https://10.0.0.1:6443":            "https://10.0.0.1:6443/api/v1/namespaces/kube-system/services/https:hubble-relay:443/proxy/observer.Observer/GetFlows",
		"https://rancher.example/k8s/c-1/": "https://rancher.example/k8s/c-1/api/v1/namespaces/kube-system/services/https:hubble-relay:443/proxy/observer.Observer/GetFlows",
		"kubernetes.default.svc:443":       "https://kubernetes.default.svc:443/api/v1/namespaces/kube-system/services/https:hubble-relay:443/proxy/observer.Observer/GetFlows",
	} {
		if got := p.Endpoint(host); got != want {
			t.Errorf("%s: %s", host, got)
		}
	}
	a := Target{Mode: "address", URL: "https://relay.example:4245"}
	if got := a.Endpoint("ignored"); got != "https://relay.example:4245/observer.Observer/GetFlows" {
		t.Fatalf("address: %s", got)
	}
	// Whisker's backend behind its nginx
	w := Target{Mode: "proxy", Source: SourceCalico, Relay: DefaultWhisker}
	if got := w.Endpoint("https://10.0.0.1:6443"); got != "https://10.0.0.1:6443/api/v1/namespaces/calico-system/services/https:whisker:8443/proxy/whisker-backend/flows" {
		t.Fatalf("whisker: %s", got)
	}
}

func TestValidate(t *testing.T) {
	good := func() Config {
		return Config{Clusters: map[string]Target{"self": {Mode: "proxy"}}, DefaultRange: time.Minute, MaxRange: time.Hour, MaxFlows: 10, GraphMaxFlows: 100, Timeout: time.Second, PerUserPerMinute: 1}
	}
	cases := map[string]func(*Config){
		"no cluster":           func(c *Config) { c.Clusters = nil },
		"bad entry":            func(c *Config) { c.Clusters = parseClusters("x=http://relay:80", Relay{}) },
		"bad relay":            func(c *Config) { c.Clusters = parseClusters("x=proxy:kube-system/relay", Relay{}) },
		"bad whisker":          func(c *Config) { c.Clusters = parseClusters("x=calico:calico-system/whisker", Relay{}) },
		"calico by address":    func(c *Config) { c.Clusters = parseClusters("x=calico-https://w:1", Relay{}) },
		"cert without key":     func(c *Config) { c.Clusters = parseClusters("x=https://r:1", Relay{}); c.CertFile = "c.pem" },
		"TLS without address":  func(c *Config) { c.CAFile = "ca.pem" },
		"default over max":     func(c *Config) { c.DefaultRange = 2 * time.Hour },
		"bad duration":         func(c *Config) { c.Timeout = -1 },
		"too many flows":       func(c *Config) { c.MaxFlows = 5000 },
		"too many graph flows": func(c *Config) { c.GraphMaxFlows = 20000 },
		"no budget":            func(c *Config) { c.PerUserPerMinute = 0 },
	}
	for name, mutate := range cases {
		c := good()
		mutate(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if err := good().Validate(); err != nil {
		t.Fatal(err)
	}
}
