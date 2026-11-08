"""What a chat turn says at its edges. A session that is gone is an error event the chat reads as one, and an answer no
table can be drawn from reaches the screen and the model as it came, so the turn goes on."""
import json
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

CATALOGS = Path(__file__).resolve().parents[3] / "frontend" / "src" / "i18n" / "locales"

# Each tool with a table, and an answer its table cannot be drawn from.
UNDRAWABLE = [
    ("get_pod_metrics", {}, ["x"]),
    ("get_pod_metrics", {}, [None]),
    ("get_node_metrics", {}, ["x"]),
    ("k8s_get_available_api_resources", {}, ["x"]),
    ("k8s_get_available_api_resources", {}, [{"name": "pods", "shortNames": 3}]),
    ("k8s_get_events", {}, ["x"]),
    ("k8s_get_events", {}, {"events": ["x"]}),
    ("k8s_get_events", {}, [{"object": "x", "last_timestamp": "2026-01-01T00:00:00Z"}]),
    ("k8s_check_service_connectivity", {"namespace": "n", "service_name": "s"}, {"ports": ["x"]}),
    ("k8s_check_service_connectivity", {"namespace": "n", "service_name": "s"}, {"port_check": "x"}),
    ("k8s_check_service_connectivity", {"namespace": "n", "service_name": "s"}, {"endpoints": {"ready": "many"}}),
    ("k8s_get_resources", {"resource_type": "pods"}, {"items": [{"metadata": {}, "status": "x"}]}),
    ("k8s_get_resources", {"resource_type": "deployments"}, {"items": [{"metadata": {}, "spec": {"replicas": "many"}}]}),
    ("k8s_get_resources", {"resource_type": "services"}, {"items": [{"metadata": {}, "spec": {"ports": ["x"]}}]}),
    ("k8s_get_resources", {"resource_type": "nodes"}, {"items": [{"metadata": {"labels": "x"}}]}),
    ("k8s_get_resources", {"resource_type": "namespaces"}, {"items": [{"metadata": {}, "status": "x"}]}),
]


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


def parsed(events):
    out = []
    for event in events:
        body = event.removeprefix("data: ").strip()
        out.append(body if body == "[DONE]" else json.loads(body))
    return out


async def one_turn(monkeypatch, name, args, answer, session=True, titles=None):
    """A turn whose model calls the tool once, gets `answer` and writes one sentence."""
    from app.services.ai import streaming

    saved, calls = [], []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1") if session else None

        async def add_message(self, sid, role, content, **kw):
            saved.append({"role": role, "content": content, **kw})

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content="well?")]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            if titles is not None:
                titles.append(title)

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

    replies = [stream([tool_call_chunk(name, json.dumps(args))]), stream([text_chunk("Read it.")])]

    async def create(**kwargs):
        calls.append(json.loads(json.dumps(kwargs["messages"], default=str)))
        return replies.pop(0)

    async def execute(tool, tool_args, ctx):
        return json.dumps(answer)

    tools = [{"type": "function", "function": {"name": name, "parameters": {"type": "object", "properties": {}}}}]
    service = SimpleNamespace(
        model="claude-haiku-5-5", provider="anthropic", user_role="admin", tier="default", cluster_name="self",
        client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
        tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: tools,
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _execute_function_with_context=execute,
    )
    events = parsed([e async for e in streaming.session_chat_stream(service, "s1", "well?")])
    return events, saved, calls


@pytest.mark.asyncio
async def test_the_title_is_masked_off_the_event_loop_and_stored_before_the_answer_ends(monkeypatch):
    import threading

    from app.services.ai import streaming
    from app.services.redact import redact_text

    loop_thread = threading.get_ident()
    seen = []

    def masking(text, *a):
        seen.append(threading.get_ident())
        return redact_text(text + " password=fake-pass-1", *a)

    monkeypatch.setattr(streaming, "redact_text", masking)
    titles = []
    events, _, _ = await one_turn(monkeypatch, "get_pod_metrics", {}, [], titles=titles)
    assert seen and all(thread != loop_thread for thread in seen), seen
    assert titles == ["well? password=<REDACTED:password>"]
    assert events[-1] == "[DONE]"


@pytest.mark.asyncio
async def test_a_session_that_is_gone_is_an_error_event_with_no_letters(monkeypatch):
    events, saved, calls = await one_turn(monkeypatch, "get_pod_metrics", {}, [], session=False)
    assert events == [{"error": "Session not found", "error_key": "sessionNotFound"}]
    assert saved == [] and calls == []


@pytest.mark.parametrize("language", ["en", "ko"])
def test_the_words_for_a_session_that_is_gone_are_in_each_catalog(language):
    catalog = json.loads((CATALOGS / f"{language}.json").read_text(encoding="utf-8"))
    assert catalog["aiChat"]["error"]["sessionNotFound"]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,answer", UNDRAWABLE, ids=[f"{n}-{json.dumps(a)}" for n, _, a in UNDRAWABLE])
async def test_an_answer_no_table_can_be_drawn_from_is_shown_as_it_came(monkeypatch, caplog, name, args, answer):
    logger = logging.getLogger("kubeast.ai")
    logger.addHandler(caplog.handler)
    try:
        events, saved, calls = await one_turn(monkeypatch, name, args, answer)
    finally:
        logger.removeHandler(caplog.handler)

    assert events[-1] == "[DONE]", events
    assert not [e for e in events if isinstance(e, dict) and "error" in e], events
    result = next(e for e in events if isinstance(e, dict) and "function_result" in e)
    pretty = json.dumps(answer, ensure_ascii=False, indent=2)
    assert (result["result"], result["is_json"], "display" in result) == (pretty, True, False)
    # the model read it and went on, and the saved message holds it with no table
    assert any(m.get("role") == "tool" and json.loads(m["content"]) == answer for m in calls[1])
    assert saved[-1]["content"].endswith("Read it.")
    assert saved[-1]["tool_calls"][0]["result"] == pretty and saved[-1]["tool_calls"][0]["display"] is None
    # and the log says which table failed, so it gets fixed
    assert any(name in r.getMessage() and r.levelno == logging.WARNING for r in caplog.records), [r.getMessage() for r in caplog.records]


@pytest.mark.asyncio
async def test_an_answer_a_table_can_be_drawn_from_keeps_its_table(monkeypatch, caplog):
    logger = logging.getLogger("kubeast.ai")
    logger.addHandler(caplog.handler)
    try:
        events, saved, _ = await one_turn(monkeypatch, "get_node_metrics", {}, [{"name": "n1", "cpu": "1m", "memory": "2Mi"}])
    finally:
        logger.removeHandler(caplog.handler)

    assert events[-1] == "[DONE]"
    result = next(e for e in events if isinstance(e, dict) and "function_result" in e)
    assert result["display"].split("\n")[1].split() == ["n1", "1m", "2Mi"]
    assert result["display_format"] == "kubectl"
    assert saved[-1]["tool_calls"][0]["display"] == result["display"]
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING and "get_node_metrics" in r.getMessage()]
