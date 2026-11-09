package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const queryPodList = `{"apiVersion":"v1","kind":"List","items":[
 {"metadata":{"name":"web-1","namespace":"shop"},"status":{"phase":"Running"},"spec":{"nodeName":"n1"}},
 {"metadata":{"name":"web-2","namespace":"shop"},"status":{"phase":"Pending"},"spec":{"nodeName":"n2"}},
 {"metadata":{"name":"api-1","namespace":"db"},"status":{"phase":"Running"},"spec":{"nodeName":"n1"}}]}`

// A jq program that builds more than a run may hold step by step is stopped with that reason, and the next program runs
// as before.
func TestJQProgramThatOutgrowsItsMemoryIsStopped(t *testing.T) {
	for _, expr := range []string{
		`[range(6000000)] | length`,
		`reduce range(27) as $i ("a"; . + .) | length`,
	} {
		fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
		out, err := handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "namespace": "shop", "jq": expr}, bearer())
		if !errors.Is(err, errBadRequest) || !strings.Contains(err.Error(), "memory") {
			t.Errorf("%s: want a refusal for its memory, got %v %.200s", expr, err, out)
		}
	}
	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	out, err := handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "namespace": "shop", "jq": `[.items[].metadata.name] | length`}, bearer())
	if err != nil || !strings.Contains(out, `"results":[3]`) {
		t.Fatalf("the next program: %v %s", err, out)
	}
}

// podListOfAbout1MiB is a kubectl list of n pods on 300 nodes, 908 KB at 4 000: about the tool output cap.
func podListOfAbout1MiB(n int) string {
	items := make([]string, 0, n)
	for i := 0; i < n; i++ {
		items = append(items, fmt.Sprintf(`{"metadata":{"name":"web-%05d","namespace":"shop","labels":{"app":"web"}},"spec":{"nodeName":"node-%03d","containers":[{"name":"app","image":"registry.example.test/web:1.2.3"}]},"status":{"phase":"Running","podIP":"10.0.0.1"}}`, i, i%300))
	}
	return `{"apiVersion":"v1","kind":"List","items":[` + strings.Join(items, ",") + `]}`
}

// With its heap not watched, a program that asks for more memory than a run may hold is refused when it asks, in one
// step or many, and ordinary programs over a list of about 1 MiB answer every time.
func TestJQProgramPastItsMemoryIsRefusedWithItsHeapUnwatched(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skipf("the kernel holds a run to its memory on Linux, where the image runs; on %s the heap watcher alone does", runtime.GOOS)
	}
	prev := jqWatchEvery
	jqWatchEvery = time.Hour
	t.Cleanup(func() { jqWatchEvery = prev })
	for _, expr := range []string{
		`"a" * 200000000 | length`,
		`[range(6000000)] | length`,
		`reduce range(27) as $i ("a"; . + .) | length`,
	} {
		fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
		out, err := handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "namespace": "shop", "jq": expr}, bearer())
		if !errors.Is(err, errBadRequest) || !strings.Contains(err.Error(), "memory") {
			t.Errorf("%s: want a refusal for its memory, got %v %.200s", expr, err, out)
		}
	}
	big := podListOfAbout1MiB(4000)
	for _, c := range []struct{ expr, want string }{
		{`[.items[] | .spec.nodeName] | group_by(.) | map({node: .[0], pods: length}) | length`, `"results":[300]`},
		{`[.items[] | {name: .metadata.name, node: .spec.nodeName, image: .spec.containers[0].image}] | length`, `"results":[4000]`},
		{`.items | map(select(.status.phase == "Running")) | length`, `"results":[4000]`},
	} {
		for i := 0; i < 2; i++ {
			fakeKubectl(t, func(args []string) (string, error) { return big, nil })
			out, err := handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "namespace": "shop", "jq": c.expr}, bearer())
			if err != nil || !strings.Contains(out, c.want) {
				t.Errorf("%s over %d bytes, run %d: %v %.300s", c.expr, len(big), i+1, err, out)
			}
		}
	}
}

// jq programs run one at a time: one that comes while another runs waits for its turn, then answers as it does alone.
func TestJQProgramsRunOneAtATime(t *testing.T) {
	if n := jqRuns.Cap(); n != 1 {
		t.Errorf("%d jq programs may run at once, want 1", n)
	}
	release, err := jqRuns.Take(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	type answer struct {
		out string
		err error
	}
	done := make(chan answer, 1)
	go func() {
		out, err := handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "namespace": "shop", "jq": `[.items[].metadata.name] | length`}, bearer())
		done <- answer{out, err}
	}()
	select {
	case a := <-done:
		release()
		t.Fatalf("answered while another program ran: %v %.200s", a.err, a.out)
	case <-time.After(500 * time.Millisecond):
	}
	release()
	select {
	case a := <-done:
		if a.err != nil || !strings.Contains(a.out, `"results":[3]`) {
			t.Fatalf("after its turn came: %v %.200s", a.err, a.out)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no answer 10 s after the running program ended")
	}
}

