package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/gitops"
)

// A caller holding everything on c1, so a write tool's permission gate stays out of what these tests look at. kubectl runs without
// the caller's identity, so the calls they read start with the verb.
func writerCtx(t *testing.T) context.Context {
	t.Helper()
	was := impersonationEnabled
	impersonationEnabled = false
	t.Cleanup(func() { impersonationEnabled = was })
	return auth.WithPayload(ctxFor("c1"), auth.TokenPayload{Perms: auth.PermissionMatrix{"c1": {"*"}}})
}

func TestGitopsObjects(t *testing.T) {
	one := `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"ns","annotations":{"argocd.argoproj.io/tracking-id":"app:apps/Deployment:ns/web"}}}`
	objs, err := gitopsObjects([]byte(one))
	if err != nil || len(objs) != 1 || objs[0].Group != "apps" || objs[0].Kind != "Deployment" || objs[0].Name != "web" {
		t.Fatalf("single: %+v %v", objs, err)
	}
	list := `{"kind":"List","apiVersion":"v1","items":[` + one + `,{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"cm"}}]}`
	objs, err = gitopsObjects([]byte(list))
	if err != nil || len(objs) != 2 || objs[1].Group != "" || objs[1].Kind != "ConfigMap" {
		t.Fatalf("list: %+v %v", objs, err)
	}
	if objs, _ := gitopsObjects([]byte(`{"apiVersion":"v1","kind":"","metadata":{}}`)); len(objs) != 0 {
		t.Fatalf("nameless: %+v", objs)
	}
}

func TestGitopsGuardObjectsBlocksOrWarns(t *testing.T) {
	saved := gitopsCfg
	defer func() { gitopsCfg = saved }()
	gitopsCfg = gitops.Config{Enabled: true, Mode: gitops.ModeBlock, TrackingAnnotation: gitops.DefaultTrackingAnnotation}
	managed := gitops.Object{Group: "apps", Kind: "Deployment", Namespace: "ns", Name: "web",
		Annotations: map[string]string{gitops.DefaultTrackingAnnotation: "app:apps/Deployment:ns/web"}}
	free := gitops.Object{Kind: "ConfigMap", Namespace: "ns", Name: "cm"}
	if notice, err := gitopsGuardObjects(nil, nil, []gitops.Object{free}, false); err != nil || notice != "" {
		t.Fatalf("unmanaged must pass silently: %q %v", notice, err)
	}
	_, err := gitopsGuardObjects(nil, nil, []gitops.Object{free, managed}, false)
	if err == nil || err.Error() != "conflict: Deployment ns/web is managed by Argo CD application app; change it in Git" {
		t.Fatalf("managed must be refused with the app name: %v", err)
	}

	// warn: the write goes through, the result starts with the notice.
	gitopsCfg.Mode = gitops.ModeWarn
	notice, err := gitopsGuardObjects(nil, nil, []gitops.Object{free, managed}, false)
	if err != nil {
		t.Fatalf("warn mode must pass: %v", err)
	}
	want := "⚠ Deployment ns/web is managed by Argo CD application app (gitops.argocd.mode=warn): this change drifts from Git until the Application syncs it back."
	if notice != want {
		t.Fatalf("notice = %q", notice)
	}
	if got := withGitopsNotice(notice, "deployment.apps/web scaled"); got != want+"\n\ndeployment.apps/web scaled" {
		t.Fatalf("prefixed output = %q", got)
	}
	if got := withGitopsNotice("", "deployment.apps/web scaled"); got != "deployment.apps/web scaled" {
		t.Fatalf("no notice must leave the output alone: %q", got)
	}

	// off: nothing is detected at all.
	gitopsCfg.Enabled = false
	if notice, err := gitopsGuardObjects(nil, nil, []gitops.Object{managed}, false); err != nil || notice != "" {
		t.Fatalf("disabled guard must be silent: %q %v", notice, err)
	}
}

