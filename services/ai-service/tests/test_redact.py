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


def test_secret_inside_list_items_and_block_scalars_stripped():
    # `kubectl get secrets -o yaml`: Secrets sit under items: at indent 2/4, the
    # last-applied annotation is a block scalar, stringData has a multi-line value.
    yaml = "\n".join([
        "apiVersion: v1", "items:",
        "- apiVersion: v1", "  data:", "    password: aHVudGVyMg==", "  kind: Secret", "  metadata:", "    name: a",
        "    annotations:", "      kubectl.kubernetes.io/last-applied-configuration: |",
        '        {"apiVersion":"v1","data":{"password":"aHVudGVyMg=="},"kind":"Secret"}', "      owner: team-a",
        "- apiVersion: v1", "  kind: Secret", "  metadata:", "    name: b", "  stringData:", "    token: plain-token-value",
        "    note: |", "      line one", "      line two", "  type: Opaque",
        "kind: List",
    ])
    out, st = redact_text(yaml, Options(enabled=False))
    for gone in ["aHVudGVyMg==", "plain-token-value", "line one", "line two"]:
        assert gone not in out, (gone, out)
    for kept in ["name: a", "name: b", "owner: team-a", "kind: List", "type: Opaque",
                 "password: <REDACTED:secret>", "token: <REDACTED:secret>", "note: <REDACTED:secret>",
                 "kubectl.kubernetes.io/last-applied-configuration: <REDACTED:secret>"]:
        assert kept in out, (kept, out)
    assert st.kinds["secret"] >= 4, st

    # "- data:" as the item's first key
    yaml2 = "kind: Secret\nitems:\n- data:\n    k: dmFsdWU=\n  kind: Secret\n- kind: ConfigMap\n  data:\n    greeting: hello\n"
    out2, _ = redact_text(yaml2, Options(enabled=False))
    assert "dmFsdWU=" not in out2 and "k: <REDACTED:secret>" in out2, out2


def test_debug_dump_off_by_default_and_redacted_when_on(monkeypatch, caplog):
    import logging
    from app.config import settings
    from app.services.ai import debug_dump

    monkeypatch.setattr(settings, "AI_DEBUG_DUMP", False)
    with caplog.at_level(logging.DEBUG, logger="kubeast.ai"):
        debug_dump.dump("[x]", {"password": "hunter2"})
    assert "hunter2" not in caplog.text and "[x]" not in caplog.text

    monkeypatch.setattr(settings, "AI_DEBUG_DUMP", True)
    with caplog.at_level(logging.DEBUG, logger="kubeast.ai"):
        debug_dump.dump("[x]", {"password": "hunter2", "model": "m"})
        debug_dump.dump("[y]", "kind: Secret\ndata:\n  p: aHVudGVyMg==\n")
    assert "[x]" in caplog.text and '"model": "m"' in caplog.text
    assert "hunter2" not in caplog.text and "aHVudGVyMg==" not in caplog.text
    # the key=value rule works per line from the key: a provider error that
    # echoes a credential line is masked, prose around it is kept
    err = debug_dump.safe_error(Exception("request rejected\nauthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\ntoken=abc123-xyz"))
    assert "abcdefghijklmnopqrstuvwxyz0123456789" not in err and "abc123-xyz" not in err and "request rejected" in err, err


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


def _r(n: int) -> str:
    return ("aB3dE6" * n)[:n]


# Built from pieces so the test file holds no key-shaped literal (same fixtures as redact_test.go).
_PROVIDER_KEYS = [
    "sk-" + "proj-" + _r(60),
    "sk-" + "ant-api03-" + _r(60),
    "sk-" + _r(48),
    "AIza" + _r(35),
    "gh" + "p_" + _r(36),
    "github" + "_pat_" + _r(40),
    "xox" + "b-" + "1234567890-" + _r(20),
    "hf" + "_" + _r(34),
]


def test_provider_keys():
    for k in _PROVIDER_KEYS:
        text = "401 - {'error': {'message': 'Incorrect API key provided: " + k + ". You can find your API key at ...'}}"
        out, st = redact_text(text, on())
        assert k not in out and "<REDACTED:api_key>" in out and st.kinds.get("provider_key") == 1, (k[:8], out)
    for kept in ["sk-telecom-production-application-backend", "task-runner-0123456789abcdefghij", "sk-1234", "api_key=ollama"]:
        out, _ = redact_text("deploy " + kept + " ready", on())
        assert kept in out, out
    out, _ = redact_text("key " + _PROVIDER_KEYS[0], Options(enabled=True, disabled={"provider_key"}))
    assert _PROVIDER_KEYS[0] in out


