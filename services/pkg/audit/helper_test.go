package audit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
