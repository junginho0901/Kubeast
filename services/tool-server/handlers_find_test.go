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

// grantOf is a context whose grant on cluster c is limited to the namespaces.
func grantOf(namespaces ...string) context.Context {
	return auth.WithPayload(withClusterID(context.Background(), "c"), auth.TokenPayload{Namespaces: map[string][]string{"c": namespaces}})
}

// deploymentsIn answers each namespace of a grant its own Deployment web-<namespace>, or what refused says of it.
func deploymentsIn(refused map[string]string) func([]string) (string, error) {
	return func(args []string) (string, error) {
		v := verb(args)
		if v[1] != "deployments" {
			return "", nil
		}
		if text := refused[v[3]]; text != "" {
			return kubectlErr(text)
		}
		return fmt.Sprintf("%s   web-%s   map[app:web]\n", v[3], v[3]), nil
	}
}

func findNotes(t *testing.T, out string) string {
	t.Helper()
	notes, err := json.Marshal(decode(t, out)["notes"])
	if err != nil {
		t.Fatal(err)
	}
	return string(notes)
}

// A namespace of a grant the cluster refuses is named in notes as not read; the kind is looked for in the others.
func TestFindResource_ARefusedNamespaceOfAGrantLosesNoOther(t *testing.T) {
	const forbidden = `Error from server (Forbidden): deployments.apps is forbidden: User "a" cannot list resource "deployments" in the namespace `
	a := args{"query": "web", "kinds": []interface{}{"deployments"}}
	for _, details := range []string{"", "true"} {
		for _, c := range []struct {
			name    string
			refused map[string]string
			matches []string
			notes   string
		}{
			{"none refused", nil, []string{"deployments/web-a", "deployments/web-b", "deployments/web-c"}, `[]`},
			{"the first", map[string]string{"a": forbidden + "a"}, []string{"deployments/web-b", "deployments/web-c"},
				`["deployments: a: ` + strings.ReplaceAll(forbidden, `"`, `\"`) + `a"]`},
			{"the last", map[string]string{"c": forbidden + "c"}, []string{"deployments/web-a", "deployments/web-b"},
				`["deployments: c: ` + strings.ReplaceAll(forbidden, `"`, `\"`) + `c"]`},
			{"two of them", map[string]string{"a": forbidden + "a", "c": forbidden + "c"}, []string{"deployments/web-b"},
				`["deployments: a, c: ` + strings.ReplaceAll(forbidden, `"`, `\"`) + `a"]`},
			{"all of them", map[string]string{"a": forbidden + "a", "b": forbidden + "b", "c": forbidden + "c"}, nil,
				`["deployments: a, b, c: ` + strings.ReplaceAll(forbidden, `"`, `\"`) + `a"]`},
		} {
			out, argv := findWith(t, details, grantOf("a", "b", "c"), a, deploymentsIn(c.refused))
			if got := matchNames(t, out); !reflect.DeepEqual(got, c.matches) {
				t.Errorf("%s (%q): matches %v, want %v", c.name, details, got, c.matches)
			}
			if got := findNotes(t, out); got != c.notes {
				t.Errorf("%s (%q): notes %s, want %s", c.name, details, got, c.notes)
			}
			if n := len(argv); n != 3 && len(c.matches) > 0 {
				t.Errorf("%s (%q): %d runs, want one of each namespace: %v", c.name, details, n, argv)
			}
		}
	}

	// more than the note lists are counted
	names := make([]string, 9)
	refused := map[string]string{}
	for i := range names {
		names[i] = fmt.Sprintf("team-%d", i)
		refused[names[i]] = forbidden + names[i]
	}
	delete(refused, "team-8")
	out, _ := findWith(t, "", grantOf(names...), a, deploymentsIn(refused))
	if got := findNotes(t, out); !strings.Contains(got, `"deployments: team-0, team-1, team-2, team-3, team-4 and 3 more: `) {
		t.Errorf("notes: %s", got)
	}
	if got := matchNames(t, out); !reflect.DeepEqual(got, []string{"deployments/web-team-8"}) {
		t.Errorf("matches: %v", got)
	}
}

// Another failure than a refusal ends the kind as before, so a cluster that does not answer is not asked once for every
// namespace; the ones it was not looked for in are named.
func TestFindResource_AFailureOfAGrantsNamespaceNamesTheOnesNotSearched(t *testing.T) {
	const down = "Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout"
	a := args{"query": "web", "kinds": []interface{}{"deployments"}}
	for _, c := range []struct {
		name  string
		grant []string
		down  string
		runs  int
		notes string
	}{
		{"the first", []string{"a", "b", "c"}, "a", 1, `["deployments: a: ` + down + `; not searched after it: b, c"]`},
		{"the second", []string{"a", "b", "c"}, "b", 2, `["deployments: b: ` + down + `; not searched after it: c"]`},
		{"the last", []string{"a", "b", "c"}, "c", 3, `["deployments: c: ` + down + `"]`},
		{"the only one", []string{"a"}, "a", 1, `["deployments: ` + down + `"]`},
	} {
		out, argv := findWith(t, "", grantOf(c.grant...), a, deploymentsIn(map[string]string{c.down: down}))
		if got := findNotes(t, out); got != c.notes || len(argv) != c.runs {
			t.Errorf("%s: %d runs, notes %s\nwant %d runs, %s", c.name, len(argv), got, c.runs, c.notes)
		}
	}
	// refused in one, not answered in another
	out, _ := findWith(t, "", grantOf("a", "b", "c"), a, deploymentsIn(map[string]string{"a": "Error from server (Forbidden): no", "b": down}))
	if got := findNotes(t, out); got != `["deployments: a: Error from server (Forbidden): no","deployments: b: `+down+`; not searched after it: c"]` {
		t.Errorf("notes: %s", got)
	}
	// a kind without namespaces is asked for once: every namespace answers it the same
	const nodes = `Error from server (Forbidden): nodes is forbidden: User "a" cannot list resource "nodes" in API group "" at the cluster scope`
	out, argv := findWith(t, "", grantOf("a", "b"), args{"query": "web", "kinds": []interface{}{"nodes"}}, func([]string) (string, error) { return kubectlErr(nodes) })
	if got := findNotes(t, out); got != `["nodes: `+strings.ReplaceAll(nodes, `"`, `\"`)+`"]` || len(argv) != 1 {
		t.Errorf("%d runs, notes %s", len(argv), got)
	}
	// and so is one the cluster does not serve
	out, argv = findWith(t, "", grantOf("a", "b"), args{"query": "web", "kinds": []interface{}{"foo"}}, func([]string) (string, error) {
		return kubectlErr(`error: the server doesn't have a resource type "foo"`)
	})
	if got := findNotes(t, out); got != `["kind \"foo\" is not served by this cluster"]` || len(argv) != 1 {
		t.Errorf("%d runs, notes %s", len(argv), got)
	}
}

