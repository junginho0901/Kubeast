package redact

import (
	"encoding/json"
	"strings"
	"testing"
)

func asJSON(t *testing.T, v any) string {
	t.Helper()
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func on() Options { return Options{Enabled: true, Disabled: map[string]bool{}} }

func TestKeyNames_YAMLEnvJSONDescribe(t *testing.T) {
	in := strings.Join([]string{
		"data:",
		"  DB_PASSWORD: hunter2-e2e",
		"  DATABASE_URL: postgres://app:s3cr3t@db:5432/app?sslmode=disable",
		"  API_KEY: sk-live-abcdef0123456789",
		"  MAX_TOKENS: \"4000\"",
		"  TOKEN_TTL: 60",
		"  PASSWORD_MIN_LENGTH: 12",
		"  AUTH_MODE: none",
		"  LOG_LEVEL: debug",
		"env:",
		"- name: POSTGRES_PASSWORD",
		"  value: plain-text-pw",
		"- name: POSTGRES_PASSWORD",
		"  valueFrom:",
		"    secretKeyRef:",
		"      name: db-creds",
		"      key: password",
		"Environment:",
		"  POSTGRES_PASSWORD:  <set to the key 'password' in secret 'db-creds'>",
		"  SMTP_PASSWORD:      letmein",
		`{"password":"json-pw","tokenizer":"tiktoken","client_secret": "abc123"}`,
		"export GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuv",
	}, "\n")
	out, st := Text(in, on())

	for _, gone := range []string{"hunter2-e2e", "s3cr3t", "sk-live-abcdef0123456789", "letmein", "json-pw", "abc123", "ghp_0123456789", "plain-text-pw"} {
		if strings.Contains(out, gone) {
			t.Errorf("value still present: %s\n%s", gone, out)
		}
	}
	for _, kept := range []string{"MAX_TOKENS: \"4000\"", "TOKEN_TTL: 60", "PASSWORD_MIN_LENGTH: 12", "AUTH_MODE: none", "LOG_LEVEL: debug",
		"name: POSTGRES_PASSWORD", "name: db-creds", "key: password", "<set to the key 'password' in secret 'db-creds'>", `"tokenizer":"tiktoken"`,
		"postgres://app:<REDACTED:password>@db:5432/app?sslmode=disable", "DB_PASSWORD: <REDACTED:DB_PASSWORD>",
		"value: <REDACTED:POSTGRES_PASSWORD>", `"password":"<REDACTED:password>"`, "GITHUB_TOKEN=<REDACTED:GITHUB_TOKEN>"} {
		if !strings.Contains(out, kept) {
			t.Errorf("expected to keep %q\n%s", kept, out)
		}
	}
	if st.Kinds["key_name"] != 7 || st.Kinds["url_credentials"] != 1 {
		t.Errorf("stats: %+v", st)
	}

	// escaped JSON (last-applied-configuration) and a JSON env list
	esc := `annotations: {"kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"password\":\"x-y-z\",\"host\":\"db\"}}"}` + "\n" +
		`{"env":[{"name":"API_TOKEN","value":"tok-123456"},{"name":"LOG_LEVEL","value":"info"}]}`
	out, _ = Text(esc, on())
	if strings.Contains(out, "x-y-z") || strings.Contains(out, "tok-123456") {
		t.Errorf("escaped/json env values still present:\n%s", out)
	}
	if !strings.Contains(out, `\"host\":\"db\"`) || !strings.Contains(out, `"value":"info"`) {
		t.Errorf("non-secret values must stay:\n%s", out)
	}
}

func TestKeyIsSensitive(t *testing.T) {
	yes := []string{"password", "DB_PASSWORD", "clientSecret", "client_secret", "apiKey", "api-key", "GITHUB_TOKEN", "aws.secret", "credentials", "DSN", "PRIVATE_KEY", "accessKey"}
	no := []string{"tokenizer", "max_tokens", "TOKEN_TTL", "password_min_length", "secretName", "secretKeyRef", "token_url", "passwordFile", "key", "KEY_DIR", "auth_mode", "clientId", "tokenType"}
	for _, k := range yes {
		if !keyIsSensitive(k) {
			t.Errorf("%q should be sensitive", k)
		}
	}
	for _, k := range no {
		if keyIsSensitive(k) {
			t.Errorf("%q should not be sensitive", k)
		}
	}
}

func TestValuePatterns(t *testing.T) {
	in := strings.Join([]string{
		"aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
		"aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		"Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiJ1MSIsImVtYWlsIjoidUBleGFtcGxlLmNvbSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU",
		"curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZC1oZXJl' https://x",
		"-----BEGIN RSA PRIVATE KEY-----",
		"MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AH1Xe6tE",
		"-----END RSA PRIVATE KEY-----",
		"redis://default:r3d1s@cache:6379/0",
		"GET /healthz 200 12ms",
	}, "\n")
	out, st := Text(in, on())
	for _, gone := range []string{"AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI", "eyJhbGciOiJSUzI1NiIs", "dXNlcjpwYXNzd29yZC1oZXJl", "MIIEpAIBAAKCAQEA", "r3d1s"} {
		if strings.Contains(out, gone) {
			t.Errorf("value still present: %s\n%s", gone, out)
		}
	}
	for _, kept := range []string{"GET /healthz 200 12ms", "redis://default:<REDACTED:password>@cache:6379/0", "<REDACTED:private_key>", "Bearer <REDACTED:token>"} {
		if !strings.Contains(out, kept) {
			t.Errorf("expected %q\n%s", kept, out)
		}
	}
	if st.Kinds["aws_key"] != 2 || st.Kinds["private_key"] != 1 || st.Kinds["authorization"] != 2 {
		t.Errorf("stats: %+v", st)
	}
}

func TestSecretInsideListItems_Stripped(t *testing.T) {
	// `kubectl get secrets -o yaml`: Secrets under items: at indent 2/4, a
	// block-scalar last-applied annotation, a multi-line stringData value.
	yaml := strings.Join([]string{
		"apiVersion: v1", "items:",
		"- apiVersion: v1", "  data:", "    password: aHVudGVyMg==", "  kind: Secret", "  metadata:", "    name: a",
		"    annotations:", "      kubectl.kubernetes.io/last-applied-configuration: |",
		`        {"apiVersion":"v1","data":{"password":"aHVudGVyMg=="},"kind":"Secret"}`, "      owner: team-a",
		"- apiVersion: v1", "  kind: Secret", "  metadata:", "    name: b", "  stringData:", "    token: plain-token-value",
		"    note: |", "      line one", "      line two", "  type: Opaque",
		"kind: List",
	}, "\n")
	out, st := Text(yaml, Options{Enabled: false})
	for _, gone := range []string{"aHVudGVyMg==", "plain-token-value", "line one", "line two"} {
		if strings.Contains(out, gone) {
			t.Errorf("still present: %s\n%s", gone, out)
		}
	}
	for _, kept := range []string{"name: a", "name: b", "owner: team-a", "kind: List", "type: Opaque",
		"password: <REDACTED:secret>", "token: <REDACTED:secret>", "note: <REDACTED:secret>",
		"kubectl.kubernetes.io/last-applied-configuration: <REDACTED:secret>"} {
		if !strings.Contains(out, kept) {
			t.Errorf("expected %q\n%s", kept, out)
		}
	}
	if st.Kinds["secret"] < 4 {
		t.Errorf("stats: %+v", st)
	}
	out2, _ := Text("kind: Secret\nitems:\n- data:\n    k: dmFsdWU=\n  kind: Secret\n", Options{Enabled: false})
	if strings.Contains(out2, "dmFsdWU=") || !strings.Contains(out2, "k: <REDACTED:secret>") {
		t.Errorf("\"- data:\" item form:\n%s", out2)
	}
}

func TestSecretDocument_AlwaysStripped(t *testing.T) {
	yaml := strings.Join([]string{
		"apiVersion: v1",
		"kind: Secret",
		"metadata:",
		"  name: db-creds",
		"  namespace: app",
		"  annotations:",
		`    kubectl.kubernetes.io/last-applied-configuration: '{"data":{"password":"aHVudGVyMg=="}}'`,
		"    owner: team-a",
		"data:",
		"  password: aHVudGVyMg==",
		"  username: YXBw",
		"type: Opaque",
		"---",
		"apiVersion: v1",
		"kind: ConfigMap",
		"metadata:",
		"  name: cfg",
		"data:",
		"  greeting: hello",
	}, "\n")
	off := Options{Enabled: false}
	out, st := Text(yaml, off)
	for _, gone := range []string{"aHVudGVyMg==", "YXBw"} {
		if strings.Contains(out, gone) {
			t.Errorf("secret value still present: %s\n%s", gone, out)
		}
	}
	for _, kept := range []string{"name: db-creds", "owner: team-a", "password: <REDACTED:secret>", "username: <REDACTED:secret>", "greeting: hello", "type: Opaque"} {
		if !strings.Contains(out, kept) {
			t.Errorf("expected %q\n%s", kept, out)
		}
	}
	if st.Kinds["secret"] != 3 {
		t.Errorf("stats: %+v", st)
	}

	js := `{"kind": "Secret", "metadata": {"name": "s", "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"p\":\"x\"}}"}}, "data": {"password": "aHVudGVyMg==", "user": "YXBw"}}`
	out, _ = Text(js, off)
	if strings.Contains(out, "aHVudGVyMg==") || strings.Contains(out, `\"p\":\"x\"`) {
		t.Errorf("json secret still present\n%s", out)
	}
}

func TestObject(t *testing.T) {
	v := map[string]any{
		"kind":     "Secret",
		"metadata": map[string]any{"name": "s", "annotations": map[string]any{"kubectl.kubernetes.io/last-applied-configuration": "{...}"}},
		"data":     map[string]any{"password": "aHVudGVyMg=="},
		"note":     "contact admin@example.com token=abc",
	}
	out, st := Object(v, on())
	m := out.(map[string]any)
	if m["data"].(map[string]any)["password"] != "<REDACTED:secret>" || m["metadata"].(map[string]any)["annotations"].(map[string]any)["kubectl.kubernetes.io/last-applied-configuration"] != "<REDACTED:secret>" {
		t.Errorf("secret fields not stripped: %+v", m)
	}
	if !strings.Contains(m["note"].(string), "admin@example.com") { // PII off by default
		t.Errorf("email must stay when PII is off: %v", m["note"])
	}
	if st.Kinds["secret"] != 2 {
		t.Errorf("stats: %+v", st)
	}

	cfg := map[string]any{"kind": "ConfigMap", "data": map[string]any{"DB_PASSWORD": "x", "TIMEOUT": "30", "api_key": "k"}, "spec": []any{map[string]any{"clientSecret": "z"}}}
	out, st = Object(cfg, on())
	d := out.(map[string]any)["data"].(map[string]any)
	if d["DB_PASSWORD"] != "<REDACTED:DB_PASSWORD>" || d["api_key"] != "<REDACTED:api_key>" || d["TIMEOUT"] != "30" {
		t.Errorf("configmap: %+v", d)
	}
	if out.(map[string]any)["spec"].([]any)[0].(map[string]any)["clientSecret"] != "<REDACTED:clientSecret>" {
		t.Errorf("nested list not walked")
	}
	if st.Kinds["key_name"] != 3 {
		t.Errorf("stats: %+v", st)
	}
}

func TestPII_OffByDefault_OnWhenAsked(t *testing.T) {
	in := "user alice@example.com (010-1234-5678, 900101-1234567) paid with 4111 1111 1111 1111; again alice@example.com and bob@example.com"
	out, _ := Text(in, on())
	if out != in {
		t.Errorf("PII must be untouched when PII=false:\n%s", out)
	}
	o := on()
	o.PII = true
	out, st := Text(in, o)
	for _, gone := range []string{"alice@example.com", "bob@example.com", "010-1234-5678", "900101-1234567", "4111 1111 1111 1111"} {
		if strings.Contains(out, gone) {
			t.Errorf("PII still present: %s\n%s", gone, out)
		}
	}
	if strings.Count(out, "<EMAIL_1>") != 2 || !strings.Contains(out, "<EMAIL_2>") {
		t.Errorf("same address must map to the same placeholder:\n%s", out)
	}
	if st.Kinds["email"] != 3 || st.Kinds["phone"] != 1 || st.Kinds["rrn"] != 1 || st.Kinds["card"] != 1 {
		t.Errorf("stats: %+v", st)
	}
}

func TestDisabledRules_AndOff(t *testing.T) {
	in := "password: p\nredis://u:pw@h/0"
	o := on()
	o.Disabled["url_credentials"] = true
	out, _ := Text(in, o)
	if !strings.Contains(out, "redis://u:pw@h/0") || strings.Contains(out, "password: p\n") {
		t.Errorf("only url rule should be off:\n%s", out)
	}
	out, st := Text(in, Options{Enabled: false})
	if out != in || st.Count != 0 {
		t.Errorf("disabled must be a no-op for non-secret text")
	}
}

func TestFromEnv(t *testing.T) {
	t.Setenv("REDACTION_ENABLED", "false")
	t.Setenv("REDACTION_PII", "true")
	t.Setenv("REDACTION_DISABLE", "jwt, Email")
	o := FromEnv()
	if o.Enabled || !o.PII || !o.Disabled["jwt"] || !o.Disabled["email"] {
		t.Errorf("%+v", o)
	}
	t.Setenv("REDACTION_ENABLED", "")
	t.Setenv("REDACTION_PII", "")
	t.Setenv("REDACTION_DISABLE", "")
	o = FromEnv()
	if !o.Enabled || o.PII || len(o.Disabled) != 0 {
		t.Errorf("defaults: %+v", o)
	}
}

func TestProviderKeys(t *testing.T) {
	// Built from pieces so the test file holds no key-shaped literal.
	r := func(n int) string { return strings.Repeat("aB3dE6", n)[:n] }
	keys := []string{
		"sk-" + "proj-" + r(60),
		"sk-" + "ant-api03-" + r(60),
		"sk-" + r(48),
		"AIza" + r(35),
		"gh" + "p_" + r(36),
		"github" + "_pat_" + r(40),
		"xox" + "b-" + "1234567890-" + r(20),
		"hf" + "_" + r(34),
	}
	for _, k := range keys {
		in := "401 - {'error': {'message': 'Incorrect API key provided: " + k + ". You can find your API key at ...'}}"
		out, st := Text(in, on())
		if strings.Contains(out, k) || !strings.Contains(out, "<REDACTED:api_key>") || st.Kinds["provider_key"] != 1 {
			t.Errorf("%s… not masked: %s (%+v)", k[:8], out, st)
		}
	}
	// lower-case sk- names (a Deployment, a namespace) and short or placeholder values stay
	for _, kept := range []string{"sk-telecom-production-application-backend", "task-runner-0123456789abcdefghij", "sk-1234", "api_key=ollama"} {
		out, _ := Text("deploy "+kept+" ready", on())
		if !strings.Contains(out, kept) {
			t.Errorf("masked a non-key %q: %s", kept, out)
		}
	}
	off := Options{Enabled: true, Disabled: map[string]bool{"provider_key": true}}
	if out, _ := Text("key "+keys[0], off); !strings.Contains(out, keys[0]) {
		t.Errorf("REDACTION_DISABLE=provider_key still masked: %s", out)
	}
}

// Every value below is made up for the tests.

// A JSON Secret's values go whatever they hold: braces, quotes, a nested object, an output cut in the middle.
func TestSecretJSON_ValuesWithBracesAndCutOutput(t *testing.T) {
	const value = "fake-plain-inside-braces"
	for name, in := range map[string]string{
		"braces in a value":   `{"kind":"Secret","stringData":{"conf":"{ value = ` + value + ` }"}}`,
		"json in a value":     `{"kind":"Secret","stringData":{"conf":"{\"a\":{\"b\":\"` + value + `\"}}"}}`,
		"quote in a value":    `{"kind":"Secret","stringData":{"conf":"a\"} ` + value + `"}}`,
		"nested object":       `{"kind":"Secret","data":{"conf":{"a":"` + value + `"}}}`,
		"pretty":              "{\n  \"data\" : {\n    \"conf\": \"{ " + value + " }\"\n  },\n  \"kind\" : \"Secret\"\n}",
		"cut in the value":    `{"kind":"Secret","stringData":{"conf":"{ value = ` + value,
		"cut after the key":   `{"kind":"Secret","stringData":{"conf":{"a":"` + value + `"}`,
		"last-applied cut":    `{"kind":"Secret","metadata":{"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\"data\":\"` + value,
		"warning first":       "Warning: deprecated\n" + `{"kind":"Secret","stringData":{"conf":"{ ` + value + ` }"}}`,
		"a value as a string": `{"kind":"Secret","data":"` + value + `"}`,
		"a value with no key": `{"kind":"Secret","stringData":{"conf" "` + value + `"}}`,
	} {
		for _, o := range []Options{on(), {Enabled: false}} {
			out, st := Text(in, o)
			if strings.Contains(out, value) {
				t.Errorf("%s (enabled=%v): value still present\n%s", name, o.Enabled, out)
			}
			if st.Kinds["secret"] == 0 {
				t.Errorf("%s (enabled=%v): stats %+v", name, o.Enabled, st)
			}
		}
	}

	// The rest of the document stays.
	out, _ := Text(`{"kind":"Secret","metadata":{"name":"db"},"stringData":{"conf":"{ `+value+` }"},"type":"Opaque"}`, Options{Enabled: false})
	if !strings.Contains(out, `"name":"db"`) || !strings.Contains(out, `"type":"Opaque"`) || !strings.Contains(out, `"stringData"`) {
		t.Errorf("the document's other fields must stay: %s", out)
	}
}

// A refused patch names a Secret only in kubectl's own words, and its JSON holds keys with no credential word in them.
func TestSecretNamedByKubectlErrorText(t *testing.T) {
	in := "error when applying patch:\n" + `{"data":{"tls.key":"ZmFrZS10bHMta2V5"},"metadata":{"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\"data\":\"ZmFrZS1hbm5v\"}"}}}` +
		"\nto:\nResource: \"/v1, Resource=secrets\", GroupVersionKind: \"/v1, Kind=Secret\"\nName: \"db\", Namespace: \"shop\"\n"
	out, _ := Text(in, Options{Enabled: false})
	if strings.Contains(out, "ZmFrZS10bHMta2V5") || strings.Contains(out, "ZmFrZS1hbm5v") || !strings.Contains(out, `Name: "db"`) {
		t.Errorf("%s", out)
	}
}

// YAML spells a Secret and its data in more ways than kubectl prints: a chart's manifest may use any of them.
func TestSecretYAML_OtherSpellings(t *testing.T) {
	const value = "fake-yaml-value"
	for name, in := range map[string]string{
		"flow data":        "kind: Secret\ndata: {tls.key: " + value + "}\n",
		"flow stringData":  "kind: Secret\nstringData: {\"conf\": \"" + value + "\"}\n",
		"quoted kind":      "kind: \"Secret\"\ndata:\n  tls.key: " + value + "\n",
		"single quoted":    "kind: 'Secret'\ndata:\n  tls.key: " + value + "\n",
		"wide kind":        "kind:   Secret\ndata:\n  tls.key: " + value + "\n",
		"quoted keys":      "\"kind\": \"Secret\"\n\"data\":\n  tls.key: " + value + "\n",
		"comment on data":  "kind: Secret\ndata: # the keys\n  tls.key: " + value + "\n",
		"multi-line flow":  "kind: Secret\ndata: {\n  tls.key: " + value + "\n}\n",
		"item, flow":       "items:\n- kind: Secret\n  data: {tls.key: " + value + "}\n",
		"item first, flow": "items:\n- data: {tls.key: " + value + "}\n  kind: Secret\n",
		"windows lines":    "kind: Secret\r\ndata:\r\n  tls.key: " + value + "\r\n",
	} {
		out, st := Text(in, Options{Enabled: false})
		if strings.Contains(out, value) || st.Kinds["secret"] == 0 {
			t.Errorf("%s: %+v\n%s", name, st, out)
		}
	}
	// empty data stays as it is and nothing else in the document changes
	out, st := Text("kind: Secret\ndata: {}\nmetadata:\n  name: db\ntype: Opaque\n", Options{Enabled: false})
	if !strings.Contains(out, "data: {}") || !strings.Contains(out, "name: db") || !strings.Contains(out, "type: Opaque") || st.Count != 0 {
		t.Errorf("%+v\n%s", st, out)
	}
	// a document of another kind is not touched
	cm := "kind: ConfigMap\ndata: {mode: plain}\n"
	if out, st := Text(cm, Options{Enabled: false}); out != cm || st.Count != 0 {
		t.Errorf("%+v\n%s", st, out)
	}
}

// An object marked as a Secret loses its values wherever they sit under it: a describe answer holds its annotations
// at the top, a snapshot its object under a key of its own, and data need not be a map.
func TestObject_SecretValuesAnywhereUnderIt(t *testing.T) {
	const value = "fake-object-value"
	last := "kubectl.kubernetes.io/last-applied-configuration"
	v := map[string]any{
		"kind":        "Secret",
		"annotations": map[string]any{last: `{"stringData":{"conf":"{ ` + value + ` }"}}`, "team": "shop"},
		"describe":    map[string]any{"annotations": map[string]any{last: value, "team": "shop"}, "data": map[string]any{"tls.key": value}},
		"raw":         map[string]any{"data": map[string]any{"tls.key": value}, "stringData": value},
		"data_values": map[string]any{"tls.key": value},
		"data_keys":   []any{"tls.key"},
	}
	out, st := Object(v, Options{Enabled: false})
	m := out.(map[string]any)
	if strings.Contains(asJSON(t, m), value) {
		t.Errorf("value still present: %s", asJSON(t, m))
	}
	anno := m["annotations"].(map[string]any)
	if anno[last] != "<REDACTED:secret>" || anno["team"] != "shop" {
		t.Errorf("annotations: %+v", anno)
	}
	if m["data_keys"].([]any)[0] != "tls.key" || st.Kinds["secret"] < 5 {
		t.Errorf("%+v %+v", m["data_keys"], st)
	}
	// the same annotation on another kind is that object's own
	cm := map[string]any{"kind": "ConfigMap", "annotations": map[string]any{last: `{"data":{"mode":"fast"}}`}, "data": map[string]any{"mode": "fast"}}
	out, _ = Object(cm, Options{Enabled: false})
	if out.(map[string]any)["annotations"].(map[string]any)[last] != `{"data":{"mode":"fast"}}` || out.(map[string]any)["data"].(map[string]any)["mode"] != "fast" {
		t.Errorf("configmap: %+v", out)
	}
}

// A program run on decoded objects sees only what is left: values go, everything else stays as it came.
func TestStripSecrets_LeavesEverythingButTheValues(t *testing.T) {
	const value = "ZmFrZS1zZWNyZXQtdmFsdWU="
	last := "kubectl.kubernetes.io/last-applied-configuration"
	list := map[string]any{"kind": "List", "items": []any{
		map[string]any{"kind": "Secret", "type": "Opaque", "metadata": map[string]any{"name": "db", "annotations": map[string]any{last: value, "team": "shop"}},
			"data": map[string]any{"tls.key": value, "password": value}, "stringData": map[string]any{"conf": value}},
		map[string]any{"kind": "ConfigMap", "metadata": map[string]any{"name": "cfg", "annotations": map[string]any{last: "{}"}}, "data": map[string]any{"password": "stays-until-the-output-rules"}},
		map[string]any{"kind": "List", "items": []any{map[string]any{"kind": "Secret", "data": map[string]any{"inner": value}}}},
	}}
	if n := StripSecrets(list); n != 5 {
		t.Errorf("masked %d values, want 5", n)
	}
	text := asJSON(t, list)
	if strings.Contains(text, value) {
		t.Errorf("value still present: %s", text)
	}
	for _, kept := range []string{`"tls.key":"<REDACTED:secret>"`, `"inner":"<REDACTED:secret>"`, `"team":"shop"`, `"type":"Opaque"`, `"stays-until-the-output-rules"`, `"` + last + `":"{}"`} {
		if !strings.Contains(text, kept) {
			t.Errorf("%s is missing: %s", kept, text)
		}
	}
}

// One address keeps one placeholder across a JSON answer's strings, as it does across a text.
func TestJSON_PersonalDataKeepsOnePlaceholderAcrossStrings(t *testing.T) {
	o := on()
	o.PII = true
	out, st, ok := JSON(`{"a":"alice@example.com","b":["bob@example.com","alice@example.com"]}`, o)
	if !ok || out != `{"a":"<EMAIL_1>","b":["<EMAIL_2>","<EMAIL_1>"]}` || st.Kinds["email"] != 3 {
		t.Errorf("ok=%v %s %+v", ok, out, st)
	}
}

func TestJSON_TakesOnlyAnObjectOrAnArray(t *testing.T) {
	for _, s := range []string{"", "plain", "12", "true", `"quoted"`, "not json {", "line\n{not json", `{"a":1}` + "\nmore"} {
		if out, _, ok := JSON(s, on()); ok || out != s {
			t.Errorf("%q: ok=%v out=%q", s, ok, out)
		}
	}
	for _, s := range []string{`{}`, `[]`, ` {"a":1} `, "Warning: x\n[1,2]\n"} {
		if out, _, ok := JSON(s, on()); !ok || out != s {
			t.Errorf("%q: ok=%v out=%q", s, ok, out)
		}
	}
}

// With redaction off a Secret's values still go, and nothing else is touched.
func TestJSON_SecretsStrippedWithRedactionOff(t *testing.T) {
	in := `{"kind":"Secret","data":{"tls.key":"ZmFrZQ=="},"password":"stays-when-off","log":"password: stays-when-off"}`
	out, st, ok := JSON(in, Options{Enabled: false})
	want := `{"kind":"Secret","data":{"tls.key":"<REDACTED:secret>"},"password":"stays-when-off","log":"password: stays-when-off"}`
	if !ok || out != want || st.Kinds["secret"] != 1 || st.Count != 1 {
		t.Errorf("ok=%v %s %+v", ok, out, st)
	}
}
