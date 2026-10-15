package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const queryPodList = `{"apiVersion":"v1","kind":"List","items":[
 {"metadata":{"name":"web-1","namespace":"shop"},"status":{"phase":"Running"},"spec":{"nodeName":"n1"}},
 {"metadata":{"name":"web-2","namespace":"shop"},"status":{"phase":"Pending"},"spec":{"nodeName":"n2"}},
 {"metadata":{"name":"api-1","namespace":"db"},"status":{"phase":"Running"},"spec":{"nodeName":"n1"}}]}`

func TestJQQuery_FilterCapsAndErrors(t *testing.T) {
	calls := fakeKubectl(t, func(args []string) (string, error) { return "Warning: deprecated\n" + queryPodList, nil })
	out, err := handleJQQuery(ctxFor("c1"), map[string]interface{}{
		"resource_type": "pods", "jq": `.items[] | select(.status.phase != "Running") | .metadata.name`, "label_selector": "app=web", "field_selector": "status.phase!=Succeeded",
	}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	v := verb((*calls)[0])
	if !has(v, "--all-namespaces") || !has(v, "-l") || !has(v, "app=web") || !has(v, "--field-selector=status.phase!=Succeeded") || !has(v, "json") {
		t.Fatalf("argv: %v", v)
	}
	m := decode(t, out)
	results, _ := json.Marshal(m["results"])
	if string(results) != `["web-2"]` || m["total_items_processed"] != float64(3) || m["matches_found"] != float64(1) || m["scope"] != "all namespaces" {
		t.Fatalf("result: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	out, _ = handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "namespace": "shop", "jq": ".items[].metadata.name", "limit": 1}, bearer())
	m = decode(t, out)
	if m["truncated"] != true || m["matches_found"] != float64(3) || len(m["results"].([]interface{})) != 1 || m["scope"] != "shop" {
		t.Fatalf("limit: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	out, _ = handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "jq": `.items[] | select(.metadata.name == "nope")`}, bearer())
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "matched nothing") {
		t.Fatalf("empty hint: %s", out)
	}

	// The environment is not visible to the program.
	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	t.Setenv("SECRET_THING", "leak")
	out, err = handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "jq": `[env.SECRET_THING, $ENV.SECRET_THING, (env | length)]`}, bearer())
	if err != nil || strings.Contains(out, "leak") || !strings.Contains(out, `[null,null,0]`) {
		t.Fatalf("env must be empty: %v %s", err, out)
	}

	fakeKubectl(t, func(args []string) (string, error) { t.Fatal("kubectl must not run for a bad program"); return "", nil })
	if _, err := handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "jq": ".items[ | "}, bearer()); !errors.Is(err, errBadRequest) || !strings.Contains(err.Error(), "jq:") {
		t.Fatalf("syntax error is the caller's: %v", err)
	}
	if _, err := handleJQQuery(ctxFor("c1"), map[string]interface{}{"jq": "."}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("resource_type required: %v", err)
	}

	// A runtime error inside the program is the caller's too.
	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	if _, err := handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "jq": `.items[0].metadata.name | .foo`}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("runtime error: %v", err)
	}

	// A scoped grant without a namespace is refused before kubectl runs.
	ctx := auth.WithPayload(withClusterID(context.Background(), "c1"), auth.TokenPayload{Namespaces: map[string][]string{"c1": {"shop"}}})
	if _, err := handleJQQuery(ctx, map[string]interface{}{"resource_type": "pods", "jq": ".", "all_namespaces": true}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("scoped grant needs a namespace: %v", err)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`error: the server doesn't have a resource type "pod2"`)
	})
	out, err = handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pod2", "jq": "."}, bearer())
	if err != nil || decode(t, out)["status"] != "unknown_kind" {
		t.Fatalf("unknown kind is a result: %v %s", err, out)
	}
}

