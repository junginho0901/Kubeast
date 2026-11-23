"""The values behind an answer's numbered placeholders go back to the person who asked, from the chat stream only: tool-server
gives them for a request whose masks ask reveal, ai-service keeps them in that request's memory and sends them once as
mask_values after the answer is saved. The saved answer, the next turn's model input, the audit rows, an investigation's
report and an MCP answer hold none of them."""
import json
from types import SimpleNamespace

import httpx
import pytest

from app import mcp_server
from app.services import redact
from app.services.investigation import runner
from app.services.tool_server_client import ToolServerClient
from tests.test_alert_investigation import cfg, completion, install_loop, row, tool_call
from tests.test_chat_turn_edges import parsed, stream, text_chunk, tool_call_chunk
from tests.test_mcp_server import call, fakes, running_app  # noqa: F401 (fakes is a fixture)
from tests.test_planted_values import LOG, PLANTED, _client_on, _Service, _StandInToolServer, chat_rig

ACTOR = {"user_id": "u1", "email": "asker@example.com"}
PAIRS = {"<EMAIL_1>": "ann.planted@example.com", "<EMAIL_2>": "bob.planted@example.com"}


def _shown(events):
    return [e for e in events if isinstance(e, dict) and "mask_values" in e]


@pytest.fixture(autouse=True)
def _numbered(monkeypatch):
    """The values come with the numbered placeholders (REDACTION_NUMBERED, chart ai.redaction.numbered); the last case is off."""
    monkeypatch.setenv("REDACTION_NUMBERED", "true")


@pytest.mark.asyncio
async def test_the_chat_sends_the_values_once_and_keeps_none_of_them(monkeypatch):
    monkeypatch.setenv("REDACTION_PII", "true")
    stand_in = _StandInToolServer([LOG])
    saved, audits = [], []
    replies = [stream([tool_call_chunk("k8s_get_pod_logs", json.dumps({"namespace": "apps", "pod_name": "web-1"}))]),
               stream([text_chunk("<EMAIL_1> and <EMAIL_2> failed to sign in.")])]
    service, calls, _ = chat_rig(monkeypatch, [SimpleNamespace(role="user", content="who failed?")], replies,
                                 tool_server=_client_on(stand_in), saved=saved, audits=audits)
    events = parsed([e async for e in service.session_chat_stream(session_id="s1", message="who failed?", audit_actor=ACTOR, audit_http={})])

    # tool-server was asked for the values by this request, and they left once, after the answer was saved
    assert [r["masks"].get("reveal") for r in stand_in.requests] == [True]
    assert stand_in.answers[0]["values"] == PAIRS
    assert _shown(events) == [{"mask_values": PAIRS, "message_id": 2}]
    assert events[-2] == _shown(events)[0] and events[-1] == "[DONE]"
    others = json.dumps([e for e in events if e not in _shown(events)], ensure_ascii=False)
    for value in PLANTED:
        assert value not in others, value

    # the saved answer, the model input and the audit rows hold the placeholders, no value, and the run let them go
    assert saved[-1]["role"] == "assistant" and "<EMAIL_1> and <EMAIL_2> failed to sign in." in saved[-1]["content"]
    assert "user=<EMAIL_1>" in saved[-1]["content"]
    assert [a["action"] for a in audits] == ["ai.chat.send", "ai.tool.call", "ai.chat.complete"]
    kept = json.dumps([saved, audits, calls], ensure_ascii=False, default=str)
    for value in PLANTED:
        assert value not in kept, value
    assert service.tool_server.numbers.values == {}

    # the next question reads the saved answer as its history: the model gets no value, and the earlier placeholders none
    later_saved = []
    history = [SimpleNamespace(role=m["role"], content=m["content"]) for m in saved] + [SimpleNamespace(role="user", content="again?")]
    later, later_calls, _ = chat_rig(monkeypatch, history, [stream([text_chunk("Still <EMAIL_1> and <EMAIL_2>.")])],
                                     tool_server=_client_on(_StandInToolServer([])), saved=later_saved)
    later_events = parsed([e async for e in later.session_chat_stream(session_id="s1", message="again?", audit_actor=ACTOR, audit_http={})])
    assert "<EMAIL_1> and <EMAIL_2> failed to sign in." in later_calls[0]
    for value in PLANTED:
        assert value not in later_calls[0], value
    assert _shown(later_events) == []