// argoTracked is an object as kubectl prints it when Argo CD tracks it.
func argoTracked(group, kind, ns, name string) string {
	apiVersion := "v1"
	if group != "" {
		apiVersion = group + "/v1"
	}
	return `{"apiVersion":"` + apiVersion + `","kind":"` + kind + `","metadata":{"name":"` + name + `","namespace":"` + ns + `","annotations":{"argocd.argoproj.io/tracking-id":"the-app:` + group + "/" + kind + ":" + ns + "/" + name + `"}}}`
}

func argoFree(group, kind, ns, name string) string {
	apiVersion := "v1"
	if group != "" {
		apiVersion = group + "/v1"
	}
	return `{"apiVersion":"` + apiVersion + `","kind":"` + kind + `","metadata":{"name":"` + name + `","namespace":"` + ns + `"}}`
}

func kubeList(items ...string) string {
	return "{\n  \"apiVersion\": \"v1\",\n  \"items\": [" + strings.Join(items, ",") + "],\n  \"kind\": \"List\"\n}\n"
}

func setGitopsMode(t *testing.T, mode string) {
	t.Helper()
	saved := gitopsCfg
	t.Cleanup(func() { gitopsCfg = saved })
	gitopsCfg = gitops.Config{Enabled: mode != "off", Mode: mode, TrackingAnnotation: gitops.DefaultTrackingAnnotation}
}

// kubectlScript answers reads with get; every other call is a write and succeeds.
func kubectlScript(t *testing.T, get func(args []string) (string, error)) *[][]string {
	t.Helper()
	return fakeKubectl(t, func(args []string) (string, error) {
		switch args[0] {
		case "get":
			return get(args)
		case "api-resources":
			return "", errors.New("exit status 1")
		case "apply":
			if len(args) > 1 && args[1] == "--dry-run=client" {
				return get(args)
			}
		}
		return "done", nil
	})
}

func writesIn(calls [][]string) []string {
	var out []string
	for _, c := range calls {
		if c[0] == "get" || c[0] == "api-resources" || (len(c) > 1 && c[1] == "--dry-run=client") {
			continue
		}
		out = append(out, strings.Join(c, " "))
	}
	return out
}

func readsIn(calls [][]string) []string {
	var out []string
	for _, c := range calls {
		if c[0] == "get" {
			out = append(out, strings.Join(c, " "))
		}
	}
	return out
}

const managedWebManifest = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: shop\n"

// Every write tool that changes an object that already exists, with what it reads to find that object.
var guardedToolCalls = []struct {
	name, tool string
	args       map[string]interface{}
	write      string
}{
	{"apply", "k8s_apply_manifest", map[string]interface{}{"yaml_content": managedWebManifest}, "apply -f -"},
	{"delete", "k8s_delete_resource", map[string]interface{}{"resource_type": "deployments", "resource_name": "web", "namespace": "shop"}, "delete deployments web -n shop"},
	{"delete everything of a type", "k8s_delete_resource", map[string]interface{}{"resource_type": "deployments", "all": true, "namespace": "shop"}, "delete deployments --all -n shop"},
	{"patch", "k8s_patch_resource", map[string]interface{}{"resource_type": "deployments", "resource_name": "web", "namespace": "shop", "patch": "{}"}, "patch deployments web -p {} -n shop"},
	{"annotate", "k8s_annotate_resource", map[string]interface{}{"resource_type": "deployments", "resource_name": "web", "namespace": "shop", "annotations": map[string]interface{}{"a": "b"}}, "annotate deployments web a=b -n shop"},
	{"remove an annotation", "k8s_remove_annotation", map[string]interface{}{"resource_type": "deployments", "resource_name": "web", "namespace": "shop", "keys": []interface{}{"a"}}, "annotate deployments web a- -n shop"},
	{"label", "k8s_label_resource", map[string]interface{}{"resource_type": "deployments", "resource_name": "web", "namespace": "shop", "labels": map[string]interface{}{"a": "b"}}, "label deployments web a=b -n shop"},
	{"remove a label", "k8s_remove_label", map[string]interface{}{"resource_type": "deployments", "resource_name": "web", "namespace": "shop", "keys": []interface{}{"a"}}, "label deployments web a- -n shop"},
	{"scale", "k8s_scale", map[string]interface{}{"resource_type": "deployments", "resource_name": "web", "namespace": "shop", "replicas": 2}, "scale deployments web --replicas 2 -n shop"},
	{"rollout restart", "k8s_rollout", map[string]interface{}{"action": "restart", "resource_type": "deployments", "resource_name": "web", "namespace": "shop"}, "rollout restart deployments/web -n shop"},
}

