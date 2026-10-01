package handler

import (
	"strings"
	"testing"
)

const sampleManifest = `---
# Source: app/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: app-db
type: Opaque
data:
  password: aHVudGVyMg==
---
# Source: app/templates/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  DB_HOST: db.internal
  DB_PASSWORD: hunter2
  LOG_LEVEL: info
`

func TestHelmRedactText_StripsSecretsAndMasksCredentials(t *testing.T) {
	out := helmRedactText(sampleManifest)
	if strings.Contains(out, "aHVudGVyMg==") {
		t.Fatalf("Secret data must be stripped:\n%s", out)
	}
	if strings.Contains(out, "DB_PASSWORD: hunter2") {
		t.Fatalf("credential-looking ConfigMap value must be masked:\n%s", out)
	}
	for _, keep := range []string{"kind: Secret", "name: app-db", "DB_HOST: db.internal", "LOG_LEVEL: info"} {
		if !strings.Contains(out, keep) {
			t.Fatalf("%q must survive:\n%s", keep, out)
		}
	}
}

func TestHelmRedactValues_MasksCredentialKeys(t *testing.T) {
	v := map[string]interface{}{
		"replicaCount": 2,
		"image":        map[string]interface{}{"tag": "1.2.3"},
		"postgresql":   map[string]interface{}{"auth": map[string]interface{}{"password": "s3cret", "username": "app"}},
		"apiKey":       "sk-live-123",
	}
	out := helmRedactValues(v)
	pg := out["postgresql"].(map[string]interface{})["auth"].(map[string]interface{})
	if pg["password"] == "s3cret" || out["apiKey"] == "sk-live-123" {
		t.Fatalf("credentials must be masked: %v", out)
	}
	if pg["username"] != "app" || out["replicaCount"] != 2 || out["image"].(map[string]interface{})["tag"] != "1.2.3" {
		t.Fatalf("ordinary values must be kept: %v", out)
	}
	if helmRedactValues(nil) != nil {
		t.Fatal("nil in, nil out")
	}
}
