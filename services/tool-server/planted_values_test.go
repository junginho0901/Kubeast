package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/redact"
)

// Made-up values planted where tools read: a log line, a container's env, a trace's attributes.
var plantedValues = []string{
	"ann.planted@example.com", "ann.planted", "bob.planted@example.com", "bob.planted",
	"010-2222-3333", "2222-3333", "4111-1111-1111-1111",
	"plantedtoken0123456789abcdef", "plantedtoken9876543210zyxwvu", "planted-db-pass-1",
	"ghp_planted0123456789abcdefghijklmnopq",
}

var plantedOutputs = []string{
	"2026-11-15T01:02:03Z INFO login user=ann.planted@example.com phone=010-2222-3333\n" +
		"2026-11-15T01:02:04Z WARN retry Authorization: Bearer plantedtoken0123456789abcdef\n",
	"Containers:\n  web:\n    Environment:\n      DB_PASSWORD:  planted-db-pass-1\n      ADMIN_EMAIL:  ann.planted@example.com\n" +
		"      GITHUB_TOKEN: ghp_planted0123456789abcdefghijklmnopq\n",
	`{"traceID":"4bf92f3577b34da6","spans":[{"name":"checkout","attributes":{"enduser.id":"bob.planted@example.com",` +
		`"http.request.header.authorization":"Bearer plantedtoken9876543210zyxwvu","user.email":"ann.planted@example.com","payment.card":"4111-1111-1111-1111"}}]}`,
}

// plantedRig answers each call of k8s_get_resources with the next planted output, with personal data masked.
func plantedRig(t *testing.T) func(masks *redact.Numbers) (ToolCallResponse, string) {
	t.Helper()
	prevOpts, prevAuth := redactOpts, toolAuth
	t.Cleanup(func() { redactOpts, toolAuth = prevOpts, prevAuth })
	redactOpts = redact.Options{Enabled: true, PII: true, Disabled: map[string]bool{}}
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	t.Cleanup(restore)
	toolAuth = fakeValidator{payload: auth.TokenPayload{UserID: "u1", Email: "reader@example.com",
		Perms: auth.PermissionMatrix{"prod": {"ai.tool.*", "resource.objects.read"}},
		Roles: map[string]string{"prod": "Read"}, Namespaces: map[string][]string{"prod": {"shop"}}}}
	next := 0
	tools := map[string]ToolDefinition{"k8s_get_resources": {
		Name: "k8s_get_resources",
		Handler: func(context.Context, map[string]interface{}, http.Header) (string, error) {
			out := plantedOutputs[next%len(plantedOutputs)]
			next++
			return out, nil
		},
	}}
	return func(masks *redact.Numbers) (ToolCallResponse, string) {
		body := map[string]interface{}{"name": "k8s_get_resources", "arguments": map[string]interface{}{"cluster": "prod", "resource_type": "pods", "namespace": "shop"}}
		if masks != nil {
			body["masks"] = masks
		}
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/call", strings.NewReader(string(raw)))
		req.Header.Set("Authorization", "Bearer t")
		rec := httptest.NewRecorder()
		handleCall(rec, req, tools)
		var resp ToolCallResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("status %d body %s: %v", rec.Code, rec.Body.String(), err)
		}
		return resp, rec.Body.String()
	}
}

// What tool-server answers is what the model reads of a tool: no planted value is in it, nor in the number table that
// comes back, which holds keys and numbers only; within one answer's table an address keeps its number from call to call.
func TestPlantedValuesReachTheModelOnlyAsPlaceholders(t *testing.T) {
	call := plantedRig(t)
	turn := &redact.Numbers{Key: "answer-one"}
	var contents []string
	for i := range plantedOutputs {
		resp, body := call(turn)
		for _, v := range plantedValues {
			if strings.Contains(body, v) {
				t.Fatalf("call %d: %q reached the answer: %s", i, v, body)
			}
		}
		contents = append(contents, resp.Content)
		turn = &redact.Numbers{Key: turn.Key, Table: resp.Masks}
	}
	for i, want := range [][]string{
		{"user=<EMAIL_1>", "phone=<PHONE_1>", "Bearer <REDACTED:token>"},
		{"DB_PASSWORD:  <REDACTED:DB_PASSWORD>", "ADMIN_EMAIL:  <EMAIL_1>", "GITHUB_TOKEN: <REDACTED:GITHUB_TOKEN>"},
		{`"enduser.id":"<EMAIL_2>"`, `"user.email":"<EMAIL_1>"`, `"payment.card":"<CARD_1>"`, "Bearer <REDACTED:token>"},
	} {
		for _, w := range want {
			if !strings.Contains(contents[i], w) {
				t.Errorf("call %d does not hold %q: %s", i, w, contents[i])
			}
		}
	}
	if len(turn.Table["email"]) != 2 || len(turn.Table["phone"]) != 1 || len(turn.Table["card"]) != 1 {
		t.Fatalf("table %v, want two addresses, a phone and a card", turn.Table)
	}
	for kind, byKey := range turn.Table {
		for k := range byKey {
			if len(k) != 16 || strings.Trim(k, "0123456789abcdef") != "" {
				t.Errorf("%s: table key %q is not a 16-character MaskKey", kind, k)
			}
		}
	}

	// Another answer has its own key: its numbers start again and its table shares no key with the first one's.
	other, body := call(&redact.Numbers{Key: "answer-two"})
	if !strings.Contains(other.Content, "user=<EMAIL_1>") || strings.Contains(body, "ann.planted") {
		t.Fatalf("another answer: %s", body)
	}
	for k := range other.Masks["email"] {
		if _, shared := turn.Table["email"][k]; shared {
			t.Fatalf("key %s is in both answers' tables", k)
		}
	}

	// A caller sending no table gets the numbers of that answer alone and no table back.
	alone, body := call(nil)
	if alone.Masks != nil || strings.Contains(body, `"masks"`) || !strings.Contains(alone.Content, "<EMAIL_1>") {
		t.Fatalf("no table sent: %s", body)
	}
}
