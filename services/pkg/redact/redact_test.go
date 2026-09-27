package redact

import (
	"strings"
	"testing"
)

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
