"""Audit rows added on 2026-10-21 (docs/audit-log-plan.md §5-2): AI model settings, the webhook's refused token,
refused report reads and the Optimization budget row."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services import audit_writer


class Admin:
    user_id = "u1"
    email = "admin@example.com"
    role = "admin"
    permissions = ("*",)

    def has_permission(self, perm):
        return True


class Reader(Admin):
    def has_permission(self, perm):
        return False


@pytest.fixture
def rows(monkeypatch):
    out = []

    async def write(**kw):
        out.append(kw)
        return True

    async def ready():
        return None

    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setattr(audit_writer, "require_audit_ready", ready)
    return out


def _db(monkeypatch, **methods):
    import app.database

    async def get():
        return SimpleNamespace(**methods)

    monkeypatch.setattr(app.database, "get_db_service", get)


def _cfg(**kw):
    base = dict(id=7, name="haiku", provider="anthropic", model="claude-haiku-5-5", base_url=None, api_key_env="ANTHROPIC_API_KEY",
                api_key_secret_name=None, api_key_secret_key=None, extra_headers={"X-Team": "secret-value"}, tls_verify=True,
                ca_cert="-----BEGIN CERTIFICATE-----", options=None, enabled=True, is_default=False, tier="default")
    base.update(kw)
    return SimpleNamespace(**base)


@pytest.mark.asyncio
async def test_a_model_config_change_is_recorded_without_its_key_header_values_or_ca(monkeypatch, rows):
    from app import api

    monkeypatch.setattr(api, "_check_model_config_policy", lambda data, current=None: None)
    monkeypatch.setattr("app.models.model_config.ModelConfigResponse.model_validate", lambda c: c)
    created = _cfg()

    async def create(data):
        return created

    _db(monkeypatch, create_model_config=create)
    await api.create_model_config(None, payload=Admin(), request={"name": "haiku", "provider": "anthropic", "model": "claude-haiku-5-5", "api_key_env": "ANTHROPIC_API_KEY"})
    row = rows[-1]
    assert row["action"] == "ai.model_config.create" and row["result"] == "success" and row["target_id"] == "haiku"
    after = row["after"]["after"]
    assert after["api_key_env"] == "ANTHROPIC_API_KEY" and after["extra_headers"] == ["X-Team"]
    assert "ca_cert" not in after and "secret-value" not in str(row)

    changed = _cfg(model="claude-sonnet-5-5")

    async def get(i):
        return _cfg()

    async def update(i, data):
        return changed

    async def delete(i):
        return True

    _db(monkeypatch, get_model_config=get, update_model_config=update, delete_model_config=delete)
    await api.update_model_config(7, None, payload=Admin(), request={"model": "claude-sonnet-5-5"})
    assert rows[-1]["action"] == "ai.model_config.update"
    assert rows[-1]["after"]["before"]["model"] == "claude-haiku-5-5" and rows[-1]["after"]["after"]["model"] == "claude-sonnet-5-5"
    await api.delete_model_config(7, None, payload=Admin())
    assert rows[-1]["action"] == "ai.model_config.delete" and rows[-1]["after"]["before"]["provider"] == "anthropic"


@pytest.mark.asyncio
async def test_a_refused_model_config_change_is_a_failure_row_and_nothing_runs_unrecorded(monkeypatch, rows):
    from app import api

    with pytest.raises(HTTPException) as exc:
        await api.create_model_config(None, payload=Admin(), request={"name": "x", "model": "m", "api_key": "sk-1"})
    assert exc.value.status_code == 400
    assert rows[-1]["action"] == "ai.model_config.create" and rows[-1]["result"] == "failure"
    assert "sk-1" not in str(rows[-1])

    async def down():
        raise audit_writer.AuditUnavailable("db")

    called = []

    async def delete(i):
        called.append(i)
        return True

    monkeypatch.setattr(audit_writer, "require_audit_ready", down)
    _db(monkeypatch, delete_model_config=delete)
    with pytest.raises(HTTPException) as exc:
        await api.delete_model_config(7, None, payload=Admin())
    assert exc.value.status_code == 503 and called == []


@pytest.mark.asyncio
async def test_the_connection_test_and_the_model_list_are_recorded(monkeypatch, rows):
    from app import api_public

    async def ok(body):
        return {"success": True, "message": "ok"}

    async def listed(body):
        return {"models": [], "error": "the provider answered 401"}

    monkeypatch.setattr(api_public, "_test_model_connection", ok)
    monkeypatch.setattr(api_public, "_list_provider_models", listed)
    body = {"provider": "openai", "model": "gpt-x", "api_key_env": "OPENAI_API_KEY", "base_url": "https://llm.example/v1", "api_key": "sk-literal"}
    await api_public.test_model_connection(None, payload=Admin(), request=body)
    assert rows[-1]["action"] == "ai.model_config.test" and rows[-1]["result"] == "success" and rows[-1]["after"]["ok"] is True
    assert rows[-1]["after"]["after"]["base_url"] == "https://llm.example/v1" and "sk-literal" not in str(rows[-1])
    async def refused(body):
        return {"success": False, "message": "the provider answered 401"}

    monkeypatch.setattr(api_public, "_test_model_connection", refused)
    await api_public.test_model_connection(None, payload=Admin(), request=body)
    assert rows[-1]["result"] == "failure" and rows[-1]["after"]["ok"] is False and rows[-1]["error"] == "the provider answered 401"
    await api_public.list_provider_models(None, payload=Admin(), request=body)
    assert rows[-1]["action"] == "ai.model_config.models" and rows[-1]["result"] == "failure"
    assert rows[-1]["error"] == "the provider answered 401"


@pytest.mark.asyncio
async def test_a_wrong_webhook_token_is_a_refused_row(monkeypatch):
    from app.services.investigation import webhook

    out = []

    async def write(**kw):
        out.append(kw)
        return True

    monkeypatch.setattr(webhook, "write_audit", write)
    monkeypatch.setattr(webhook.inv_settings, "load", lambda: SimpleNamespace(enabled=True, webhook_token="right"))
    request = SimpleNamespace(headers={"x-real-ip": "10.0.0.9", "user-agent": "Alertmanager/0.34"}, client=None,
                              url=SimpleNamespace(path="/api/v1/alerts/webhook"))
    with pytest.raises(HTTPException) as exc:
        await webhook.alert_webhook(request, cluster="self", authorization="Bearer wrong")
    assert exc.value.status_code == 401
    assert out[-1]["action"] == "alert.webhook.refuse" and out[-1]["result"] == "failure"
    assert out[-1]["cluster"] == "self" and out[-1]["after"] == {"reason": "token mismatch"} and out[-1]["request_ip"] == "10.0.0.9"
    with pytest.raises(HTTPException):
        await webhook.alert_webhook(request, cluster="self", authorization=None)
    assert out[-1]["after"] == {"reason": "missing token"}


@pytest.mark.asyncio
async def test_a_refused_report_read_is_recorded(monkeypatch):
    import app.api_investigations as api_inv

    out = []

    async def write(**kw):
        out.append(kw)
        return True

    monkeypatch.setattr(api_inv, "write_audit", write)
    request = SimpleNamespace(headers={}, client=None, url=SimpleNamespace(path="/api/v1/ai/investigations/inv-1"))
    with pytest.raises(HTTPException) as exc:
        await api_inv.get_investigation("inv-1", request, payload=Reader())
    assert exc.value.status_code == 403
    assert out[-1]["action"] == "ai.investigation.view" and out[-1]["result"] == "failure" and out[-1]["target_id"] == "inv-1"


@pytest.mark.asyncio
async def test_an_approved_write_runs_as_ai_tool_execute(monkeypatch):
    import app.api as api

    out = []

    async def write(**kw):
        out.append(kw)
        return True

    async def ready():
        return None

    approval = SimpleNamespace(id="ap1", user_id="u1", cluster="self", tool="k8s_scale",
                               args={"resource_type": "deployment", "resource_name": "web", "namespace": "shop", "replicas": 2},
                               session_id="s1", result="", status="pending", created_at=None, expires_at=None, decided_at=None)

    class DB:
        async def transition_tool_approval(self, *a, **k):
            for key, value in k.items():
                setattr(approval, key, value)
            return approval

        async def add_message(self, *a, **k):
            messages.append((a, k))

    async def load(approval_id, payload):
        return DB(), approval

    messages = []
    who = {"cluster": "self", "kind": "person", "user": "dev@example.com", "groups": ["kubeast:authenticated", "kubeast:operator"],
           "role": "Write", "impersonation": True}

    class Service:
        tool_server = SimpleNamespace(last_access=None)

        async def _call_tool_server(self, tool, args, **kw):
            self.tool_server.last_access = who
            return "deployment.apps/web scaled"

    async def build(authorization, cluster_name=None):
        return Service()

    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setattr(audit_writer, "require_audit_ready", ready)
    monkeypatch.setattr(api, "_load_own_pending_approval", load)
    monkeypatch.setattr(api, "_caller", lambda auth: SimpleNamespace(user_id="u1"))
    monkeypatch.setattr(api, "_extract_audit_meta", lambda request, auth: ({"user_id": "u1", "email": "dev@example.com"}, {}))
    monkeypatch.setattr(api, "_build_ai_service", build)
    monkeypatch.setattr("app.services.approval_token.sign", lambda *a, **k: "tok")
    await api.approve_tool_approval("ap1", request=SimpleNamespace(), authorization="Bearer x")
    actions = [r["action"] for r in out]
    assert actions == ["ai.tool.approve", "ai.tool.execute"], actions  # the run is not a read tool's ai.tool.call
    run = out[-1]
    assert run["result"] == "success" and run["target_id"] == "web" and run["namespace"] == "shop" and run["after"]["tool"] == "k8s_scale"
    # the identity the write went out as, in the row and in the chat message
    assert run["after"]["access"] == {**who, "mode": "write"}
    (_, _, content), kw = messages[0]
    assert "<p><strong>🔐 Ran as:</strong> <code>dev@example.com</code>" in content and content.index("🔐") < content.index("```")
    assert kw["tool_calls"][0]["access"] == {**who, "mode": "write"}
