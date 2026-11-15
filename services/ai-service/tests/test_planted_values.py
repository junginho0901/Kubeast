"""Made-up values planted in an alert and in what tools read never reach the model. The alert is masked here; a tool's
answer is masked by tool-server, stood in below with the same rules (redact_shape_cases.json holds the two lists equal),
numbering with the table the request sent. Both number a value from the one table of the run, which lives in this
process's memory for that run and goes in no report, audit row or stored tool log."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from app.services import redact
from app.services.investigation import runner
from app.services.tool_server_client import ToolServerClient
from tests.test_alert_investigation import FakeService, cfg, completion, install_loop, row, tool_call

PLANTED = [
    "ann.planted@example.com", "ann.planted", "bob.planted@example.com", "bob.planted",
    "010-2222-3333", "2222-3333", "plantedtoken0123456789abcdef", "plantedtoken9876543210zyxwvu", "planted-db-pass-1",
]

LOG = ("2026-11-15T01:02:03Z INFO login failed user=ann.planted@example.com\n"
       "2026-11-15T01:02:04Z INFO login failed user=bob.planted@example.com Authorization: Bearer plantedtoken9876543210zyxwvu\n")
ENV = "Environment:\n  DB_PASSWORD:  planted-db-pass-1\n  ADMIN_EMAIL:  bob.planted@example.com\n"


class _StandInToolServer:
    """POST /tools/call as tool-server answers it: the output masked with the request's table, the table sent back, and
    the values and held placeholders only when the request's masks ask reveal (redact.Numbers.Values, Held)."""

    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.requests = []
        self.answers = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        if "masks" not in body:  # REDACTION_NUMBERED off: no table, masked as before numbering
            out, stats = redact.redact_text(self.outputs.pop(0), redact.Options(pii=True))
            return httpx.Response(200, json={"content": out, "redacted": stats.as_dict()})
        numbers = redact.Numbers(key=body["masks"]["key"])
        numbers.table = {kind: dict(by_key) for kind, by_key in body["masks"].get("table", {}).items()}
        numbers.after = dict(body["masks"].get("after", {}))
        if body["masks"].get("reveal") is True:
            numbers.keep_values()
        out, stats = redact.redact_text(self.outputs.pop(0), redact.Options(pii=True, numbered=True), numbers)
        answer = {"content": out, "redacted": stats.as_dict(), "masks": numbers.table}
        if numbers.values:
            answer["values"] = dict(numbers.values)
        if numbers.values is not None and numbers.held:
            answer["held"] = sorted(numbers.held)
        self.answers.append(answer)
        return httpx.Response(200, json=answer)


@pytest.fixture(autouse=True)
def _numbered(monkeypatch):
    """The cases below are those of REDACTION_NUMBERED (chart ai.redaction.numbered), but the last one."""
    monkeypatch.setenv("REDACTION_NUMBERED", "true")


class _Service(FakeService):
    def __init__(self, replies, stand_in):
        super().__init__(replies)
        self.tool_server = ToolServerClient(authorization="Bearer t")
        self.tool_server.client = httpx.AsyncClient(base_url="http://tool-server", transport=httpx.MockTransport(stand_in.handler))

    async def _execute_function_with_context(self, name, args, ctx):
        self.executed.append((name, args))
        return await self.tool_server.call_tool(name, args)


