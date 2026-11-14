"""Made-up values planted in an alert and in what tools read never reach the model. The alert is masked here; a tool's
answer is masked by tool-server, stood in below with the same rules (redact_shape_cases.json holds the two lists equal),
numbering with the table the request sent. Both number a value from the one table of the run, which lives in this
process's memory for that run and goes in no report, audit row or stored tool log."""
import json

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
    """POST /tools/call as tool-server answers it: the output masked with the request's table, the table sent back."""

    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.requests = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        numbers = redact.Numbers(key=body["masks"]["key"])
        numbers.table = {kind: dict(by_key) for kind, by_key in body["masks"].get("table", {}).items()}
        out, stats = redact.redact_text(self.outputs.pop(0), redact.Options(pii=True), numbers)
        return httpx.Response(200, json={"content": out, "redacted": stats.as_dict(), "masks": numbers.table})


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
    assert sent[0] == {"key": c.numbers.key, "table": {}}
    assert sent[1]["table"] == sent[2]["table"] == {"email": {"0123456789abcdef": 1}}
    assert c.numbers.table == {"email": {"0123456789abcdef": 1}}


def test_a_number_two_calls_at_once_gave_two_values_moves_in_the_later_answer():
    numbers = redact.Numbers(key="k")
    numbers.table = {"email": {"a" * 16: 1}}
    left_with = {"email": {"a" * 16: 1}}
    # both calls left with the same table; the first answer gives 2 and 3 to two new values
    assert numbers.take_answer(left_with, {"email": {"a" * 16: 1, "b" * 16: 2, "c" * 16: 3}}, "<EMAIL_2> <EMAIL_3>") == "<EMAIL_2> <EMAIL_3>"
    # the second gave 2 to c, which the first answer numbered 3, and 3 to d, new to the run: they move to 3 and 4
    later =numbers.take_answer(left_with, {"email": {"a" * 16: 1, "c" * 16: 2, "d" * 16: 3}}, "<EMAIL_1> <EMAIL_2> <EMAIL_3> <EMAIL_9>")
    assert later == "<EMAIL_1> <EMAIL_3> <EMAIL_4> <EMAIL_9>"
    assert numbers.table == {"email": {"a" * 16: 1, "b" * 16: 2, "c" * 16: 3, "d" * 16: 4}}
    # a number of another kind is not taken
    assert numbers.take_answer({}, {"phone": {"e" * 16: 2}}, "<PHONE_2> <EMAIL_2>") == "<PHONE_2> <EMAIL_2>"


@pytest.mark.asyncio
async def test_two_calls_at_once_end_with_one_number_for_each_value():
    import asyncio

    both_sent = asyncio.Event()
    seen = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body["masks"])
        if len(seen) == 2:
            both_sent.set()
        await both_sent.wait()
        numbers = redact.Numbers(key=body["masks"]["key"])
        numbers.table = body["masks"]["table"]
        value = "ann.planted@example.com" if body["arguments"]["pod"] == "a" else "bob.planted@example.com"
        out, _ = redact.redact_text(f"user={value}", redact.Options(pii=True), numbers)
        return httpx.Response(200, json={"content": out, "masks": numbers.table})

    c = ToolServerClient(authorization="Bearer t")
    c.client = httpx.AsyncClient(base_url="http://tool-server", transport=httpx.MockTransport(handler))
    a, b = await asyncio.gather(c.call_tool("k8s_get_pod_logs", {"pod": "a"}), c.call_tool("k8s_get_pod_logs", {"pod": "b"}))
    assert seen[0]["table"] == seen[1]["table"] == {}  # both left before either answered
    assert sorted([a, b]) == ["user=<EMAIL_1>", "user=<EMAIL_2>"]
    assert sorted(c.numbers.table["email"].values()) == [1, 2]
