package controller

import (
	"encoding/json"
	"strings"
	"testing"
)

// A row keeps where questions go and which key variable — never the key, a
// header value or the CA — and a reconcile that writes the same values is not
// a change.
func TestTheSyncRowKeepsNoSecretsAndOnlyChangesCount(t *testing.T) {
	d := modelConfigData{Name: "haiku", Provider: "anthropic", Model: "claude-haiku-5-5", APIKeyEnv: "ANTHROPIC_API_KEY",
		SecretName: "ai-keys", SecretKey: "anthropic", ExtraHeaders: map[string]string{"X-Team": "header-secret", "A": "b"},
		TLSVerify: true, CACert: "-----BEGIN CERTIFICATE-----", Options: map[string]string{"temperature": "0"}, Enabled: true, Tier: "default"}
	v := viewOf(d)
	raw, _ := json.Marshal(v)
	if strings.Contains(string(raw), "header-secret") || strings.Contains(string(raw), "CERTIFICATE") {
		t.Fatalf("leaks: %s", raw)
	}
	if got := v["extra_headers"].([]string); len(got) != 2 || got[0] != "A" || got[1] != "X-Team" {
		t.Fatalf("header names, sorted: %v", got)
	}
	if !changed(nil, v) {
		t.Fatal("a new config is a change")
	}
	if changed(viewOf(d), v) {
		t.Fatal("the same values are not a change")
	}
	d2 := d
	d2.IsDefault = true
	if !changed(v, viewOf(d2)) {
		t.Fatal("becoming the default is a change")
	}
	d3 := d
	d3.ExtraHeaders = map[string]string{"X-Team": "other-secret", "A": "b"}
	if !changed(v, viewOf(d3)) {
		t.Fatal("a changed header value is a change (by its hash)")
	}
	d4 := d
	d4.CACert = "-----BEGIN CERTIFICATE----- other"
	if !changed(v, viewOf(d4)) || viewOf(d4)["ca_cert_sha256"] == "" {
		t.Fatal("a changed CA is a change (by its hash)")
	}
	if viewOf(modelConfigData{})["ca_cert_sha256"] != "" {
		t.Fatal("no CA, no hash")
	}
}
