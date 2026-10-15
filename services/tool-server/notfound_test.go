package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// fakeKubectl scripts kubectlExec for one test and records every argv.
func fakeKubectl(t *testing.T, respond func(args []string) (string, error)) *[][]string {
	t.Helper()
	orig := kubectlExec
	var calls [][]string
	kubectlExec = func(_ context.Context, args []string, _ *string) ([]byte, error) {
		calls = append(calls, args)
		out, err := respond(args)
		return []byte(out), err
	}
	t.Cleanup(func() { kubectlExec = orig })
	return &calls
}

// verb strips the kubeconfig/impersonation prefix kubectlArgs may add.
func verb(args []string) []string {
	for i, a := range args {
		switch a {
		case "get", "describe", "logs", "explain", "top", "api-resources", "config", "version":
			return args[i:]
		}
	}
	return args
}

func has(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func kubectlErr(text string) (string, error) { return text, errors.New("exit status 1") }

func decode(t *testing.T, s string) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, s)
	}
	return m
}

func TestClassifyKubectlFailure(t *testing.T) {
	cases := []struct {
		text   string
		status string
		kind   string
		name   string
	}{
		{`kubectl failed: Error from server (NotFound): pods "web" not found`, "not_found", "pods", "web"},
		{`kubectl failed: Error from server (NotFound): deployments.apps "web" not found`, "not_found", "deployments.apps", "web"},
		// kubectl logs words it differently from get/describe.
		{`kubectl failed: error: error from server (NotFound): pods "web" not found in namespace "shop"`, "not_found", "pods", "web"},
		{`kubectl failed: error: the server doesn't have a resource type "deploymnet"`, "unknown_kind", "deploymnet", ""},
		{`kubectl failed: Error from server (BadRequest): previous terminated container "app" in pod "web-1" not found`, "no_previous", "pods", "web-1"},
		{`kubectl failed: error: a container name must be specified for pod web-1, choose one of: [app sidecar]`, "container_required", "pods", "web-1"},
		{`kubectl failed: error: Metrics API not available`, "unavailable", "metrics-server", ""},
	}
	for _, c := range cases {
		f, ok := classifyKubectlFailure(errors.New(c.text))
		if !ok || f.Status != c.status || f.Kind != c.kind || f.Name != c.name {
			t.Errorf("%s → %+v (ok=%v), want %s/%s/%s", c.text, f, ok, c.status, c.kind, c.name)
		}
	}
	if _, ok := classifyKubectlFailure(errors.New("kubectl failed: Unable to connect to the server: dial tcp: i/o timeout")); ok {
		t.Fatal("a connection error is not a failure the model can act on")
	}
	if f, _ := classifyKubectlFailure(errors.New(`kubectl failed: error: a container name must be specified for pod web-1, choose one of: [app sidecar]`)); strings.Join(f.Containers, ",") != "app,sidecar" {
		t.Fatalf("containers: %v", f.Containers)
	}
}