@pytest.mark.asyncio
async def test_planted_values_never_reach_the_model_and_one_value_keeps_one_number(monkeypatch):
    monkeypatch.setenv("REDACTION_PII", "true")
    stand_in = _StandInToolServer([LOG, ENV])
    service = _Service([
        completion(calls=[tool_call("c1", "k8s_get_resources", {"resource_type": "pods", "namespace": "apps"})]),
        completion(calls=[tool_call("c2", "k8s_get_resources", {"resource_type": "deployments", "namespace": "apps"})]),
        completion(content="## Summary\n<EMAIL_1> and <EMAIL_2> failed to sign in."),
    ], stand_in)
    audits = []
    install_loop(monkeypatch, service, audits)
    r = row(labels={"alertname": "LoginFailures", "user": "ann.planted@example.com"},
            annotations={"summary": "paged 010-2222-3333", "auth": "Bearer plantedtoken0123456789abcdef"})
    out = await runner.investigate(cfg(max_steps=5), r)

    messages = service.completions.calls[-1]["messages"]
    model_input = json.dumps([c["messages"] for c in service.completions.calls], ensure_ascii=False, default=str)
    for value in PLANTED:
        assert model_input.count(value) == 0, value
    # one table for the run: the alert's address and the log's are one number, the next address the next one
    assert "<EMAIL_1>" in messages[1]["content"] and "<PHONE_1>" in messages[1]["content"]
    tool_texts = [m["content"] for m in messages if isinstance(m, dict) and m.get("role") == "tool"]
    assert len(tool_texts) == 2
    assert "user=<EMAIL_1>" in tool_texts[0] and "user=<EMAIL_2>" in tool_texts[0]
    assert "ADMIN_EMAIL:  <EMAIL_2>" in tool_texts[1] and "<REDACTED:DB_PASSWORD>" in tool_texts[1]

    # tool-server was sent the run's key and table, which hold no value
    assert stand_in.requests[0]["masks"]["key"] == stand_in.requests[1]["masks"]["key"] == service.tool_server.numbers.key
    assert len(stand_in.requests[0]["masks"]["table"]["email"]) == 1 and len(stand_in.requests[1]["masks"]["table"]["email"]) == 2
    sent_to_tool_server = json.dumps(stand_in.requests, ensure_ascii=False)
    for value in PLANTED:
        assert value not in sent_to_tool_server, value

    # the saved report keeps the placeholders; the rows and the stored tool log hold no value and no table
    assert "<EMAIL_1> and <EMAIL_2>" in out["report"]
    kept = json.dumps([audits, out["tool_calls"], out["report"]], ensure_ascii=False, default=str)
    for value in PLANTED + [service.tool_server.numbers.key]:
        assert value not in kept, value
    for by_key in service.tool_server.numbers.table.values():
        for key in by_key:
            assert key not in kept


def test_each_run_numbers_with_a_key_of_its_own():
    one, two = ToolServerClient(authorization="Bearer a"), ToolServerClient(authorization="Bearer a")
    assert one.numbers.key != two.numbers.key
    assert redact.mask_key(one.numbers.key, "email", "ann.planted@example.com") != redact.mask_key(two.numbers.key, "email", "ann.planted@example.com")


@pytest.mark.asyncio
async def test_the_client_keeps_the_table_tool_server_answers_and_ignores_other_shapes():
    answers = [
        {"content": "<EMAIL_1>", "masks": {"email": {"0123456789abcdef": 1}}},
        {"content": "ok", "masks": {"email": {"fedcba9876543210": "2", "bad": True}, "other": {"x": 1}}},
        {"content": "ok"},
    ]
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content)["masks"])
        return httpx.Response(200, json=answers.pop(0))

    c = ToolServerClient(authorization="Bearer t")
    c.client = httpx.AsyncClient(base_url="http://tool-server", transport=httpx.MockTransport(handler))
    assert await c.call_tool("k8s_get_resources", {}) == "<EMAIL_1>"
    await c.call_tool("k8s_get_resources", {})
    await c.call_tool("k8s_get_resources", {})
    assert sent[0] == {"key": c.numbers.key, "table": {}, "after": {}}
    assert sent[1]["table"] == sent[2]["table"] == {"email": {"0123456789abcdef": 1}}
    assert sent[1]["after"] == {"email": 1}
    assert c.numbers.table == {"email": {"0123456789abcdef": 1}}


def test_a_number_two_calls_at_once_gave_two_values_moves_in_the_later_answer():
    numbers = redact.Numbers(key="k")
    numbers.table = {"email": {"a" * 16: 1}}
    left_with = {"email": {"a" * 16: 1}}
    # both calls left with the same table; the first answer gives 2 and 3 to two new values
    assert numbers.take_answer(left_with, {"email": {"a" * 16: 1, "b" * 16: 2, "c" * 16: 3}}, "<EMAIL_2> <EMAIL_3>") == "<EMAIL_2> <EMAIL_3>"
    # the second gave 2 to c, which the first answer numbered 3, and 3 to d, new to the run: c moves to 3 and d past
    # every number the run has seen, the 9 its text already held included
    later = numbers.take_answer(left_with, {"email": {"a" * 16: 1, "c" * 16: 2, "d" * 16: 3}}, "<EMAIL_1> <EMAIL_2> <EMAIL_3> <EMAIL_9>")
    assert later == "<EMAIL_1> <EMAIL_3> <EMAIL_10> <EMAIL_9>"
    assert numbers.table == {"email": {"a" * 16: 1, "b" * 16: 2, "c" * 16: 3, "d" * 16: 10}}
    # a number of another kind is not taken
    assert numbers.take_answer({}, {"phone": {"e" * 16: 2}}, "<PHONE_2> <EMAIL_2>") == "<PHONE_2> <EMAIL_2>"


