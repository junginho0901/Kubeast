package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
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

// findInCluster answers the namespaces of a cluster and, of the other kinds, one Service.
func findInCluster(namespaces ...string) func([]string) (string, error) {
	return func(args []string) (string, error) {
		v := verb(args)
		switch v[1] {
		case "namespaces":
			var out strings.Builder
			for _, ns := range namespaces {
				if named := v[2:]; !strings.HasPrefix(named[0], "-") && !has(named, ns) {
					continue
				}
				if has(v, "custom-columns=NS:.metadata.namespace,NAME:.metadata.name,LABELS:.metadata.labels") {
					fmt.Fprintf(&out, "<none>   %s   map[kubernetes.io/metadata.name:%s]\n", ns, ns)
				} else {
					fmt.Fprintf(&out, "%s\n", ns)
				}
			}
			return out.String(), nil
		case "services":
			return "shop   checkout-svc   map[app:checkout]\n", nil
		}
		return "", nil
	}
}

func findWith(t *testing.T, details string, ctx context.Context, a args, respond func([]string) (string, error)) (string, [][]string) {
	t.Helper()
	t.Setenv("AI_TOOL_RESULT_DETAILS", details)
	calls := fakeKubectl(t, respond)
	out, err := handleFindResource(ctx, a, nil)
	if err != nil {
		t.Fatal(err)
	}
	argv := make([][]string, 0, len(*calls))
	for _, c := range *calls {
		argv = append(argv, verb(c))
	}
	return out, argv
}

func matchNames(t *testing.T, out string) []string {
	t.Helper()
	var names []string
	for _, m := range decode(t, out)["matches"].([]interface{}) {
		e := m.(map[string]interface{})
		names = append(names, fmt.Sprintf("%v/%v", e["kind"], e["name"]))
	}
	return names
}

// With AI_TOOL_RESULT_DETAILS off the answers and the kubectl runs are the ones before it: no namespace is searched and
// nothing found says Stop searching.
func TestFindResource_OffTheAnswersAreTheBytesTheyWere(t *testing.T) {
	const searchedAll = `"searched":{"kinds":["pods","deployments","statefulsets","daemonsets","services","ingresses","configmaps","jobs","cronjobs"],"namespaces":"all namespaces"},"truncated":false}`
	const stop = `"hint":"Nothing matched in the searched kinds and namespaces. Stop searching: tell the user what was searched and ask for the exact name, the namespace, or whether it lives in another cluster.",`
	for _, details := range []string{"", "false", "0"} {
		for _, c := range []struct {
			name string
			args args
			want string
			runs int
		}{
			{"a service", args{"query": "checkout"}, `{"matches":[{"kind":"services","name":"checkout-svc","namespace":"shop"}],"notes":[],"query":"checkout",` + searchedAll, 9},
			{"a namespace's name", args{"query": "payments"}, `{` + stop + `"matches":[],"notes":[],"query":"payments",` + searchedAll, 9},
			{"kinds given", args{"query": "payments", "kinds": []interface{}{"deployments"}},
				`{` + stop + `"matches":[],"notes":[],"query":"payments","searched":{"kinds":["deployments"],"namespaces":"all namespaces"},"truncated":false}`, 1},
			{"a namespace given", args{"query": "payments", "namespace": "shop", "kinds": []interface{}{"deployments"}},
				`{` + stop + `"matches":[],"notes":[],"query":"payments","searched":{"kinds":["deployments"],"namespaces":["shop"]},"truncated":false}`, 1},
			{"the namespaces kind", args{"query": "pay", "kinds": []interface{}{"namespaces"}},
				`{"matches":[{"kind":"namespaces","name":"payments"},{"kind":"namespaces","name":"payouts"}],"notes":[],"query":"pay","searched":{"kinds":["namespaces"],"namespaces":"all namespaces"},"truncated":false}`, 1},
		} {
			out, argv := findWith(t, details, context.Background(), c.args, findInCluster("payments", "payouts", "shop"))
			if out != c.want || len(argv) != c.runs {
				t.Errorf("%s (%q): %d runs, %s\nwant %d runs, %s", c.name, details, len(argv), out, c.runs, c.want)
			}
		}
	}
}

