package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
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

// downAudit is an audit store that cannot take a row (the fail-closed check fails).
type downAudit struct{ memAudit }

func (d *downAudit) Ready(context.Context) error { return audit.ErrUnavailable }

// A dry-run's manifest diff follows the revision diff's rules: masked without
// resource.secret.reveal, in full with it and a helm.release.reveal row, and
// refused (503, nothing shown) when that row cannot be recorded.
func TestDryRunDiffIsARevealLikeTheRevisionDiff(t *testing.T) {
	diff := "+kind: Secret\n+data:\n+  password: c2VjcmV0\n"
	masked := "(the diff of the masked manifests)"
	req := func(perms ...string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/helm/releases/ns/rel/rollback", nil)
		ctx := context.WithValue(r.Context(), auth.TokenPayloadContextKey(),
			auth.TokenPayload{UserID: "u1", Email: "dev@example.com", Perms: auth.PermissionMatrix{"self": perms}})
		return r.WithContext(cluster.WithID(ctx, cluster.ID("self")))
	}

	store := &memAudit{}
	h := &Handler{auditStore: store}
	got := diff
	if !h.revealDryRunDiff(httptest.NewRecorder(), req("resource.helm.rollback"), "ns", "rel", "rollback dry-run", &got, masked) {
		t.Fatal("masked diff must be answered")
	}
	if got != masked || len(store.rows) != 0 {
		t.Fatalf("without reveal: masked and no row, got %q rows %d", got, len(store.rows))
	}

	got = diff
	if !h.revealDryRunDiff(httptest.NewRecorder(), req("resource.helm.rollback", "resource.secret.reveal"), "ns", "rel", "rollback dry-run", &got, masked) {
		t.Fatal("revealed diff must be answered")
	}
	if got != diff || len(store.rows) != 1 || store.rows[0].Action != "helm.release.reveal" || !strings.Contains(string(store.rows[0].After), "rollback dry-run") {
		t.Fatalf("with reveal: full text and one reveal row, got %q rows %+v", got, store.rows)
	}

	down := &Handler{auditStore: &downAudit{}}
	w := httptest.NewRecorder()
	got = diff
	if down.revealDryRunDiff(w, req("resource.helm.rollback", "resource.secret.reveal"), "ns", "rel", "rollback dry-run", &got, masked) || w.Code != http.StatusServiceUnavailable {
		t.Fatalf("audit down: refused with 503, got %d", w.Code)
	}

	empty := ""
	if !h.revealDryRunDiff(httptest.NewRecorder(), req("resource.helm.rollback", "resource.secret.reveal"), "ns", "rel", "rollback dry-run", &empty, masked) || len(store.rows) != 1 {
		t.Fatal("an empty diff reveals nothing and writes no row")
	}
}
