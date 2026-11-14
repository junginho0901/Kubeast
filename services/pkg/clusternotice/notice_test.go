package clusternotice

import (
	"encoding/json"
	"strings"
	"testing"
)

// The channel and the message are what k8s-service's internal/clustersync publishes: kubeast:clusters:changed:<db> and
// {"cluster":…,"from":…}.
func TestChannelAndMessageAreClustersyncs(t *testing.T) {
	if got := ChannelFor(0); got != "kubeast:clusters:changed:0" {
		t.Fatalf("ChannelFor(0) = %q", got)
	}
	if got := ChannelFor(7); got != "kubeast:clusters:changed:7" {
		t.Fatalf("ChannelFor(7) = %q", got)
	}
	b, err := json.Marshal(Notice{Cluster: "prod", From: "0123456789abcdef"})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"cluster":"prod","from":"0123456789abcdef"}` {
		t.Fatalf("message = %s", b)
	}
}

func TestDecodeTakesANoticeAndNothingElse(t *testing.T) {
	n, err := Decode(`{"cluster":"prod","from":"0123456789abcdef"}`)
	if err != nil || n.Cluster != "prod" || n.From != "0123456789abcdef" {
		t.Fatalf("Decode = %+v, %v", n, err)
	}
	// fields a notice does not have are not read
	if n, err := Decode(`{"cluster":"prod","from":"x","kubeconfig":"apiVersion: v1"}`); err != nil || n.Cluster != "prod" {
		t.Fatalf("extra field: %+v, %v", n, err)
	}
	refused := map[string]string{
		"not JSON":           "prod",
		"no cluster":         `{"from":"x"}`,
		"empty cluster":      `{"cluster":"","from":"x"}`,
		"cluster not string": `{"cluster":7,"from":"x"}`,
		"control character":  `{"cluster":"pr\nod","from":"x"}`,
		"cluster too long":   `{"cluster":"` + strings.Repeat("a", 254) + `","from":"x"}`,
		"message too long":   `{"cluster":"prod","from":"` + strings.Repeat("a", MaxPayload) + `"}`,
	}
	for name, payload := range refused {
		if n, err := Decode(payload); err == nil {
			t.Errorf("%s: Decode took %+v", name, n)
		}
	}
	if _, err := Decode(`{"cluster":"` + strings.Repeat("a", 253) + `","from":"x"}`); err != nil {
		t.Errorf("a 253-byte cluster id: %v", err)
	}
}