// A get with a name answers the object, one without answers a list; a client dry run renders the manifest.
func answerWith(object string) func(args []string) (string, error) {
	return func(args []string) (string, error) {
		if args[0] == "apply" {
			return object, nil
		}
		if len(args) > 2 && strings.HasPrefix(args[2], "-") {
			return kubeList(object), nil
		}
		return object, nil
	}
}

// On block every write tool is refused for a managed object, naming the Application, and nothing is written.
func TestWriteToolsAreRefusedForAManagedObjectOnBlock(t *testing.T) {
	registry := buildToolRegistry()
	for _, tc := range guardedToolCalls {
		t.Run(tc.name, func(t *testing.T) {
			setGitopsMode(t, gitops.ModeBlock)
			calls := kubectlScript(t, answerWith(argoTracked("apps", "Deployment", "shop", "web")))
			out, err := registry[tc.tool].Handler(writerCtx(t), tc.args, bearer())
			if !errors.Is(err, errConflict) {
				t.Fatalf("got %q, %v; want a conflict (calls %v)", out, err, *calls)
			}
			if want := "conflict: Deployment shop/web is managed by Argo CD application the-app; change it in Git"; err.Error() != want {
				t.Fatalf("error %q, want %q", err.Error(), want)
			}
			if got := writesIn(*calls); len(got) != 0 {
				t.Fatalf("the write went out: %v", got)
			}
		})
	}
}

// What Argo CD does not manage is written on block as it is anywhere else.
func TestWriteToolsWriteAFreeObjectOnBlock(t *testing.T) {
	registry := buildToolRegistry()
	for _, tc := range guardedToolCalls {
		t.Run(tc.name, func(t *testing.T) {
			setGitopsMode(t, gitops.ModeBlock)
			calls := kubectlScript(t, answerWith(argoFree("apps", "Deployment", "shop", "web")))
			out, err := registry[tc.tool].Handler(writerCtx(t), tc.args, bearer())
			if err != nil || out != "done" {
				t.Fatalf("got %q, %v (calls %v)", out, err, *calls)
			}
			if got := writesIn(*calls); len(got) != 1 || got[0] != tc.write {
				t.Fatalf("writes %v, want %s", got, tc.write)
			}
		})
	}
}

// warn writes, and the result starts with a notice naming the Application.
func TestWriteToolsWriteAManagedObjectOnWarnWithANotice(t *testing.T) {
	registry := buildToolRegistry()
	for _, tc := range guardedToolCalls {
		t.Run(tc.name, func(t *testing.T) {
			setGitopsMode(t, gitops.ModeWarn)
			calls := kubectlScript(t, answerWith(argoTracked("apps", "Deployment", "shop", "web")))
			out, err := registry[tc.tool].Handler(writerCtx(t), tc.args, bearer())
			if err != nil {
				t.Fatalf("%v (calls %v)", err, *calls)
			}
			want := "⚠ Deployment shop/web is managed by Argo CD application the-app (gitops.argocd.mode=warn): this change drifts from Git until the Application syncs it back.\n\ndone"
			if out != want {
				t.Fatalf("output %q", out)
			}
			if got := writesIn(*calls); len(got) != 1 || got[0] != tc.write {
				t.Fatalf("writes %v, want %s", got, tc.write)
			}
		})
	}
}

