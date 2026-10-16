"""A tool call whose argument text is empty (the Anthropic adapter streams none for a call with no input) or not
JSON must not end the chat turn: the tool runs with {} and the history the next model call gets carries "{}"."""
import json
from types import SimpleNamespace

import pytest


def stream(chunks):
    async def gen():
        for c in chunks:
            yield c
    return gen()


def tool_call_chunk(name, arguments):
    fn = SimpleNamespace(name=name, arguments=arguments)
    tc = SimpleNamespace(index=0, id="call_1", function=fn)
    delta = SimpleNamespace(content=None, tool_calls=[tc])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="tool_calls")], usage=None)


def text_chunk(text):
    delta = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="stop")], usage=None)


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", ["", "not json", "[1, 2]"])
async def test_a_call_without_usable_arguments_runs_with_an_empty_object(monkeypatch, arguments):
    from app.services.ai import streaming

    saved, calls, executed = [], [], []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            saved.append({"role": role, "content": content, **kw})

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content="clusters?")]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

    async def get_db_service():
        return DB()

    async def no_audit(**kw):
        return True

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", no_audit)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)

    replies = [stream([tool_call_chunk("list_clusters", arguments)]), stream([text_chunk("Two clusters.")])]

    async def create(**kwargs):
        calls.append(json.loads(json.dumps(kwargs["messages"], default=str)))
        return replies.pop(0)

    async def execute(name, args, ctx):
        executed.append((name, args))
        return json.dumps([{"name": "self"}, {"name": "default"}])

    tools = [{"type": "function", "function": {"name": "list_clusters", "parameters": {"type": "object", "properties": {}}}}]
    service = SimpleNamespace(
        model="claude-haiku-5-5", provider="anthropic", user_role="read", tier="default", cluster_name="self",
        client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
        tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: tools,
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _detect_write_intent=lambda message: False,
        _execute_function_with_context=execute,
    )

    events = [e async for e in streaming.session_chat_stream(service, "s1", "clusters?")]

    assert not any('"error"' in e for e in events), events
    assert executed == [("list_clusters", {})]
    assert saved[-1]["role"] == "assistant" and saved[-1]["content"].endswith("Two clusters.")
    sent = [m for m in calls[1] if m.get("tool_calls")][0]
    assert sent["tool_calls"][0]["function"]["arguments"] == (arguments or "{}")