@pytest.mark.asyncio
async def test_the_floating_page_gives_its_values_and_a_placeholder_it_already_held_gets_none(monkeypatch):
    from app.models.floating_ai import PageContextPayload, VisibleDataLayer
    from app.services.floating_ai_service import FloatingAIService

    monkeypatch.setenv("REDACTION_PII", "true")
    stand_in = _StandInToolServer([LOG])
    saved = []
    replies = [stream([tool_call_chunk("k8s_get_pod_logs", json.dumps({"namespace": "apps", "pod_name": "web-1"}))]),
               stream([text_chunk("<EMAIL_1> owns it; <EMAIL_3> and <EMAIL_4> failed; <EMAIL_2> is the report's.")])]
    service, calls, _ = chat_rig(monkeypatch, [SimpleNamespace(role="user", content="who?")], replies,
                                 tool_server=_client_on(stand_in), saved=saved)
    ctx = PageContextPayload(
        page_type="resource-detail", page_title="web-1", path="/workloads/pods", snapshot_at="2026-11-15T00:00:00Z",
        base=VisibleDataLayer(source="base", summary="pod", data={"owner": "carol.planted@example.com"}),
        overlays=[VisibleDataLayer(source="InvestigationReport", summary="report", data={"note": "the last report named <EMAIL_2>"})],
    )
    events = parsed([e async for e in FloatingAIService(service).session_chat_stream("s1", "who?", page_context=ctx, audit_actor=ACTOR)])

    assert "carol.planted" not in calls[0] and '\\"owner\\":\\"<EMAIL_1>\\"' in calls[0]
    assert "login failed user=<EMAIL_3>" in calls[1] and "user=<EMAIL_4>" in calls[1]
    # the page's value and the tool's come back; the report's <EMAIL_2> stands for no value of this answer
    assert _shown(events) == [{"mask_values": {"<EMAIL_1>": "carol.planted@example.com", "<EMAIL_3>": "ann.planted@example.com",
                                               "<EMAIL_4>": "bob.planted@example.com"}, "message_id": 2}]
    kept = json.dumps([saved, calls], ensure_ascii=False, default=str)
    for value in PLANTED + ["carol.planted"]:
        assert value not in kept, value


@pytest.mark.asyncio
async def test_an_answer_that_shows_no_placeholder_sends_no_values(monkeypatch):
    monkeypatch.setenv("REDACTION_PII", "true")
    replies = [stream([tool_call_chunk("k8s_get_pod_logs", json.dumps({"namespace": "apps", "pod_name": "web-1"}))]),
               stream([text_chunk("Nothing to say.")])]
    stand_in = _StandInToolServer(["no personal data here\n"])
    service, _, _ = chat_rig(monkeypatch, [SimpleNamespace(role="user", content="logs?")], replies,
                             tool_server=_client_on(stand_in), saved=[])
    events = parsed([e async for e in service.session_chat_stream(session_id="s1", message="logs?", audit_actor=ACTOR)])
    assert stand_in.requests[0]["masks"]["reveal"] is True
    assert _shown(events) == [] and events[-1] == "[DONE]"


@pytest.mark.asyncio
@pytest.mark.parametrize("owner, actor", [("u2", ACTOR), ("u1", None), ("u1", {"email": "asker@example.com"})])
async def test_values_are_asked_only_for_the_conversations_own_user(monkeypatch, owner, actor):
    """The chat routes let only a session's own user stream it; the stream itself asks for the values only then too, so a
    caller that is not the session's user, or none that it can name, gets the placeholders alone."""
    monkeypatch.setenv("REDACTION_PII", "true")
    stand_in = _StandInToolServer([LOG])
    replies = [stream([tool_call_chunk("k8s_get_pod_logs", json.dumps({"namespace": "apps", "pod_name": "web-1"}))]),
               stream([text_chunk("<EMAIL_1> and <EMAIL_2> failed to sign in.")])]
    service, _, _ = chat_rig(monkeypatch, [SimpleNamespace(role="user", content="who?")], replies,
                             tool_server=_client_on(stand_in), saved=[], audits=[], owner=owner)
    events = parsed([e async for e in service.session_chat_stream(session_id="s1", message="who?", audit_actor=actor, audit_http={})])
    assert "reveal" not in stand_in.requests[0]["masks"] and "values" not in stand_in.answers[0]
    assert _shown(events) == [] and events[-1] == "[DONE]"
    for value in PLANTED:
        assert value not in json.dumps(events, ensure_ascii=False), value


@pytest.mark.asyncio
async def test_an_investigation_never_asks_for_the_values(monkeypatch):
    monkeypatch.setenv("REDACTION_PII", "true")
    stand_in = _StandInToolServer([LOG])
    service = _Service([
        completion(calls=[tool_call("c1", "k8s_get_resources", {"resource_type": "pods", "namespace": "apps"})]),
        completion(content="## Summary\n<EMAIL_1> and <EMAIL_2> failed to sign in."),
    ], stand_in)
    audits = []
    install_loop(monkeypatch, service, audits)
    out = await runner.investigate(cfg(max_steps=5), row(labels={"alertname": "LoginFailures"}))

    assert [r["masks"].get("reveal") for r in stand_in.requests] == [None]
    assert "values" not in stand_in.answers[0] and "held" not in stand_in.answers[0]
    assert service.tool_server.numbers.values is None
    assert "<EMAIL_1> and <EMAIL_2>" in out["report"]
    kept = json.dumps([audits, out["tool_calls"], out["report"]], ensure_ascii=False, default=str)
    for value in PLANTED:
        assert value not in kept, value