@pytest.mark.asyncio
async def test_two_calls_at_once_end_with_one_number_for_each_value():
    both_sent = asyncio.Event()
    seen = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(json.loads(request.content)["masks"])  # as sent: the table below is numbered into
        if len(seen) == 2:
            both_sent.set()
        await both_sent.wait()
        numbers = redact.Numbers(key=body["masks"]["key"])
        numbers.table = body["masks"]["table"]
        value = "ann.planted@example.com" if body["arguments"]["pod"] == "a" else "bob.planted@example.com"
        out, _ = redact.redact_text(f"user={value}", redact.Options(pii=True, numbered=True), numbers)
        return httpx.Response(200, json={"content": out, "masks": numbers.table})

    c = ToolServerClient(authorization="Bearer t")
    c.client = httpx.AsyncClient(base_url="http://tool-server", transport=httpx.MockTransport(handler))
    a, b = await asyncio.gather(c.call_tool("k8s_get_pod_logs", {"pod": "a"}), c.call_tool("k8s_get_pod_logs", {"pod": "b"}))
    assert seen[0]["table"] == seen[1]["table"] == {}  # both left before either answered
    assert sorted([a, b]) == ["user=<EMAIL_1>", "user=<EMAIL_2>"]
    assert sorted(c.numbers.table["email"].values()) == [1, 2]


def test_the_highest_number_of_each_kind_a_conversation_already_holds():
    texts = ["<EMAIL_1> wrote to <EMAIL_3>", None, "\\u003cPHONE_2\\u003e", "<EMAIL_1234567> <EMAIL_ADDRESS> <SSN_9>", {"x": "<EMAIL_8>"}]
    assert redact.highest_numbers(texts) == {"email": 3, "phone": 2}


def _client_on(stand_in):
    c = ToolServerClient(authorization="Bearer t")
    c.client = httpx.AsyncClient(base_url="http://tool-server", transport=httpx.MockTransport(stand_in.handler))
    return c


def chat_rig(monkeypatch, history, replies, tool_server=None, order=None, saved=None, audits=None, owner="u1"):
    """streaming.session_chat_stream over stand-ins: the messages the session holds, the model's replies and tool-server.
    Returns the service, the messages of each model call (as JSON) and the sessions whose messages were read. ``saved``
    and ``audits``, when given, collect the messages saved (each answered with an id) and the audit rows written;
    ``owner`` is the user the session belongs to."""
    from app.services.ai import streaming

    reads, calls, replies = [], [], list(replies)

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id=owner)

        async def add_message(self, sid, role, content, **kw):
            if saved is not None:
                saved.append({"role": role, "content": content, **kw})
                return SimpleNamespace(id=len(saved))

        async def get_messages(self, sid):
            reads.append(sid)
            if order is not None:
                order.append("history read")
            return list(history)

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

    async def get_db_service():
        return DB()

    async def no_audit(**kw):
        if audits is not None:
            audits.append(kw)
        return True

    async def audit_ready():
        return True, None

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", no_audit)
    monkeypatch.setattr("app.services.audit_writer.audit_ready", audit_ready)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)

    async def create(**kwargs):
        if order is not None:
            order.append("model called")
        calls.append(json.dumps(kwargs["messages"], ensure_ascii=False, default=str))
        return replies.pop(0)

    async def execute(tool, tool_args, ctx):
        return await tool_server.call_tool(tool, tool_args)

    tools = [{"type": "function", "function": {"name": "k8s_get_pod_logs", "parameters": {"type": "object", "properties": {}}}}]
    service = SimpleNamespace(
        model="claude-haiku-5-5", provider="anthropic", user_role="admin", tier="default", cluster_name="self",
        client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
        tool_contexts={}, tool_server=tool_server if tool_server is not None else SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: tools,
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _execute_function_with_context=execute,
    )
    service.session_chat_stream = lambda **kw: streaming.session_chat_stream(service, **kw)
    return service, calls, reads


@pytest.mark.asyncio
async def test_a_new_answer_numbers_past_the_placeholders_its_history_shows(monkeypatch):
    """An earlier answer's <EMAIL_1> was another table's: a new value of this answer never takes 1, so the model is not led
    to join two people. The same value would get a new number (a join missed, never a wrong one)."""
    from tests.test_chat_turn_edges import stream, text_chunk, tool_call_chunk

    stand_in = _StandInToolServer(["login carol.planted@example.com from 010-4444-5555\n"])
    history = [SimpleNamespace(role="user", content="who called?"),
               SimpleNamespace(role="assistant", content="<EMAIL_1> called from <PHONE_2>."),
               SimpleNamespace(role="user", content="and now?")]
    replies = [stream([tool_call_chunk("k8s_get_pod_logs", json.dumps({"namespace": "apps", "pod_name": "web-1"}))]),
               stream([text_chunk("Read it.")])]
    service, calls, reads = chat_rig(monkeypatch, history, replies, tool_server=_client_on(stand_in))
    [e async for e in service.session_chat_stream(session_id="s1", message="and now?")]

    assert stand_in.requests[0]["masks"]["after"] == {"email": 1, "phone": 2}
    assert len(calls) == 2 and "login <EMAIL_2> from <PHONE_3>" in calls[1]
    for value in ("carol.planted", "4444-5555"):
        assert value not in calls[1], value
    assert reads == ["s1"]