def test_remembered_secret_masked_by_value():
    from app.services.redact import remember_secret

    azure_like = "0f" * 16  # 32 hex characters: no published prefix
    remember_secret(azure_like)
    remember_secret("ollama")  # a placeholder, too short to remember
    out, st = redact_text(f"Access denied due to invalid subscription key {azure_like}. ollama is fine", on())
    assert azure_like not in out and "<REDACTED:api_key>" in out and "ollama is fine" in out
    assert st.kinds.get("provider_key") == 1


def test_safe_error_masks_whatever_the_redaction_switch(monkeypatch):
    from app.services.ai.debug_dump import safe_error

    monkeypatch.setenv("REDACTION_ENABLED", "false")
    monkeypatch.setenv("REDACTION_DISABLE", "provider_key")
    err = RuntimeError("Incorrect API key provided: " + _PROVIDER_KEYS[0])
    assert _PROVIDER_KEYS[0] not in safe_error(err)
    # a key the caller holds, even one with no known shape
    assert "typed-in-key-123" not in safe_error(RuntimeError("bad key typed-in-key-123"), ["typed-in-key-123"])


# Every value below is made up for the tests (same fixtures as redact_test.go).
_BRACE_VALUE = "fake-plain-inside-braces"


def test_secret_json_values_with_braces_and_cut_output():
    cases = {
        "braces in a value": '{"kind":"Secret","stringData":{"conf":"{ value = ' + _BRACE_VALUE + ' }"}}',
        "json in a value": '{"kind":"Secret","stringData":{"conf":"{\\"a\\":{\\"b\\":\\"' + _BRACE_VALUE + '\\"}}"}}',
        "quote in a value": '{"kind":"Secret","stringData":{"conf":"a\\"} ' + _BRACE_VALUE + '"}}',
        "nested object": '{"kind":"Secret","data":{"conf":{"a":"' + _BRACE_VALUE + '"}}}',
        "pretty": '{\n  "data" : {\n    "conf": "{ ' + _BRACE_VALUE + ' }"\n  },\n  "kind" : "Secret"\n}',
        "cut in the value": '{"kind":"Secret","stringData":{"conf":"{ value = ' + _BRACE_VALUE,
        "cut after the key": '{"kind":"Secret","stringData":{"conf":{"a":"' + _BRACE_VALUE + '"}',
        "last-applied cut": '{"kind":"Secret","metadata":{"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\\"data\\":\\"' + _BRACE_VALUE,
        "warning first": 'Warning: deprecated\n{"kind":"Secret","stringData":{"conf":"{ ' + _BRACE_VALUE + ' }"}}',
        "a value as a string": '{"kind":"Secret","data":"' + _BRACE_VALUE + '"}',
        "a value with no key": '{"kind":"Secret","stringData":{"conf" "' + _BRACE_VALUE + '"}}',
    }
    for name, text in cases.items():
        for o in (on(), Options(enabled=False)):
            out, st = redact_text(text, o)
            assert _BRACE_VALUE not in out, (name, out)
            assert st.kinds.get("secret"), (name, st)
    out, _ = redact_text('{"kind":"Secret","metadata":{"name":"db"},"stringData":{"conf":"{ ' + _BRACE_VALUE + ' }"},"type":"Opaque"}', Options(enabled=False))
    assert '"name":"db"' in out and '"type":"Opaque"' in out and '"stringData"' in out, out


def test_secret_named_by_kubectl_error_text():
    text = ('error when applying patch:\n{"data":{"tls.key":"ZmFrZS10bHMta2V5"},"metadata":{"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\\"data\\":\\"ZmFrZS1hbm5v\\"}"}}}'
            '\nto:\nResource: "/v1, Resource=secrets", GroupVersionKind: "/v1, Kind=Secret"\nName: "db", Namespace: "shop"\n')
    out, _ = redact_text(text, Options(enabled=False))
    assert "ZmFrZS10bHMta2V5" not in out and "ZmFrZS1hbm5v" not in out and 'Name: "db"' in out, out


