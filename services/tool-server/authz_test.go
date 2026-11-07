package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

type fakeValidator struct {
	payload auth.TokenPayload
	err     error
}

func (f fakeValidator) Validate(string) (auth.TokenPayload, error) { return f.payload, f.err }

func hdr(token string) http.Header {
	h := http.Header{}
	if token != "" {
		h.Set("Authorization", "Bearer "+token)
	}
	return h
}

func TestWriteTools(t *testing.T) {
	for _, name := range []string{"k8s_apply_manifest", "k8s_create_resource", "k8s_delete_resource", "k8s_patch_resource", "k8s_annotate_resource", "k8s_remove_annotation", "k8s_label_resource", "k8s_remove_label", "k8s_scale", "k8s_rollout", "k8s_execute_command"} {
		if !requiresApproval(name) {
			t.Fatalf("%s must be a write tool", name)
		}
	}
}

func TestAuthorizeToolCall(t *testing.T) {
	v := fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{
		"alpha": {"ai.tool.*"},
		"prod":  {"resource.*.read"},
	}}}
	cases := []struct {
		name, tool, cluster, token string
		validator                  tokenValidator
		wantStatus                 int
	}{
		{"granted on alpha", "k8s_get_resources", "alpha", "t", v, 0},
		{"same tool refused on prod", "k8s_delete_resource", "prod", "t", v, http.StatusForbidden},
		{"read tool refused on prod (no ai.tool grant)", "k8s_get_resources", "prod", "t", v, http.StatusForbidden},
		{"empty cluster = default, no grant", "k8s_get_resources", "", "t", v, http.StatusForbidden},
		{"missing token", "k8s_get_resources", "alpha", "", v, http.StatusUnauthorized},
		{"invalid token", "k8s_get_resources", "alpha", "t", fakeValidator{err: errors.New("bad")}, http.StatusUnauthorized},
		{"global admin any cluster", "k8s_execute_command", "prod", "t", fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"*"}}}}, 0},
	}
	for _, c := range cases {
		_, status, err := authorizeToolCall(c.validator, hdr(c.token), c.tool, c.cluster, nil)
		if status != c.wantStatus {
			t.Errorf("%s: status %d want %d (err %v)", c.name, status, c.wantStatus, err)
		}
	}
}

// toolPermissionCasesFile is read by ai-service's test_tool_app_permissions.py: both services decide the same.
const toolPermissionCasesFile = "../ai-service/tests/fixtures/tool_app_permission_cases.json"

type toolPermissionCase struct {
	Name    string                 `json:"name"`
	Tool    string                 `json:"tool"`
	Args    map[string]interface{} `json:"args"`
	Perms   []string               `json:"perms"`
	Allowed bool                   `json:"allowed"`
}

// What each grant may do on the routed cluster, written out by hand. The Write entry is the seeded role's own list
// (auth-service repository_schema.go).
func toolPermissionCases() []toolPermissionCase {
	write := []string{
		"menu.*", "resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete",
		"resource.cronjob.suspend", "resource.cronjob.trigger", "resource.secret.reveal", "resource.alert.silence", "resource.pod.logfile",
		"resource.helm.read", "resource.helm.rollback", "resource.helm.upgrade", "resource.helm.test", "ai.tool.*", "ai.mcp.use",
	}
	grants := []struct {
		name                                    string
		perms                                   []string
		exec, undo, reads, changes, scale, drop bool
	}{
		{"Write role", write, false, false, true, true, true, true},
		{"Admin role", []string{"*"}, true, true, true, true, true, true},
		{"custom role with both screen permissions", []string{"ai.tool.*", "resource.pod.exec", "resource.workload.rollback"}, true, true, true, false, false, false},
		{"custom role with Pod exec only", []string{"ai.tool.*", "resource.pod.exec"}, true, false, true, false, false, false},
		{"custom role with rollback only", []string{"ai.tool.*", "resource.workload.rollback"}, false, true, true, false, false, false},
		{"screen permissions without the AI tools", []string{"resource.pod.exec", "resource.workload.rollback"}, false, false, false, false, false, false},
		{"the exec tool with its screen permission", []string{"ai.tool.k8s_execute_command", "resource.pod.exec"}, true, false, false, false, false, false},
		{"the exec tool without its screen permission", []string{"ai.tool.k8s_execute_command"}, false, false, false, false, false, false},
		{"the rollout tool with rollback", []string{"ai.tool.k8s_rollout", "resource.workload.rollback"}, false, true, true, false, false, false},
		{"the rollout tool without rollback", []string{"ai.tool.k8s_rollout"}, false, false, true, false, false, false},
		{"the rollout tool with edit of that kind", []string{"ai.tool.k8s_rollout", "resource.deployment.edit"}, false, false, true, true, false, false},
		{"custom role with no resource permission", []string{"ai.tool.*"}, false, false, true, false, false, false},
		{"custom role with these kinds", []string{"ai.tool.*", "resource.deployment.edit", "resource.configmap.delete"}, false, false, true, true, true, true},
		{"custom role with other kinds", []string{"ai.tool.*", "resource.statefulset.edit", "resource.secret.delete"}, false, false, true, false, false, false},
		{"custom role with read only", []string{"ai.tool.*", "resource.*.read"}, false, false, true, false, false, false},
	}
	workload := func(action string) map[string]interface{} {
		return map[string]interface{}{"action": action, "resource_type": "deployment", "resource_name": "web"}
	}
	var cases []toolPermissionCase
	for _, g := range grants {
		add := func(call, tool string, args map[string]interface{}, allowed bool) {
			cases = append(cases, toolPermissionCase{Name: g.name + ": " + call, Tool: tool, Args: args, Perms: g.perms, Allowed: allowed})
		}
		add("pod exec", "k8s_execute_command", map[string]interface{}{"pod_name": "web", "namespace": "shop", "command": []interface{}{"ls"}}, g.exec)
		add("rollout undo", "k8s_rollout", workload("undo"), g.undo)
		for _, action := range []string{"restart", "pause", "resume"} {
			add("rollout "+action, "k8s_rollout", workload(action), g.changes)
		}
		for _, action := range []string{"status", "history"} {
			add("rollout "+action, "k8s_rollout", workload(action), g.reads)
		}
		add("scale", "k8s_scale", map[string]interface{}{"resource_type": "deployment", "resource_name": "web", "replicas": 2}, g.scale)
		add("delete", "k8s_delete_resource", map[string]interface{}{"resource_type": "configmap", "resource_name": "web"}, g.drop)
	}
	return cases
}

