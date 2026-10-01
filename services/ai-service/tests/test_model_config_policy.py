"""M19: a model config may only read the key variables meant for it, send
them to public endpoints (or allow-listed hosts) and carry no auth headers."""
import pytest

from app.services import model_config_policy as policy


def _resolver(table):
    def resolve(host, port=None):
        if host not in table:
            raise OSError("no such host")
        return [(None, None, None, None, (ip, 0)) for ip in table[host]]
    return resolve


def test_api_key_env_allow_list():
    for ok in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "KUBEAST_AI_KEY_AZURE", "KUBEAST_AI_KEY_1", None, ""):
        policy.check_api_key_env(ok)
    for bad in ("DATABASE_URL", "AI_APPROVAL_SECRET", "kubeast_ai_key_x", "KUBEAST_AI_KEY_", "KUBEAST_AI_KEY_a-b", "OPENAI_API_KEY2"):
        with pytest.raises(policy.PolicyError):
            policy.check_api_key_env(bad)


def test_extra_headers_reject_auth_and_mask():
    policy.check_extra_headers({"X-Tenant": "ops", "User-Agent": "kubeast"})
    policy.check_extra_headers(None)
    for bad in ("Authorization", "authorization", " X-API-Key ", "api-key", "Proxy-Authorization", "x-goog-api-key"):
        with pytest.raises(policy.PolicyError):
            policy.check_extra_headers({bad: "v"})
    assert policy.mask_headers({"X-Tenant": "ops", "X-Other": "x"}) == {"X-Tenant": "***", "X-Other": "***"}
    assert policy.mask_headers(None) == {}


def test_base_url_scheme_credentials_metadata():
    resolve = _resolver({"api.example.com": ["93.184.216.34"], "md.example.com": ["169.254.169.254"]})
    policy.check_base_url("https://api.example.com/v1", resolve)
    policy.check_base_url(None, resolve)
    for bad in ("ftp://api.example.com", "https://", "https://user:pw@api.example.com", "http://metadata.google.internal/",
                "http://169.254.169.254/latest", "http://md.example.com/latest", "http://[fd00:ec2::254]/"):
        with pytest.raises(policy.PolicyError):
            policy.check_base_url(bad, resolve)


def test_base_url_private_addresses_need_the_allow_list(monkeypatch):
    resolve = _resolver({"ollama.ollama.svc": ["10.96.12.3"], "llm-gw.corp": ["192.168.5.5", "10.0.0.9"], "pub.example.com": ["203.0.113.7"]})
    monkeypatch.delenv("AI_BASE_URL_ALLOWED_HOSTS", raising=False)
    for bad in ("http://ollama.ollama.svc:11434", "http://10.0.0.5:8080/v1", "http://127.0.0.1:11434", "http://localhost:11434",
                "http://[::1]:11434", "http://100.64.1.1/", "http://llm-gw.corp/v1"):
        with pytest.raises(policy.PolicyError):
            policy.check_base_url(bad, _resolver({"localhost": ["127.0.0.1"], **{"ollama.ollama.svc": ["10.96.12.3"], "llm-gw.corp": ["192.168.5.5"]}}))
    policy.check_base_url("https://pub.example.com/v1", resolve)

    monkeypatch.setenv("AI_BASE_URL_ALLOWED_HOSTS", "ollama.ollama.svc, .corp, host.docker.internal")
    policy.check_base_url("http://ollama.ollama.svc:11434", resolve)
    policy.check_base_url("http://llm-gw.corp/v1", resolve)
    policy.check_base_url("http://host.docker.internal:11434/v1", _resolver({}))  # listed: no resolution needed
    with pytest.raises(policy.PolicyError):
        policy.check_base_url("http://10.0.0.5:8080/v1", resolve)  # a bare private IP is not a listed host
    with pytest.raises(policy.PolicyError):
        policy.check_base_url("http://169.254.169.254/", resolve)  # metadata never, listed or not
    with pytest.raises(policy.PolicyError):
        policy.check_base_url("http://metadata.google.internal/", resolve)


def test_base_url_unresolvable_is_refused():
    with pytest.raises(policy.PolicyError):
        policy.check_base_url("https://nope.invalid/v1", _resolver({}))