@pytest.mark.asyncio
async def test_an_mcp_call_never_asks_for_the_values(fakes, monkeypatch):  # noqa: F811
    monkeypatch.setenv("REDACTION_PII", "true")
    stand_in = _StandInToolServer([LOG])

    class Client(ToolServerClient):
        def __init__(self, authorization=None, base_url=None):
            super().__init__(authorization=authorization, base_url=base_url)
            self.client = httpx.AsyncClient(base_url="http://tool-server", transport=httpx.MockTransport(stand_in.handler))

    monkeypatch.setattr(mcp_server, "ToolServerClient", Client)
    server = mcp_server.KubeastMCPServer(tool_server_url="http://tools")
    async with running_app(server) as client:
        res = await call(client, "tok-key", "tools/call", {"name": "k8s_get_resources", "arguments": {"cluster": "self", "resource_type": "pods", "namespace": "kubeast"}})
    assert res.status_code == 200, res.text
    assert [r["masks"].get("reveal") for r in stand_in.requests] == [None]
    assert "user=<EMAIL_1>" in res.json()["result"]["content"][0]["text"]
    kept = json.dumps([res.json(), fakes["audit"]], ensure_ascii=False, default=str)
    for value in PLANTED:
        assert value not in kept, value


def test_a_client_nobody_turned_on_asks_for_no_values():
    c = ToolServerClient(authorization="Bearer t")
    assert "reveal" not in c.numbers.wire() and c.numbers.values is None
    c.numbers.keep({"<EMAIL_1>": "a@b.io"}, ["<EMAIL_2>"])
    assert c.numbers.values is None and c.numbers.revealed("<EMAIL_1>") == {}
    c.numbers.keep_values()
    assert c.numbers.wire()["reveal"] is True


def test_values_follow_a_number_the_later_of_two_calls_at_once_moves():
    numbers = redact.Numbers(key="k")
    numbers.keep_values()
    left_with = {"email": {}}
    first = numbers.take_answer(left_with, {"email": {"a" * 16: 1}}, "user=<EMAIL_1>", {"<EMAIL_1>": "ann@example.com"})
    # the later call gave 1 to bob, which the first gave ann: bob moves to 2, in the text and in the values
    later = numbers.take_answer(left_with, {"email": {"b" * 16: 1}}, "user=<EMAIL_1>", {"<EMAIL_1>": "bob@example.com"})
    assert (first, later) == ("user=<EMAIL_1>", "user=<EMAIL_2>")
    assert numbers.values == {"<EMAIL_1>": "ann@example.com", "<EMAIL_2>": "bob@example.com"}
    assert numbers.revealed("<EMAIL_2> only") == {"<EMAIL_2>": "bob@example.com"}


def test_a_placeholder_any_answer_held_gets_no_value_and_shapes_not_ours_are_dropped():
    numbers = redact.Numbers(key="k")
    numbers.keep_values()
    numbers.take_answer({}, {"email": {"a" * 16: 1}}, "user=<EMAIL_1>", {"<EMAIL_1>": "ann@example.com"})
    # a later answer's text held <EMAIL_1> (an earlier report): the screen could not tell the two apart
    numbers.take_answer({"email": {"a" * 16: 1}}, {"email": {"a" * 16: 1}}, "report: <EMAIL_1>", None, ["<EMAIL_1>"])
    assert numbers.values == {} and numbers.revealed("user=<EMAIL_1>") == {}
    numbers.keep({"<EMAIL_1>": "again@example.com", "EMAIL_5": "x", "<TOKEN_1>": "y", "<PHONE_2>": 3, 4: "z"}, "<PHONE_3>")
    assert numbers.values == {}
    # the first spelling of a value stays
    numbers.keep({"<PHONE_1>": "010-1234-5678"})
    numbers.keep({"<PHONE_1>": "01012345678"})
    assert numbers.values == {"<PHONE_1>": "010-1234-5678"}


@pytest.mark.asyncio
async def test_with_numbering_off_the_chat_asks_for_no_values_and_sends_none(monkeypatch):
    monkeypatch.setenv("REDACTION_PII", "true")
    monkeypatch.delenv("REDACTION_NUMBERED")
    stand_in = _StandInToolServer([LOG])
    saved = []
    replies = [stream([tool_call_chunk("k8s_get_pod_logs", json.dumps({"namespace": "apps", "pod_name": "web-1"}))]),
               stream([text_chunk("<EMAIL_1> and <EMAIL_2> failed to sign in.")])]
    service, calls, _ = chat_rig(monkeypatch, [SimpleNamespace(role="user", content="who failed?")], replies,
                                 tool_server=_client_on(stand_in), saved=saved)
    events = parsed([e async for e in service.session_chat_stream(session_id="s1", message="who failed?", audit_actor=ACTOR, audit_http={})])
    assert service.tool_server.numbers is None and [sorted(r) for r in stand_in.requests] == [["arguments", "name"]]
    assert _shown(events) == [] and events[-1] == "[DONE]"
    assert "user=<EMAIL_1>" in saved[-1]["content"]
    for value in PLANTED:
        assert value not in json.dumps([events, saved, calls], ensure_ascii=False, default=str), value