// off reads nothing and writes as asked.
// A delete of a whole type can touch thousands of managed objects: the notice names the first ones and how many more,
// so it does not push the tool's own answer out of what the model reads.
func TestWarnNoticeOfManyObjectsNamesTheFirstAndCountsTheRest(t *testing.T) {
	setGitopsMode(t, gitops.ModeWarn)
	var objs []gitops.Object
	for i := 0; i < 25; i++ {
		objs = append(objs, gitops.Object{Group: "apps", Kind: "Deployment", Namespace: "ns", Name: fmt.Sprintf("web-%d", i),
			Annotations: map[string]string{gitops.DefaultTrackingAnnotation: fmt.Sprintf("app:apps/Deployment:ns/web-%d", i)}})
	}
	notice, err := gitopsGuardObjects(nil, nil, objs, false)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(notice, "\n")
	if len(lines) != gitopsNoticeLines+1 {
		t.Fatalf("%d lines:\n%s", len(lines), notice)
	}
	if !strings.Contains(lines[0], "web-0 ") || !strings.Contains(lines[gitopsNoticeLines-1], fmt.Sprintf("web-%d ", gitopsNoticeLines-1)) {
		t.Errorf("not the first ones:\n%s", notice)
	}
	if want := fmt.Sprintf("⚠ … and %d more objects managed by Argo CD.", 25-gitopsNoticeLines); lines[gitopsNoticeLines] != want {
		t.Errorf("last line %q, want %q", lines[gitopsNoticeLines], want)
	}
}

func TestWarnNoticeUpToTheLimitNamesEveryObject(t *testing.T) {
	setGitopsMode(t, gitops.ModeWarn)
	var objs []gitops.Object
	for i := 0; i < gitopsNoticeLines; i++ {
		objs = append(objs, gitops.Object{Group: "apps", Kind: "Deployment", Namespace: "ns", Name: fmt.Sprintf("web-%d", i),
			Annotations: map[string]string{gitops.DefaultTrackingAnnotation: fmt.Sprintf("app:apps/Deployment:ns/web-%d", i)}})
	}
	notice, err := gitopsGuardObjects(nil, nil, objs, false)
	if err != nil {
		t.Fatal(err)
	}
	if lines := strings.Split(notice, "\n"); len(lines) != gitopsNoticeLines || strings.Contains(notice, "more objects") {
		t.Errorf("%d lines:\n%s", len(lines), notice)
	}
}

// On block the first managed object is the answer, however many there are.
func TestBlockAnswersTheFirstManagedObjectAsBefore(t *testing.T) {
	setGitopsMode(t, gitops.ModeBlock)
	objs := []gitops.Object{
		{Group: "apps", Kind: "Deployment", Namespace: "ns", Name: "web-0", Annotations: map[string]string{gitops.DefaultTrackingAnnotation: "app:apps/Deployment:ns/web-0"}},
		{Group: "apps", Kind: "Deployment", Namespace: "ns", Name: "web-1", Annotations: map[string]string{gitops.DefaultTrackingAnnotation: "app:apps/Deployment:ns/web-1"}},
	}
	if _, err := gitopsGuardObjects(nil, nil, objs, false); !errors.Is(err, errConflict) || !strings.Contains(err.Error(), "web-0") {
		t.Errorf("%v", err)
	}
}

func TestWriteToolsReadNothingWithTheGuardOff(t *testing.T) {
	registry := buildToolRegistry()
	for _, tc := range guardedToolCalls {
		t.Run(tc.name, func(t *testing.T) {
			setGitopsMode(t, "off")
			calls := kubectlScript(t, answerWith(argoTracked("apps", "Deployment", "shop", "web")))
			out, err := registry[tc.tool].Handler(writerCtx(t), tc.args, bearer())
			if err != nil || out != "done" {
				t.Fatalf("got %q, %v", out, err)
			}
			if got := readsIn(*calls); len(got) != 0 {
				t.Fatalf("reads %v", got)
			}
			if got := writesIn(*calls); len(got) != 1 || got[0] != tc.write {
				t.Fatalf("writes %v, want %s", got, tc.write)
			}
		})
	}
}

