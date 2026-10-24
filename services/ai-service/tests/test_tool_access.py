"""The identity an AI tool call reached a cluster as: read from tool-server's answer or k8s-service's
X-Kubeast-Access header, never worked out in ai-service; shown as the 🔐 line of the tool block and kept in the
ai.tool.call row. A tool that reaches no cluster shows none — not the previous call's."""
import base64
import json
from types import SimpleNamespace

import httpx
import pytest

from app.services.ai import access
from app.services.tool_server_client import ToolServerClient

READ = {"cluster": "prod", "kind": "person", "user": "a@example.com", "groups": ["kubeast:authenticated", "kubeast:viewer"],
        "role": "Read", "impersonation": True}


def header(value: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def test_from_header_reads_base64url_json_without_padding():
    assert access.from_header(header(READ)) == READ
    assert access.from_header(None) is None
    assert access.from_header("not base64!") is None
    assert access.from_header(base64.urlsafe_b64encode(b"[1]").decode()) is None


@pytest.mark.parametrize("value, want", [
    ({**READ, "mode": "read"},
     "<p><strong>🔐 Ran as:</strong> <code>a@example.com</code> · groups <code>kubeast:authenticated</code> "
     "<code>kubeast:viewer</code> · role Read · whole cluster · read-only</p>"),
    ({**READ, "role": "Write", "groups": ["kubeast:authenticated", "kubeast:role:write"], "namespaces": ["shop", "payments"], "mode": "write"},
     "<p><strong>🔐 Ran as:</strong> <code>a@example.com</code> · groups <code>kubeast:authenticated</code> "
     "<code>kubeast:role:write</code> · role Write · namespaces shop, payments · write</p>"),
    ({**READ, "role": "*", "groups": ["kubeast:admin", "kubeast:authenticated"]},
     "<p><strong>🔐 Ran as:</strong> <code>a@example.com</code> · groups <code>kubeast:admin</code> "
     "<code>kubeast:authenticated</code> · global admin · whole cluster · read-only</p>"),
    ({**READ, "kind": "api_key", "api_key": "k-1"},
     "<p><strong>🔐 Ran as:</strong> <code>a@example.com</code> (API key) · groups <code>kubeast:authenticated</code> "
     "<code>kubeast:viewer</code> · role Read · whole cluster · read-only</p>"),
    ({"cluster": "prod", "kind": "investigator", "user": "kubeast:investigator", "groups": ["kubeast:investigator"], "impersonation": True},
     "<p><strong>🔐 Ran as:</strong> <code>kubeast:investigator</code> · groups <code>kubeast:investigator</code> · "
     "alert investigator · read-only</p>"),
    ({"cluster": "prod", "kind": "person", "role": "Read", "impersonation": False},
     "<p><strong>🔐 Ran as:</strong> ⚠️ Kubeast's own credential, not this user's permissions (impersonation is off) · "
     "role Read · whole cluster · read-only</p>"),
    ({**READ, "role": ""},
     "<p><strong>🔐 Ran as:</strong> <code>a@example.com</code> · groups <code>kubeast:authenticated</code> "
     "<code>kubeast:viewer</code> · no role in this cluster · whole cluster · read-only</p>"),
])
def test_line(value, want):
    assert access.line(value) == want


def test_line_escapes_what_the_token_carries():
    out = access.line({**READ, "user": "<b>x</b>", "role": "<img src=x>", "namespaces": ["<s>"]})
    assert "<b>" not in out and "<img" not in out and "<s>" not in out
    assert "&lt;b&gt;x&lt;/b&gt;" in out and "&lt;img src=x&gt;" in out
    assert access.line(None) == ""


def _tool_client(handler) -> ToolServerClient:
    c = ToolServerClient(authorization="Bearer t")
    c.client = httpx.AsyncClient(base_url="http://tool-server", transport=httpx.MockTransport(handler))
    return c


@pytest.mark.asyncio
async def test_tool_server_client_keeps_access_on_success_and_failure():
    answers = [httpx.Response(200, json={"content": "ok", "access": READ}),
               httpx.Response(500, json={"error": "kubectl failed: forbidden", "access": READ}),
               httpx.Response(400, json={"error": "cluster is required"})]
    c = _tool_client(lambda request: answers.pop(0))
    assert await c.call_tool("k8s_get_resources", {}) == "ok"
    assert c.last_access == READ
    with pytest.raises(Exception, match="forbidden"):
        await c.call_tool("k8s_get_resources", {})
    assert c.last_access == READ
    # refused before reaching the cluster: nothing to show, not the previous call's
    with pytest.raises(Exception, match="cluster is required"):
        await c.call_tool("k8s_get_resources", {})
    assert c.last_access is None


@pytest.mark.asyncio
async def test_k8s_client_notes_the_header(monkeypatch):
    from app.services import http_shared
    from app.services.k8s_client import K8sServiceClient

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/namespaces"):
            return httpx.Response(200, json=[], headers={access.HEADER: header(READ)})
        return httpx.Response(200, json={"id": "prod"})  # a route outside the cluster middleware: no header

    monkeypatch.setattr(http_shared, "shared_client",
                        lambda base_url, timeout: httpx.AsyncClient(base_url=base_url, transport=httpx.MockTransport(handler)))
    c = K8sServiceClient(authorization="Bearer t", cluster_name="prod")
    await c.get_namespaces()
    assert c.last_access == READ
    await c.get_current_cluster()
    assert c.last_access == READ  # kept: a response without the header says nothing about the identity


def test_of_call_prefers_tool_server_and_adds_the_mode():
    service = SimpleNamespace(tool_server=SimpleNamespace(last_access=None, last_redacted={"count": 2}),
                              k8s_service=SimpleNamespace(last_access={**READ, "cluster": "k8s"}))
    assert access.of_call(service, "k8s_get_resources") == {**READ, "cluster": "k8s", "mode": "read"}
    service.tool_server.last_access = READ
    assert access.of_call(service, "k8s_scale") == {**READ, "mode": "write"}
    access.reset(service)
    assert access.of_call(service, "k8s_get_resources") is None
    assert service.tool_server.last_redacted is None


def stream(chunks):
    async def gen():
        for c in chunks:
            yield c
    return gen()


def tool_call_chunk(name):
    fn = SimpleNamespace(name=name, arguments="{}")
    delta = SimpleNamespace(content=None, tool_calls=[SimpleNamespace(index=0, id="call_1", function=fn)])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="tool_calls")], usage=None)


