"""timeline's changes view is offered to the model only with AI_TIMELINE_CHANGES (chart ai.timelineChanges, off by
default): off, the chat, alert investigations and the MCP server get timeline and the system prompt as they were before
the view, and only those differ when it is on. A call naming the view takes it to tool-server only with this switch, or
in an alert investigation with its step 0 on (ALERT_INVESTIGATION_CHANGES_FIRST); k8s-service's changes route answers 404
without this switch or step 0's (with ALERT_INVESTIGATION_ENABLED)."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.ai import features, prompts, tools
from app.services.ai.tool_dispatch import execute_function_with_context


@pytest.fixture(autouse=True)
def _clear_cache():
    features.clear_cache()
    yield
    features.clear_cache()


def _all_tools():
    return tools.get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda ts: ts))


async def _offered():
    service = SimpleNamespace(cluster_name="self", token=None, k8s_service=None)
    return {t["function"]["name"]: t for t in await features.gate_tools(_all_tools(), service)}


def _timeline_table():
    (tool,) = [t for t in tools.K8S_READONLY_TOOLS if t["function"]["name"] == "timeline"]
    return tool


# the one switch rule (app/services/switch.py, fixtures/switch_cases.json)
@pytest.mark.parametrize("value", ["true", "TRUE", " true ", "1", "on", "yes"])
def test_the_switch_is_on_for_the_switch_rules_words(monkeypatch, value):
    monkeypatch.setenv("AI_TIMELINE_CHANGES", value)
    assert tools.timeline_changes_on()


@pytest.mark.parametrize("value", [None, "", "false", "no", "0", "t"])
def test_the_switch_is_off_otherwise(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("AI_TIMELINE_CHANGES", raising=False)
    else:
        monkeypatch.setenv("AI_TIMELINE_CHANGES", value)
    assert not tools.timeline_changes_on()


@pytest.mark.asyncio
async def test_off_the_model_gets_timeline_without_the_view_and_on_only_timeline_differs(monkeypatch):
    monkeypatch.delenv("AI_TIMELINE_CHANGES", raising=False)
    off = await _offered()
    timeline = off["timeline"]["function"]
    assert tools.TIMELINE_CHANGES_PARAM not in timeline["parameters"]["properties"]
    assert "changes" not in json.dumps(timeline)
    assert timeline["description"] + tools.TIMELINE_CHANGES_DESCRIPTION == _timeline_table()["function"]["description"]

    monkeypatch.setenv("AI_TIMELINE_CHANGES", "true")
    on = await _offered()
    assert on["timeline"] == _timeline_table()
    assert on["timeline"]["function"]["parameters"]["properties"][tools.TIMELINE_CHANGES_PARAM]["enum"] == ["events", "changes"]
    assert list(on) == list(off)
    assert [name for name in on if on[name] != off[name]] == ["timeline"]


def test_the_table_keeps_the_view_and_off_takes_nothing_else_away(monkeypatch):
    monkeypatch.delenv("AI_TIMELINE_CHANGES", raising=False)
    table = _timeline_table()
    (off,) = tools.offer_timeline_changes([table])
    assert off is not table and tools.TIMELINE_CHANGES_PARAM in table["function"]["parameters"]["properties"]
    on_props = dict(table["function"]["parameters"]["properties"])
    on_props.pop(tools.TIMELINE_CHANGES_PARAM)
    assert off["function"]["parameters"]["properties"] == on_props
    others = [t for t in tools.K8S_READONLY_TOOLS if t["function"]["name"] != "timeline"]
    assert all(a is b for a, b in zip(tools.offer_timeline_changes(others), others))


def test_off_the_prompt_is_as_before_and_on_three_lines_name_the_view(monkeypatch):
    monkeypatch.delenv("AI_TIMELINE_CHANGES", raising=False)
    off = prompts.system_message()
    assert off == prompts.SYSTEM_MESSAGE
    assert 'view: "changes"' not in off and "바뀐 것부터" not in off and "timeline(view" not in off

    monkeypatch.setenv("AI_TIMELINE_CHANGES", "true")
    on = prompts.system_message()
    off_lines, on_lines = off.split("\n"), on.split("\n")
    assert len(on_lines) == len(off_lines) + 1
    changed = [line for line in on_lines if line not in off_lines]
    assert len(changed) == 3
    assert [line for line in off_lines if line not in on_lines] == [prompts._TIMELINE_GUIDE, prompts._TIMELINE_SIGNATURE]
    assert all('view: "changes"' in line or 'view="changes"' in line for line in changed)
    assert any(line.startswith("- **고장 원인을 물으면 바뀐 것부터 보세요**") for line in changed)


def test_the_mcp_read_tools_follow_the_switch(monkeypatch):
    from app import mcp_server

    monkeypatch.delenv("AI_TIMELINE_CHANGES", raising=False)
    off = mcp_server._read_tools()["timeline"]
    assert tools.TIMELINE_CHANGES_PARAM not in off.input_schema["properties"]
    assert "changes" not in off.description
    monkeypatch.setenv("AI_TIMELINE_CHANGES", "true")
    on = mcp_server._read_tools()["timeline"]
    assert tools.TIMELINE_CHANGES_PARAM in on.input_schema["properties"]
    assert 'view "changes"' in on.description


@pytest.mark.asyncio
@pytest.mark.parametrize("session, on, keeps", [
    ("s1", None, False),
    ("s1", "AI_TIMELINE_CHANGES", True),
    ("s1", "ALERT_INVESTIGATION_CHANGES_FIRST", False),  # the investigation's switch alone: a chat sends what main sent
    ("investigation:inv-1", None, False),
    ("investigation:inv-1", "ALERT_INVESTIGATION_CHANGES_FIRST", True),  # step 0 reads the view
    ("investigation:inv-1", "AI_TIMELINE_CHANGES", True),
])
async def test_a_call_naming_the_view_keeps_it_only_where_a_switch_reads_it(monkeypatch, session, on, keeps):
    for name in ("AI_TIMELINE_CHANGES", "ALERT_INVESTIGATION_CHANGES_FIRST"):
        monkeypatch.delenv(name, raising=False)
    if on:
        monkeypatch.setenv(on, "true")
    service = SimpleNamespace(user_role="admin", _is_tool_allowed=MagicMock(return_value=True),
                              _call_tool_server=AsyncMock(return_value='{"ok": true}'), k8s_service=MagicMock())
    await execute_function_with_context(service, "timeline", {"view": "changes", "namespace": "shop", "since_time": "4h"},
                                        SimpleNamespace(session_id=session, state={}, cache={}))
    sent = {"namespace": "shop", "since_time": "4h"} | ({"view": "changes"} if keeps else {})
    service._call_tool_server.assert_awaited_once_with("timeline", sent)


def _stream(chunks):
    async def gen():
        for c in chunks:
            yield c
    return gen()


def _text_chunk(text):
    delta = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="stop")], usage=None)


async def _system_prompt_of_a_turn(monkeypatch):
    """The system message a chat turn sends the model, its tools as the switch leaves them."""
    from app.services.ai import streaming

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            pass

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content="why did it break?")]

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

    sent = []

    async def create(**kwargs):
        sent.append(kwargs)
        return _stream([_text_chunk("Read it.")])

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", no_audit)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    service = SimpleNamespace(
        model="claude-haiku-5-5", provider="anthropic", user_role="admin", tier="default", cluster_name="self", token=None, k8s_service=None,
        client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
        tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: [_timeline_table()],
        _filter_tools_for_output_preference=lambda ts, message: ts,
        _execute_function_with_context=AsyncMock(return_value="{}"),
    )
    [e async for e in streaming.session_chat_stream(service, "s1", "why did it break?")]
    (call,) = sent
    (timeline,) = [t for t in call.get("tools") or [] if t["function"]["name"] == "timeline"]
    return call["messages"][0]["content"], timeline


@pytest.mark.asyncio
async def test_a_chat_turn_sends_the_view_only_with_the_switch(monkeypatch):
    monkeypatch.delenv("AI_TIMELINE_CHANGES", raising=False)
    system, timeline = await _system_prompt_of_a_turn(monkeypatch)
    assert system == prompts.SYSTEM_MESSAGE
    assert tools.TIMELINE_CHANGES_PARAM not in timeline["function"]["parameters"]["properties"]

    monkeypatch.setenv("AI_TIMELINE_CHANGES", "true")
    system, timeline = await _system_prompt_of_a_turn(monkeypatch)
    assert "고장 원인을 물으면 바뀐 것부터 보세요" in system
    assert tools.TIMELINE_CHANGES_PARAM in timeline["function"]["parameters"]["properties"]
