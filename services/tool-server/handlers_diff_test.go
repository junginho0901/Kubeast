package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

const dryRunCM = `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"app","namespace":"shop","uid":"u1","resourceVersion":"99","creationTimestamp":"2026-10-15T00:00:00Z","managedFields":[{"manager":"kubectl"}],"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{}","team":"shop"}},"data":{"a":"2","b":"x"}}`
const liveCM = `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"app","namespace":"shop","uid":"u1","resourceVersion":"42","creationTimestamp":"2026-10-15T00:00:00Z","managedFields":[{"manager":"helm"}],"annotations":{"team":"shop"}},"data":{"a":"1","b":"x"}}`

func TestDiff_ChangedCreatedUnchangedAndRefusals(t *testing.T) {
	var stdinSeen string
	calls := fakeKubectl(t, func(args []string) (string, error) {
		v := verb(args)
		switch v[0] {
		case "apply":
			return "Warning: x\n" + dryRunCM, nil
		case "get":
			return liveCM, nil
		}
		return "", nil
	})
	orig := kubectlExec
	kubectlExec = func(ctx context.Context, args []string, stdin *string) ([]byte, error) {
		if stdin != nil {
			stdinSeen = *stdin
		}
		return orig(ctx, args, stdin)
	}
	t.Cleanup(func() { kubectlExec = orig })
	manifest := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: shop\ndata:\n  a: \"2\"\n  b: x\n"
	out, err := handleDiff(ctxFor("c1"), map[string]interface{}{"yaml_content": manifest}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	apply := verb((*calls)[0])
	if strings.Join(apply, " ") != "apply --dry-run=server -f - -o json" || stdinSeen != strings.TrimSpace(manifest) {
		t.Fatalf("dry run argv/stdin: %v / %q", apply, stdinSeen)
	}
	get := verb((*calls)[1])
	if strings.Join(get, " ") != "get ConfigMap app -o json -n shop" {
		t.Fatalf("live get: %v", get)
	}
	m := decode(t, out)
	diff := m["diff"].(string)
	if m["status"] != "changed" || m["lines_added"] != float64(1) || m["lines_removed"] != float64(1) || !strings.Contains(diff, `-    "a": "1"`) || !strings.Contains(diff, `+    "a": "2"`) {
		t.Fatalf("changed: %s", out)
	}
	// Server-owned fields never show up as changes.
	for _, noise := range []string{"resourceVersion", "managedFields", "last-applied", "uid"} {
		if strings.Contains(diff, noise) {
			t.Fatalf("noise %s in diff:\n%s", noise, diff)
		}
	}
	if !strings.Contains(m["note"].(string), "nothing was applied") || m["kind"] != "ConfigMap" || m["namespace"] != "shop" {
		t.Fatalf("meta: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		if verb(args)[0] == "apply" {
			return dryRunCM, nil
		}
		return kubectlErr(`Error from server (NotFound): configmaps "app" not found`)
	})
	out, err = handleDiff(ctxFor("c1"), map[string]interface{}{"manifest": manifest}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	if m["status"] != "created" || m["lines_removed"] != float64(0) || m["lines_added"].(float64) < 5 {
		t.Fatalf("created: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		if verb(args)[0] == "apply" {
			return strings.Replace(dryRunCM, `"a":"2"`, `"a":"1"`, 1), nil
		}
		return liveCM, nil
	})
	out, err = handleDiff(ctxFor("c1"), map[string]interface{}{"yaml_content": manifest}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	if m["status"] != "unchanged" || m["diff"] != "" || !strings.Contains(m["hint"].(string), "change nothing") {
		t.Fatalf("unchanged: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`Error from server (Forbidden): configmaps "app" is forbidden: User "r@x" cannot patch resource "configmaps" in API group "" in the namespace "shop"`)
	})
	out, err = handleDiff(ctxFor("c1"), map[string]interface{}{"yaml_content": manifest}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "forbidden" || !strings.Contains(m["reason"].(string), "cannot patch") {
		t.Fatalf("forbidden is a result: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr("error: error validating data: unknown field \"spec.foo\"")
	})
	if _, err := handleDiff(ctxFor("c1"), map[string]interface{}{"yaml_content": manifest}, bearer()); err == nil || errors.Is(err, errBadRequest) {
		t.Fatalf("a validation error stays an error: %v", err)
	}
	if _, err := handleDiff(ctxFor("c1"), map[string]interface{}{"yaml_content": manifest + "---\n" + manifest}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("multi-document refused: %v", err)
	}
	if _, err := handleDiff(ctxFor("c1"), map[string]interface{}{}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("manifest required: %v", err)
	}
}

func TestUnifiedDiffAndHelpers(t *testing.T) {
	a := "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n"
	b := "l1\nl2\nl3\nl4\nX5\nl6\nl7\nl8\nl9\nl10\n"
	text, added, removed := unifiedDiff(a, b, "shop/ConfigMap/app")
	if added != 2 || removed != 1 {
		t.Fatalf("counts: +%d -%d", added, removed)
	}
	if !strings.HasPrefix(text, "--- live shop/ConfigMap/app\n+++ after apply shop/ConfigMap/app\n@@\n") || !strings.Contains(text, "-l5\n+X5\n") || !strings.Contains(text, "+l10\n") {
		t.Fatalf("diff:\n%s", text)
	}
	// Context is three lines: l1 is not in the first hunk.
	if strings.Contains(text, " l1\n") {
		t.Fatalf("too much context:\n%s", text)
	}
	if text, a, r := unifiedDiff("same\n", "same\n", "x"); text != "" || a != 0 || r != 0 {
		t.Fatal("identical inputs diff to nothing")
	}
	if text, a, _ := unifiedDiff("", "new\n", "x"); a != 1 || !strings.Contains(text, "+new") {
		t.Fatal("created object")
	}

	obj := map[string]interface{}{"metadata": map[string]interface{}{"name": "a", "annotations": map[string]interface{}{"kubectl.kubernetes.io/last-applied-configuration": "{}"}}, "status": map[string]interface{}{"x": 1}}
	for _, p := range diffNoise {
		dropPath(obj, p)
	}
	meta := obj["metadata"].(map[string]interface{})
	if _, has := obj["status"]; has || meta["annotations"] != nil || meta["name"] != "a" {
		t.Fatalf("dropPath: %v", obj)
	}
	if qualifiedType("Deployment", "apps/v1") != "Deployment.apps" || qualifiedType("ConfigMap", "v1") != "ConfigMap" || qualifiedType("Rollout", "argoproj.io/v1alpha1") != "Rollout.argoproj.io" {
		t.Fatal("qualifiedType")
	}
	if fieldString(map[string]interface{}{"a": map[string]interface{}{"b": 3.0}}, ".a.b") != "3" || fieldString(map[string]interface{}{}, ".a") != "<none>" {
		t.Fatal("fieldString")
	}
}
