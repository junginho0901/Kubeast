package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const argoAppList = `{"apiVersion":"v1","kind":"List","items":[
 {"apiVersion":"argoproj.io/v1alpha1","kind":"Application","metadata":{"name":"alpha-web","namespace":"argocd"},
  "spec":{"project":"shop","source":{"repoURL":"https://git.example/shop.git","path":"web","targetRevision":"main"},"destination":{"server":"https://kubernetes.default.svc","namespace":"shop"},"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}},
  "status":{"sync":{"status":"Synced","revision":"0123456789abcdef"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded","finishedAt":"2026-10-16T01:00:00Z"},"reconciledAt":"2026-10-16T01:05:00Z",
   "resources":[{"kind":"Deployment","namespace":"shop","name":"web","status":"Synced","health":{"status":"Healthy"}}]}},
 {"apiVersion":"argoproj.io/v1alpha1","kind":"Application","metadata":{"name":"api","namespace":"argocd"},
  "spec":{"project":"shop","sources":[{"repoURL":"https://git.example/api.git","path":"deploy"},{"repoURL":"https://charts.example","chart":"redis","targetRevision":"1.2.3"}],"destination":{"name":"prod","namespace":"api"}},
  "status":{"sync":{"status":"OutOfSync","revision":"fedcba9876543210"},"health":{"status":"Degraded","message":"Deployment api has 0/2 replicas"},
   "operationState":{"phase":"Failed","message":"one or more objects failed to apply","startedAt":"2026-10-16T00:50:00Z","finishedAt":"2026-10-16T00:51:00Z","retryCount":2},
   "conditions":[{"type":"SyncError","message":"ConfigMap api-config: forbidden"},{"type":"OrphanedResourceWarning","message":"orphaned"}],
   "resources":[{"kind":"Deployment","namespace":"api","name":"api","status":"OutOfSync","health":{"status":"Degraded","message":"0/2"}},{"kind":"ConfigMap","namespace":"api","name":"api-config","status":"OutOfSync"},{"kind":"Service","namespace":"api","name":"api","status":"Synced","health":{"status":"Healthy"}}]}},
 {"apiVersion":"argoproj.io/v1alpha1","kind":"Application","metadata":{"name":"batch","namespace":"argocd"},
  "spec":{"project":"data","source":{"repoURL":"https://git.example/batch.git","path":"."},"destination":{"server":"https://kubernetes.default.svc","namespace":"batch"}},
  "status":{"sync":{"status":"Synced","revision":"v1.4.0"},"health":{"status":"Progressing","message":"waiting for rollout"},"operationState":{"phase":"Running"}}}
]}`

