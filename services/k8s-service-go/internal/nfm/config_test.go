package nfm

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLoadConfig(t *testing.T) {
	t.Setenv("NETWORK_FLOW_MONITOR_ENABLED", "true")
	t.Setenv("NETWORK_FLOW_MONITOR_REGION", " ap-northeast-2 ")
	t.Setenv("NETWORK_FLOW_MONITOR_ENDPOINT", "http://nfm-stub.kubeast-devtools:8080/")
	t.Setenv("NETWORK_FLOW_MONITOR_CLUSTERS", "alpha=alpha-monitor, beta = beta-monitor ,")
	t.Setenv("NETWORK_FLOW_MONITOR_DEFAULT_RANGE", "30m")
	c := LoadConfig()
	want := Config{Enabled: true, Region: "ap-northeast-2", Endpoint: "http://nfm-stub.kubeast-devtools:8080",
		Clusters: map[string]string{"alpha": "alpha-monitor", "beta": "beta-monitor"}, DefaultRange: 30 * time.Minute, MaxRange: 2 * time.Hour,
		Limit: 500, Timeout: 15 * time.Second, PerUserPerMinute: 20}
	if !reflect.DeepEqual(c, want) {
		t.Fatalf("got  %+v\nwant %+v", c, want)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if got := c.ClusterIDs(); !reflect.DeepEqual(got, []string{"alpha", "beta"}) {
		t.Fatalf("ids %v", got)
	}
}

func TestValidate(t *testing.T) {
	for want, edit := range map[string]func(*Config){
		"REGION is required":        func(c *Config) { c.Region = "" },
		"lists no cluster":          func(c *Config) { c.Clusters = map[string]string{} },
		"shop-eks: no monitor name": func(c *Config) { c.Clusters["shop-eks"] = "" },
		"positive durations":        func(c *Config) { c.Timeout = -1 },
		"is longer than":            func(c *Config) { c.DefaultRange = 3 * time.Hour },
		"LIMIT must be 1..500":      func(c *Config) { c.Limit = 501 },
		"at least 1":                func(c *Config) { c.PerUserPerMinute = 0 },
	} {
		c := testConfig("")
		edit(&c)
		if err := c.Validate(); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", want, err)
		}
	}
	t.Setenv("NETWORK_FLOW_MONITOR_TIMEOUT", "soon")
	if c := LoadConfig(); c.Timeout != -1 {
		t.Fatalf("an unreadable duration is kept for Validate to refuse: %v", c.Timeout)
	}
}
