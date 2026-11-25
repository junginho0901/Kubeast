package audit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/redact"
)

func TestFromHTTPRequest_ClientIPComesFromTheGateway(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		remote  string
		want    string
	}{
		{"gateway's X-Real-IP wins", map[string]string{"X-Real-IP": "203.0.113.9", "X-Forwarded-For": "1.2.3.4, 203.0.113.9"}, "10.0.0.5:4321", "203.0.113.9"},
		{"a client-supplied X-Forwarded-For is ignored", map[string]string{"X-Forwarded-For": "1.2.3.4"}, "10.0.0.5:4321", "10.0.0.5"},
		{"a client-supplied True-Client-IP is ignored", map[string]string{"True-Client-IP": "1.2.3.4"}, "10.0.0.5:4321", "10.0.0.5"},
		{"peer address without the port", nil, "[fd00::7]:5555", "fd00::7"},
		{"peer address as is when it has no port", nil, "10.0.0.5", "10.0.0.5"},
	}
	for _, tc := range cases {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
		r.RemoteAddr = tc.remote
		for k, v := range tc.headers {
			r.Header.Set(k, v)
		}
		if got := FromHTTPRequest(r).RequestIP; got != tc.want {
			t.Errorf("%s: RequestIP = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestRealIP_OnlyTrustsXRealIP(t *testing.T) {
	var seen string
	h := RealIP(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { seen = r.RemoteAddr }))

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.5:4321"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	r.Header.Set("True-Client-IP", "5.6.7.8")
	h.ServeHTTP(httptest.NewRecorder(), r)
	if seen != "10.0.0.5:4321" {
		t.Fatalf("spoofable headers must not change RemoteAddr: %q", seen)
	}

	r.Header.Set("X-Real-IP", "203.0.113.9")
	h.ServeHTTP(httptest.NewRecorder(), r)
	if seen != "203.0.113.9" {
		t.Fatalf("X-Real-IP from the gateway must set RemoteAddr: %q", seen)
	}
}

func TestMaskSensitive_MasksEverySpellingOfACredentialKey(t *testing.T) {
	keys := []string{
		"password", "db_password", "POSTGRES_PASSWORD", "passwd", "pwd", "DB_PWD", "db-pwd", "dbPwd",
		"secret", "clientSecret", "token", "refresh_token",
		"apikey", "api_key", "api-key", "apiKey", "API_KEY", "x-api-key", "api.key",
		"privatekey", "private_key", "private-key", "privateKey",
		"access_key", "access-key", "accessKey", "AWS_ACCESS_KEY", "accesskey",
		"credential", "credentials", "awsCredentials", "aws-credential",
		"connection_string", "connection-string", "connectionString", "DB_CONNECTION_STRING",
		"dsn", "DSN", "db_dsn", "db-dsn", "dbDsn", "sentry.dsn",
		"authorization",
	}
	for _, key := range keys {
		raw, err := json.Marshal(map[string]any{"outer": []any{map[string]any{key: "fake-value"}}, "kept": "plain"})
		if err != nil {
			t.Fatal(err)
		}
		out := string(MaskSensitive(raw))
		if strings.Contains(out, "fake-value") || !strings.Contains(out, `"kept":"plain"`) {
			t.Errorf("key %q: %s", key, out)
		}
	}
}

// A row is stored for good, so the audit mask holds at least what the redaction rules hold. Each name runs through both
// real rules: the case file says what each answers, and names a setting the row masks and the model is told.
func TestMaskSensitive_HoldsEveryKeyTheRedactionRulesHold(t *testing.T) {
	raw, err := os.ReadFile("../../ai-service/tests/fixtures/redact_shape_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases struct {
		KeyNames []struct {
			Key    string `json:"key"`
			Redact bool   `json:"redact"`
			Audit  bool   `json:"audit"`
		} `json:"key_names"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.KeyNames) == 0 {
		t.Fatal("no cases read")
	}
	const value = "fake-value-1"
	for _, c := range cases.KeyNames {
		t.Run(c.Key, func(t *testing.T) {
			out, _ := redact.Text(c.Key+": "+value+"\n", redact.Options{Enabled: true, Disabled: map[string]bool{}})
			byRedact := !strings.Contains(out, value)
			row, err := json.Marshal(map[string]string{c.Key: value})
			if err != nil {
				t.Fatal(err)
			}
			byAudit := !strings.Contains(string(MaskSensitive(row)), value)
			if byRedact != c.Redact || byAudit != c.Audit {
				t.Errorf("redact masks = %v (want %v), audit masks = %v (want %v)", byRedact, c.Redact, byAudit, c.Audit)
			}
			if byRedact && !byAudit {
				t.Error("the redaction rules hold this key and the audit mask does not")
			}
		})
	}
}

func TestMaskSensitive_KeepsOrdinaryNames(t *testing.T) {
	for _, key := range []string{"name", "role", "permissions", "fields_names", "kinds_namespaces", "cmd_snapshot", "idsNumber", "app_wd", "keyboard"} {
		raw, err := json.Marshal(map[string]any{key: "fake-value"})
		if err != nil {
			t.Fatal(err)
		}
		if out := string(MaskSensitive(raw)); !strings.Contains(out, "fake-value") {
			t.Errorf("key %q was masked: %s", key, out)
		}
	}
}

// A number past a float64 is JSON, and PostgreSQL's JSONB takes it: the fields beside it are masked as any, and the
// number stays as it was written. What a float64 holds reads as it did.
func TestMaskSensitive_MasksBesideANumberNoFloatHolds(t *testing.T) {
	for raw, want := range map[string]string{
		`{"password":"fake-value","n":1e400}`:                         `{"n":1e400,"password":"***"}`,
		`{"n":-1E+999,"outer":[{"api_key":{"a":"fake-value"}}]}`:      `{"n":-1E+999,"outer":[{"api_key":"***"}]}`,
		`[1e400,{"token":["fake-value"]},{"kept":"plain","m":1.50}]`:  `[1e400,{"token":"***"},{"kept":"plain","m":1.50}]`,
		`{"secret":1e400,"kept":{"dbPwd":"fake-value","deep":1e400}}`: `{"kept":{"dbPwd":"***","deep":1e400},"secret":"***"}`,
		" {\"n\" : 1e400,\n\"credential\" : \"fake-value\"}\n":        `{"credential":"***","n":1e400}`,
		`1e400`: `1e400`,
		`{"password":"fake-value","n":1.50,"m":12345678901234567890}`: `{"m":12345678901234567000,"n":1.5,"password":"***"}`,
		`{"password":"fake-value","n":1e308,"m":-0.0}`:                `{"m":-0,"n":1e+308,"password":"***"}`,
	} {
		if out := string(MaskSensitive(json.RawMessage(raw))); out != want {
			t.Errorf("%s: %s, want %s", raw, out, want)
		}
	}
	// what is not JSON is left as it is: the table keeps its length in its place (storableJSON)
	for _, raw := range []string{`{"password":"fake-value","n":1e400`, `{"password":"fake-value"} {"n":1e400}`, `password: fake-value`} {
		if out := string(MaskSensitive(json.RawMessage(raw))); out != raw {
			t.Errorf("%s: %s", raw, out)
		}
		if out := string(storableJSON(MaskSensitive(json.RawMessage(raw)))); strings.Contains(out, "fake-value") {
			t.Errorf("%s is kept as %s", raw, out)
		}
	}
}