func TestStripHash(t *testing.T) {
	cases := map[string]string{
		"web-7d9f8c6b5-x2k9p":                  "web",
		"kubeast-auth-service-6c8f9d7b4-x2k9p": "kubeast-auth-service",
		"redis-cache":                          "redis-cache",
		"web-1":                                "web-1",
		"api-5bkd8":                            "api",
		"web":                                  "web",
	}
	for in, want := range cases {
		if got := stripHash(in); got != want {
			t.Errorf("stripHash(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSimilarNames_RanksAndCaps(t *testing.T) {
	cands := []namedObject{
		{"db", "redis-cache"},
		{"shop", "wep"},
		{"shop", "webhook-receiver"},
		{"shop", "web-7d9f8c6b5-x2k9p"},
		{"ops", "frontend-web-proxy"},
	}
	got := similarNames("web", cands)
	names := make([]string, 0, len(got))
	for _, m := range got {
		names = append(names, m["namespace"]+"/"+m["name"])
	}
	want := "shop/web-7d9f8c6b5-x2k9p shop/webhook-receiver ops/frontend-web-proxy shop/wep"
	if strings.Join(names, " ") != want {
		t.Fatalf("ranking:\n got %v\nwant %s", names, want)
	}

	var many []namedObject
	for i := 0; i < 15; i++ {
		many = append(many, namedObject{"ns", "web-" + strings.Repeat("x", i+1)})
	}
	if n := len(similarNames("web", many)); n != 10 {
		t.Fatalf("cap at ten, got %d", n)
	}
	if n := len(similarNames("web", []namedObject{{"ns", "postgres"}})); n != 0 {
		t.Fatalf("unrelated names are not suggested: %d", n)
	}
}

func TestDescribe_NotFoundBecomesStructuredResult(t *testing.T) {
	calls := fakeKubectl(t, func(args []string) (string, error) {
		v := verb(args)
		switch {
		case v[0] == "describe":
			return kubectlErr(`Error from server (NotFound): pods "web" not found`)
		case v[0] == "get" && v[1] == "namespace":
			return "namespace/shop\n", nil
		case v[0] == "get" && v[1] == "pods" && has(v, "--all-namespaces"):
			return "shop   web-7d9f8c6b5-x2k9p\nshop   api-5bkd8-7p2kq\nkube-system   coredns-xk2lp\n", nil
		}
		t.Fatalf("unexpected kubectl %v", v)
		return "", nil
	})
	out, err := handleDescribeResource(context.Background(), map[string]interface{}{"resource_type": "pods", "resource_name": "web", "namespace": "shop"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["status"] != "not_found" || m["namespace_exists"] != true || m["searched"] != "all namespaces" {
		t.Fatalf("result: %s", out)
	}
	similar := m["similar"].([]interface{})
	if len(similar) != 1 || similar[0].(map[string]interface{})["name"] != "web-7d9f8c6b5-x2k9p" {
		t.Fatalf("similar: %v", similar)
	}
	if !strings.Contains(m["hint"].(string), "hash suffix") {
		t.Fatalf("hint: %v", m["hint"])
	}
	if len(*calls) != 3 {
		t.Fatalf("one describe + two follow-ups, got %d calls", len(*calls))
	}
}

func TestNotFound_ScopedGrantSearchesOnlyItsNamespaces(t *testing.T) {
	calls := fakeKubectl(t, func(args []string) (string, error) {
		v := verb(args)
		if v[0] == "get" && v[1] == "pods" && v[2] == "web" {
			return kubectlErr(`Error from server (NotFound): pods "web" not found`)
		}
		if v[0] == "get" && v[1] == "namespace" {
			return "namespace/shop\n", nil
		}
		return "", nil
	})
	payload := auth.TokenPayload{Namespaces: map[string][]string{"c": {"shop", "web"}}}
	ctx := auth.WithPayload(withClusterID(context.Background(), "c"), payload)
	out, err := handleGetResources(ctx, map[string]interface{}{"resource_type": "pods", "resource_name": "web", "namespace": "shop"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if s, _ := json.Marshal(m["searched"]); string(s) != `["shop","web"]` {
		t.Fatalf("searched: %s", s)
	}
	for _, c := range *calls {
		if has(c, "--all-namespaces") {
			t.Fatalf("a scoped grant must not list the whole cluster: %v", c)
		}
	}
}

func TestGetResources_UnknownKind(t *testing.T) {
	fakeKubectl(t, func(args []string) (string, error) {
		v := verb(args)
		if v[0] == "api-resources" {
			return "deployments.apps\npods\nservices\n", nil
		}
		return kubectlErr(`error: the server doesn't have a resource type "deploymnet"`)
	})
	out, err := handleGetResources(context.Background(), map[string]interface{}{"resource_type": "deploymnet"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	kinds, _ := json.Marshal(m["similar_kinds"])
	if m["status"] != "unknown_kind" || m["kind"] != "deploymnet" || !strings.Contains(string(kinds), "deployments.apps") {
		t.Fatalf("result: %s", out)
	}
}

func TestNodeMetrics_Unavailable(t *testing.T) {
	fakeKubectl(t, func(args []string) (string, error) { return kubectlErr("error: Metrics API not available") })
	out, err := handleGetNodeMetrics(context.Background(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["status"] != "unavailable" || m["feature"] != "metrics-server" || !strings.Contains(m["alternative"].(string), "k8s_describe_resource") {
		t.Fatalf("result: %s", out)
	}
}

func TestPodLogs_FlagsAndGrep(t *testing.T) {
	calls := fakeKubectl(t, func(args []string) (string, error) {
		return "a\nERROR one\nb\nerror two\nerror three\n", nil
	})
	out, err := handleGetPodLogs(context.Background(), map[string]interface{}{
		"pod_name": "web-1", "namespace": "shop", "previous": true, "since": "10m", "all_containers": true, "grep": "error", "tail_lines": 2,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	v := verb((*calls)[0])
	for _, want := range []string{"--previous", "--since=10m", "--all-containers=true", "--prefix", "2000"} {
		if !has(v, want) {
			t.Fatalf("argv missing %s: %v", want, v)
		}
	}
	if has(v, "-c") {
		t.Fatalf("all_containers replaces -c: %v", v)
	}
	want := "# grep \"error\": 3 of 5 lines matched, showing the last 2\nerror two\nerror three"
	if out != want {
		t.Fatalf("grep output:\n%s\nwant:\n%s", out, want)
	}

	calls = fakeKubectl(t, func(args []string) (string, error) { return "x\n", nil })
	if _, err := handleGetPodLogs(context.Background(), map[string]interface{}{"pod_name": "web-1", "namespace": "shop", "container": "app"}, nil); err != nil {
		t.Fatal(err)
	}
	v = verb((*calls)[0])
	if !has(v, "-c") || has(v, "--previous") || has(v, "--prefix") || !has(v, "50") {
		t.Fatalf("plain call unchanged: %v", v)
	}
}

func TestPodLogs_NoPreviousAndContainerRequired(t *testing.T) {
	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`Error from server (BadRequest): previous terminated container "app" in pod "web-1" not found`)
	})
	out, err := handleGetPodLogs(context.Background(), map[string]interface{}{"pod_name": "web-1", "namespace": "shop", "previous": true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "no_previous" || m["container"] != "app" {
		t.Fatalf("result: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`error: a container name must be specified for pod web-1, choose one of: [app sidecar]`)
	})
	out, err = handleGetPodLogs(context.Background(), map[string]interface{}{"pod_name": "web-1", "namespace": "shop"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	containers, _ := json.Marshal(m["containers"])
	if m["status"] != "container_required" || string(containers) != `["app","sidecar"]` {
		t.Fatalf("result: %s", out)
	}
}

func TestGetEvents_SelectorsAndScope(t *testing.T) {
	calls := fakeKubectl(t, func(args []string) (string, error) { return `{"items":[]}`, nil })
	if _, err := handleGetEvents(context.Background(), map[string]interface{}{
		"namespace": "shop", "field_selector": "type=Warning", "kind": "pods", "name": "web-1",
	}, nil); err != nil {
		t.Fatal(err)
	}
	v := verb((*calls)[0])
	if !has(v, "--field-selector=type=Warning,involvedObject.kind=Pod,involvedObject.name=web-1") || !has(v, "shop") || has(v, "--all-namespaces") {
		t.Fatalf("argv: %v", v)
	}

	calls = fakeKubectl(t, func(args []string) (string, error) { return `{"items":[]}`, nil })
	if _, err := handleGetEvents(context.Background(), map[string]interface{}{"namespace": "shop", "all_namespaces": true}, nil); err != nil {
		t.Fatal(err)
	}
	v = verb((*calls)[0])
	if !has(v, "--all-namespaces") || has(v, "-n") {
		t.Fatalf("all_namespaces wins: %v", v)
	}
	for _, c := range v {
		if strings.HasPrefix(c, "--field-selector") {
			t.Fatalf("no selector when none asked: %v", v)
		}
	}
}

func TestEventKindName(t *testing.T) {
	cases := map[string]string{"pods": "Pod", "Pod": "Pod", "deployment": "Deployment", "ingresses": "Ingress", "hpa": "HorizontalPodAutoscaler", "statefulsets": "StatefulSet", "Rollout": "Rollout"}
	for in, want := range cases {
		if got := eventKindName(in); got != want {
			t.Errorf("eventKindName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestServiceConnectivity_NotFoundSuggests(t *testing.T) {
	fakeKubectl(t, func(args []string) (string, error) {
		v := verb(args)
		switch {
		case v[0] == "get" && v[1] == "svc":
			return kubectlErr(`Error from server (NotFound): services "api" not found`)
		case v[0] == "get" && v[1] == "namespace":
			return kubectlErr(`Error from server (NotFound): namespaces "shp" not found`)
		case v[0] == "get" && v[1] == "services":
			return "shop   api-gateway\nshop   web\n", nil
		}
		return "", nil
	})
	out, err := handleCheckServiceConnectivity(context.Background(), map[string]interface{}{"service_name": "api", "namespace": "shp"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	similar, _ := json.Marshal(m["similar"])
	if m["status"] != "NotFound" || m["namespace_exists"] != false || !strings.Contains(string(similar), "api-gateway") {
		t.Fatalf("result: %s", out)
	}
}