func TestFindResource_OnNamespaceNamesAreSearchedToo(t *testing.T) {
	cluster := findInCluster("checkout", "payments", "payouts", "shop")
	for _, c := range []struct {
		name     string
		args     args
		matches  []string
		searched int // kinds searched, with the namespaces when they were
		hint     string
	}{
		// beside the default kinds, after them
		{"a namespace alone", args{"query": "sho"}, []string{"namespaces/shop"}, 10, "a namespace does"},
		{"a service alone", args{"query": "checkout-s"}, []string{"services/checkout-svc"}, 10, ""},
		{"a service and a namespace", args{"query": "checkout"}, []string{"services/checkout-svc", "namespaces/checkout"}, 10, ""},
		{"several namespaces", args{"query": "PAY"}, []string{"namespaces/payments", "namespaces/payouts"}, 10, "a namespace does"},
		// kinds given: only when they matched nothing
		{"kinds given, no match", args{"query": "payments", "kinds": []interface{}{"deployments"}}, []string{"namespaces/payments"}, 2, "a namespace does"},
		{"kinds given, a match", args{"query": "checkout", "kinds": []interface{}{"services"}}, []string{"services/checkout-svc"}, 1, ""},
		// the namespaces kind itself is searched once, as before
		{"the namespaces kind", args{"query": "pay", "kinds": []interface{}{"ns"}}, nil, 1, "Do not repeat this search"},
		// one namespace, or a label: the names of others are not looked at
		{"a namespace given", args{"query": "payments", "namespace": "shop"}, nil, 9, "Only namespace shop was searched"},
		{"a label", args{"query": "app=payments"}, nil, 9, "Do not repeat this search"},
	} {
		out, argv := findWith(t, "true", context.Background(), c.args, cluster)
		if got := matchNames(t, out); !reflect.DeepEqual(got, c.matches) {
			t.Errorf("%s: matches %v, want %v", c.name, got, c.matches)
		}
		m := decode(t, out)
		kinds := m["searched"].(map[string]interface{})["kinds"].([]interface{})
		if len(kinds) != c.searched || len(argv) != c.searched {
			t.Errorf("%s: %d runs, searched %v, want %d", c.name, len(argv), kinds, c.searched)
		}
		hint, _ := m["hint"].(string)
		if (c.hint == "") != (hint == "") || !strings.Contains(hint, c.hint) {
			t.Errorf("%s: hint %q, want it to hold %q", c.name, hint, c.hint)
		}
	}
	if len(findDefaultKinds) != 9 {
		t.Fatalf("the default kinds changed: %v", findDefaultKinds)
	}
}

// A namespace is found by its name alone: every namespace carries its name and kubernetes.io in a label.
func TestFindResource_OnANamespacesLabelsAreNotSearched(t *testing.T) {
	out, argv := findWith(t, "true", context.Background(), args{"query": "kubernetes.io"}, findInCluster("payments", "shop"))
	if got := matchNames(t, out); got != nil {
		t.Errorf("matches %v", got)
	}
	last := strings.Join(argv[len(argv)-1], " ")
	if last != "get namespaces -o custom-columns=NAME:.metadata.name --no-headers" {
		t.Errorf("argv: %s", last)
	}
}

