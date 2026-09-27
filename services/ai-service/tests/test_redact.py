"""Mirror of services/pkg/redact/redact_test.go — same fixtures, same expectations."""
from app.services.redact import Options, from_env, redact_object, redact_text


def on() -> Options:
    return Options(enabled=True)


def test_key_names_yaml_env_json_describe():
    text = "\n".join([
        "data:",
        "  DB_PASSWORD: hunter2-e2e",
        "  DATABASE_URL: postgres://app:s3cr3t@db:5432/app?sslmode=disable",
        "  API_KEY: sk-live-abcdef0123456789",
        '  MAX_TOKENS: "4000"',
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
        '{"password":"json-pw","tokenizer":"tiktoken","client_secret": "abc123"}',
        "export GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuv",
    ])
    out, st = redact_text(text, on())
    for gone in ["hunter2-e2e", "s3cr3t", "sk-live-abcdef0123456789", "letmein", "json-pw", "abc123", "ghp_0123456789", "plain-text-pw"]:
        assert gone not in out, out
    for kept in ['MAX_TOKENS: "4000"', "TOKEN_TTL: 60", "PASSWORD_MIN_LENGTH: 12", "AUTH_MODE: none", "LOG_LEVEL: debug",
                 "name: POSTGRES_PASSWORD", "name: db-creds", "key: password",
                 "<set to the key 'password' in secret 'db-creds'>", '"tokenizer":"tiktoken"',
                 "postgres://app:<REDACTED:password>@db:5432/app?sslmode=disable", "DB_PASSWORD: <REDACTED:DB_PASSWORD>",
                 "value: <REDACTED:POSTGRES_PASSWORD>", '"password":"<REDACTED:password>"', "GITHUB_TOKEN=<REDACTED:GITHUB_TOKEN>"]:
        assert kept in out, (kept, out)
    assert st.kinds["key_name"] == 7 and st.kinds["url_credentials"] == 1, st

    esc = ('annotations: {"kubectl.kubernetes.io/last-applied-configuration": "{\\"data\\":{\\"password\\":\\"x-y-z\\",\\"host\\":\\"db\\"}}"}\n'
           '{"env":[{"name":"API_TOKEN","value":"tok-123456"},{"name":"LOG_LEVEL","value":"info"}]}')
    out, _ = redact_text(esc, on())
    assert "x-y-z" not in out and "tok-123456" not in out, out
    assert '\\"host\\":\\"db\\"' in out and '"value":"info"' in out, out


def test_key_is_sensitive():
    from app.services.redact import _key_is_sensitive
    for k in ["password", "DB_PASSWORD", "clientSecret", "client_secret", "apiKey", "api-key", "GITHUB_TOKEN", "aws.secret", "credentials", "DSN", "PRIVATE_KEY", "accessKey"]:
        assert _key_is_sensitive(k), k
    for k in ["tokenizer", "max_tokens", "TOKEN_TTL", "password_min_length", "secretName", "secretKeyRef", "token_url", "passwordFile", "key", "KEY_DIR", "auth_mode", "clientId", "tokenType"]:
        assert not _key_is_sensitive(k), k


def test_value_patterns():
    text = "\n".join([
        "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
        "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiJ1MSIsImVtYWlsIjoidUBleGFtcGxlLmNvbSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU",
        "curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZC1oZXJl' https://x",
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AH1Xe6tE",
        "-----END RSA PRIVATE KEY-----",
        "redis://default:r3d1s@cache:6379/0",
        "GET /healthz 200 12ms",
    ])
    out, st = redact_text(text, on())
    for gone in ["AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI", "eyJhbGciOiJSUzI1NiIs", "dXNlcjpwYXNzd29yZC1oZXJl", "MIIEpAIBAAKCAQEA", "r3d1s"]:
        assert gone not in out, out
    for kept in ["GET /healthz 200 12ms", "redis://default:<REDACTED:password>@cache:6379/0", "<REDACTED:private_key>", "Bearer <REDACTED:token>"]:
        assert kept in out, (kept, out)
    assert st.kinds["aws_key"] == 2 and st.kinds["private_key"] == 1 and st.kinds["authorization"] == 2, st


def test_secret_document_always_stripped():
    yaml = "\n".join([
        "apiVersion: v1", "kind: Secret", "metadata:", "  name: db-creds", "  namespace: app", "  annotations:",
        "    kubectl.kubernetes.io/last-applied-configuration: '{\"data\":{\"password\":\"aHVudGVyMg==\"}}'",
        "    owner: team-a", "data:", "  password: aHVudGVyMg==", "  username: YXBw", "type: Opaque",
        "---", "apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: cfg", "data:", "  greeting: hello",
    ])
    out, st = redact_text(yaml, Options(enabled=False))
    assert "aHVudGVyMg==" not in out and "YXBw" not in out, out
    for kept in ["name: db-creds", "owner: team-a", "password: <REDACTED:secret>", "username: <REDACTED:secret>", "greeting: hello", "type: Opaque"]:
        assert kept in out, (kept, out)
    assert st.kinds["secret"] == 3, st

    js = '{"kind": "Secret", "metadata": {"name": "s", "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "{\\"data\\":{\\"p\\":\\"x\\"}}"}}, "data": {"password": "aHVudGVyMg==", "user": "YXBw"}}'
    out, _ = redact_text(js, Options(enabled=False))
    assert "aHVudGVyMg==" not in out and '\\"p\\":\\"x\\"' not in out, out


