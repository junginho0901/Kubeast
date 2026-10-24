package netflows

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLoadConfig(t *testing.T) {
	t.Setenv("NETWORK_FLOWS_ENABLED", "true")
	t.Setenv("NETWORK_FLOWS_CLUSTERS", "self=proxy, cilium=proxy:monitoring/relay:4245 ,edge=https://relay.example:4245/")
	t.Setenv("NETWORK_FLOWS_MAX_FLOWS", "300")
	c := LoadConfig()
	want := map[string]Target{
		"self":   {Mode: "proxy", Relay: Relay{Namespace: "kube-system", Service: "hubble-relay", Port: 443}},
		"cilium": {Mode: "proxy", Relay: Relay{Namespace: "monitoring", Service: "relay", Port: 4245}},
		"edge":   {Mode: "address", Relay: Relay{Namespace: "kube-system", Service: "hubble-relay", Port: 443}, URL: "https://relay.example:4245"},
	}
	if !c.Enabled || !reflect.DeepEqual(c.Clusters, want) || c.MaxFlows != 300 || c.DefaultRange != 15*time.Minute || c.MaxRange != time.Hour {
		t.Fatalf("config %+v", c)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(c.ClusterIDs(), ","); got != "cilium,edge,self" {
		t.Fatalf("ids %s", got)
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
}

func TestValidate(t *testing.T) {
	good := func() Config {
		return Config{Clusters: map[string]Target{"self": {Mode: "proxy"}}, DefaultRange: time.Minute, MaxRange: time.Hour, MaxFlows: 10, Timeout: time.Second, PerUserPerMinute: 1}
	}
	cases := map[string]func(*Config){
		"no cluster":          func(c *Config) { c.Clusters = nil },
		"bad entry":           func(c *Config) { c.Clusters = parseClusters("x=http://relay:80", Relay{}) },
		"bad relay":           func(c *Config) { c.Clusters = parseClusters("x=proxy:kube-system/relay", Relay{}) },
		"cert without key":    func(c *Config) { c.Clusters = parseClusters("x=https://r:1", Relay{}); c.CertFile = "c.pem" },
		"TLS without address": func(c *Config) { c.CAFile = "ca.pem" },
		"default over max":    func(c *Config) { c.DefaultRange = 2 * time.Hour },
		"bad duration":        func(c *Config) { c.Timeout = -1 },
		"too many flows":      func(c *Config) { c.MaxFlows = 5000 },
		"no budget":           func(c *Config) { c.PerUserPerMinute = 0 },
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
