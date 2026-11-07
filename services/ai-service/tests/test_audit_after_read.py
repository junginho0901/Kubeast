"""The row of a read is a precondition for its answer: a read tool whose row could not be stored gives no answer, in the
chat, over MCP and in an investigation, as the screens' log reads do. A write has already happened, so it keeps its
answer. Calls that spend the server's model key are refused before they start while no row can be stored."""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import api_public, mcp_server
from app.security import TokenPayload
from app.services import audit_writer, model_config_audit
from app.services.ai import permissions, streaming
from app.services.investigation import runner

FAKE_LOG = "application log line that must not leave without a row"
ACTOR = {"user_id": "u1", "email": "dev@example.com"}


@pytest.fixture(autouse=True)
def _fail_closed_default(monkeypatch):
    monkeypatch.delenv("AUDIT_FAIL_CLOSED", raising=False)


def _chat_audit(monkeypatch, stored):
    rows = []

    async def ready():
        return True, None

    async def write(**kw):
        rows.append(kw)
        return stored

    monkeypatch.setattr(audit_writer, "audit_ready", ready)
    monkeypatch.setattr(audit_writer, "write_audit", write)
    return rows


def _chat_service():
    async def execute(_name, _args, _ctx):
        return FAKE_LOG

    return SimpleNamespace(token=None, user_role="write", cluster_name="prod", tool_server=SimpleNamespace(last_redacted=None),
                           _execute_function_with_context=execute)


async def _chat(tool, args):
    return await streaming._call_tool(_chat_service(), None, SimpleNamespace(user_id="u1"), "s1", [], None, tool, args,
                                      iteration=1, audit_actor=ACTOR, audit_http=None)


async def test_a_chat_read_whose_row_was_lost_gives_no_answer(monkeypatch):
    _chat_audit(monkeypatch, stored=False)
    events, entry, llm_text = await _chat("k8s_get_pod_logs", {"namespace": "shop", "pod_name": "web-0"})
    assert FAKE_LOG not in llm_text and FAKE_LOG not in "".join(events) and FAKE_LOG not in entry["result"]
    assert json.loads(llm_text)["status"] == "audit_unavailable"


async def test_a_chat_read_whose_row_was_stored_gives_its_answer(monkeypatch):
    _chat_audit(monkeypatch, stored=True)
    events, entry, llm_text = await _chat("k8s_get_pod_logs", {"namespace": "shop", "pod_name": "web-0"})
    assert FAKE_LOG in llm_text and FAKE_LOG in "".join(events) and FAKE_LOG in entry["result"]


async def test_a_chat_read_with_fail_closed_off_keeps_its_answer(monkeypatch):
    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "false")
    _chat_audit(monkeypatch, stored=False)
    _events, _entry, llm_text = await _chat("k8s_get_pod_logs", {"namespace": "shop", "pod_name": "web-0"})
    assert FAKE_LOG in llm_text


async def test_a_chat_write_that_ran_keeps_its_answer(monkeypatch):
    monkeypatch.setenv("AI_WRITE_APPROVAL", "false")
    monkeypatch.setattr(permissions, "tool_refusal", lambda *a, **k: None)
    _chat_audit(monkeypatch, stored=False)
    _events, _entry, llm_text = await _chat("k8s_scale", {"resource_type": "deployment", "resource_name": "web", "replicas": 2})
    assert FAKE_LOG in llm_text, "the change happened, so the model and the person must hear how it went"


class _McpTools:
    def __init__(self, authorization=None, base_url=None):
        self.last_redacted = self.last_access = self.last_requests = None

    async def call_tool(self, _name, _arguments=None, headers=None):
        return FAKE_LOG


def _mcp(monkeypatch, stored, permissions_of=("ai.mcp.use", "ai.tool.*", "resource.*.edit", "resource.*.read")):
    async def write(**_kw):
        return stored

    async def ready():
        return None

    monkeypatch.setattr(mcp_server, "ToolServerClient", _McpTools)
    monkeypatch.setattr(mcp_server, "write_audit", write)
    monkeypatch.setattr(mcp_server, "require_audit_ready", ready)
    payload = TokenPayload(user_id="u1", role="member", email="u1@example.com", matrix={"prod": tuple(permissions_of)})
    monkeypatch.setattr(mcp_server, "get_access_token", lambda: SimpleNamespace(token="tok", claims={}))
    monkeypatch.setattr(mcp_server, "payload_of", lambda _token: payload)
    return mcp_server.KubeastMCPServer(tool_server_url="http://tools")


async def _mcp_call(server, name, args):
    return await server.call_tool(name, {"cluster": "prod", **args}, None)


async def test_an_mcp_read_whose_row_was_lost_gives_no_answer(monkeypatch):
    server = _mcp(monkeypatch, stored=False)
    result = await _mcp_call(server, "k8s_get_pod_logs", {"namespace": "shop", "pod_name": "web-0"})
    text = result.content[0].text
    assert result.is_error is True and FAKE_LOG not in text and "audit unavailable" in text


async def test_an_mcp_read_whose_row_was_stored_gives_its_answer(monkeypatch):
    server = _mcp(monkeypatch, stored=True)
    result = await _mcp_call(server, "k8s_get_pod_logs", {"namespace": "shop", "pod_name": "web-0"})
    assert not result.is_error and result.content[0].text == FAKE_LOG