def test_object():
    v = {
        "kind": "Secret",
        "metadata": {"name": "s", "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "{...}"}},
        "data": {"password": "aHVudGVyMg=="},
        "note": "contact admin@example.com token=abc",
        "yaml": "kind: Secret\ndata:\n  password: aHVudGVyMg==\n",
    }
    out, st = redact_object(v, on())
    assert out["data"]["password"] == "<REDACTED:secret>"
    assert out["metadata"]["annotations"]["kubectl.kubernetes.io/last-applied-configuration"] == "<REDACTED:secret>"
    assert "aHVudGVyMg==" not in out["yaml"]
    assert "admin@example.com" in out["note"]  # PII off by default
    assert st.kinds["secret"] == 3, st

    cfg = {"kind": "ConfigMap", "data": {"DB_PASSWORD": "x", "TIMEOUT": "30", "api_key": "k"}, "spec": [{"clientSecret": "z"}]}
    out, st = redact_object(cfg, on())
    assert out["data"] == {"DB_PASSWORD": "<REDACTED:DB_PASSWORD>", "TIMEOUT": "30", "api_key": "<REDACTED:api_key>"}
    assert out["spec"][0]["clientSecret"] == "<REDACTED:clientSecret>"
    assert st.kinds["key_name"] == 3, st


def test_pii_off_by_default_on_when_asked():
    text = "user alice@example.com (010-1234-5678, 900101-1234567) paid with 4111 1111 1111 1111; again alice@example.com and bob@example.com"
    out, _ = redact_text(text, on())
    assert out == text
    out, st = redact_text(text, Options(enabled=True, pii=True))
    for gone in ["alice@example.com", "bob@example.com", "010-1234-5678", "900101-1234567", "4111 1111 1111 1111"]:
        assert gone not in out, out
    assert out.count("<EMAIL_1>") == 2 and "<EMAIL_2>" in out, out
    assert st.kinds == {"email": 3, "phone": 1, "rrn": 1, "card": 1}, st


def test_disabled_rules_and_off():
    text = "password: p\nredis://u:pw@h/0"
    out, _ = redact_text(text, Options(enabled=True, disabled={"url_credentials"}))
    assert "redis://u:pw@h/0" in out and "password: p\n" not in out, out
    out, st = redact_text(text, Options(enabled=False))
    assert out == text and st.count == 0


def test_floating_page_context_strips_secret_overlay():
    """The floating widget sends the open detail drawer's YAML/raw JSON; a revealed
    Secret must not reach the prompt (server-side, independent of the browser)."""
    from app.models.floating_ai import PageContextPayload, VisibleDataLayer
    from app.prompts.floating_system_prompt import build_context_prompt

    ctx = PageContextPayload(
        page_type="resource-list", page_title="Secrets", path="/configuration/secrets", resource_kind="Secret",
        namespace="app", snapshot_at="2026-09-27T00:00:00Z",
        base=VisibleDataLayer(source="base", summary="Secrets list", data={"rows": 3}),
        overlays=[
            VisibleDataLayer(
                source="ResourceDetailDrawer", summary="Secret db-creds (app) 상세 — YAML 탭",
                data={"kind": "Secret", "name": "db-creds", "yaml": "kind: Secret\nmetadata:\n  name: db-creds\ndata:\n  password: aHVudGVyMg==\n"},
            ),
            VisibleDataLayer(
                source="ResourceDetailDrawer", summary="Secret db-creds (app) 상세 — Info 탭",
                data={"kind": "Secret", "raw": {"kind": "Secret", "metadata": {"name": "db-creds"}, "data": {"password": "aHVudGVyMg=="}}},
            ),
            VisibleDataLayer(
                source="ResourceDetailDrawer", summary="ConfigMap cfg 상세",
                data={"kind": "ConfigMap", "raw": {"kind": "ConfigMap", "data": {"DB_PASSWORD": "hunter2", "LOG_LEVEL": "info"}}},
            ),
        ],
    )
    prompt = build_context_prompt(ctx, "default")
    assert "aHVudGVyMg==" not in prompt and "hunter2" not in prompt, prompt
    assert "db-creds" in prompt and "LOG_LEVEL" in prompt and '"rows":3' in prompt, prompt


def test_from_env(monkeypatch):
    monkeypatch.setenv("REDACTION_ENABLED", "false")
    monkeypatch.setenv("REDACTION_PII", "true")
    monkeypatch.setenv("REDACTION_DISABLE", "jwt, Email")
    o = from_env()
    assert not o.enabled and o.pii and o.disabled == {"jwt", "email"}
    monkeypatch.delenv("REDACTION_ENABLED")
    monkeypatch.delenv("REDACTION_PII")
    monkeypatch.delenv("REDACTION_DISABLE")
    o = from_env()
    assert o.enabled and not o.pii and not o.disabled