// A required argument that is missing is still the tool's own answer, before anything is read.
func TestWriteToolsAnswerAMissingArgumentThemselves(t *testing.T) {
	setGitopsMode(t, gitops.ModeBlock)
	registry := buildToolRegistry()
	for _, tool := range []string{"k8s_annotate_resource", "k8s_remove_annotation", "k8s_label_resource", "k8s_remove_label"} {
		for _, args := range []map[string]interface{}{
			{"resource_type": "deployments"},
			{"resource_type": "deployments", "resource_name": "web", "namespace": "shop"},
		} {
			calls := kubectlScript(t, answerWith(argoTracked("apps", "Deployment", "shop", "web")))
			_, err := registry[tool].Handler(ctxFor("c1"), args, bearer())
			if !errors.Is(err, errBadRequest) {
				t.Errorf("%s %v: %v", tool, args, err)
			}
			if len(*calls) != 0 {
				t.Errorf("%s %v: calls %v", tool, args, *calls)
			}
		}
	}
}

// A delete of everything of a type looks at everything of that type: one managed object refuses it, none lets it go.
func TestDeleteEverythingOfATypeLooksAtEveryObject(t *testing.T) {
	args := map[string]interface{}{"resource_type": "all", "all": true, "namespace": "shop"}
	registry := buildToolRegistry()
	setGitopsMode(t, gitops.ModeBlock)

	calls := kubectlScript(t, func([]string) (string, error) {
		return kubeList(argoFree("", "Pod", "shop", "p"), argoTracked("", "Service", "shop", "svc"), argoFree("apps", "Deployment", "shop", "d")), nil
	})
	_, err := registry["k8s_delete_resource"].Handler(ctxFor("c1"), args, bearer())
	if !errors.Is(err, errConflict) || !strings.Contains(err.Error(), "Service shop/svc is managed by Argo CD application the-app") {
		t.Fatalf("one managed among many: %v", err)
	}
	if got := strings.Join(readsIn(*calls), "|"); got != "get all -o json -n shop" {
		t.Fatalf("reads %q", got)
	}
	if got := writesIn(*calls); len(got) != 0 {
		t.Fatalf("the write went out: %v", got)
	}

	calls = kubectlScript(t, func([]string) (string, error) { return kubeList(), nil })
	if out, err := registry["k8s_delete_resource"].Handler(ctxFor("c1"), args, bearer()); err != nil || out != "done" {
		t.Fatalf("nothing there: %q %v", out, err)
	}
	if got := writesIn(*calls); len(got) != 1 {
		t.Fatalf("nothing there: writes %v", got)
	}
}