func TestFindResource_OnTheLimitsHold(t *testing.T) {
	many := make([]string, 80)
	for i := range many {
		many[i] = fmt.Sprintf("preview-%02d", i)
	}
	for _, c := range []struct {
		name  string
		args  args
		want  int
		trunc bool
	}{
		{"the default", args{"query": "preview"}, 20, true},
		{"given", args{"query": "preview", "limit": 3}, 3, true},
		{"above the most", args{"query": "preview", "limit": 500}, findMaxMatches, true},
		{"kinds given", args{"query": "preview", "limit": 5, "kinds": []interface{}{"deployments"}}, 5, true},
		{"all of them fit", args{"query": "preview-0"}, 10, false},
	} {
		out, _ := findWith(t, "true", context.Background(), c.args, findInCluster(many...))
		if got := matchNames(t, out); len(got) != c.want || decode(t, out)["truncated"] != c.trunc {
			t.Errorf("%s: %d matches, truncated %v, want %d, %v", c.name, len(got), decode(t, out)["truncated"], c.want, c.trunc)
		}
	}

	// objects fill the limit first: the namespaces share it
	out, _ := findWith(t, "true", context.Background(), args{"query": "checkout", "limit": 1}, findInCluster("checkout", "shop"))
	if got := matchNames(t, out); !reflect.DeepEqual(got, []string{"services/checkout-svc"}) || decode(t, out)["truncated"] != true {
		t.Errorf("a full answer: %s", out)
	}
	// a search cut before its last kind does not read the namespaces, and does not say it did
	out, argv := findWith(t, "true", context.Background(), args{"query": "web", "limit": 1}, func(args []string) (string, error) {
		if v := verb(args); v[1] == "pods" {
			return "shop web-1 <none>\nshop web-2 <none>\n", nil
		}
		return "", nil
	})
	if len(matchNames(t, out)) != 1 || len(argv) != 1 || strings.Contains(out, `"namespaces"]`) || strings.Contains(out, `"kind":"namespaces"`) {
		t.Errorf("a cut search: %v %s", argv, out)
	}
	// the most kinds a call may name stays
	kinds := make([]interface{}, findMaxKinds+1)
	for i := range kinds {
		kinds[i] = "pods"
	}
	if _, err := handleFindResource(context.Background(), args{"query": "web", "kinds": kinds}, nil); !errors.Is(err, errBadRequest) {
		t.Errorf("too many kinds: %v", err)
	}
}

// A grant limited to namespaces finds only its own, read by name: it may not list the cluster's.
func TestFindResource_OnALimitedGrantFindsItsOwnNamespaces(t *testing.T) {
	ctx := auth.WithPayload(withClusterID(context.Background(), "c"), auth.TokenPayload{Namespaces: map[string][]string{"c": {"payments", "paygone", "shop"}}})
	cluster := findInCluster("payments", "payouts", "shop")
	out, argv := findWith(t, "true", ctx, args{"query": "pay", "kinds": []interface{}{"deployments"}}, cluster)
	if got := matchNames(t, out); !reflect.DeepEqual(got, []string{"namespaces/payments"}) {
		t.Errorf("matches: %s", out)
	}
	const columns = " --ignore-not-found -o custom-columns=NAME:.metadata.name --no-headers"
	if got := namespaceReads(argv); !reflect.DeepEqual(got, []string{"get namespaces payments" + columns, "get namespaces paygone" + columns}) {
		t.Errorf("argv: %v", got)
	}
	for _, v := range argv {
		if has(v, "--all-namespaces") || has(v, "payouts") {
			t.Errorf("widened: %v", v)
		}
	}
	// no granted namespace is named like it: nothing is read, and nothing is found
	out, argv = findWith(t, "true", ctx, args{"query": "orders", "kinds": []interface{}{"deployments"}}, cluster)
	if matchNames(t, out) != nil || len(argv) != 3 || !strings.Contains(out, "Do not repeat this search") {
		t.Errorf("%d runs: %s", len(argv), out)
	}
	// the limit bounds what is read by name too
	names := make([]string, 60)
	for i := range names {
		names[i] = fmt.Sprintf("pay-%02d", i)
	}
	ctx = auth.WithPayload(withClusterID(context.Background(), "c"), auth.TokenPayload{Namespaces: map[string][]string{"c": names}})
	out, argv = findWith(t, "true", ctx, args{"query": "pay", "kinds": []interface{}{"foo"}, "limit": 2}, func(args []string) (string, error) {
		if v := verb(args); v[1] == "foo" {
			return kubectlErr(`error: the server doesn't have a resource type "foo"`)
		}
		return findInCluster(names...)(args)
	})
	if got := matchNames(t, out); len(got) != 2 || decode(t, out)["truncated"] != true {
		t.Errorf("limit: %s", out)
	}
	if got := namespaceReads(argv); !reflect.DeepEqual(got, []string{"get namespaces pay-00" + columns, "get namespaces pay-01" + columns, "get namespaces pay-02" + columns}) {
		t.Errorf("argv: %v", got)
	}
}

