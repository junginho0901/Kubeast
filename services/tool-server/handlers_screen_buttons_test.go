package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

var screenButtonTools = map[string]string{
	"k8s_cordon_node":     "resource.node.cordon",
	"k8s_cronjob_suspend": "resource.cronjob.suspend",
	"k8s_cronjob_trigger": "resource.cronjob.trigger",
}

// The role that holds a button's permission and nothing else does through the AI what the button does.
func TestScreenButtons_AskWhatTheButtonAsks(t *testing.T) {
	for tool, permission := range screenButtonTools {
		got, listed := toolAppPermissions(tool, args{"resource_name": "x", "namespace": "shop"})
		if !listed || len(got) != 1 || got[0] != permission {
			t.Errorf("%s asks %v listed=%v, want %s", tool, got, listed, permission)
		}
		holder := fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{"c1": {"ai.tool." + tool, permission}}}}
		if _, status, err := authorizeToolCall(holder, hdr("t"), tool, "c1", args{"resource_name": "x", "namespace": "shop"}); status != 0 || err != nil {
			t.Errorf("%s with %s: %d %v", tool, permission, status, err)
		}
		editOnly := fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{"c1": {"ai.tool." + tool, "resource.*.edit", "resource.*.create"}}}}
		_, status, err := authorizeToolCall(editOnly, hdr("t"), tool, "c1", args{"resource_name": "x", "namespace": "shop"})
		if status != http.StatusForbidden || err == nil || !strings.Contains(err.Error(), permission) {
			t.Errorf("%s without %s: %d %v", tool, permission, status, err)
		}
		otherCluster := fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{"c1": {"ai.tool." + tool}, "c2": {permission}}}}
		if _, status, _ := authorizeToolCall(otherCluster, hdr("t"), tool, "c1", args{"resource_name": "x", "namespace": "shop"}); status != http.StatusForbidden {
			t.Errorf("%s with another cluster's %s: %d", tool, permission, status)
		}
		if !requiresApproval(tool) {
			t.Errorf("%s changes the cluster and runs without an approval", tool)
		}
		if _, ok := buildToolRegistry()[tool]; !ok {
			t.Errorf("%s is not registered", tool)
		}
	}
}

// buttonRoutes answers the button's route and keeps what it was sent.
func buttonRoutes(t *testing.T, status int, answer string) (*[]*http.Request, *[]string) {
	t.Helper()
	var bodies []string
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		raw, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(raw))
		return status, answer
	})
	return seen, &bodies
}

func TestCordonNode_PressesTheButtonsRoute(t *testing.T) {
	for _, c := range []struct {
		name   string
		call   args
		path   string
		answer string
	}{
		{"cordon", args{"resource_name": "node-1"}, "/api/v1/nodes/node-1/cordon", `{"status":"cordoned","unschedulable":true}`},
		{"uncordon", args{"resource_name": "node-1", "uncordon": true}, "/api/v1/nodes/node-1/uncordon", `{"status":"uncordoned","unschedulable":false}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			seen, _ := buttonRoutes(t, 200, c.answer)
			out := runTool(t, ctxWithPayload("self", holderOf()), "k8s_cordon_node", c.call)
			r := (*seen)[0]
			if r.Method != http.MethodPost || r.URL.Path != c.path || r.URL.Query().Get("cluster") != "self" || r.Header.Get("Authorization") != "Bearer user-token" {
				t.Fatalf("request: %s %s auth=%q", r.Method, r.URL, r.Header.Get("Authorization"))
			}
			if r.Header.Get("User-Agent") != "kubeast-tool-server" {
				t.Errorf("the route's audit row should say a tool pressed it: %q", r.Header.Get("User-Agent"))
			}
			assertSame(t, "answer", parsed(t, out), c.answer)
		})
	}
}

func TestCronJobSuspend_PressesTheButtonsRoute(t *testing.T) {
	for _, c := range []struct {
		name string
		flag interface{}
		body string
	}{
		{"suspend", true, `{"suspend":true}`},
		{"resume", false, `{"suspend":false}`},
		{"the model's spelling of false", "false", `{"suspend":false}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			seen, bodies := buttonRoutes(t, 200, c.body)
			out := runTool(t, ctxWithPayload("self", holderOf()), "k8s_cronjob_suspend", args{"resource_name": "nightly", "namespace": "shop", "suspend": c.flag})
			r := (*seen)[0]
			if r.Method != http.MethodPatch || r.URL.Path != "/api/v1/namespaces/shop/cronjobs/nightly/suspend" || r.URL.Query().Get("cluster") != "self" {
				t.Fatalf("request: %s %s", r.Method, r.URL)
			}
			assertSame(t, "body", parsed(t, (*bodies)[0]), c.body)
			assertSame(t, "answer", parsed(t, out), c.body)
		})
	}
}

