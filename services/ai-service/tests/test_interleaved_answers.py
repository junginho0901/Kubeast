"""Roadmap 28: an answer that uses tools part way keeps its order. What the model writes before a tool call is saved
in front of that call's block (the chat showed it there), and the history the next model call gets drops the tool
blocks whole — arguments and results too — while the text between them stays."""
import json
from types import SimpleNamespace

import pytest

from app.services.ai.streaming import answer_markdown, tool_block_markdown
from app.services.ai_service import strip_tool_blocks


def call(call_id, name="list_clusters", result="[]"):
    return {"function": name, "args": {}, "result": result, "call_id": call_id}


def test_text_and_tool_blocks_are_saved_in_the_order_they_came():
    calls = [call(0), call(1, "k8s_get_resources")]
    out = answer_markdown([("text", "Checking the clusters."), ("tool", 0), ("text", "\n\nNow the pods."), ("tool", 1),
                           ("text", "\n\nTwo clusters, all pods running.")], calls)
    assert out == ("Checking the clusters.\n\n" + tool_block_markdown(calls[0]) + "Now the pods.\n\n"
                   + tool_block_markdown(calls[1]) + "Two clusters, all pods running.")


def test_calls_made_back_to_back_follow_each_other():
    calls = [call(0), call(1)]
    out = answer_markdown([("tool", 0), ("tool", 1), ("text", "Done.")], calls)
    assert out == tool_block_markdown(calls[0]) + tool_block_markdown(calls[1]) + "Done."


def test_a_call_no_part_names_goes_before_the_last_text_as_before():
    """An answer saved without parts (or a call that missed its marker) keeps the old shape: blocks, then the text."""
    calls = [call(0), call(1)]
    assert answer_markdown([("text", "Two clusters.")], calls) == "".join(map(tool_block_markdown, calls)) + "Two clusters."
    assert answer_markdown([("text", "First."), ("tool", 0), ("text", "Last.")], calls) == (
        "First.\n\n" + tool_block_markdown(calls[0]) + tool_block_markdown(calls[1]) + "Last.")
    assert answer_markdown([], calls) == "".join(map(tool_block_markdown, calls))


def test_blank_text_adds_nothing_and_no_tools_is_the_text_alone():
    assert answer_markdown([("text", "  \n"), ("text", "Hello.")], []) == "Hello."
    assert answer_markdown([("text", "Before."), ("tool", 0), ("text", "\n\n")], [call(0)]) == (
        "Before.\n\n" + tool_block_markdown(call(0)))


def test_a_log_without_call_ids_is_matched_by_position():
    """call_id is the position in the turn's log, so an entry without one is found by its index."""
    calls = [{"function": "a", "args": {}, "result": "1"}, {"function": "b", "args": {}, "result": "2"}]
    assert answer_markdown([("tool", 1), ("text", "x")], calls) == (
        tool_block_markdown(calls[1]) + tool_block_markdown(calls[0]) + "x")


def test_tool_blocks_leave_the_history_whole_and_the_text_between_stays():
    block = tool_block_markdown({"function": "k8s_get_resources", "args": {"namespace": "default"}, "result": "pod-a Running"})
    assert "<details>\n<summary><strong>📋 Arguments" in block  # nested sections: the old regex stopped at the first
    text = "Checking.\n\n" + block + "Now the logs.\n\n" + block + "All good."
    assert strip_tool_blocks(text) == "Checking.\n\nNow the logs.\n\nAll good."
    assert "pod-a" not in strip_tool_blocks(text)


def test_other_details_and_an_unclosed_block_are_handled():
    other = "<details><summary>More</summary>kept</details>"
    assert strip_tool_blocks("a " + other + " b") == "a " + other + " b"
    assert strip_tool_blocks("Before.\n\n<details>\n<summary>🔧 <strong>x</strong></summary>\n\ncut off") == "Before.\n\n"


def test_the_history_the_model_gets_has_no_tool_results():
    from app.services.ai_service import AIService

    block = tool_block_markdown({"function": "k8s_get_secret", "args": {}, "result": "token: abc"})
    content = AIService._sanitize_history_content(SimpleNamespace(), "assistant", "Looking.\n\n" + block + "Found it.")
    assert content == "Looking.\n\nFound it."
    assert AIService._sanitize_history_content(SimpleNamespace(), "user", block) == block


def stream(chunks):
    async def gen():
        for c in chunks:
            yield c
    return gen()


def chunk(content=None, tool_call=None, finish_reason=None):
    tool_calls = None
    if tool_call:
        tool_calls = [SimpleNamespace(index=0, id="call_1", function=SimpleNamespace(name=tool_call, arguments="{}"))]
    delta = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=finish_reason)], usage=None)


@pytest.mark.asyncio
async def test_an_api_key_turn_saves_the_text_before_a_call_in_front_of_it(monkeypatch):
    from app.services.ai import streaming

    saved, audits = [], []

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

    async def write_audit(**kw):
        audits.append(kw)
        return True

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", write_audit)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)

    replies = [
        stream([chunk("Checking "), chunk("the clusters."), chunk(tool_call="list_clusters", finish_reason="tool_calls")]),
        stream([chunk("Now the namespaces."), chunk(tool_call="list_namespaces", finish_reason="tool_calls")]),
        stream([chunk("Two clusters.", finish_reason="stop")]),
    ]

    async def create(**kwargs):
        return replies.pop(0)

    async def execute(name, args, ctx):
        return json.dumps([{"name": "self"}, {"name": "default"}])

    tools = [{"type": "function", "function": {"name": n, "parameters": {"type": "object", "properties": {}}}}
             for n in ("list_clusters", "list_namespaces")]
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

    events = [e async for e in streaming.session_chat_stream(service, "s1", "clusters?", audit_actor={"user_id": "u1", "email": "a@b"})]

    payloads = [json.loads(e.removeprefix("data: ").strip()) for e in events if e != "data: [DONE]\n\n"]
    order = [("content", p["content"]) if "content" in p else ("function", p["function"]) for p in payloads
             if "content" in p or "function" in p]
    assert order == [("content", "Checking "), ("content", "the clusters."), ("function", "list_clusters"),
                     ("content", "Now the namespaces."), ("function", "list_namespaces"), ("content", "Two clusters.")]
    content = saved[-1]["content"]
    calls = saved[-1]["tool_calls"]
    assert [c["call_id"] for c in calls] == [0, 1]
    assert content == ("Checking the clusters.\n\n" + tool_block_markdown(calls[0]) + "Now the namespaces.\n\n"
                       + tool_block_markdown(calls[1]) + "Two clusters.")
    complete = [a for a in audits if a["action"] == "ai.chat.complete"][0]["after"]
    assert complete["message_length"] == len("Checking the clusters.") + len("Now the namespaces.") + len("Two clusters.")
