package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A call that names no cluster is refused before authorization or kubectl:
// ai-service always sends the cluster it resolved, and an empty one must not be
// read as a cluster that happens to be called "default".
func TestHandleCallRequiresCluster(t *testing.T) {
	ran := false
	tools := map[string]ToolDefinition{"k8s_get_resources": {
		Name: "k8s_get_resources",
		Handler: func(context.Context, map[string]interface{}, http.Header) (string, error) {
			ran = true
			return "", nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/call", strings.NewReader(`{"name":"k8s_get_resources","arguments":{"resource_type":"pods"}}`))
	rec := httptest.NewRecorder()
	handleCall(rec, req, tools)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "cluster is required") || ran {
		t.Fatalf("status %d body %s ran=%v, want 400 cluster is required and no run", rec.Code, rec.Body.String(), ran)
	}
}

// The response names the identity the call reached the cluster as — the same
// user and groups kubectl was given — whether the tool succeeded or failed.
func TestHandleCallReturnsAccess(t *testing.T) {
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	defer restore()
	payload := auth.TokenPayload{UserID: "u1", Email: "a@example.com",
		Perms: auth.PermissionMatrix{"prod": {"ai.tool.*"}},
		Roles: map[string]string{"prod": "Read"}, Namespaces: map[string][]string{"prod": {"shop"}}}
	prevAuth, prevImp := toolAuth, impersonationEnabled
	toolAuth = fakeValidator{payload: payload}
	defer func() { toolAuth, impersonationEnabled = prevAuth, prevImp }()

	var sent []string
	fail := false
	tools := map[string]ToolDefinition{"k8s_get_resources": {
		Name: "k8s_get_resources",
		Handler: func(ctx context.Context, _ map[string]interface{}, _ http.Header) (string, error) {
			sent = kubectlArgs(ctx, nil)
			if fail {
				return "", errors.New("kubectl failed: forbidden")
			}
			return "ok", nil
		},
	}}
	call := func() ToolCallResponse {
		req := httptest.NewRequest(http.MethodPost, "/call", strings.NewReader(`{"name":"k8s_get_resources","arguments":{"cluster":"prod","resource_type":"pods","namespace":"shop"}}`))
		req.Header.Set("Authorization", "Bearer t")
		rec := httptest.NewRecorder()
		handleCall(rec, req, tools)
		var resp ToolCallResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("status %d body %s: %v", rec.Code, rec.Body.String(), err)
		}
		return resp
	}

	impersonationEnabled = true
	for _, fail = range []bool{false, true} {
		resp := call()
		if resp.Access == nil {
			t.Fatalf("fail=%v: no access in %+v", fail, resp)
		}
		want := payload.Access("prod", true)
		if !reflect.DeepEqual(*resp.Access, want) {
			t.Fatalf("fail=%v: access %+v, want %+v", fail, *resp.Access, want)
		}
		// what is shown is what kubectl sent
		wantArgs := append([]string{"--kubeconfig"}, auth.KubectlImpersonationArgs(payload, "prod")...)
		if len(sent) < 2 || !reflect.DeepEqual(append([]string{sent[0]}, sent[2:]...), wantArgs) {
			t.Fatalf("kubectl args %v, want --kubeconfig <path> %v", sent, wantArgs[1:])
		}
		if resp.Access.User != "a@example.com" || !reflect.DeepEqual(resp.Access.Groups, []string{auth.GroupAuthenticated, "kubeast:role:read"}) {
			t.Fatalf("fail=%v: access shows %s %v", fail, resp.Access.User, resp.Access.Groups)
		}
	}

	impersonationEnabled, fail = false, false
	if resp := call(); resp.Access == nil || resp.Access.Impersonation || resp.Access.User != "" || len(resp.Access.Groups) != 0 {
		t.Fatalf("impersonation off: access %+v, want no user or groups", resp.Access)
	}
}
