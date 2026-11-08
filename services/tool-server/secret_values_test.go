package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// Every value in this file is made up for the tests.
const (
	fakeSecretB64 = "ZmFrZS1zZWNyZXQtdmFsdWU="
	fakeTLSB64    = "ZmFrZS10bHMta2V5LXZhbHVl"
	fakeBracePlan = "fake-plain-inside-braces"
	fakeConfig    = "plain-config-value"
	fakeImage     = "registry.example/web:1.2.3"
)

var secretValuesCluster = "secret-values"

var fakeSecretItem = `{"apiVersion":"v1","kind":"Secret","type":"Opaque",
 "metadata":{"name":"db","namespace":"shop","annotations":{"team":"shop",
  "kubectl.kubernetes.io/last-applied-configuration":"{\"kind\":\"Secret\",\"stringData\":{\"conf\":\"{ value = ` + fakeBracePlan + ` }\"}}"}},
 "data":{"password":"` + fakeSecretB64 + `","tls.key":"` + fakeTLSB64 + `"}}`

var fakeConfigMapItem = `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"cfg","namespace":"shop"},"data":{"mode":"` + fakeConfig + `"}}`

var fakeDeploymentItem = `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"shop"},"spec":{"replicas":2,"image":"` + fakeImage + `"}}`

// fakeItems answers kubectl get's first argument the way a cluster with one Secret, one ConfigMap and one
// Deployment would. allHasSecret stands for a category that holds Secrets.
func fakeItems(kind string, allHasSecret bool) []string {
	var items []string
	for _, one := range strings.Split(kind, ",") {
		switch strings.ToLower(one) {
		case "secret", "secrets", "secret.v1", "secrets.v1":
			items = append(items, fakeSecretItem)
		case "configmaps", "configmap":
			items = append(items, fakeConfigMapItem)
		case "deployments", "deployment":
			items = append(items, fakeDeploymentItem)
		case "all":
			if allHasSecret {
				items = append(items, fakeSecretItem)
			}
			items = append(items, fakeConfigMapItem, fakeDeploymentItem)
		}
	}
	return items
}

// fakeClusterKubectl prints what kubectl prints for each output: an expression sees the object's values.
func fakeClusterKubectl(t *testing.T, allHasSecret bool) *[][]string {
	t.Helper()
	return fakeKubectl(t, func(args []string) (string, error) {
		v := verb(args)
		switch v[0] {
		case "api-resources":
			return "NAME SHORTNAMES APIVERSION NAMESPACED KIND\n", nil
		case "describe":
			return "Name: db\nData\n====\nconf:  8 bytes\n", nil
		}
		items := fakeItems(v[1], allHasSecret)
		output := ""
		for i, a := range v {
			if a == "-o" && i+1 < len(v) {
				output = v[i+1]
			}
		}
		switch {
		case output == "json":
			return `{"apiVersion":"v1","kind":"List","items":[` + strings.Join(items, ",") + `]}`, nil
		case output == "name":
			var names []string
			for _, it := range items {
				switch {
				case strings.Contains(it, `"kind":"Secret"`):
					names = append(names, "secret/db")
				case strings.Contains(it, `"kind":"ConfigMap"`):
					names = append(names, "configmap/cfg")
				default:
					names = append(names, "deployment.apps/web")
				}
			}
			return strings.Join(names, "\n") + "\n", nil
		case strings.HasPrefix(output, "jsonpath"), strings.HasPrefix(output, "go-template"), strings.HasPrefix(output, "custom-columns"):
			var values []string
			for _, it := range items {
				switch {
				case strings.Contains(it, `"kind":"Secret"`):
					values = append(values, fakeSecretB64+" "+fakeTLSB64)
				case strings.Contains(it, `"kind":"ConfigMap"`):
					values = append(values, fakeConfig)
				default:
					values = append(values, fakeImage)
				}
			}
			if strings.HasPrefix(output, "custom-columns") {
				return "V\n" + strings.Join(values, "\n") + "\n", nil
			}
			return strings.Join(values, " "), nil
		}
		return "NAME TYPE DATA AGE\ndb Opaque 2 1d\n", nil
	})
}

// callTool sends one call through handleCall, as ai-service does, on the real tool registry.
func callTool(t *testing.T, name string, args map[string]interface{}) ToolCallResponse {
	t.Helper()
	full := map[string]interface{}{"cluster": secretValuesCluster}
	for k, v := range args {
		full[k] = v
	}
	raw, err := json.Marshal(ToolCallRequest{Name: name, Arguments: full})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/tools/call", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer t")
	rec := httptest.NewRecorder()
	handleCall(rec, req, buildToolRegistry())
	var resp ToolCallResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("status %d body %s: %v", rec.Code, rec.Body.String(), err)
	}
	return resp
}

