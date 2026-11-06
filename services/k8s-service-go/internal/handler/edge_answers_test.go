package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/helm"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// breakerAfter says whether a cluster counts as down after one request whose handler is next.
func breakerAfter(t *testing.T, next http.HandlerFunc) bool {
	t.Helper()
	svc, err := k8s.NewService(context.Background(), middlewareRegistry{}, false, nil, k8s.ServiceOptions{BreakerFails: 1})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{svc: svc, auditStore: &memAudit{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/cluster/overview?cluster=known", nil)
	req = req.WithContext(auth.WithPayload(req.Context(), auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}))
	h.ClusterMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { next(w, r) })).ServeHTTP(httptest.NewRecorder(), req)
	return svc.ClusterDown("known")
}

func TestAnAnswerFromKubeastItselfDoesNotMarkTheClusterDown(t *testing.T) {
	for name, msg := range map[string]string{
		"the audit store":    audit.ErrUnavailable.Error(),
		"session recording":  "session recording unavailable",
		"the sign-off store": "hygiene sign-off store unavailable",
	} {
		down := breakerAfter(t, func(w http.ResponseWriter, _ *http.Request) {
			response.Error(w, http.StatusServiceUnavailable, msg)
		})
		if down {
			t.Errorf("%s being unavailable marked the cluster down", name)
		}
	}
}

func TestAFailedCallToTheClusterStillMarksItDown(t *testing.T) {
	h := &Handler{}
	for _, msg := range []string{"dial tcp 10.0.0.9:6443: connect: connection refused", "connection refused", "i/o timeout"} {
		down := breakerAfter(t, func(w http.ResponseWriter, _ *http.Request) {
			h.handleError(w, errors.New(msg))
		})
		if !down {
			t.Errorf("%q did not mark the cluster down", msg)
		}
	}
}

func TestAFailedHelmTestKeepsItsHookResults(t *testing.T) {
	hooks := []helm.TestHookResult{{Name: "smoke", Phase: "Failed", Failed: true}, {Name: "db", Phase: "Succeeded"}}
	result := &helm.TestResult{Success: false, Hooks: hooks}
	status, body := helmTestAnswer(result, errors.New("pod smoke failed"))
	if status != http.StatusOK {
		t.Fatalf("status %d: a failing hook is the test's answer, not the service's failure", status)
	}
	got, ok := body.(*helm.TestResult)
	if !ok || got.Success || len(got.Hooks) != 2 || got.Hooks[0].Name != "smoke" || !got.Hooks[0].Failed {
		t.Fatalf("body = %+v", body)
	}
	if got.Error != "pod smoke failed" {
		t.Fatalf("error = %q", got.Error)
	}
}

func TestAHelmTestThatNeverRanStaysAFailure(t *testing.T) {
	for name, result := range map[string]*helm.TestResult{"no result": nil, "no hooks": {Success: false}} {
		status, body := helmTestAnswer(result, errors.New("release not found"))
		if status != 0 || body != nil {
			t.Errorf("%s: status %d body %+v, want the error handled as one", name, status, body)
		}
	}
}

func TestAPassedHelmTestIsAnswered(t *testing.T) {
	result := &helm.TestResult{Success: true, Hooks: []helm.TestHookResult{{Name: "smoke", Phase: "Succeeded"}}}
	status, body := helmTestAnswer(result, nil)
	if status != http.StatusOK || body != any(result) {
		t.Fatalf("status %d body %+v", status, body)
	}
}

func TestValuesThatDoNotParseOrFitTheSchemaAreARequestError(t *testing.T) {
	for name, tc := range map[string]struct{ schema, values string }{
		"not YAML":                        {"", "a: [unclosed\n"},
		"not a map":                       {"", "- one\n- two\n"},
		"the chart's schema refuses them": {`{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"replicas":{"type":"integer"}}}`, "replicas: lots\n"},
	} {
		w, _ := upgradeValues(t, tc.schema, tc.values)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d %s, want 400", name, w.Code, w.Body)
		}
	}
}

func TestAWriteRowKeepsNoValueTheAPIServerQuoted(t *testing.T) {
	store := &memAudit{}
	h := &Handler{auditStore: store}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/resources/yaml/apply", nil)
	req = req.WithContext(auth.WithPayload(cluster.WithID(req.Context(), "c"), auth.TokenPayload{UserID: "u1"}))
	cause := errors.New(`Deployment.apps "web" is invalid: spec.template.spec.containers[0].env[0].value: Invalid value: "fake-secret-value": must not have spaces`)
	if err := h.recordAuditWithPayload(req, "k8s.yaml.apply", "deployments", "web", "shop", cause, nil, nil); err != nil {
		t.Fatal(err)
	}
	row := store.rows[0]
	if strings.Contains(row.Error, "fake-secret-value") {
		t.Fatalf("row error holds the value: %s", row.Error)
	}
	if !strings.Contains(row.Error, "spec.template.spec.containers[0].env[0].value: Invalid value") || !strings.Contains(row.Error, "must not have spaces") {
		t.Fatalf("row error lost what was wrong: %s", row.Error)
	}
}

// aggregatedDown is an API server with one aggregated API that does not answer.
func aggregatedDown(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	switch r.URL.Path {
	case "/api":
		write(map[string]any{"kind": "APIVersions", "versions": []string{"v1"}})
	case "/apis":
		group := func(name, version string) map[string]any {
			gv := map[string]any{"groupVersion": name + "/" + version, "version": version}
			return map[string]any{"name": name, "versions": []any{gv}, "preferredVersion": gv}
		}
		write(map[string]any{"kind": "APIGroupList", "groups": []any{group("apps", "v1"), group("metrics.k8s.io", "v1beta1")}})
	case "/api/v1":
		write(map[string]any{"kind": "APIResourceList", "groupVersion": "v1", "resources": []any{
			map[string]any{"name": "pods", "singularName": "pod", "namespaced": true, "kind": "Pod", "verbs": []string{"get", "list"}},
		}})
	case "/apis/apps/v1":
		write(map[string]any{"kind": "APIResourceList", "groupVersion": "apps/v1", "resources": []any{
			map[string]any{"name": "deployments", "singularName": "deployment", "namespaced": true, "kind": "Deployment", "verbs": []string{"get", "list"}},
		}})
	default:
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"ServiceUnavailable","code":503,"message":"the server is currently unable to handle the request"}`)
	}
}

func TestOneDeadAggregatedAPILeavesTheOtherKindsReadable(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(aggregatedDown))
	defer api.Close()
	blob := strings.Replace(middlewareKubeconfig, "https://127.0.0.1:6443", api.URL, 1)
	svc, err := k8s.NewService(context.Background(), canIRegistry{blob: blob}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	lists, err := svc.GetAPIResources(cluster.WithID(context.Background(), "c"))
	if err != nil {
		t.Fatalf("discovery failed as a whole: %v", err)
	}
	seen := map[string]bool{}
	for _, list := range lists {
		for _, res := range list.APIResources {
			seen[res.Name] = true
		}
	}
	if !seen["pods"] || !seen["deployments"] {
		t.Fatalf("served kinds left out: %v", seen)
	}
}