// Several types by one name: what kubectl found counts even when it could not find the rest.
func TestObjectOfSeveralTypesIsCheckedAcrossThem(t *testing.T) {
	setGitopsMode(t, gitops.ModeBlock)
	args := map[string]interface{}{"resource_type": "pods,deployments", "resource_name": "web", "namespace": "shop"}
	notFound := "Error from server (NotFound): pods \"web\" not found"
	calls := kubectlScript(t, func([]string) (string, error) {
		return kubeList(argoTracked("apps", "Deployment", "shop", "web")) + notFound + "\n", errors.New("exit status 1")
	})
	_, err := buildToolRegistry()["k8s_delete_resource"].Handler(ctxFor("c1"), args, bearer())
	if !errors.Is(err, errConflict) {
		t.Fatalf("managed among the found: %v (calls %v)", err, *calls)
	}
	if got := writesIn(*calls); len(got) != 0 {
		t.Fatalf("the write went out: %v", got)
	}

	calls = kubectlScript(t, func([]string) (string, error) {
		return kubeList(argoFree("apps", "Deployment", "shop", "web")) + notFound + "\n", errors.New("exit status 1")
	})
	if out, err := buildToolRegistry()["k8s_delete_resource"].Handler(ctxFor("c1"), args, bearer()); err != nil || out != "done" {
		t.Fatalf("free among the found: %q %v", out, err)
	}
	if got := writesIn(*calls); len(got) != 1 {
		t.Fatalf("free among the found: writes %v", got)
	}

	// A type it was refused says nothing of that type's object: the answer is not known.
	calls = kubectlScript(t, func([]string) (string, error) {
		return kubeList(argoFree("", "Pod", "shop", "web")) + "Error from server (Forbidden): deployments.apps \"web\" is forbidden\n", errors.New("exit status 1")
	})
	_, err = buildToolRegistry()["k8s_delete_resource"].Handler(ctxFor("c1"), args, bearer())
	if err == nil || errors.Is(err, errConflict) || !strings.Contains(err.Error(), "could not check whether Argo CD manages pods,deployments web") || !strings.Contains(err.Error(), "(Forbidden)") {
		t.Fatalf("a type refused: %v", err)
	}
	if got := writesIn(*calls); len(got) != 0 {
		t.Fatalf("a type refused: the write went out: %v", got)
	}
}

// A list kubectl could not hold is not read for the guard: block does not write what it could not look at, warn writes as before.
func TestDeleteEverythingOfAHugeTypeIsNotListed(t *testing.T) {
	args := map[string]interface{}{"resource_type": "events", "all": true, "namespace": "shop"}
	deletes := func(calls [][]string) int {
		n := 0
		for _, c := range calls {
			if c[0] == "delete" {
				n++
			}
		}
		return n
	}
	registry := buildToolRegistry()

	setGitopsMode(t, gitops.ModeBlock)
	calls := bigCluster(t)
	_, err := registry["k8s_delete_resource"].Handler(ctxFor("c1"), args, bearer())
	if err == nil || !strings.Contains(err.Error(), "could not check whether Argo CD manages events") || !strings.Contains(err.Error(), "110000") {
		t.Fatalf("block: %v", err)
	}
	if n := deletes(*calls); n != 0 {
		t.Fatalf("block: %d deletes", n)
	}

	setGitopsMode(t, gitops.ModeWarn)
	calls = bigCluster(t)
	out, err := registry["k8s_delete_resource"].Handler(ctxFor("c1"), args, bearer())
	if err != nil || strings.HasPrefix(out, "⚠") {
		t.Fatalf("warn: %q %v", out, err)
	}
	if n := deletes(*calls); n != 1 {
		t.Fatalf("warn: %d deletes", n)
	}
}

// On block a target that could not be read is refused; on warn and off the write goes as it did, with no notice.
func TestTargetThatCannotBeReadIsRefusedOnlyOnBlockForTheTools(t *testing.T) {
	failure := func([]string) (string, error) {
		return "Error from server (Forbidden): deployments.apps \"web\" is forbidden: User \"u\" cannot get resource", errors.New("exit status 1")
	}
	registry := buildToolRegistry()
	for _, tc := range guardedToolCalls {
		t.Run(tc.name, func(t *testing.T) {
			setGitopsMode(t, gitops.ModeBlock)
			calls := kubectlScript(t, failure)
			_, err := registry[tc.tool].Handler(writerCtx(t), tc.args, bearer())
			if err == nil || !strings.Contains(err.Error(), "could not check whether Argo CD manages") || !strings.Contains(err.Error(), "(Forbidden)") {
				t.Fatalf("block: %v", err)
			}
			if got := writesIn(*calls); len(got) != 0 {
				t.Fatalf("block: the write went out: %v", got)
			}

			setGitopsMode(t, gitops.ModeWarn)
			calls = kubectlScript(t, failure)
			out, err := registry[tc.tool].Handler(writerCtx(t), tc.args, bearer())
			if err != nil || out != "done" {
				t.Fatalf("warn: %q %v", out, err)
			}
			if got := writesIn(*calls); len(got) != 1 {
				t.Fatalf("warn: writes %v", got)
			}
		})
	}
}