// toolServerForSecrets signs the caller in with every AI tool and answers k8s-service's paths with api; the kubeconfig
// lookup is answered here.
func toolServerForSecrets(t *testing.T, api func(w http.ResponseWriter, r *http.Request)) {
	t.Helper()
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/internal/") {
			_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
			return
		}
		if api != nil {
			api(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	t.Cleanup(restore)
	prev := toolAuth
	toolAuth = fakeValidator{payload: auth.TokenPayload{UserID: "u1", Email: "a@example.com",
		Perms: auth.PermissionMatrix{secretValuesCluster: {"ai.tool.*", "resource.*.read", "resource.*.edit", "resource.helm.read"}}}}
	t.Cleanup(func() { toolAuth = prev })
}

func secretValueIn(resp ToolCallResponse) string {
	text := resp.Content + "\n" + resp.Error
	for _, v := range []string{fakeSecretB64, fakeTLSB64, fakeBracePlan} {
		if strings.Contains(text, v) {
			return v
		}
	}
	return ""
}

// The shapes a read tool can give its output, for each way of naming a kind that holds a Secret: none of them hands
// out a Secret's values.
func TestSecretValuesStayOutOfEveryReadToolOutput(t *testing.T) {
	spellings := []string{"secrets", "secret", "Secret", "SECRETS", "secrets.v1", "secret.v1", "secrets,configmaps", "configmaps,secrets", "all"}
	calls := []struct {
		tool string
		args map[string]interface{}
	}{
		{"k8s_jq_query", map[string]interface{}{"jq": ".items[].data"}},
		{"k8s_jq_query", map[string]interface{}{"jq": `[.items[] | select(.data != null) | .data | to_entries[] | .value]`}},
		{"k8s_jq_query", map[string]interface{}{"jq": ".items[] | .metadata.annotations"}},
		{"k8s_jq_query", map[string]interface{}{"jq": ".items[]"}},
		{"k8s_jq_query", map[string]interface{}{"jq": `.items[] | select(.kind == "Secret") | .data.password | .missing`}},
		{"k8s_tabular_query", map[string]interface{}{"columns": "V:.data.password"}},
		{"k8s_tabular_query", map[string]interface{}{"columns": "N:.metadata.name", "sort_by": ".data.password"}},
		{"k8s_count", map[string]interface{}{"group_by": ".data.password"}},
		{"k8s_count", map[string]interface{}{"group_by": ".data"}},
		{"k8s_count", map[string]interface{}{"group_by": ".metadata.annotations"}},
		{"k8s_get_resources", map[string]interface{}{"output": "jsonpath={.items[*].data}"}},
		{"k8s_get_resources", map[string]interface{}{"output": "jsonpath-as-json={.items[*].data}"}},
		{"k8s_get_resources", map[string]interface{}{"output": "go-template={{range .items}}{{.data}}{{end}}"}},
		{"k8s_get_resources", map[string]interface{}{"output": "custom-columns=V:.data.password"}},
		{"k8s_get_resources", map[string]interface{}{"output": "json"}},
	}
	toolServerForSecrets(t, nil)
	fakeClusterKubectl(t, true)
	for _, kind := range spellings {
		for _, c := range calls {
			args := map[string]interface{}{"resource_type": kind, "namespace": "shop"}
			for k, v := range c.args {
				args[k] = v
			}
			if v := secretValueIn(callTool(t, c.tool, args)); v != "" {
				t.Errorf("%s %s %v: the answer holds the value %q", c.tool, kind, c.args, v)
			}
		}
	}
}

// A refusal says why and where to go, so the model does not try the next spelling; kubectl never prints the values.
func TestSecretOutputExpressionIsRefusedBeforeKubectlRuns(t *testing.T) {
	toolServerForSecrets(t, nil)
	calls := fakeClusterKubectl(t, false)
	for _, c := range []struct {
		tool string
		args map[string]interface{}
	}{
		{"k8s_tabular_query", map[string]interface{}{"resource_type": "secrets", "namespace": "shop", "columns": "V:.data.password"}},
		{"k8s_get_resources", map[string]interface{}{"resource_type": "secret", "namespace": "shop", "output": "jsonpath={.data}"}},
		{"k8s_get_resources", map[string]interface{}{"resource_type": "secrets,configmaps", "namespace": "shop", "output": "custom-columns=V:.data"}},
		{"k8s_count", map[string]interface{}{"resource_type": "secrets", "namespace": "shop", "group_by": ".data.password"}},
	} {
		*calls = nil
		resp := callTool(t, c.tool, c.args)
		if resp.Error != "" {
			t.Errorf("%s %v: a refusal is a result the model reads, got the error %q", c.tool, c.args, resp.Error)
			continue
		}
		var m map[string]interface{}
		if err := json.Unmarshal([]byte(resp.Content), &m); err != nil {
			t.Errorf("%s %v: the answer is not a refusal: %q", c.tool, c.args, resp.Content)
			continue
		}
		reason, _ := m["reason"].(string)
		hint, _ := m["hint"].(string)
		if m["status"] != "forbidden" || !strings.Contains(reason, "Secret") || !strings.Contains(hint, "k8s_describe_resource") {
			t.Errorf("%s %v: refusal %q", c.tool, c.args, resp.Content)
		}
		if len(*calls) != 0 {
			t.Errorf("%s %v: kubectl ran: %v", c.tool, c.args, *calls)
		}
	}
}

// The same calls on kinds that are not Secrets answer as kubectl does: nothing is refused or emptied.
func TestOtherKindsKeepTheirValuesInEveryReadToolOutput(t *testing.T) {
	toolServerForSecrets(t, nil)
	fakeClusterKubectl(t, false)
	for _, c := range []struct {
		tool, kind string
		args       map[string]interface{}
		want       string
	}{
		{"k8s_jq_query", "configmaps", map[string]interface{}{"jq": ".items[].data.mode"}, fakeConfig},
		{"k8s_jq_query", "configmaps", map[string]interface{}{"jq": ".items[].data"}, fakeConfig},
		{"k8s_jq_query", "deployments", map[string]interface{}{"jq": ".items[].spec.image"}, fakeImage},
		{"k8s_jq_query", "all", map[string]interface{}{"jq": ".items[].data.mode"}, fakeConfig},
		{"k8s_tabular_query", "configmaps", map[string]interface{}{"columns": "V:.data.mode"}, fakeConfig},
		{"k8s_tabular_query", "deployments", map[string]interface{}{"columns": "V:.spec.image"}, fakeImage},
		{"k8s_tabular_query", "all", map[string]interface{}{"columns": "V:.data.mode"}, fakeConfig},
		{"k8s_count", "configmaps", map[string]interface{}{"group_by": ".data.mode"}, fakeConfig},
		{"k8s_count", "deployments", map[string]interface{}{"group_by": ".spec.image"}, fakeImage},
		{"k8s_count", "all", map[string]interface{}{"group_by": ".data.mode"}, fakeConfig},
		{"k8s_get_resources", "configmaps", map[string]interface{}{"output": "jsonpath={.items[*].data.mode}"}, fakeConfig},
		{"k8s_get_resources", "configmaps", map[string]interface{}{"output": "jsonpath-as-json={.items[*].data.mode}"}, fakeConfig},
		{"k8s_get_resources", "configmaps", map[string]interface{}{"output": "go-template={{range .items}}{{.data.mode}}{{end}}"}, fakeConfig},
		{"k8s_get_resources", "configmaps", map[string]interface{}{"output": "custom-columns=V:.data.mode"}, fakeConfig},
		{"k8s_get_resources", "deployments", map[string]interface{}{"output": "jsonpath={.items[*].spec.image}"}, fakeImage},
		{"k8s_get_resources", "all", map[string]interface{}{"output": "jsonpath={.items[*].data.mode}"}, fakeConfig},
		{"k8s_get_resources", "configmaps", map[string]interface{}{"output": "json"}, fakeConfig},
	} {
		args := map[string]interface{}{"resource_type": c.kind, "namespace": "shop"}
		for k, v := range c.args {
			args[k] = v
		}
		resp := callTool(t, c.tool, args)
		if resp.Error != "" || !strings.Contains(resp.Content, c.want) {
			t.Errorf("%s %s %v: want %q, got content %q error %q", c.tool, c.kind, c.args, c.want, resp.Content, resp.Error)
		}
	}

	// a list of both keeps the ConfigMap's value and drops the Secret's
	fakeClusterKubectl(t, true)
	resp := callTool(t, "k8s_jq_query", map[string]interface{}{"resource_type": "secrets,configmaps", "namespace": "shop", "jq": ".items[].data"})
	if !strings.Contains(resp.Content, fakeConfig) || secretValueIn(resp) != "" {
		t.Errorf("mixed list: %q", resp.Content)
	}
	resp = callTool(t, "k8s_get_resources", map[string]interface{}{"resource_type": "secrets,configmaps", "namespace": "shop", "output": "json"})
	if !strings.Contains(resp.Content, fakeConfig) || secretValueIn(resp) != "" {
		t.Errorf("mixed list as JSON: %q", resp.Content)
	}
}

// What needs no value stays open on Secrets: how many, of which type, under which names and keys.
func TestSecretNamesKeysAndCountsStayReadable(t *testing.T) {
	toolServerForSecrets(t, nil)
	fakeClusterKubectl(t, false)
	for _, c := range []struct {
		tool string
		args map[string]interface{}
		want string
	}{
		{"k8s_count", map[string]interface{}{}, `"count":1`},
		{"k8s_count", map[string]interface{}{"group_by": ".type"}, `"key":"Opaque"`},
		{"k8s_jq_query", map[string]interface{}{"jq": ".items[].metadata.name"}, `"db"`},
		{"k8s_jq_query", map[string]interface{}{"jq": ".items[].data | keys"}, `tls.key`},
		{"k8s_jq_query", map[string]interface{}{"jq": ".items[].metadata.annotations.team"}, `"shop"`},
		{"k8s_get_resources", map[string]interface{}{"output": "wide"}, "Opaque"},
		{"k8s_get_resources", map[string]interface{}{"output": "name"}, "secret/db"},
		{"k8s_get_resources", map[string]interface{}{"output": "json"}, `tls.key`},
		{"k8s_describe_resource", map[string]interface{}{"resource_name": "db"}, "conf:  8 bytes"},
	} {
		args := map[string]interface{}{"resource_type": "secrets", "namespace": "shop"}
		for k, v := range c.args {
			args[k] = v
		}
		resp := callTool(t, c.tool, args)
		if !strings.Contains(resp.Content, c.want) || resp.Error != "" || secretValueIn(resp) != "" {
			t.Errorf("%s %v: want %q, got content %q error %q", c.tool, c.args, c.want, resp.Content, resp.Error)
		}
	}
}

// A Secret cut off by the output cap may end before the line that says it is a Secret.
func TestSecretOutputCutBeforeItsKindIsMasked(t *testing.T) {
	saved := outputMaxBytes
	t.Cleanup(func() { outputMaxBytes = saved })
	toolServerForSecrets(t, nil)
	for _, tc := range []struct {
		tool string
		args map[string]interface{}
		out  string
	}{
		{"k8s_get_resource_yaml", map[string]interface{}{"resource_type": "secret", "resource_name": "db"}, "apiVersion: v1\ndata:\n  tls.key: " + fakeTLSB64 + "\n  other: " + fakeSecretB64 + "\nkind: Secret\n"},
		{"k8s_get_resources", map[string]interface{}{"resource_type": "secrets", "resource_name": "db", "output": "json"}, `{"apiVersion":"v1","data":{"tls.key":"` + fakeTLSB64 + `","other":"` + fakeSecretB64 + `"},"kind":"Secret"}`},
	} {
		outputMaxBytes = strings.Index(tc.out, "kind") - 2
		fakeKubectl(t, func(args []string) (string, error) { return tc.out, nil })
		if v := secretValueIn(callTool(t, tc.tool, tc.args)); v != "" {
			t.Errorf("%s: the cut answer holds %q", tc.tool, v)
		}
	}
}

// A tool's JSON answer is masked inside its strings: a YAML document or a log line is the same text it would be alone.
func TestToolOutputIsMaskedInsideItsJSONStrings(t *testing.T) {
	for _, c := range []struct {
		name  string
		value interface{}
		gone  []string
		kept  []string
	}{
		{"Secret document", map[string]interface{}{"content": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ndata:\n  tls.key: " + fakeTLSB64 + "\n"},
			[]string{fakeTLSB64}, []string{"tls.key", "name: db"}},
		{"chart password", map[string]interface{}{"content": "adminPassword: fake-chart-password\nreplicaCount: 2\n"},
			[]string{"fake-chart-password"}, []string{"replicaCount: 2", "adminPassword"}},
		{"log line", map[string]interface{}{"lines": []interface{}{map[string]interface{}{"line": "password: fake-log-password"}, map[string]interface{}{"line": "GET /healthz 200"}}},
			[]string{"fake-log-password"}, []string{"GET /healthz 200"}},
		{"Secret as JSON text with braces", map[string]interface{}{"content": `{"kind":"Secret","stringData":{"conf":"{ value = ` + fakeBracePlan + ` }"}}`},
			[]string{fakeBracePlan}, []string{"stringData"}},
		{"Secret object in a result", map[string]interface{}{"results": []interface{}{map[string]interface{}{"kind": "Secret", "data": map[string]interface{}{"tls.key": fakeTLSB64}}}},
			[]string{fakeTLSB64}, []string{"tls.key"}},
		{"ConfigMap next to a Secret", map[string]interface{}{"results": []interface{}{
			map[string]interface{}{"kind": "Secret", "data": map[string]interface{}{"tls.key": fakeTLSB64}},
			map[string]interface{}{"kind": "ConfigMap", "data": map[string]interface{}{"mode": fakeConfig}}}},
			[]string{fakeTLSB64}, []string{fakeConfig}},
		{"credential key", map[string]interface{}{"auth": map[string]interface{}{"password": `fake"after"quote`, "user": "app"}},
			[]string{"after"}, []string{`"user":"app"`}},
		{"env pair", map[string]interface{}{"env": []interface{}{map[string]interface{}{"name": "API_TOKEN", "value": "fake-env-token"}, map[string]interface{}{"name": "MODE", "value": "fast"}}},
			[]string{"fake-env-token"}, []string{"fast"}},
	} {
		text, err := marshalJSON(c.value)
		if err != nil {
			t.Fatal(err)
		}
		out, stats := redactToolOutput(text)
		for _, gone := range c.gone {
			if strings.Contains(out, gone) {
				t.Errorf("%s: %q is still there: %s", c.name, gone, out)
			}
		}
		for _, kept := range c.kept {
			if !strings.Contains(out, kept) {
				t.Errorf("%s: %q was lost: %s", c.name, kept, out)
			}
		}
		if !json.Valid([]byte(out)) {
			t.Errorf("%s: the answer is no longer JSON: %s", c.name, out)
		}
		if stats == nil || stats.Count == 0 {
			t.Errorf("%s: the audit row must say something was masked: %+v", c.name, stats)
		}
	}
}

// Masking one string leaves the rest of the answer byte for byte: numbers, key order, spacing and non-JSON text.
func TestToolOutputKeepsEverythingElseOfItsJSON(t *testing.T) {
	in := `{ "z": 12345678901234567890, "a": 1.50, "m": 1e3,
  "t": [true, null, "x<y&z"], "unicode": "\uD55C\uAE00", "line": "password: fake-log-password",
  "b": {"y": 1, "x": 2} }`
	want := `{ "z": 12345678901234567890, "a": 1.50, "m": 1e3,
  "t": [true, null, "x<y&z"], "unicode": "\uD55C\uAE00", "line": "password: <REDACTED:password>",
  "b": {"y": 1, "x": 2} }`
	if out, stats := redactToolOutput(in); out != want || stats == nil || stats.Kinds["key_name"] != 1 {
		t.Errorf("got  %s\nwant %s\nstats %+v", out, want, stats)
	}
	same := `{"z":1.0,"b":[1,2],"a":"plain"}`
	if out, stats := redactToolOutput(same); out != same || stats != nil {
		t.Errorf("an answer with nothing to mask must be returned as it came: %s %+v", out, stats)
	}
	// kubectl's warning before the JSON keeps JSON's rules for what follows
	warned := "Warning: something is deprecated\n" + `{"content":"adminPassword: fake-chart-password\nreplicaCount: 2"}`
	out, _ := redactToolOutput(warned)
	if strings.Contains(out, "fake-chart-password") || !strings.HasPrefix(out, "Warning: something is deprecated\n") || !strings.Contains(out, "replicaCount: 2") {
		t.Errorf("warning then JSON: %s", out)
	}
	for _, text := range []string{"NAME READY\nweb 1/1\n", "12", "true", "not json {"} {
		if out, stats := redactToolOutput(text); out != text || stats != nil {
			t.Errorf("plain text %q changed: %q %+v", text, out, stats)
		}
	}
}

// secretRevealer signs the caller of toolServerForSecrets in with resource.secret.reveal as well.
func secretRevealer(t *testing.T) {
	t.Helper()
	prev := toolAuth
	toolAuth = fakeValidator{payload: auth.TokenPayload{UserID: "u1", Email: "a@example.com",
		Perms: auth.PermissionMatrix{secretValuesCluster: {"ai.tool.*", "resource.*.read", "resource.*.edit", "resource.helm.read", "resource.secret.reveal"}}}}
	t.Cleanup(func() { toolAuth = prev })
}

// What k8s_diff answered of a Secret, the parts a value could change.
func diffAnswer(t *testing.T, resp ToolCallResponse) string {
	t.Helper()
	m := decode(t, resp.Content)
	read, _ := json.Marshal([]interface{}{m["status"], m["lines_added"], m["lines_removed"], m["diff"], m["hint"], m["values_not_compared"]})
	return string(read)
}

// k8s_diff previews a Secret without its values, whatever its keys are called, and to one who may reveal them still says
// which keys would change.
func TestDiffOfASecretNamesTheChangedKeysWithoutTheirValues(t *testing.T) {
	const oldKey, newKey, sameCrt, oldReg, newReg = "b2xkLWZha2Uta2V5", "bmV3LWZha2Uta2V5", "c2FtZS1mYWtlLWNydA==", "b2xkLWZha2UtcmVn", "bmV3LWZha2UtcmVn"
	secret := func(key, reg string) string {
		return `{"apiVersion":"v1","kind":"Secret","type":"kubernetes.io/tls","metadata":{"name":"tls","namespace":"shop","uid":"u1","annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\"data\":{\"tls.key\":\"` + key + `\"}}","team":"shop"}},` +
			`"data":{"tls.key":"` + key + `","tls.crt":"` + sameCrt + `",".dockerconfigjson":"` + reg + `"}}`
	}
	manifest := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: tls\n  namespace: shop\n"
	toolServerForSecrets(t, nil)
	secretRevealer(t)
	values := []string{oldKey, newKey, sameCrt, oldReg, newReg}

	fakeKubectl(t, func(args []string) (string, error) {
		if has(args, "apply") {
			return secret(newKey, newReg), nil
		}
		return secret(oldKey, oldReg), nil
	})
	resp := callTool(t, "k8s_diff", map[string]interface{}{"yaml_content": manifest})
	for _, v := range values {
		if strings.Contains(resp.Content+resp.Error, v) {
			t.Fatalf("the preview holds the value %q: %s %s", v, resp.Content, resp.Error)
		}
	}
	m := decode(t, resp.Content)
	diff, _ := m["diff"].(string)
	if m["status"] != "changed" || m["lines_added"] != float64(2) || m["lines_removed"] != float64(2) {
		t.Fatalf("two keys change: %s", resp.Content)
	}
	for _, line := range []string{`-    "tls.key"`, `+    "tls.key"`, `-    ".dockerconfigjson"`, `+    ".dockerconfigjson"`} {
		if !strings.Contains(diff, line) {
			t.Fatalf("%q missing from:\n%s", line, diff)
		}
	}
	if strings.Contains(diff, `-    "tls.crt"`) || strings.Contains(diff, `+    "tls.crt"`) {
		t.Fatalf("a key that stays the same is no change:\n%s", diff)
	}

	fakeKubectl(t, func(args []string) (string, error) { return secret(oldKey, oldReg), nil })
	if m := decode(t, callTool(t, "k8s_diff", map[string]interface{}{"yaml_content": manifest}).Content); m["status"] != "unchanged" {
		t.Fatalf("same values: %v", m)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		if has(args, "apply") {
			return secret(newKey, newReg), nil
		}
		return kubectlErr(`Error from server (NotFound): secrets "tls" not found`)
	})
	resp = callTool(t, "k8s_diff", map[string]interface{}{"yaml_content": manifest})
	for _, v := range values {
		if strings.Contains(resp.Content, v) {
			t.Fatalf("a new Secret's preview holds %q: %s", v, resp.Content)
		}
	}
	if m := decode(t, resp.Content); m["status"] != "created" || !strings.Contains(m["diff"].(string), "tls.key") {
		t.Fatalf("created: %s", resp.Content)
	}
}

// k8s_diff of a Secret as the signed-in caller, against a live Secret holding liveData; the dry run holds dryData.
func secretDiff(t *testing.T, manifest string, liveData, dryData map[string]string) ToolCallResponse {
	t.Helper()
	object := func(data map[string]string) string {
		raw, _ := json.Marshal(map[string]interface{}{"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
			"metadata": map[string]interface{}{"name": "db", "namespace": "shop"}, "data": data})
		return string(raw)
	}
	fakeKubectl(t, func(args []string) (string, error) {
		if has(args, "apply") {
			return object(dryData), nil
		}
		return object(liveData), nil
	})
	return callTool(t, "k8s_diff", map[string]interface{}{"yaml_content": manifest})
}

// Without resource.secret.reveal a Secret's values are not compared: a value that matches the live one and one that does
// not read the same, under stringData and data alike, and each key the manifest gives shows as a change, saying why.
func TestDiffOfASecretWithoutRevealReadsTheSameForARightAndAWrongValue(t *testing.T) {
	const livePassword, liveToken, kept = "fake-live-password", "ZmFrZS1saXZlLXRva2Vu", "ZmFrZS1rZXB0LXZhbHVl"
	toolServerForSecrets(t, nil)
	answerFor := func(password, token string) (string, ToolCallResponse) {
		manifest := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\nstringData:\n  password: " + password + "\ndata:\n  token: " + token + "\n"
		resp := secretDiff(t, manifest,
			map[string]string{"password": base64.StdEncoding.EncodeToString([]byte(livePassword)), "token": liveToken, "kept": kept},
			map[string]string{"password": base64.StdEncoding.EncodeToString([]byte(password)), "token": token, "kept": kept})
		return diffAnswer(t, resp), resp
	}
	right, rightResp := answerFor(livePassword, liveToken)
	wrong, wrongResp := answerFor("fake-wrong-guess", "ZmFrZS13cm9uZy10b2tlbg==")
	if right != wrong {
		t.Fatalf("a right value and a wrong one read differently:\nright: %s\nwrong: %s", right, wrong)
	}
	for _, resp := range []ToolCallResponse{rightResp, wrongResp} {
		for _, v := range []string{livePassword, liveToken, kept, "fake-wrong-guess", "ZmFrZS13cm9uZy10b2tlbg==", base64.StdEncoding.EncodeToString([]byte(livePassword))} {
			if strings.Contains(resp.Content+resp.Error, v) {
				t.Fatalf("the preview holds the value %q: %s", v, resp.Content)
			}
		}
	}
	m := decode(t, rightResp.Content)
	diff, _ := m["diff"].(string)
	if m["status"] != "changed" || m["lines_added"] != float64(2) || m["lines_removed"] != float64(2) {
		t.Fatalf("each key the manifest gives is a change: %s", rightResp.Content)
	}
	for _, line := range []string{`-    "password": "<REDACTED:secret>"`, `+    "password": "<REDACTED:secret`, `-    "token": "<REDACTED:secret>"`, `+    "token": "<REDACTED:secret`} {
		if !strings.Contains(diff, line) {
			t.Fatalf("%q missing from:\n%s", line, diff)
		}
	}
	if strings.Contains(diff, `-    "kept"`) || strings.Contains(diff, `+    "kept"`) {
		t.Fatalf("a key the manifest does not give is no change:\n%s", diff)
	}
	if note, _ := m["values_not_compared"].(string); !strings.Contains(note, "resource.secret.reveal") || !strings.Contains(note, "password") || !strings.Contains(note, "token") {
		t.Fatalf("the answer must say which values were not compared and why: %s", rightResp.Content)
	}
}

// Keys the manifest adds and keys the apply takes out are still named, without a value.
func TestDiffOfASecretWithoutRevealNamesAddedAndRemovedKeys(t *testing.T) {
	const gone, added, kept = "ZmFrZS1nb25lLXZhbHVl", "ZmFrZS1uZXctdmFsdWU=", "ZmFrZS1rZXB0LXZhbHVl"
	toolServerForSecrets(t, nil)
	manifest := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\ndata:\n  added: " + added + "\n"
	resp := secretDiff(t, manifest, map[string]string{"gone": gone, "kept": kept}, map[string]string{"added": added, "kept": kept})
	for _, v := range []string{gone, added, kept} {
		if strings.Contains(resp.Content+resp.Error, v) {
			t.Fatalf("the preview holds the value %q: %s", v, resp.Content)
		}
	}
	m := decode(t, resp.Content)
	diff, _ := m["diff"].(string)
	if m["status"] != "changed" || m["lines_added"] != float64(1) || m["lines_removed"] != float64(1) {
		t.Fatalf("one key added, one taken out: %s", resp.Content)
	}
	for _, line := range []string{`+    "added": "<REDACTED:secret>"`, `-    "gone": "<REDACTED:secret>"`} {
		if !strings.Contains(diff, line) {
			t.Fatalf("%q missing from:\n%s", line, diff)
		}
	}
	if note, _ := m["values_not_compared"].(string); !strings.Contains(note, "resource.secret.reveal") {
		t.Fatalf("the answer must say the values are not compared: %s", resp.Content)
	}
}

// One who may reveal the values gets them compared, as before: unchanged for the same value, the key changed for another.
func TestDiffOfASecretByOneWhoMayRevealComparesTheValues(t *testing.T) {
	const live = "ZmFrZS1saXZlLXZhbHVl"
	toolServerForSecrets(t, nil)
	secretRevealer(t)
	manifest := func(value string) string {
		return "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: shop\ndata:\n  password: " + value + "\n"
	}
	same := decode(t, secretDiff(t, manifest(live), map[string]string{"password": live}, map[string]string{"password": live}).Content)
	if same["status"] != "unchanged" || same["values_not_compared"] != nil {
		t.Fatalf("the same value: %v", same)
	}
	other := decode(t, secretDiff(t, manifest("ZmFrZS1vdGhlcg=="), map[string]string{"password": live}, map[string]string{"password": "ZmFrZS1vdGhlcg=="}).Content)
	diff, _ := other["diff"].(string)
	if other["status"] != "changed" || other["lines_added"] != float64(1) || other["lines_removed"] != float64(1) || !strings.Contains(diff, `-    "password"`) ||
		!strings.Contains(diff, `+    "password"`) || strings.Contains(diff, live) || strings.Contains(diff, "ZmFrZS1vdGhlcg==") || other["values_not_compared"] != nil {
		t.Fatalf("another value: %v", other)
	}
}

// Other kinds keep their diff as it was, values and all, whoever asks.
func TestDiffOfAnotherKindIsNotTouchedByTheSecretRule(t *testing.T) {
	toolServerForSecrets(t, nil)
	object := func(mode string) string {
		return `{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"app","namespace":"shop"},"data":{"mode":"` + mode + `"}}`
	}
	fakeKubectl(t, func(args []string) (string, error) {
		if has(args, "apply") {
			return object("plain-config-new"), nil
		}
		return object("plain-config-old"), nil
	})
	m := decode(t, callTool(t, "k8s_diff", map[string]interface{}{"yaml_content": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: shop\ndata:\n  mode: plain-config-new\n"}).Content)
	diff, _ := m["diff"].(string)
	if m["status"] != "changed" || !strings.Contains(diff, `-    "mode": "plain-config-old"`) || !strings.Contains(diff, `+    "mode": "plain-config-new"`) || m["values_not_compared"] != nil {
		t.Fatalf("a ConfigMap's diff: %v", m)
	}
}

// What the read took out of the list is in the audit row's count too, which the answer's masking cannot see any more.
func TestSecretValuesTakenOutAtTheReadAreCountedForTheAuditRow(t *testing.T) {
	toolServerForSecrets(t, nil)
	list := `{"apiVersion":"v1","kind":"List","items":[` +
		`{"kind":"Secret","metadata":{"name":"a"},"data":{"note":"ZmFrZS0x","other":"ZmFrZS0y"}},` +
		`{"kind":"Secret","metadata":{"name":"b"},"data":{"note":"ZmFrZS0z"}}]}`
	fakeKubectl(t, func([]string) (string, error) { return list, nil })
	for _, c := range []struct {
		tool string
		args map[string]interface{}
	}{
		{"k8s_jq_query", map[string]interface{}{"resource_type": "secrets", "namespace": "shop", "jq": ".items[].metadata.name"}},
		{"k8s_count", map[string]interface{}{"resource_type": "secrets", "namespace": "shop", "group_by": ".type"}},
	} {
		resp := callTool(t, c.tool, c.args)
		if resp.Error != "" {
			t.Fatalf("%s: %s", c.tool, resp.Error)
		}
		if resp.Redacted == nil || resp.Redacted.Kinds["secret"] != 3 {
			t.Errorf("%s: redacted = %+v, want 3 taken out at the read", c.tool, resp.Redacted)
		}
	}

	fakeKubectl(t, func([]string) (string, error) {
		return `{"apiVersion":"v1","kind":"List","items":[{"kind":"Pod","metadata":{"name":"a"}}]}`, nil
	})
	resp := callTool(t, "k8s_jq_query", map[string]interface{}{"resource_type": "pods", "namespace": "shop", "jq": ".items[].metadata.name"})
	if resp.Redacted != nil {
		t.Errorf("nothing to take out, redacted = %+v", resp.Redacted)
	}

	// A read that failed after the list came still says what it took out.
	fakeKubectl(t, func([]string) (string, error) { return list, nil })
	resp = callTool(t, "k8s_jq_query", map[string]interface{}{"resource_type": "secrets", "namespace": "shop", "jq": ".items[0].metadata.name | .foo"})
	if resp.Error == "" {
		t.Fatalf("the program did not fail: %s", resp.Content)
	}
	if resp.Redacted == nil || resp.Redacted.Kinds["secret"] != 3 {
		t.Errorf("after a failed program, redacted = %+v", resp.Redacted)
	}
}

// A Secret the output cap cut goes through the text rules before the answer's: those are counted too.
func TestACutSecretsValuesAreCountedForTheAuditRow(t *testing.T) {
	toolServerForSecrets(t, nil)
	fakeKubectl(t, func([]string) (string, error) {
		return "metadata:\n  name: a\ndata:\n  note: ZmFrZS0x\n" + truncatedMarkerLead + " cut", nil
	})
	resp := callTool(t, "k8s_get_resources", map[string]interface{}{"resource_type": "secrets", "resource_name": "a", "namespace": "shop", "output": "yaml"})
	if resp.Error != "" {
		t.Fatal(resp.Error)
	}
	if strings.Contains(resp.Content, "ZmFrZS0x") {
		t.Errorf("the value left: %s", resp.Content)
	}
	if resp.Redacted == nil || resp.Redacted.Kinds["secret"] != 1 {
		t.Errorf("redacted = %+v, want 1: %s", resp.Redacted, resp.Content)
	}
}

// A failed tool's text goes through the same masking as a good answer: stdout of a failed command, a refused patch,
// a failed lookup, an argument echoed back.
func TestFailedToolOutputIsMasked(t *testing.T) {
	toolServerForSecrets(t, nil)

	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr("boom\npassword: fake-failed-password\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz012345\nstill here")
	})
	resp := callTool(t, "k8s_describe_resource", map[string]interface{}{"resource_type": "pods", "resource_name": "web"})
	if resp.Error == "" || strings.Contains(resp.Error, "fake-failed-password") || strings.Contains(resp.Error, "abcdefghijklmnopqrstuvwxyz012345") || !strings.Contains(resp.Error, "still here") {
		t.Errorf("kubectl failure: %q", resp.Error)
	}
	if resp.Redacted == nil || resp.Redacted.Count == 0 {
		t.Errorf("the audit row must say something was masked: %+v", resp.Redacted)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr("Error from server: error when applying patch:\n" + `{"data":{"tls.key":"` + fakeTLSB64 + `"},"metadata":{"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\"stringData\":{\"conf\":\"` + fakeBracePlan + `\"}}"}}}` +
			"\nto:\nResource: \"/v1, Resource=secrets\", GroupVersionKind: \"/v1, Kind=Secret\"\nName: \"db\", Namespace: \"shop\"\nfor: \"STDIN\": conflict")
	})
	resp = callTool(t, "k8s_diff", map[string]interface{}{"yaml_content": "kind: Secret\nmetadata:\n  name: db\n"})
	if resp.Error == "" || secretValueIn(resp) != "" {
		t.Errorf("refused patch of a Secret: %q", resp.Error)
	}

	if err := validateToolArgs(map[string]interface{}{"namespace": "AKIAIOSFODNN7EXAMPLE"}); err == nil || !errors.Is(err, errBadRequest) {
		t.Fatalf("the check must refuse this argument: %v", err)
	}
	resp = callTool(t, "k8s_get_resources", map[string]interface{}{"resource_type": "pods", "namespace": "AKIAIOSFODNN7EXAMPLE"})
	if resp.Error == "" || strings.Contains(resp.Error, "AKIAIOSFODNN7EXAMPLE") {
		t.Errorf("an argument echoed back: %q", resp.Error)
	}

	// k8s-service answering 500 with the line in its detail
	toolServerForSecrets(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"upstream said\npassword: fake-feature-password"}`))
	})
	resp = callTool(t, "logsearch", map[string]interface{}{"namespace": "shop"})
	if resp.Error == "" || strings.Contains(resp.Error, "fake-feature-password") {
		t.Errorf("k8s-service failure: %q", resp.Error)
	}

	// the kubeconfig lookup failing
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("password: fake-lookup-password"))
	})
	t.Cleanup(restore)
	resp = callTool(t, "k8s_get_resources", map[string]interface{}{"resource_type": "pods", "namespace": "shop"})
	if resp.Error == "" || strings.Contains(resp.Error, "fake-lookup-password") {
		t.Errorf("kubeconfig lookup failure: %q", resp.Error)
	}
}

// The log store's lines reach the model as masked as kubectl logs' do.
func TestLogStoreLinesAreMaskedLikeKubectlLogs(t *testing.T) {
	toolServerForSecrets(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/logsearch/logql"):
			_, _ = w.Write([]byte(`{"resultType":"streams","lines":[{"line":"password: fake-log-password","pod":"web-1"},{"line":"GET /healthz 200","pod":"web-1"}]}`))
		case strings.HasSuffix(r.URL.Path, "/logsearch"):
			_, _ = w.Write([]byte(`{"lines":[{"line":"token=fake-log-token","pod":"web-1"},{"line":"GET /healthz 200","pod":"web-1"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	fakeKubectl(t, func(args []string) (string, error) { return "password: fake-log-password\nGET /healthz 200\n", nil })
	logs := callTool(t, "k8s_get_pod_logs", map[string]interface{}{"pod_name": "web-1", "namespace": "shop"})
	if strings.Contains(logs.Content, "fake-log-password") {
		t.Fatalf("kubectl logs: %q", logs.Content)
	}
	for _, c := range []struct {
		tool string
		args map[string]interface{}
		gone string
	}{
		{"loki_query", map[string]interface{}{"logql": `{k8s_namespace_name="shop"}`, "namespace": "shop"}, "fake-log-password"},
		{"logsearch", map[string]interface{}{"namespace": "shop"}, "fake-log-token"},
	} {
		resp := callTool(t, c.tool, c.args)
		if resp.Error != "" || strings.Contains(resp.Content, c.gone) || !strings.Contains(resp.Content, "GET /healthz 200") {
			t.Errorf("%s: content %q error %q", c.tool, resp.Content, resp.Error)
		}
	}
}

// helm_read asks k8s-service for the masked text whatever the caller may reveal: no reveal happens on the AI path.
func TestHelmReadAsksForTheMaskedText(t *testing.T) {
	var asked []string
	toolServerForSecrets(t, func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path+" masked="+r.URL.Query().Get("masked"))
		switch {
		case strings.HasSuffix(r.URL.Path, "/diff"):
			_, _ = w.Write([]byte(`{"from":1,"to":2,"diff":"+kind: Secret\n"}`))
		case strings.HasSuffix(r.URL.Path, "/releases/shop/web"):
			_, _ = w.Write([]byte(`{"name":"web","values":{"a":1}}`))
		default:
			_, _ = w.Write([]byte(`{"section":"values","content":"apiVersion: v1\nkind: Secret\ndata:\n  tls.key: ` + fakeTLSB64 + `\n"}`))
		}
	})
	for _, args := range []map[string]interface{}{
		{"what": "get"}, {"what": "values"}, {"what": "manifest"}, {"what": "notes"}, {"what": "hooks"},
		{"what": "revision", "revision": 1, "section": "manifest"}, {"what": "diff", "from": 1, "to": 2},
	} {
		asked = nil
		args["namespace"], args["release"] = "shop", "web"
		resp := callTool(t, "helm_read", args)
		if resp.Error != "" || secretValueIn(resp) != "" {
			t.Errorf("%v: content %q error %q", args, resp.Content, resp.Error)
		}
		if len(asked) != 1 || !strings.HasSuffix(asked[0], "masked=1") {
			t.Errorf("%v: asked %v", args, asked)
		}
	}
}