def text_chunk(text):
    delta = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="stop")], usage=None)


@pytest.mark.asyncio
async def test_chat_shows_and_audits_each_calls_own_identity(monkeypatch):
    from app.services.ai import streaming

    saved, audits = [], []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            saved.append({"role": role, "content": content, **kw})

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content="pods?")]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

    async def get_db_service():
        return DB()

    async def audit(**kw):
        audits.append(kw)
        return True

    async def ready():
        return True, None

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", audit)
    monkeypatch.setattr("app.services.audit_writer.audit_ready", ready)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)

    replies = [stream([tool_call_chunk("k8s_get_resources")]), stream([tool_call_chunk("list_clusters")]), stream([text_chunk("Done.")])]

    async def create(**kwargs):
        return replies.pop(0)

    tool_server = SimpleNamespace(last_access=None, last_redacted=None)

    async def execute(name, args, ctx):
        if name == "k8s_get_resources":  # reaches the cluster through tool-server
            tool_server.last_access = READ
        return "[]"

    tools = [{"type": "function", "function": {"name": n, "parameters": {"type": "object", "properties": {}}}}
             for n in ("k8s_get_resources", "list_clusters")]
    service = SimpleNamespace(
        model="claude-haiku-5-5", provider="anthropic", user_role="read", tier="default", cluster_name="prod",
        client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
        tool_contexts={}, tool_server=tool_server,
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: tools,
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _detect_write_intent=lambda message: False,
        _execute_function_with_context=execute,
    )

    events = [e async for e in streaming.session_chat_stream(service, "s1", "pods?", audit_actor={"user_id": "u1", "email": "a@example.com"})]

    results = [json.loads(e[len("data: "):]) for e in events if '"function_result"' in e]
    assert [r.get("access") for r in results] == [{**READ, "mode": "read"}, None]
    answer = saved[-1]
    assert [tc.get("access") for tc in answer["tool_calls"]] == [{**READ, "mode": "read"}, None]
    line = access.line({**READ, "mode": "read"})
    assert answer["content"].count("🔐 Ran as:") == 1
    assert f"<summary>🔧 <strong>k8s_get_resources</strong></summary>\n\n{line}\n\n" in answer["content"]
    rows = [a for a in audits if a["action"] == "ai.tool.call"]
    assert [r["after"]["access"] for r in rows] == [{**READ, "mode": "read"}, None]