func TestGitopsStatus_SummaryOrderAndFilters(t *testing.T) {
	calls := fakeKubectl(t, func(args []string) (string, error) {
		if verb(args)[0] == "get" && has(args, argoApplicationsType) {
			return argoAppList, nil
		}
		return "", nil
	})
	out, err := handleGitopsStatus(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if v := verb((*calls)[0]); strings.Join(v, " ") != "get applications.argoproj.io --all-namespaces -o json" {
		t.Fatalf("argv: %v", v)
	}
	m := decode(t, out)
	if m["applications_total"] != float64(3) || m["matched"] != float64(3) || m["scope"] != "all namespaces" {
		t.Fatalf("totals: %s", out)
	}
	counts := m["counts"].(map[string]interface{})
	if counts["sync"].(map[string]interface{})["OutOfSync"] != float64(1) || counts["health"].(map[string]interface{})["Healthy"] != float64(1) || counts["health"].(map[string]interface{})["Progressing"] != float64(1) {
		t.Fatalf("counts: %v", counts)
	}
	apps := m["applications"].([]interface{})
	first := apps[0].(map[string]interface{})
	second := apps[1].(map[string]interface{})
	third := apps[2].(map[string]interface{})
	// Problems first: api (OutOfSync/Degraded/Failed), batch (Progressing), then the healthy
	// alpha-web — which plain name order would have put first.
	if first["name"] != "api" || second["name"] != "batch" || third["name"] != "alpha-web" {
		t.Fatalf("order: %v %v %v", first["name"], second["name"], third["name"])
	}
	if _, leaked := first["problem"]; leaked {
		t.Fatalf("sorting keys must not leak: %v", first)
	}
	if first["sync"].(map[string]interface{})["revision"] != "fedcba98" || first["health"].(map[string]interface{})["message"] != "Deployment api has 0/2 replicas" {
		t.Fatalf("api sync/health: %v", first)
	}
	op := first["operation"].(map[string]interface{})
	if op["phase"] != "Failed" || op["retry_count"] != float64(2) || op["message"] != "one or more objects failed to apply" {
		t.Fatalf("operation: %v", op)
	}
	if first["conditions_total"] != float64(2) || len(first["conditions"].([]interface{})) != 2 {
		t.Fatalf("conditions: %v", first["conditions"])
	}
	res := first["resources"].(map[string]interface{})
	if res["total"] != float64(3) || res["problems"] != float64(2) || len(first["problem_resources"].([]interface{})) != 2 {
		t.Fatalf("resources: %v / %v", res, first["problem_resources"])
	}
	if len(first["sources"].([]interface{})) != 2 || first["destination"].(map[string]interface{})["name"] != "prod" {
		t.Fatalf("sources/destination: %v", first)
	}
	// A tag revision stays whole; a sha is shortened; automated sync is reported.
	if second["sync"].(map[string]interface{})["revision"] != "v1.4.0" || third["sync"].(map[string]interface{})["revision"] != "01234567" {
		t.Fatalf("revisions: %v %v", second["sync"], third["sync"])
	}
	if third["automated"].(map[string]interface{})["prune"] != true || third["source"].(map[string]interface{})["path"] != "web" {
		t.Fatalf("web: %v", third)
	}
	if _, has := third["problem_resources"]; has {
		t.Fatalf("a healthy app lists no problem resources: %v", third)
	}

	fakeKubectl(t, func(args []string) (string, error) { return argoAppList, nil })
	out, _ = handleGitopsStatus(ctxFor("c1"), map[string]interface{}{"only_problems": true, "project": "shop"}, bearer())
	m = decode(t, out)
	apps = m["applications"].([]interface{})
	if m["matched"] != float64(1) || len(apps) != 1 || apps[0].(map[string]interface{})["name"] != "api" {
		t.Fatalf("only_problems + project: %s", out)
	}
	// Counts cover the project filter but not only_problems.
	if m["counts"].(map[string]interface{})["sync"].(map[string]interface{})["Synced"] != float64(1) {
		t.Fatalf("counts after project filter: %v", m["counts"])
	}

	fakeKubectl(t, func(args []string) (string, error) { return argoAppList, nil })
	out, _ = handleGitopsStatus(ctxFor("c1"), map[string]interface{}{"destination_namespace": "batch", "limit": 1}, bearer())
	m = decode(t, out)
	if m["matched"] != float64(1) || m["applications"].([]interface{})[0].(map[string]interface{})["name"] != "batch" {
		t.Fatalf("destination filter: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) { return argoAppList, nil })
	out, _ = handleGitopsStatus(ctxFor("c1"), map[string]interface{}{"limit": 2}, bearer())
	m = decode(t, out)
	if m["truncated"] != true || len(m["applications"].([]interface{})) != 2 || m["matched"] != float64(3) {
		t.Fatalf("limit: %s", out)
	}
}

func TestGitopsStatus_SingleAppScopeAndMissingCRD(t *testing.T) {
	single := `{"apiVersion":"argoproj.io/v1alpha1","kind":"Application","metadata":{"name":"web","namespace":"argocd"},"spec":{"project":"shop"},"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}}`
	calls := fakeKubectl(t, func(args []string) (string, error) { return single, nil })
	out, err := handleGitopsStatus(ctxFor("c1"), map[string]interface{}{"name": "web", "namespace": "argocd"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if v := verb((*calls)[0]); strings.Join(v, " ") != "get applications.argoproj.io web -n argocd -o json" {
		t.Fatalf("argv: %v", v)
	}
	if m := decode(t, out); m["applications_total"] != float64(1) || m["scope"] != "argocd" {
		t.Fatalf("single: %s", out)
	}
	if _, err := handleGitopsStatus(ctxFor("c1"), map[string]interface{}{"name": "web"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("name without namespace: %v", err)
	}
	// A namespace-scoped grant cannot widen to the cluster.
	if _, err := handleGitopsStatus(ctxFor("c1", "shop"), map[string]interface{}{}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("scoped grant: %v", err)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`error: the server doesn't have a resource type "applications"`)
	})
	out, err = handleGitopsStatus(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "unavailable" || m["feature"] != "gitops_status" || !strings.Contains(m["reason"].(string), "management cluster") {
		t.Fatalf("missing CRD is unavailable: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`Error from server (Forbidden): applications.argoproj.io is forbidden: User "r@x" cannot list resource "applications" in API group "argoproj.io" at the cluster scope`)
	})
	out, _ = handleGitopsStatus(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); m["status"] != "forbidden" {
		t.Fatalf("forbidden is a result: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) { return `{"apiVersion":"v1","kind":"List","items":[]}`, nil })
	out, _ = handleGitopsStatus(ctxFor("c1"), map[string]interface{}{"namespace": "argocd"}, bearer())
	if m := decode(t, out); m["applications_total"] != float64(0) || !strings.Contains(m["hint"].(string), "another cluster") {
		t.Fatalf("empty hint: %s", out)
	}

	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"argocd"}}}
	if err := namespaceGate(scoped, "c", "gitops_status", map[string]interface{}{}); err != nil {
		t.Fatalf("gitops_status scopes itself: %v", err)
	}
	for _, args := range []map[string]interface{}{{"project": "shop"}, {"destination_namespace": "api"}} {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v should pass: %v", args, err)
		}
	}
	if err := validateToolArgs(map[string]interface{}{"project": "-n"}); !errors.Is(err, errBadRequest) {
		t.Errorf("project flag refused: %v", err)
	}
}