def test_secret_yaml_other_spellings():
    value = "fake-yaml-value"
    cases = {
        "flow data": "kind: Secret\ndata: {tls.key: " + value + "}\n",
        "flow stringData": 'kind: Secret\nstringData: {"conf": "' + value + '"}\n',
        "quoted kind": 'kind: "Secret"\ndata:\n  tls.key: ' + value + "\n",
        "single quoted": "kind: 'Secret'\ndata:\n  tls.key: " + value + "\n",
        "wide kind": "kind:   Secret\ndata:\n  tls.key: " + value + "\n",
        "quoted keys": '"kind": "Secret"\n"data":\n  tls.key: ' + value + "\n",
        "comment on data": "kind: Secret\ndata: # the keys\n  tls.key: " + value + "\n",
        "multi-line flow": "kind: Secret\ndata: {\n  tls.key: " + value + "\n}\n",
        "item, flow": "items:\n- kind: Secret\n  data: {tls.key: " + value + "}\n",
        "item first, flow": "items:\n- data: {tls.key: " + value + "}\n  kind: Secret\n",
        "windows lines": "kind: Secret\r\ndata:\r\n  tls.key: " + value + "\r\n",
    }
    for name, text in cases.items():
        out, st = redact_text(text, Options(enabled=False))
        assert value not in out and st.kinds.get("secret"), (name, st, out)
    out, st = redact_text("kind: Secret\ndata: {}\nmetadata:\n  name: db\ntype: Opaque\n", Options(enabled=False))
    assert "data: {}" in out and "name: db" in out and "type: Opaque" in out and st.count == 0, (st, out)
    cm = "kind: ConfigMap\ndata: {mode: plain}\n"
    assert redact_text(cm, Options(enabled=False))[0] == cm


def test_object_secret_values_anywhere_under_it():
    value = "fake-object-value"
    last = "kubectl.kubernetes.io/last-applied-configuration"
    v = {
        "kind": "Secret",
        "annotations": {last: '{"stringData":{"conf":"{ ' + value + ' }"}}', "team": "shop"},
        "describe": {"annotations": {last: value, "team": "shop"}, "data": {"tls.key": value}},
        "raw": {"data": {"tls.key": value}, "stringData": value},
        "data_values": {"tls.key": value},
        "data_keys": ["tls.key"],
    }
    out, st = redact_object(v, Options(enabled=False))
    assert value not in repr(out), out
    assert out["annotations"][last] == "<REDACTED:secret>" and out["annotations"]["team"] == "shop", out
    assert out["data_keys"] == ["tls.key"] and st.kinds["secret"] >= 5, (out, st)
    # the same annotation on another kind is that object's own
    cm = {"kind": "ConfigMap", "annotations": {last: '{"data":{"mode":"fast"}}'}, "data": {"mode": "fast"}}
    out, _ = redact_object(cm, Options(enabled=False))
    assert out["annotations"][last] == '{"data":{"mode":"fast"}}' and out["data"] == {"mode": "fast"}, out


def test_floating_page_context_keeps_a_secret_describe_out_of_the_prompt():
    """The Secret drawer's describe layer: annotations at the top of the object, a value with braces."""
    from app.models.floating_ai import PageContextPayload, VisibleDataLayer
    from app.prompts.floating_system_prompt import build_context_prompt

    last = '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"db"},"stringData":{"conf":"{ value = ' + _BRACE_VALUE + ' }"}}'
    ctx = PageContextPayload(
        page_type="resource-list", page_title="Secrets", path="/configuration/secrets", resource_kind="Secret",
        namespace="app", snapshot_at="2026-11-06T00:00:00Z",
        base=VisibleDataLayer(source="base", summary="Secrets list", data={"rows": 1}),
        overlays=[VisibleDataLayer(source="SecretInfo", summary="Secret db (app) 상세", data={
            "kind": "Secret", "name": "db", "namespace": "app", "type": "Opaque", "data_keys": ["conf"],
            "annotations": {"kubectl.kubernetes.io/last-applied-configuration": last, "team": "shop"},
        })],
    )
    prompt = build_context_prompt(ctx, "default")
    assert _BRACE_VALUE not in prompt, prompt
    assert '"data_keys":["conf"]' in prompt and '"team":"shop"' in prompt and "last-applied-configuration" in prompt, prompt