// Which way a CronJob goes is the call's to say: a call that does not say changes nothing.
func TestCronJobSuspend_ACallThatDoesNotSayWhichWayIsRefused(t *testing.T) {
	seen, _ := buttonRoutes(t, 200, `{}`)
	tool, ok := buildToolRegistry()["k8s_cronjob_suspend"]
	if !ok {
		t.Fatal("k8s_cronjob_suspend is not a tool")
	}
	_, err := tool.Handler(ctxWithPayload("self", holderOf()), args{"resource_name": "nightly", "namespace": "shop"}, bearer())
	if !errors.Is(err, errBadRequest) || !strings.Contains(err.Error(), "suspend") {
		t.Fatalf("err = %v", err)
	}
	if len(*seen) != 0 {
		t.Errorf("the route was called: %v", (*seen)[0].URL)
	}
}

func TestCronJobTrigger_PressesTheButtonsRoute(t *testing.T) {
	seen, _ := buttonRoutes(t, 200, `{"job_name":"nightly-manual-1"}`)
	out := runTool(t, ctxWithPayload("self", holderOf()), "k8s_cronjob_trigger", args{"resource_name": "nightly", "namespace": "shop"})
	r := (*seen)[0]
	if r.Method != http.MethodPost || r.URL.Path != "/api/v1/namespaces/shop/cronjobs/nightly/trigger" || r.URL.Query().Get("cluster") != "self" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s", r.Method, r.URL)
	}
	if decode(t, out)["job_name"] != "nightly-manual-1" {
		t.Errorf("answer: %s", out)
	}
}

func TestScreenButtons_NameAndNamespaceAreRequired(t *testing.T) {
	for _, c := range []struct {
		tool string
		call args
		want string
	}{
		{"k8s_cordon_node", args{}, "resource_name"},
		{"k8s_cronjob_suspend", args{"namespace": "shop", "suspend": true}, "resource_name"},
		{"k8s_cronjob_suspend", args{"resource_name": "nightly", "suspend": true}, "namespace"},
		{"k8s_cronjob_trigger", args{"namespace": "shop"}, "resource_name"},
		{"k8s_cronjob_trigger", args{"resource_name": "nightly"}, "namespace"},
	} {
		seen, _ := buttonRoutes(t, 200, `{}`)
		tool, ok := buildToolRegistry()[c.tool]
		if !ok {
			t.Fatalf("%s is not a tool", c.tool)
		}
		_, err := tool.Handler(ctxWithPayload("self", holderOf()), c.call, bearer())
		if !errors.Is(err, errBadRequest) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s %v: err = %v", c.tool, c.call, err)
		}
		if len(*seen) != 0 {
			t.Errorf("%s %v: the route was called", c.tool, c.call)
		}
	}
}

// A refusal stays a failed call, so the card and the audit row say the write did not happen, with the route's own words.
func TestScreenButtons_ARefusedPressIsAFailedCallWithTheRoutesWords(t *testing.T) {
	for _, c := range []struct {
		name   string
		status int
		detail string
		is     error
	}{
		{"no permission", http.StatusForbidden, "Permission denied", errForbidden},
		{"a guarded namespace", http.StatusForbidden, "namespace kubeast is guarded", errForbidden},
		{"managed by Argo CD", http.StatusConflict, "managed by Argo CD application shop", errConflict},
		{"no such object", http.StatusNotFound, "cronjobs.batch nightly not found", errBadRequest},
		{"the audit log is down", http.StatusServiceUnavailable, "audit store unavailable", nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]string{"detail": c.detail})
			buttonRoutes(t, c.status, string(body))
			tool, ok := buildToolRegistry()["k8s_cronjob_trigger"]
			if !ok {
				t.Fatal("k8s_cronjob_trigger is not a tool")
			}
			out, err := tool.Handler(ctxWithPayload("self", holderOf()), args{"resource_name": "nightly", "namespace": "shop"}, bearer())
			if err == nil {
				t.Fatalf("answered as done: %s", out)
			}
			if !strings.Contains(err.Error(), c.detail) {
				t.Errorf("err = %v, want the route's words", err)
			}
			if c.is != nil && !errors.Is(err, c.is) {
				t.Errorf("err = %v, want %v", err, c.is)
			}
		})
	}
}

// As the routes do: a node is the whole cluster's, a CronJob its namespace's.
func TestScreenButtons_AGrantLimitedToNamespaces(t *testing.T) {
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"shop"}}}
	if err := namespaceGate(scoped, "c", "k8s_cordon_node", args{"resource_name": "n1"}); !errors.Is(err, errNamespaceScope) || !strings.Contains(err.Error(), "spans the cluster") {
		t.Errorf("cordon: %v", err)
	}
	for _, tool := range []string{"k8s_cronjob_suspend", "k8s_cronjob_trigger"} {
		if err := namespaceGate(scoped, "c", tool, args{"resource_name": "x", "namespace": "shop"}); err != nil {
			t.Errorf("%s in its namespace: %v", tool, err)
		}
		if err := namespaceGate(scoped, "c", tool, args{"resource_name": "x", "namespace": "other"}); !errors.Is(err, errNamespaceScope) {
			t.Errorf("%s in another namespace: %v", tool, err)
		}
	}
}

func TestScreenButtons_NamesKeepToTheirShape(t *testing.T) {
	for _, bad := range []args{
		{"resource_name": "../secrets"},
		{"resource_name": "a/b"},
		{"namespace": "a/b"},
	} {
		if err := validateToolArgs(bad); !errors.Is(err, errBadRequest) {
			t.Errorf("%v: %v", bad, err)
		}
	}
}
