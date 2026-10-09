package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func TestPermResource(t *testing.T) {
	cases := map[string]string{
		"ConfigMap":                "configmap",
		"Deployment":               "deployment",
		"Endpoints":                "endpoints",
		"HorizontalPodAutoscaler":  "hpa",
		"VerticalPodAutoscaler":    "vpa",
		"PodDisruptionBudget":      "pdb",
		"PersistentVolume":         "pv",
		"PersistentVolumeClaim":    "pvc",
		"CustomResourceDefinition": "crd",
		"BackendTLSPolicy":         "backendtlspolicy",
		"ModelConfig":              "customresource",
		"":                         "customresource",
	}
	for kind, want := range cases {
		if got := permResource(kind); got != want {
			t.Errorf("permResource(%q) = %q, want %q", kind, got, want)
		}
	}
}

// Every document of a YAML create needs the create permission of its own kind:
// a grant on ConfigMaps does not let a Secret through in the same request.
func TestCreateFromYAMLChecksEachKind(t *testing.T) {
	svc, err := k8s.NewService(context.Background(), middlewareRegistry{}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{svc: svc}
	writer := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"known": {"resource.configmap.create"}}}
	call := func(yaml string) *httptest.ResponseRecorder {
		body := `{"yaml":` + jsonString(yaml) + `,"namespace":"default"}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/resources/yaml/create", strings.NewReader(body))
		ctx := cluster.WithID(auth.WithPayload(req.Context(), writer), "known")
		rec := httptest.NewRecorder()
		h.CreateResourcesFromYAML(rec, req.WithContext(ctx))
		return rec
	}
	cm := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n"
	secret := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: b\n"

	if rec := call(cm + "---\n" + secret); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "resource.secret.create") {
		t.Errorf("ConfigMap + Secret: status %d body %s, want 403 naming resource.secret.create", rec.Code, rec.Body.String())
	}
	// Past the permission check the request reaches the (unreachable) cluster.
	if rec := call(cm); rec.Code == http.StatusForbidden {
		t.Errorf("ConfigMap alone: refused with %s", rec.Body.String())
	}
}

func jsonString(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return `"` + r.Replace(s) + `"`
}