// A tool that does what a screen guards asks for the screen's permission too; the other cluster's grant is no help.
func TestAuthorizeToolCall_AsksForTheScreensPermission(t *testing.T) {
	for _, c := range toolPermissionCases() {
		v := fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{
			"alpha": c.Perms,
			"prod":  {"resource.pod.exec", "resource.workload.rollback"},
		}}}
		_, status, err := authorizeToolCall(v, hdr("t"), c.Tool, "alpha", c.Args)
		if c.Allowed && status != 0 {
			t.Errorf("%s: status %d, want allowed (err %v)", c.Name, status, err)
		}
		if !c.Allowed && status != http.StatusForbidden {
			t.Errorf("%s: status %d, want 403", c.Name, status)
		}
	}
}

// The refusal names what is missing and where, so the person knows what to ask for.
func TestAuthorizeToolCall_RefusalNamesThePermission(t *testing.T) {
	v := fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{"alpha": {"ai.tool.*"}}}}
	for _, c := range []struct {
		tool string
		args map[string]interface{}
		perm string
	}{
		{"k8s_execute_command", map[string]interface{}{"pod_name": "web"}, "resource.pod.exec"},
		{"k8s_rollout", map[string]interface{}{"action": "undo"}, "resource.workload.rollback"},
	} {
		_, status, err := authorizeToolCall(v, hdr("t"), c.tool, "alpha", c.args)
		if status != http.StatusForbidden || err == nil {
			t.Fatalf("%s: status %d err %v, want 403", c.tool, status, err)
		}
		if !errors.Is(err, errForbidden) || !strings.Contains(err.Error(), c.perm) || !strings.Contains(err.Error(), "alpha") {
			t.Errorf("%s: refusal %q does not name %s and the cluster", c.tool, err, c.perm)
		}
	}
}

// The undo check reads the action as the handler does; the argument check refuses other spellings before the call runs.
func TestAuthorizeToolCall_UndoInAnySpellingNeedsTheRollbackPermission(t *testing.T) {
	v := fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{"alpha": {"ai.tool.*"}}}}
	for _, action := range []string{"undo", "UNDO", " undo ", "Undo"} {
		_, status, _ := authorizeToolCall(v, hdr("t"), "k8s_rollout", "alpha", map[string]interface{}{"action": action})
		if status != http.StatusForbidden {
			t.Errorf("action %q: status %d, want 403", action, status)
		}
	}
}

// The grid has to test both answers for the fixture to mean anything, and both services read this one file.
func TestToolPermissionCasesFixture(t *testing.T) {
	cases := toolPermissionCases()
	allowed := 0
	for _, c := range cases {
		if c.Allowed {
			allowed++
		}
	}
	if allowed < 10 || allowed > len(cases)-10 {
		t.Fatalf("%d of %d cases allowed: the cases do not test both answers", allowed, len(cases))
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	if err := enc.Encode(cases); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_TOOL_PERMISSION_CASES") == "1" {
		if err := os.WriteFile(toolPermissionCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(toolPermissionCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_TOOL_PERMISSION_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("tool_app_permission_cases.json is not these cases: rerun with UPDATE_TOOL_PERMISSION_CASES=1")
	}
}
