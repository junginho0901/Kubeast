package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// maskedWriteCasesFile is read by ai-service's test_masked_writes.py too: the chat stops before the approval card what
// tool-server stops before kubectl.
const maskedWriteCasesFile = "../ai-service/tests/fixtures/masked_write_cases.json"

type maskedWriteCase struct {
	Name    string                 `json:"name"`
	Tool    string                 `json:"tool"`
	Args    map[string]interface{} `json:"args"`
	Refused []string               `json:"refused"`
}

func maskedWriteCases(t *testing.T) []maskedWriteCase {
	t.Helper()
	raw, err := os.ReadFile(maskedWriteCasesFile)
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []maskedWriteCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) < 20 {
		t.Fatalf("only %d cases", len(file.Cases))
	}
	return file.Cases
}

type maskedWriteCall struct {
	args  []string
	stdin string
}

// maskedWriteRig signs in a caller holding every write, with or without reveal, and records what kubectl was given.
func maskedWriteRig(t *testing.T, perms ...string) *[]maskedWriteCall {
	t.Helper()
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	t.Cleanup(restore)
	prevAuth, prevApproval, prevExec := toolAuth, writeApprovalRequired, kubectlExec
	t.Cleanup(func() { toolAuth, writeApprovalRequired, kubectlExec = prevAuth, prevApproval, prevExec })
	toolAuth = fakeValidator{payload: auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"prod": append([]string{"ai.tool.*", "resource.*.read", "resource.*.edit", "resource.*.create", "resource.*.delete", "resource.pod.exec"}, perms...)}}}
	writeApprovalRequired = false
	var calls []maskedWriteCall
	kubectlExec = func(_ context.Context, args []string, stdin *string) ([]byte, error) {
		call := maskedWriteCall{args: args}
		if stdin != nil {
			call.stdin = *stdin
		}
		calls = append(calls, call)
		return []byte(`{"apiVersion":"v1","kind":"List","items":[]}`), nil
	}
	return &calls
}

func callMaskedWrite(t *testing.T, tool string, args map[string]interface{}) *httptest.ResponseRecorder {
	t.Helper()
	full := map[string]interface{}{"cluster": "prod"}
	for k, v := range args {
		full[k] = v
	}
	raw, err := json.Marshal(ToolCallRequest{Name: tool, Arguments: full})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/tools/call", strings.NewReader(string(raw)))
	req.Header.Set("Authorization", "Bearer t")
	rec := httptest.NewRecorder()
	handleCall(rec, req, buildToolRegistry())
	return rec
}

// What the assistant reads in place of a value is not that value: a write holding it would store those letters, and nothing
// reaches the cluster, whoever asks. The answer names the placeholder and says what to do instead.
func TestAWriteHoldingWhatStandsForAValueIsRefused(t *testing.T) {
	for _, reveal := range []bool{false, true} {
		for _, c := range maskedWriteCases(t) {
			if len(c.Refused) == 0 {
				continue
			}
			t.Run(c.Name, func(t *testing.T) {
				var calls *[]maskedWriteCall
				if reveal {
					calls = maskedWriteRig(t, "resource.secret.reveal")
				} else {
					calls = maskedWriteRig(t)
				}
				rec := callMaskedWrite(t, c.Tool, c.Args)
				if len(*calls) != 0 {
					t.Errorf("kubectl ran with what stands for a value: %+v", *calls)
				}
				if rec.Code != http.StatusBadRequest {
					t.Errorf("status %d, want 400: %s", rec.Code, rec.Body)
				}
				var resp ToolCallResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
					t.Fatalf("%s: %v", rec.Body, err)
				}
				for _, word := range append([]string{"placeholder", "k8s_patch_resource", "Nothing was changed"}, c.Refused...) {
					if !strings.Contains(resp.Error, word) {
						t.Errorf("the answer does not say %q: %s", word, resp.Error)
					}
				}
			})
		}
	}
}

// The same tools with values of their own run as before.
func TestAWriteWithoutWhatStandsForAValueGoesOn(t *testing.T) {
	for _, c := range maskedWriteCases(t) {
		if len(c.Refused) != 0 {
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			calls := maskedWriteRig(t)
			rec := callMaskedWrite(t, c.Tool, c.Args)
			if strings.Contains(rec.Body.String(), "placeholder") {
				t.Fatalf("refused: %s", rec.Body)
			}
			if rec.Code != http.StatusOK || len(*calls) == 0 {
				t.Fatalf("status %d, kubectl calls %d: %s", rec.Code, len(*calls), rec.Body)
			}
		})
	}
}

// Reading goes on: the placeholder in an argument of a read says nothing about a write.
func TestAReadNamingAPlaceholderIsNoWrite(t *testing.T) {
	maskedWriteRig(t)
	rec := callMaskedWrite(t, "k8s_get_events", map[string]interface{}{"namespace": "shop", "resource_name": "x", "note": "<REDACTED:secret>"})
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "placeholder") {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
}