@pytest.mark.asyncio
async def test_the_floating_page_and_the_tool_results_of_an_answer_share_numbers_with_one_read_of_the_history(monkeypatch):
    from app.models.floating_ai import PageContextPayload, VisibleDataLayer
    from app.services.floating_ai_service import FloatingAIService
    from tests.test_chat_turn_edges import stream, text_chunk, tool_call_chunk

    monkeypatch.setenv("REDACTION_PII", "true")
    stand_in = _StandInToolServer(["login ann.planted@example.com and bob.planted@example.com\n"])
    history = [SimpleNamespace(role="assistant", content="<EMAIL_1> asked earlier."), SimpleNamespace(role="user", content="who?")]
    replies = [stream([tool_call_chunk("k8s_get_pod_logs", json.dumps({"namespace": "apps", "pod_name": "web-1"}))]),
               stream([text_chunk("Read it.")])]
    service, calls, reads = chat_rig(monkeypatch, history, replies, tool_server=_client_on(stand_in))
    ctx = PageContextPayload(
        page_type="resource-detail", page_title="web-1", path="/workloads/pods", snapshot_at="2026-11-15T00:00:00Z",
        base=VisibleDataLayer(source="base", summary="pod", data={"owner": "ann.planted@example.com", "note": "paged ann.planted@example.com"}),
    )
    [e async for e in FloatingAIService(service).session_chat_stream("s1", "who?", page_context=ctx)]

    # one read of the session's messages per question, the chat's own
    assert reads == ["s1"]
    # the page: one number for the value across its strings, past the history's <EMAIL_1>; the tool result: the same
    assert "ann.planted" not in calls[0] and '\\"owner\\":\\"<EMAIL_2>\\"' in calls[0] and "paged <EMAIL_2>" in calls[0]
    assert "login <EMAIL_2> and <EMAIL_3>" in calls[1]
    assert stand_in.requests[0]["masks"]["after"] == {"email": 2}  # past what the model reads, the page included


def test_an_alert_quoting_an_earlier_report_numbers_past_its_placeholders(monkeypatch):
    from app.services.investigation import prompt as inv_prompt

    monkeypatch.setenv("REDACTION_PII", "true")
    numbers = redact.Numbers()
    alert = {"annotations": {"summary": "the last report named <EMAIL_1> and <PHONE_2>; now dana.planted@example.com, 010-6666-7777"}}
    msg = inv_prompt.alert_message(cluster="self", alert=alert, numbers=numbers)
    assert "now <EMAIL_2>, <PHONE_3>" in msg and "dana.planted" not in msg
    assert numbers.after == {"email": 1, "phone": 2}


@pytest.mark.asyncio
async def test_with_numbering_off_a_run_sends_no_table_and_masks_as_before(monkeypatch):
    monkeypatch.setenv("REDACTION_PII", "true")
    monkeypatch.delenv("REDACTION_NUMBERED")
    stand_in = _StandInToolServer([LOG])
    service = _Service([
        completion(calls=[tool_call("c1", "k8s_get_resources", {"resource_type": "pods", "namespace": "apps"})]),
        completion(content="## Summary\nok"),
    ], stand_in)
    install_loop(monkeypatch, service, [])
    r = row(labels={"alertname": "LoginFailures", "user": "ann.planted@example.com"}, annotations={"summary": "paged 010-2222-3333"})
    await runner.investigate(cfg(max_steps=5), r)
    messages = service.completions.calls[-1]["messages"]
    assert service.tool_server.numbers is None and [sorted(b) for b in stand_in.requests] == [["arguments", "name"]]
    assert "<EMAIL_1>" in messages[1]["content"] and "<REDACTED:phone>" in messages[1]["content"]
    (tool_text,) = [m["content"] for m in messages if isinstance(m, dict) and m.get("role") == "tool"]
    assert "user=<EMAIL_1>" in tool_text and "user=<EMAIL_2>" in tool_text  # numbered within that answer alone
    assert "<PHONE_" not in json.dumps([c["messages"] for c in service.completions.calls], ensure_ascii=False, default=str)
