"""What a failed turn wrote before it failed stays with its question: on a reload and for the next model call the letters
and the tool blocks are there, marked as an answer that ended by an error. A failure before any of them saves no answer."""
import json
from types import SimpleNamespace

import pytest


class Refused(Exception):
    pass


def text_chunk(text, finish=None):
    delta = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=finish)], usage=None)


def tool_call_chunk(name):
    fn = SimpleNamespace(name=name, arguments="{}")
    tc = SimpleNamespace(index=0, id="call_1", function=fn)
    delta = SimpleNamespace(content=None, tool_calls=[tc])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="tool_calls")], usage=None)


def usage_chunk():
    usage = SimpleNamespace(prompt_tokens=100, completion_tokens=7, total_tokens=107, prompt_tokens_details=None)
    return SimpleNamespace(choices=[], usage=usage)


def stream(chunks):
    async def gen():
        for chunk in chunks:
            if isinstance(chunk, Exception):
                raise chunk
            yield chunk
    return gen()


async def one_turn(monkeypatch, replies, client=None, provider="openai", fail_context=False):
    """A turn whose model calls answer `replies` in order: a list of chunks, or an exception raised at the call."""
    from app.services.ai import streaming

    saved = []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            saved.append({"role": role, "content": content, **kw})

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content="well?")]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            if fail_context:
                raise Refused("the context did not save")

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

    replies = list(replies)

    async def create(**kwargs):
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return stream(reply)

    async def execute(tool, tool_args, ctx):
        return json.dumps({"ok": True})

    tools = [{"type": "function", "function": {"name": "get_cluster_overview", "parameters": {"type": "object", "properties": {}}}}]
    service = SimpleNamespace(
        model="claude-haiku-5-5", provider=provider, user_role="admin", tier="default", cluster_name="self",
        client=client or SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
        tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: tools,
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _detect_write_intent=lambda message: False,
        _execute_function_with_context=execute,
    )
    events = [e async for e in streaming.session_chat_stream(service, "s1", "well?")]
    return events, saved


def answers(saved):
    return [m for m in saved if m["role"] == "assistant"]


def error_events(events):
    bodies = [json.loads(e.removeprefix("data: ").strip()) for e in events if e != "data: [DONE]\n\n"]
    return [b for b in bodies if "error" in b]


@pytest.mark.asyncio
async def test_the_letters_that_came_before_a_model_call_failed_are_saved_and_marked(monkeypatch):
    events, saved = await one_turn(monkeypatch, [[text_chunk("Two pods are "), Refused("the provider went away")]])
    assert [m["role"] for m in saved] == ["user", "assistant"]
    assert answers(saved)[0]["content"] == "Two pods are"
    assert answers(saved)[0]["usage"] == {"failed": True}
    assert len(error_events(events)) == 1
    assert events[-1] == "data: [DONE]\n\n"


@pytest.mark.asyncio
async def test_a_tool_that_ran_stays_when_the_next_model_call_is_refused(monkeypatch):
    events, saved = await one_turn(monkeypatch, [[text_chunk("Looking."), tool_call_chunk("get_cluster_overview")], Refused("429"), Refused("429")])
    answer = answers(saved)[0]
    assert answer["content"].startswith("Looking.\n\n<details>\n<summary>🔧 <strong>get_cluster_overview</strong>")
    assert answer["tool_calls"][0]["function"] == "get_cluster_overview"
    assert answer["usage"] == {"failed": True}
    assert len(error_events(events)) == 1


@pytest.mark.asyncio
async def test_text_after_a_tool_goes_below_its_block(monkeypatch):
    _, saved = await one_turn(monkeypatch, [[tool_call_chunk("get_cluster_overview")], [text_chunk("Then "), Refused("cut")]])
    content = answers(saved)[0]["content"]
    assert content.startswith("<details>\n<summary>🔧")
    assert content.endswith("\n\nThen")


@pytest.mark.asyncio
async def test_a_failure_before_any_letter_saves_no_answer(monkeypatch):
    events, saved = await one_turn(monkeypatch, [Refused("401"), Refused("401")])
    assert [m["role"] for m in saved] == ["user"]
    assert len(error_events(events)) == 1


@pytest.mark.asyncio
async def test_the_tokens_the_provider_reported_stay_beside_the_mark(monkeypatch):
    _, saved = await one_turn(monkeypatch, [[usage_chunk(), tool_call_chunk("get_cluster_overview")], Refused("429"), Refused("429")])
    usage = answers(saved)[0]["usage"]
    assert usage["failed"] is True
    assert (usage["prompt_tokens"], usage["completion_tokens"]) == (100, 7)


@pytest.mark.asyncio
async def test_a_failed_continuation_keeps_what_came_before_it(monkeypatch):
    events, saved = await one_turn(monkeypatch, [[text_chunk("The first half", finish="length")], Refused("gone"), Refused("gone")])
    assert answers(saved)[0]["content"] == "The first half"
    assert answers(saved)[0]["usage"] == {"failed": True}
    assert len(error_events(events)) == 1


@pytest.mark.asyncio
async def test_an_answer_finished_and_saved_is_not_saved_again_when_a_later_step_fails(monkeypatch):
    events, saved = await one_turn(monkeypatch, [[text_chunk("All good.", finish="stop")]], fail_context=True)
    assert len(answers(saved)) == 1
    assert answers(saved)[0]["content"] == "All good."
    assert "failed" not in (answers(saved)[0]["usage"] or {})
    assert len(error_events(events)) == 1


@pytest.mark.asyncio
async def test_a_finished_answer_has_no_mark(monkeypatch):
    _, saved = await one_turn(monkeypatch, [[text_chunk("All good.", finish="stop")]])
    assert "failed" not in (answers(saved)[0]["usage"] or {})


@pytest.mark.asyncio
async def test_a_failed_claude_code_turn_keeps_what_it_wrote(monkeypatch):
    class Turn:
        async def turn(self, messages, tools, run_tool, out):
            await run_tool("get_cluster_overview", {}, 1, 0)
            out.parts.append(("tool", 0))
            out.parts.append(("text", "Half of it"))
            yield 'data: {"content": "Half of it"}\n\n'
            raise Refused("the subscription refused")

    client = SimpleNamespace(claude_code=Turn())
    events, saved = await one_turn(monkeypatch, [], client=client, provider="claude-code")
    answer = answers(saved)[0]
    assert answer["content"].startswith("<details>\n<summary>🔧") and answer["content"].endswith("Half of it")
    assert answer["usage"] == {"failed": True}
    assert len(error_events(events)) == 1