func namespaceReads(argv [][]string) []string {
	var out []string
	for _, v := range argv {
		if v[1] == "namespaces" {
			out = append(out, strings.Join(v, " "))
		}
	}
	return out
}

// A granted namespace the cluster refuses is a note; the others are found.
func TestFindResource_OnARefusedNamespaceOfAGrantLosesNoOther(t *testing.T) {
	ctx := auth.WithPayload(withClusterID(context.Background(), "c"), auth.TokenPayload{Namespaces: map[string][]string{"c": {"pay-a", "pay-b", "pay-c", "pay-d"}}})
	out, argv := findWith(t, "true", ctx, args{"query": "pay", "kinds": []interface{}{"foo"}}, func(args []string) (string, error) {
		v := verb(args)
		if v[1] != "namespaces" {
			return kubectlErr(`error: the server doesn't have a resource type "foo"`)
		}
		if has(v, "pay-b") || has(v, "pay-d") {
			// what kubectl prints for several names, the refused one's error among the others
			return kubectlErr("pay-a\n" + `Error from server (Forbidden): namespaces "` + v[2] + `" is forbidden`)
		}
		return v[2] + "\n", nil
	})
	if got := matchNames(t, out); !reflect.DeepEqual(got, []string{"namespaces/pay-a", "namespaces/pay-c"}) {
		t.Errorf("matches: %s", out)
	}
	if n := len(namespaceReads(argv)); n != 4 {
		t.Errorf("%d reads", n)
	}
	notes := decode(t, out)["notes"].([]interface{})
	last := notes[len(notes)-1].(string)
	if !strings.HasPrefix(last, "namespaces: pay-b, pay-d: ") || !strings.Contains(last, `namespaces "pay-b" is forbidden`) {
		t.Errorf("note: %q", last)
	}
}

func TestFindResource_OnNamespacesThatCannotBeReadAreANote(t *testing.T) {
	out, _ := findWith(t, "true", context.Background(), args{"query": "payments"}, func(args []string) (string, error) {
		if v := verb(args); v[1] == "namespaces" {
			return kubectlErr(`Error from server (Forbidden): namespaces is forbidden`)
		}
		return "", nil
	})
	m := decode(t, out)
	notes, _ := json.Marshal(m["notes"])
	if string(notes) != `["namespaces: Error from server (Forbidden): namespaces is forbidden"]` || matchNames(t, out) != nil {
		t.Errorf("notes: %s", out)
	}
}

// The text for a search that found nothing is about the search, not about the work it was part of.
func TestFindResource_OnNothingFoundDoesNotEndTheInvestigation(t *testing.T) {
	out, _ := findWith(t, "true", context.Background(), args{"query": "orders"}, findInCluster("shop"))
	hint := decode(t, out)["hint"].(string)
	for _, want := range []string{"Do not repeat this search with the same words", "not the investigation", "logs and metrics", "exact name, the namespace, or whether it lives in another cluster"} {
		if !strings.Contains(hint, want) {
			t.Errorf("%q is not in %q", want, hint)
		}
	}
	if strings.Contains(strings.ToLower(hint), "stop") {
		t.Errorf("hint: %q", hint)
	}
}

// Kinds given that matched: the same answer and the same runs on and off.
func TestFindResource_OnAMatchOfTheKindsGivenIsTheSame(t *testing.T) {
	a := args{"query": "checkout", "kinds": []interface{}{"services"}}
	on, onRuns := findWith(t, "true", context.Background(), a, findInCluster("checkout"))
	off, offRuns := findWith(t, "", context.Background(), a, findInCluster("checkout"))
	if on != off || !reflect.DeepEqual(onRuns, offRuns) {
		t.Errorf("on %s %v, off %s %v", on, onRuns, off, offRuns)
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