async def test_an_mcp_read_with_fail_closed_off_keeps_its_answer(monkeypatch):
    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "false")
    server = _mcp(monkeypatch, stored=False)
    result = await _mcp_call(server, "k8s_get_pod_logs", {"namespace": "shop", "pod_name": "web-0"})
    assert not result.is_error and result.content[0].text == FAKE_LOG


async def test_an_mcp_write_that_ran_keeps_its_answer(monkeypatch):
    monkeypatch.setenv("MCP_WRITE_TOOLS", "true")
    monkeypatch.setenv("AI_WRITE_APPROVAL", "false")
    server = _mcp(monkeypatch, stored=False)
    result = await _mcp_call(server, "k8s_scale", {"resource_type": "deployment", "resource_name": "web", "replicas": 2})
    assert not result.is_error and result.content[0].text == FAKE_LOG


def _completion(content=None, calls=None):
    message = SimpleNamespace(content=content, tool_calls=calls)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="tool_calls" if calls else "stop")],
                           usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2), model="m")


def _call(name, args):
    return SimpleNamespace(id="c1", type="function", function=SimpleNamespace(name=name, arguments=json.dumps(args)))


class _InvestigationModel:
    provider, model = "ollama", "m"

    def __init__(self):
        self.calls = []
        self.tool_server = SimpleNamespace(last_redacted=None)
        self.cluster_name = "self"
        self.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=self._create)))

    async def _create(self, **kw):
        self.calls.append(json.loads(json.dumps(kw["messages"], default=str)))
        if len(self.calls) == 1:
            return _completion(calls=[_call("k8s_get_pod_logs", {"namespace": "apps", "pod_name": "web-0"})])
        return _completion(content="## Summary\nok")

    def _get_tools_definition(self):
        return [{"type": "function", "function": {"name": "k8s_get_pod_logs"}}]

    async def _execute_function_with_context(self, _name, _args, _ctx):
        return FAKE_LOG


async def _investigate(monkeypatch, stored):
    from app.services.investigation.settings import InvestigationSettings

    service = _InvestigationModel()

    async def token(_cfg, _cluster, _namespace):
        return "investigator-token"

    async def build(_cfg, _token, _cluster):
        return service

    async def write(**_kw):
        return stored

    async def ready():
        return True, None

    async def gate(tools, _service):
        return tools

    monkeypatch.setattr(runner, "fetch_token", token)
    monkeypatch.setattr(runner, "build_service", build)
    monkeypatch.setattr(runner, "write_audit", write)
    monkeypatch.setattr(runner, "audit_ready", ready)
    monkeypatch.setattr("app.services.ai.features.gate_tools", gate)
    row = SimpleNamespace(id="inv-1", cluster="self", fingerprint="fp", alertname="A", severity="critical", namespace="apps",
                          labels={"alertname": "A"}, annotations={"summary": "s"}, starts_at=None, generator_url="")
    out = await runner.investigate(InvestigationSettings(enabled=True, max_steps=3, timeout_seconds=60), row)
    return service, out


async def test_an_investigation_read_whose_row_was_lost_gives_the_model_nothing(monkeypatch):
    service, out = await _investigate(monkeypatch, stored=False)
    assert FAKE_LOG not in json.dumps(service.calls[-1])
    assert out["tool_calls"][0]["error"] == "audit unavailable"


async def test_an_investigation_read_whose_row_was_stored_reaches_the_model(monkeypatch):
    service, out = await _investigate(monkeypatch, stored=True)
    assert FAKE_LOG in json.dumps(service.calls[-1])
    assert "error" not in out["tool_calls"][0]


def _public(monkeypatch, *, audit_up):
    ran = []
    rows = []

    async def ready(_what):
        if not audit_up:
            raise HTTPException(status_code=503, detail="audit unavailable")

    async def record(action, *_a, **kw):
        rows.append((action, kw))
        return True

    monkeypatch.setattr(model_config_audit, "ready_or_503", ready)
    monkeypatch.setattr(model_config_audit, "record", record)

    async def connection(_body):
        ran.append("connection")
        return {"success": True, "message": "Connection successful", "model": "m"}

    async def listing(_body):
        ran.append("list")
        return {"models": [{"name": "m"}]}

    monkeypatch.setattr(api_public, "_test_model_connection", connection)
    monkeypatch.setattr(api_public, "_list_provider_models", listing)
    return ran, rows


RAW = SimpleNamespace()
PAYLOAD = SimpleNamespace(user_id="u1", email="u1@example.com")


@pytest.mark.parametrize("call", [api_public.test_model_connection, api_public.list_provider_models], ids=["connection test", "model list"])
async def test_the_servers_key_stays_home_while_no_row_can_be_stored(monkeypatch, call):
    ran, rows = _public(monkeypatch, audit_up=False)
    with pytest.raises(HTTPException) as exc:
        await call(RAW, payload=PAYLOAD, request={"provider": "openai", "model": "m"})
    assert exc.value.status_code == 503 and exc.value.detail == "audit unavailable"
    assert ran == [] and rows == []


@pytest.mark.parametrize("call,action", [(api_public.test_model_connection, "ai.model_config.test"), (api_public.list_provider_models, "ai.model_config.models")], ids=["connection test", "model list"])
async def test_the_model_calls_work_while_rows_can_be_stored(monkeypatch, call, action):
    ran, rows = _public(monkeypatch, audit_up=True)
    out = await call(RAW, payload=PAYLOAD, request={"provider": "openai", "model": "m"})
    assert ran and rows[0][0] == action
    assert out.get("success") is True or out.get("models")