// A jq program that finds no turn before its call's time runs out is not run: its caller is told, once that time is
// over, that tool-server was busy and to ask again.
func TestJQProgramThatFindsNoTurnInItsCallsTimeIsABusyRefusal(t *testing.T) {
	for i := 0; i < jqRuns.Cap(); i++ {
		release, err := jqRuns.Take(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		defer release()
	}
	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	ctx, cancel := context.WithTimeout(ctxFor("c1"), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	out, err := handleJQQuery(ctx, map[string]interface{}{"resource_type": "pods", "namespace": "shop", "jq": `[.items[].metadata.name] | length`}, bearer())
	took := time.Since(start)
	if !errors.Is(err, errBusy) || !strings.Contains(err.Error(), "busy") || !strings.Contains(err.Error(), "ask again") {
		t.Errorf("want a busy refusal that asks to ask again, got %v %.200s", err, out)
	}
	if took < 250*time.Millisecond {
		t.Errorf("refused after %s, before its call's time ran out", took)
	}
}

// The caller of a jq program that found no turn gets a 503 saying tool-server was busy, with the identity the call
// reached the cluster as, as the caller of a big answer that found no place does.
func TestHandleCallAnswersAJQProgramWithNoTurnAsBusy(t *testing.T) {
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	t.Cleanup(restore)
	prev := toolAuth
	toolAuth = fakeValidator{payload: auth.TokenPayload{UserID: "u1", Email: "reader@example.com",
		Perms: auth.PermissionMatrix{"prod": {"ai.tool.*", "resource.objects.read"}}, Roles: map[string]string{"prod": "Read"}}}
	t.Cleanup(func() { toolAuth = prev })
	shortCalls(t, 300*time.Millisecond)
	for i := 0; i < jqRuns.Cap(); i++ {
		release, err := jqRuns.Take(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		defer release()
	}
	tools := map[string]ToolDefinition{"k8s_jq_query": {
		Name: "k8s_jq_query",
		Handler: func(ctx context.Context, _ map[string]interface{}, _ http.Header) (string, error) {
			_, err := runJQ(ctx, `.items | length`, 1, map[string]interface{}{"items": []interface{}{}})
			return "", err
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/call", strings.NewReader(`{"name":"k8s_jq_query","arguments":{"cluster":"prod","resource_type":"pods","namespace":"shop","jq":".items | length"}}`))
	req.Header.Set("Authorization", "Bearer t")
	rec := httptest.NewRecorder()
	handleCall(rec, req, tools)
	var answer ToolCallResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
		t.Fatalf("status %d, not JSON (%v): %.200s", rec.Code, err, rec.Body.String())
	}
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(answer.Error, "busy") || !strings.Contains(answer.Error, "ask again") || answer.Access == nil {
		t.Errorf("status %d, error %q, access %v", rec.Code, answer.Error, answer.Access)
	}
}

// A jq program that runs past the time limit is stopped with that reason.
func TestJQProgramThatRunsPastItsTimeIsStopped(t *testing.T) {
	prev := jqTimeout
	jqTimeout = 300 * time.Millisecond
	t.Cleanup(func() { jqTimeout = prev })
	fakeKubectl(t, func(args []string) (string, error) { return queryPodList, nil })
	start := time.Now()
	_, err := handleJQQuery(ctxFor("c1"), map[string]interface{}{"resource_type": "pods", "namespace": "shop", "jq": `until(false; .)`}, bearer())
	if !errors.Is(err, errBadRequest) || !strings.Contains(err.Error(), "took longer than 300ms") {
		t.Fatalf("want a refusal for its time, got %v", err)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("stopped after %s", took)
	}
}

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
		// kubectl's JSONPath filters and negative indices (an AI eval run on 2026-11-08 wrote these and was refused)
		{"columns": `NAME:.metadata.name,STATUS:.status.conditions[-1].type,READY:.status.conditions[?(@.type=="Ready")].status,TAINTS:.spec.taints`},
		{"columns": `PORT:.spec.ports[?(@.port >= 1000)].port,LAST:.status.conditions[-2:].type`},
		{"sort_by": ".metadata.creationTimestamp"}, {"group_by": ".spec.nodeName"}, {"label_selector": "app=web,tier!=db"}, {"label_selector": "env in (prod,staging)"},
	} {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v should pass: %v", args, err)
		}
	}
	for _, args := range []map[string]interface{}{
		{"jq": strings.Repeat(".", 1001)}, {"columns": "NAME"}, {"columns": "NAME:.a;rm"}, {"sort_by": "metadata.name"}, {"group_by": ".a b"},
		{"columns": "N:{.metadata.name}"}, {"columns": "N:.a`x`"}, {"columns": "N:.a$(x)"}, {"columns": "N:.a\nb"}, {"columns": "N:.a\\b"},
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
