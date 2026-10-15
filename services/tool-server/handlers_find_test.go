package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func findFixture(args []string) (string, error) {
	v := verb(args)
	switch v[1] {
	case "pods":
		return "shop   web-7d9f8c6b5-x2k9p   map[app:web pod-template-hash:7d9f8c6b5]\nshop   api-1   map[app:api tier:backend]\n", nil
	case "deployments":
		return "shop   web   map[app:web]\n", nil
	case "foo":
		return kubectlErr(`error: the server doesn't have a resource type "foo"`)
	}
	return "", nil
}

func TestFindResource_ByNameAndLabel(t *testing.T) {
	fakeKubectl(t, findFixture)
	out, err := handleFindResource(context.Background(), map[string]interface{}{"query": "web", "kinds": []interface{}{"pods", "deployments", "foo"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	matches, _ := json.Marshal(m["matches"])
	if string(matches) != `[{"kind":"pods","name":"web-7d9f8c6b5-x2k9p","namespace":"shop"},{"kind":"deployments","name":"web","namespace":"shop"}]` {
		t.Fatalf("matches: %s", matches)
	}
	notes, _ := json.Marshal(m["notes"])
	if !strings.Contains(string(notes), `foo`) || m["truncated"] != false {
		t.Fatalf("notes/truncated: %s", out)
	}

	fakeKubectl(t, findFixture)
	out, err = handleFindResource(context.Background(), map[string]interface{}{"query": "app=api", "kinds": "pods,deployments"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	matches, _ = json.Marshal(m["matches"])
	if string(matches) != `[{"kind":"pods","name":"api-1","namespace":"shop"}]` {
		t.Fatalf("label match: %s", matches)
	}

	fakeKubectl(t, findFixture)
	out, err = handleFindResource(context.Background(), map[string]interface{}{"query": "web", "kinds": "pods,deployments", "limit": 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	if m["truncated"] != true || len(m["matches"].([]interface{})) != 1 {
		t.Fatalf("limit: %s", out)
	}

	fakeKubectl(t, findFixture)
	out, err = handleFindResource(context.Background(), map[string]interface{}{"query": "nothing-here", "kinds": "pods"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	if len(m["matches"].([]interface{})) != 0 || !strings.Contains(m["hint"].(string), "Stop searching") {
		t.Fatalf("empty result carries the stop hint: %s", out)
	}
}

func TestFindResource_DefaultKindsAndScope(t *testing.T) {
	calls := fakeKubectl(t, func(args []string) (string, error) { return "", nil })
	if _, err := handleFindResource(context.Background(), map[string]interface{}{"query": "web"}, nil); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != len(findDefaultKinds) || !has(verb((*calls)[0]), "--all-namespaces") {
		t.Fatalf("one all-namespaces call per default kind, got %d", len(*calls))
	}

	payload := auth.TokenPayload{Namespaces: map[string][]string{"c": {"shop", "web"}}}
	ctx := auth.WithPayload(withClusterID(context.Background(), "c"), payload)
	calls = fakeKubectl(t, func(args []string) (string, error) { return "", nil })
	out, err := handleFindResource(ctx, map[string]interface{}{"query": "web", "kinds": "pods"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 2 || has(verb((*calls)[0]), "--all-namespaces") || !has(verb((*calls)[0]), "shop") || !has(verb((*calls)[1]), "web") {
		t.Fatalf("scoped grant: one call per granted namespace: %v", *calls)
	}
	searched, _ := json.Marshal(decode(t, out)["searched"])
	if string(searched) != `{"kinds":["pods"],"namespaces":["shop","web"]}` {
		t.Fatalf("searched: %s", searched)
	}
}

func TestFindResource_BadArgs(t *testing.T) {
	fakeKubectl(t, func(args []string) (string, error) { t.Fatal("kubectl must not run"); return "", nil })
	if _, err := handleFindResource(context.Background(), map[string]interface{}{}, nil); !errors.Is(err, errBadRequest) {
		t.Fatalf("empty query: %v", err)
	}
	many := make([]interface{}, findMaxKinds+1)
	for i := range many {
		many[i] = "pods"
	}
	if _, err := handleFindResource(context.Background(), map[string]interface{}{"query": "web", "kinds": many}, nil); !errors.Is(err, errBadRequest) {
		t.Fatalf("too many kinds: %v", err)
	}
}

func TestLabelMatch(t *testing.T) {
	labels := "map[app:web pod-template-hash:7d9f8c6b5 tier:frontend]"
	for _, ok := range [][2]string{{"app", "web"}, {"tier", "frontend"}, {"pod-template-hash", "7d9f8c6b5"}} {
		if !labelMatch(labels, ok[0], ok[1]) {
			t.Errorf("%s=%s should match", ok[0], ok[1])
		}
	}
	for _, bad := range [][2]string{{"app", "we"}, {"pp", "web"}, {"tier", "front"}, {"myapp", "web"}} {
		if labelMatch(labels, bad[0], bad[1]) {
			t.Errorf("%s=%s must not match", bad[0], bad[1])
		}
	}
	if !labelMatch("map[app:web]", "app", "web") || labelMatch("<none>", "app", "web") {
		t.Fatal("single label / no labels")
	}
}

func TestExplain(t *testing.T) {
	calls := fakeKubectl(t, func(args []string) (string, error) { return "KIND: Deployment\nFIELD: replicas <integer>\n", nil })
	out, err := handleExplain(context.Background(), map[string]interface{}{"resource": "deployments.spec.replicas", "api_version": "apps/v1", "recursive": true}, nil)
	if err != nil || !strings.Contains(out, "replicas") {
		t.Fatalf("explain: %v %q", err, out)
	}
	v := verb((*calls)[0])
	if strings.Join(v, " ") != "explain deployments.spec.replicas --api-version=apps/v1 --recursive" {
		t.Fatalf("argv: %v", v)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		if verb(args)[0] == "api-resources" {
			return "deployments.apps\n", nil
		}
		return kubectlErr(`error: the server doesn't have a resource type "deploymnet"`)
	})
	out, err = handleExplain(context.Background(), map[string]interface{}{"resource": "deploymnet"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if decode(t, out)["status"] != "unknown_kind" {
		t.Fatalf("unknown kind: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) { return kubectlErr(`error: field "spec.foo" does not exist`) })
	out, err = handleExplain(context.Background(), map[string]interface{}{"resource": "deployments.spec.foo"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if decode(t, out)["status"] != "unknown_field" {
		t.Fatalf("unknown field: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) { return strings.Repeat("x", explainMaxBytes+10), nil })
	out, err = handleExplain(context.Background(), map[string]interface{}{"resource": "pods", "recursive": true}, nil)
	if err != nil || !strings.Contains(out, "truncated by tool-server") || len(out) > explainMaxBytes+len(truncatedMarker)+16 {
		t.Fatalf("explain is capped: %v %d", err, len(out))
	}

	if _, err := handleExplain(context.Background(), map[string]interface{}{}, nil); !errors.Is(err, errBadRequest) {
		t.Fatalf("resource required: %v", err)
	}
}
