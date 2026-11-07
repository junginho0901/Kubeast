"""An answer the user stops part way is saved by the page, from what the stream told it. So what the stream says of a
write tool's call is what may be kept: the masked copy with the same fields, as in the answer the server saves. The
waiting card reads the real arguments from the approval row, not from here."""
import copy
import json
import sys
from types import SimpleNamespace

import pytest

from app.services import claude_code
from app.services.ai import permissions
from tests.test_claude_code import OK, make_sdk

FAKE = "fake-secret-value"

PATCH = {
    "resource_type": "deployment", "resource_name": "web", "namespace": "shop",
    "patch": {"spec": {"template": {"spec": {"containers": [{"name": "app", "env": [
        {"name": "DB_PASSWORD", "value": FAKE}, {"name": "LOG_LEVEL", "value": "debug"},
    ]}]}}}},
}
EXEC = {"pod_name": "web-0", "namespace": "shop", "command": ["sh", "-c", f"mysql --password={FAKE} -e 'select 1'"]}
READ = {"resource_type": "pods", "namespace": "shop", "label_selector": "app=web"}


def _stream(chunks):
    async def gen():
        for c in chunks:
            yield c
    return gen()


def _tool_call_chunk(name, arguments):
    fn = SimpleNamespace(name=name, arguments=arguments)
    tc = SimpleNamespace(index=0, id="call_1", function=fn)
    delta = SimpleNamespace(content=None, tool_calls=[tc])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="tool_calls")], usage=None)


def _text_chunk(text):
    delta = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="stop")], usage=None)


@pytest.fixture
def chat(monkeypatch):
    """The API-key chat with a model that calls one tool and then answers. Returns the stream's events and the real
    arguments the approval was made with."""
    from app.services.ai import streaming

    made = []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            pass

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content="go")]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

        async def expire_due_tool_approvals(self, *a, **kw):
            return 0

        async def create_tool_approval(self, **kw):
            made.append(copy.deepcopy(kw))
            return SimpleNamespace(id="ap1", cluster=kw["cluster"], expires_at=streaming_now())

    async def get_db_service():
        return DB()

    async def no_audit(**kw):
        return True

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    async def ready():
        return None

    async def probe():
        return True, None

    def streaming_now():
        from app.database import utcnow
        return utcnow()

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", no_audit)
    monkeypatch.setattr("app.services.audit_writer.require_audit_ready", ready)
    monkeypatch.setattr("app.services.audit_writer.audit_ready", probe)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)
    monkeypatch.setattr(permissions, "tool_refusal", lambda *a, **k: None)
    monkeypatch.setattr(permissions, "may_request_approval", lambda *a, **k: True)
    monkeypatch.setenv("AI_WRITE_APPROVAL", "true")

    async def run(name, args):
        replies = [_stream([_tool_call_chunk(name, json.dumps(args))]), _stream([_text_chunk("Done.")])]

        async def create(**_kw):
            return replies.pop(0)

        async def execute(_name, _args, _ctx):
            return "[]"

        tools = [{"type": "function", "function": {"name": name, "parameters": {"type": "object", "properties": {}}}}]
        service = SimpleNamespace(
            model="claude-haiku-5-5", provider="anthropic", user_role="write", tier="default", cluster_name="self", token=None,
            client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
            tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
            _sanitize_history_content=lambda role, content: content,
            _build_language_directive=lambda message: "Answer in English.",
            _get_tools_definition=lambda: tools,
            _filter_tools_for_output_preference=lambda tools, message: tools,
            _detect_write_intent=lambda message: False,
            _execute_function_with_context=execute,
        )
        events = [e async for e in streaming.session_chat_stream(service, "s1", "go")]
        payloads = [json.loads(e.removeprefix("data: ").strip()) for e in events if e != "data: [DONE]\n\n"]
        return payloads, made

    return run


def _started_call(payloads):
    calls = [p for p in payloads if "function" in p and "approval_required" not in p]
    assert len(calls) == 1, payloads
    return calls[0]


@pytest.mark.parametrize("name, args, kept", [
    ("k8s_patch_resource", PATCH, ["web", "shop", "LOG_LEVEL", "debug", "DB_PASSWORD"]),
    ("k8s_execute_command", EXEC, ["web-0", "shop", "mysql", "select 1"]),
])
async def test_the_call_the_page_is_told_of_holds_no_credential_and_keeps_its_fields(chat, name, args, kept):
    payloads, _made = await chat(name, args)
    started = _started_call(payloads)
    shown = json.dumps(started["args"])
    assert FAKE not in shown
    assert set(started["args"]) == set(args), "the block on screen still lists every argument"
    for text in kept:
        assert text in shown


async def test_the_approval_still_holds_the_real_arguments(chat):
    payloads, made = await chat("k8s_patch_resource", PATCH)
    assert made[0]["args"] == PATCH, "the run after the approval uses these"
    assert FAKE not in json.dumps(_started_call(payloads)["args"])


async def test_a_read_tool_call_is_told_of_as_it_came(chat):
    payloads, _made = await chat("k8s_get_resources", READ)
    assert _started_call(payloads)["args"] == READ


async def test_the_subscription_chat_tells_of_a_call_the_same_way(monkeypatch):
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_ENABLED", True, raising=False)
    monkeypatch.setattr(claude_code, "_semaphores", {})
    sdk = make_sdk([("call", "k8s_patch_resource", copy.deepcopy(PATCH)), ("call", "k8s_get_resources", dict(READ)), ("result", OK)])
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    ran = []

    async def run_tool(name, args, turn, call_id=None):
        ran.append((name, copy.deepcopy(args)))
        return [], "ok"

    tools = [{"type": "function", "function": {"name": n, "description": n, "parameters": {"type": "object"}}}
             for n in ("k8s_patch_resource", "k8s_get_resources")]
    chat = claude_code.ClaudeCodeChat(model="claude-haiku-5-5", token="sk-ant-oat01-token")
    out = claude_code.TurnResult()
    events = [e async for e in chat.turn(messages=[{"role": "user", "content": "go"}], tools=tools, run_tool=run_tool, out=out)]
    calls = [p for p in (json.loads(e.removeprefix("data: ").strip()) for e in events) if "function" in p]

    assert [c["function"] for c in calls] == ["k8s_patch_resource", "k8s_get_resources"]
    assert FAKE not in json.dumps(calls[0]["args"])
    assert set(calls[0]["args"]) == set(PATCH)
    assert calls[1]["args"] == READ
    assert ran[0] == ("k8s_patch_resource", PATCH), "the tool itself gets the real arguments"
