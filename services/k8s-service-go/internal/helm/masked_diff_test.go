package helm

import (
	"strings"
	"testing"
)

const fromManifest = `---
apiVersion: v1
kind: Secret
metadata:
  name: app-db
data:
  password: b2xkLXNlY3JldA==
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app
data:
  db_password: old-plain-pass
  replicas: "1"
`

const toManifest = `---
apiVersion: v1
kind: Secret
metadata:
  name: app-db
data:
  password: bmV3LXNlY3JldA==
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app
data:
  db_password: new-plain-pass
  replicas: "2"
`

// The diff of the masked manifests shows the change but no secret, on either
// side; masking the diff output instead leaks (its +/- prefixes hide the YAML
// the masking reads) — the revision diff did that before.
func TestMaskedDiffKeepsSecretsOutOfBothSides(t *testing.T) {
	secrets := []string{"b2xkLXNlY3JldA==", "bmV3LXNlY3JldA==", "old-plain-pass", "new-plain-pass"}
	raw := unifiedDiff("a", "b", fromManifest, toManifest)
	for _, s := range secrets {
		if !strings.Contains(raw, s) {
			t.Fatalf("the raw diff carries %q (fixture check)", s)
		}
	}
	masked := maskedDiff("a", "b", fromManifest, toManifest)
	for _, s := range secrets {
		if strings.Contains(masked, s) {
			t.Errorf("masked diff leaks %q:\n%s", s, masked)
		}
	}
	if !strings.Contains(masked, `-  replicas: "1"`) || !strings.Contains(masked, `+  replicas: "2"`) {
		t.Errorf("the non-secret change stays visible:\n%s", masked)
	}
	leaky := maskText(raw)
	leaked := false
	for _, s := range secrets {
		leaked = leaked || strings.Contains(leaky, s)
	}
	if !leaked {
		t.Error("masking the diff output was expected to leak (if it no longer does, the reason for maskedDiff is gone)")
	}
}