// An object that is not there and a type the cluster does not serve are not managed: the write reports its own failure.
func TestMissingTargetIsLeftToTheWrite(t *testing.T) {
	registry := buildToolRegistry()
	for name, answer := range map[string]string{
		"no such object": "Error from server (NotFound): deployments.apps \"web\" not found",
		"no such type":   "error: the server doesn't have a resource type \"deployments\"",
		"after a klog line": "E1106 01:02:03.000000       1 memcache.go:287] \"Unhandled Error\" err=\"couldn't get resource list\"\n" +
			"Error from server (NotFound): deployments.apps \"web\" not found",
	} {
		for _, tc := range guardedToolCalls {
			t.Run(name+" "+tc.name, func(t *testing.T) {
				setGitopsMode(t, gitops.ModeBlock)
				calls := kubectlScript(t, func([]string) (string, error) { return answer, errors.New("exit status 1") })
				if out, err := registry[tc.tool].Handler(writerCtx(t), tc.args, bearer()); err != nil || out != "done" {
					t.Fatalf("%q %v", out, err)
				}
				if got := writesIn(*calls); len(got) != 1 {
					t.Fatalf("writes %v", got)
				}
			})
		}
	}
}

// kubectl prints warnings into the same stream as its JSON, and a big object has to be read whole.
func TestManagedObjectIsReadThroughWarningsAndAtAnySize(t *testing.T) {
	registry := buildToolRegistry()
	args := map[string]interface{}{"resource_type": "deployments", "resource_name": "web", "namespace": "shop"}
	big := `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"shop","annotations":{"filler":"` + strings.Repeat("x", 4096) + `","argocd.argoproj.io/tracking-id":"the-app:apps/Deployment:shop/web"}}}`
	savedCap := outputMaxBytes
	t.Cleanup(func() { outputMaxBytes = savedCap })
	outputMaxBytes = 1024
	for name, answer := range map[string]string{
		"an API warning first": "Warning: apps/v1 Deployment is deprecated {soon}\n" + argoTracked("apps", "Deployment", "shop", "web"),
		"a klog line first":    "E1106 01:02:03.000000       1 memcache.go:287] couldn't get resource list\n" + argoTracked("apps", "Deployment", "shop", "web"),
		"past the output cap":  big,
	} {
		t.Run(name, func(t *testing.T) {
			setGitopsMode(t, gitops.ModeBlock)
			calls := kubectlScript(t, func([]string) (string, error) { return answer, nil })
			_, err := registry["k8s_delete_resource"].Handler(ctxFor("c1"), args, bearer())
			if !errors.Is(err, errConflict) {
				t.Fatalf("%v (calls %v)", err, *calls)
			}
			if got := writesIn(*calls); len(got) != 0 {
				t.Fatalf("the write went out: %v", got)
			}
		})
	}
	// The same warning in front of a free object's JSON does not stop its write.
	setGitopsMode(t, gitops.ModeBlock)
	calls := kubectlScript(t, func([]string) (string, error) {
		return "Warning: apps/v1 Deployment is deprecated\n" + argoFree("apps", "Deployment", "shop", "web"), nil
	})
	if out, err := registry["k8s_delete_resource"].Handler(ctxFor("c1"), args, bearer()); err != nil || out != "done" {
		t.Fatalf("free object: %q %v", out, err)
	}
	if got := writesIn(*calls); len(got) != 1 {
		t.Fatalf("free object: writes %v", got)
	}
}