// One place to look in: the note is the reason alone, as it was.
func TestFindResource_OnePlaceToLookInIsNotedAsItWas(t *testing.T) {
	const forbidden = `Error from server (Forbidden): deployments.apps is forbidden`
	for _, c := range []struct {
		name string
		ctx  context.Context
		args args
	}{
		{"the cluster", context.Background(), args{"query": "web", "kinds": []interface{}{"deployments"}}},
		{"a namespace", context.Background(), args{"query": "web", "kinds": []interface{}{"deployments"}, "namespace": "a"}},
		{"a namespace of a grant", grantOf("a", "b"), args{"query": "web", "kinds": []interface{}{"deployments"}, "namespace": "a"}},
		{"a grant of one", grantOf("a"), args{"query": "web", "kinds": []interface{}{"deployments"}}},
	} {
		out, argv := findWith(t, "", c.ctx, c.args, func([]string) (string, error) { return kubectlErr(forbidden) })
		if got := findNotes(t, out); got != `["deployments: `+forbidden+`"]` || len(argv) != 1 {
			t.Errorf("%s: %d runs, notes %s", c.name, len(argv), got)
		}
	}
}

// The namespaces of a grant read by name are bounded by the answer's limit whatever is found: refused and gone ones count.
func TestFindResource_OnTheNamespacesReadOfAGrantAreBounded(t *testing.T) {
	names := make([]string, 200)
	for i := range names {
		names[i] = fmt.Sprintf("team-%03d", i)
	}
	ctx := auth.WithPayload(withClusterID(context.Background(), "c"), auth.TokenPayload{Namespaces: map[string][]string{"c": names}})
	answering := func(namespaces func(name string) (string, error)) func([]string) (string, error) {
		return func(a []string) (string, error) {
			v := verb(a)
			if v[1] != "namespaces" {
				return kubectlErr(`error: the server doesn't have a resource type "foo"`)
			}
			return namespaces(v[2])
		}
	}
	refused := func(name string) (string, error) {
		return kubectlErr(`Error from server (Forbidden): namespaces "` + name + `" is forbidden`)
	}
	for _, c := range []struct {
		name  string
		limit int
		reads int
		found int
		read  func(string) (string, error)
		note  string
	}{
		{"all refused", 0, 21, 0, refused, "team-000, team-001, team-002, team-003, team-004 and 16 more: "},
		{"all refused, a limit given", 2, 3, 0, refused, "team-000, team-001, team-002: "},
		{"all gone", 0, 21, 0, func(string) (string, error) { return "", nil }, "namespaces: 21 of "},
		{"every other refused", 0, 21, 11, func(name string) (string, error) {
			if strings.HasSuffix(name, "1") || strings.HasSuffix(name, "3") || strings.HasSuffix(name, "5") || strings.HasSuffix(name, "7") || strings.HasSuffix(name, "9") {
				return refused(name)
			}
			return name + "\n", nil
		}, "team-001, team-003, team-005, team-007, team-009 and 5 more: "},
		{"all there", 0, 21, 20, func(name string) (string, error) { return name + "\n", nil }, ""},
	} {
		a := args{"query": "team", "kinds": []interface{}{"foo"}}
		if c.limit > 0 {
			a["limit"] = c.limit
		}
		out, argv := findWith(t, "true", ctx, a, answering(c.read))
		if n := len(namespaceReads(argv)); n != c.reads {
			t.Errorf("%s: %d reads, want %d", c.name, n, c.reads)
		}
		if n := len(matchNames(t, out)); n != c.found {
			t.Errorf("%s: %d found, want %d", c.name, n, c.found)
		}
		var note string
		for _, n := range decode(t, out)["notes"].([]interface{}) {
			if s := n.(string); strings.HasPrefix(s, "namespaces: ") {
				note += s
			}
		}
		if (c.note == "") != (note == "") || !strings.Contains(note, c.note) || len(note) > 400 {
			t.Errorf("%s: note of %d bytes: %s", c.name, len(note), note)
		}
		// the ones that were not looked at are counted where the answer is not full
		if said := strings.Contains(note, fmt.Sprintf("%d of the grant's 200 namespaces", c.reads)); said != (c.note != "") {
			t.Errorf("%s: note %s", c.name, note)
		}
		if truncated := decode(t, out)["truncated"]; truncated != (c.note == "") {
			t.Errorf("%s: truncated %v", c.name, truncated)
		}
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
