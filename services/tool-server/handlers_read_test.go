package main

import (
	"strings"
	"testing"
)

// Every tool result leaves through redactToolOutput: a Secret document keeps
// its shape but loses its values, and credentials elsewhere are masked.
func TestRedactToolOutput_SecretAndCredentials(t *testing.T) {
	secret := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: default\ndata:\n  password: aHVudGVyMg==\ntype: Opaque\n"
	out, stats := redactToolOutput(secret)
	if strings.Contains(out, "aHVudGVyMg==") || !strings.Contains(out, "password: <REDACTED:secret>") || !strings.Contains(out, "name: db") {
		t.Fatalf("secret values must be stripped, shape kept:\n%s", out)
	}
	if stats == nil || stats.Kinds["secret"] != 1 {
		t.Fatalf("stats: %+v", stats)
	}

	cm := "kind: ConfigMap\ndata:\n  DB_PASSWORD: hunter2\n  LOG_LEVEL: info\n"
	out, stats = redactToolOutput(cm)
	if strings.Contains(out, "hunter2") || !strings.Contains(out, "LOG_LEVEL: info") {
		t.Fatalf("configmap credential must be masked, other keys kept:\n%s", out)
	}
	if stats == nil || stats.Kinds["key_name"] != 1 {
		t.Fatalf("stats: %+v", stats)
	}

	out, stats = redactToolOutput("NAME   READY   STATUS\nweb-1  1/1     Running\n")
	if out != "NAME   READY   STATUS\nweb-1  1/1     Running\n" || stats != nil {
		t.Fatalf("plain output must pass through untouched")
	}
}