// A manifest is read as kubectl reads it, and each object it would change is looked at live.
func TestManifestIsCheckedObjectByObject(t *testing.T) {
	registry := buildToolRegistry()
	managed := func(args []string) (string, error) {
		for _, a := range args {
			if a == "web" {
				return argoTracked("apps", "Deployment", "shop", "web"), nil
			}
		}
		return "Error from server (NotFound): objects \"x\" not found", errors.New("exit status 1")
	}
	cases := []struct {
		name, manifest string
		dryRun         string // what kubectl apply --dry-run=client prints for it
		dryRunFails    bool
	}{
		{"one document", managedWebManifest, argoFree("apps", "Deployment", "shop", "web"), false},
		{"a later document", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: new\n  namespace: shop\n---\n" + managedWebManifest, kubeList(argoFree("", "ConfigMap", "shop", "new"), argoFree("apps", "Deployment", "shop", "web")), false},
		{"JSON", `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"shop"}}`, argoFree("apps", "Deployment", "shop", "web"), false},
		{"a List", "apiVersion: v1\nkind: List\nitems:\n- apiVersion: apps/v1\n  kind: Deployment\n  metadata:\n    name: web\n    namespace: shop\n", kubeList(argoFree("apps", "Deployment", "shop", "web")), false},
		{"a typed list whose items do not repeat the kind", "apiVersion: apps/v1\nkind: DeploymentList\nitems:\n- metadata:\n    name: web\n    namespace: shop\n", kubeList(argoFree("apps", "Deployment", "shop", "web")), false},
		{"quoted keys and values", "'apiVersion': 'apps/v1'\n'kind': 'Deployment'\n'metadata':\n  'name': 'web'\n  'namespace': 'shop'\n", argoFree("apps", "Deployment", "shop", "web"), false},
		{"beside a document kubectl cannot map", managedWebManifest + "---\napiVersion: nowhere.example.com/v1\nkind: Nothing\nmetadata:\n  name: n\n", "", true},
		{"before a document that does not parse", managedWebManifest + "---\nkind: [\n", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setGitopsMode(t, gitops.ModeBlock)
			calls := kubectlScript(t, func(args []string) (string, error) {
				if args[0] == "apply" {
					if tc.dryRunFails {
						return "error: unable to recognize \"STDIN\": no matches for kind", errors.New("exit status 1")
					}
					return tc.dryRun, nil
				}
				return managed(args)
			})
			_, err := registry["k8s_apply_manifest"].Handler(writerCtx(t), map[string]interface{}{"yaml_content": tc.manifest}, bearer())
			if !errors.Is(err, errConflict) || !strings.Contains(err.Error(), "managed by Argo CD application the-app") {
				t.Fatalf("%v (calls %v)", err, *calls)
			}
			if got := writesIn(*calls); len(got) != 0 {
				t.Fatalf("the write went out: %v", got)
			}
		})
	}

	// New objects, and a manifest kubectl will report on, reach kubectl.
	for name, manifest := range map[string]string{
		"a new object":             "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: new\n  namespace: shop\n",
		"a generated name":         "apiVersion: batch/v1\nkind: Job\nmetadata:\n  generateName: run-\n  namespace: shop\n",
		"a document with no kind":  "metadata:\n  name: x\n",
		"text that does not parse": "kind: [\n",
	} {
		t.Run(name, func(t *testing.T) {
			setGitopsMode(t, gitops.ModeBlock)
			calls := kubectlScript(t, func(args []string) (string, error) {
				if args[0] == "apply" {
					return kubeList(), nil
				}
				return "Error from server (NotFound): objects \"x\" not found", errors.New("exit status 1")
			})
			if out, err := registry["k8s_apply_manifest"].Handler(writerCtx(t), map[string]interface{}{"yaml_content": manifest}, bearer()); err != nil || out != "done" {
				t.Fatalf("%q %v", out, err)
			}
			if got := writesIn(*calls); len(got) != 1 {
				t.Fatalf("writes %v", got)
			}
		})
	}
}