func TestTabularQuery_ColumnsSortCap(t *testing.T) {
	var rows []string
	for i := 0; i < tabularRowsCap+5; i++ {
		rows = append(rows, "shop   web-"+strings.Repeat("x", i%7)+"   Running")
	}
	calls := fakeKubectl(t, func(args []string) (string, error) {
		return "NAMESPACE   NAME   PHASE\n" + strings.Join(rows, "\n") + "\n", nil
	})
	out, err := handleTabularQuery(ctxFor("c1"), map[string]interface{}{
		"resource_type": "pods", "columns": "NAMESPACE:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase", "sort_by": ".metadata.name", "limit": 10,
	}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	v := verb((*calls)[0])
	if !has(v, "custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase") || !has(v, "--sort-by=.metadata.name") {
		t.Fatalf("argv: %v", v)
	}
	lines := strings.Split(out, "\n")
	if !strings.HasPrefix(lines[0], "# pods in all namespaces: 205 rows, showing the first 10") || lines[1] != "NAMESPACE   NAME   PHASE" || len(lines) != 12 {
		t.Fatalf("table:\n%s", strings.Join(lines[:3], "\n"))
	}

	calls = fakeKubectl(t, func(args []string) (string, error) { return "NAMESPACE   NAME\n", nil })
	out, _ = handleTabularQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "namespace": "shop"}, bearer())
	if !has(verb((*calls)[0]), "custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name") || !strings.Contains(out, "0 rows (none)") {
		t.Fatalf("defaults: %v / %s", verb((*calls)[0]), out)
	}
}

func TestCount_GroupBy(t *testing.T) {
	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	out, err := handleCount(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "group_by": ".status.phase"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	groups, _ := json.Marshal(m["groups"])
	if m["count"] != float64(3) || string(groups) != `[{"count":2,"key":"Running"},{"count":1,"key":"Pending"}]` {
		t.Fatalf("groups: %s", out)
	}
	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	out, _ = handleCount(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "group_by": ".spec.missing"}, bearer())
	missing := decode(t, out)["groups"].([]interface{})
	if len(missing) != 1 || missing[0].(map[string]interface{})["key"] != "<none>" || missing[0].(map[string]interface{})["count"] != float64(3) {
		t.Fatalf("missing field: %s", out)
	}
	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	out, _ = handleCount(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "namespace": "shop"}, bearer())
	if m := decode(t, out); m["count"] != float64(3) || m["groups"] != nil || m["scope"] != "shop" {
		t.Fatalf("plain count: %s", out)
	}
}

func TestQueryArgsAndGate(t *testing.T) {
	for _, args := range []map[string]interface{}{
		{"jq": `.items[] | select(.status.phase == "Running")`}, {"columns": "NAME:.metadata.name,IMG:.spec.containers[*].image"},
		{"sort_by": ".metadata.creationTimestamp"}, {"group_by": ".spec.nodeName"}, {"label_selector": "app=web,tier!=db"}, {"label_selector": "env in (prod,staging)"},
	} {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v should pass: %v", args, err)
		}
	}
	for _, args := range []map[string]interface{}{
		{"jq": strings.Repeat(".", 1001)}, {"columns": "NAME"}, {"columns": "NAME:.a;rm"}, {"sort_by": "metadata.name"}, {"group_by": ".a b"},
		{"label_selector": "--all"}, {"label_selector": "a\nb"},
	} {
		if err := validateToolArgs(args); !errors.Is(err, errBadRequest) {
			t.Errorf("%v should be refused: %v", args, err)
		}
	}
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"shop"}}}
	if err := namespaceGate(scoped, "c", "k8s_diff", map[string]interface{}{"yaml_content": "x"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("a preview names its own object: refused for a scoped grant: %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_count", map[string]interface{}{"resource_type": "pods"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("count without a namespace is refused for a scoped grant: %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_jq_query", map[string]interface{}{"resource_type": "pods", "namespace": "shop"}); err != nil {
		t.Fatalf("own namespace: %v", err)
	}
}
