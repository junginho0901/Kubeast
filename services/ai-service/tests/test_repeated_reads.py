"""ai.refuseRepeatedReads (app/services/ai/repeats.py): the same read twice in one chat answer or one investigation is
not run again within a minute, in both loops (the API-key loop and Claude Code on a subscription) of the chat and the
investigator, and its ai.tool.call row says so. Off, nothing of it is reached: the calls, the rows and what the model
reads are what they were."""
import json
import sys
from types import SimpleNamespace

import pytest

from app.services import claude_code
from app.services.ai import repeats
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import runner
from tests.test_alert_investigation import (FakeClaudeCode, FakeService, FakeSubscriptionService, cfg, completion,
                                            install_loop, row, tool_call)
from tests.test_claude_code import OK, make_sdk, slots_db  # noqa: F401 (slots_db: a fixture)
from tests.test_investigation_window import STARTED, STEP_ZERO_ARGS, ChangesService, at_now

PODS = {"resource_type": "pods", "namespace": "apps"}
LOGS = {"namespace": "apps", "pod_name": "p"}
POD_LIST = '{"items": [{"name": "web-0"}]}'
# what an ai.tool.call row of the chat and of an investigation held before the switch
CHAT_ROW_KEYS = {"session_id", "tool", "iteration", "resource_type", "status", "redacted", "access", "requests"}
INVESTIGATION_ROW_KEYS = {"investigation_id", "tool", "iteration", "resource_type", "redacted", "access", "requests"}


@pytest.fixture
def refuse(monkeypatch):
    monkeypatch.setenv("AI_REFUSE_REPEATED_READS", "true")


@pytest.fixture
def never_guarded(monkeypatch):
    """Off: building a guard at all fails the test."""
    monkeypatch.delenv("AI_REFUSE_REPEATED_READS", raising=False)

    def boom(*a, **k):
        raise AssertionError("a RepeatGuard was made with ai.refuseRepeatedReads off")

    monkeypatch.setattr(repeats, "RepeatGuard", boom)


# --- the guard ---------------------------------------------------------------------------------------------------


def test_the_switch_is_off_unless_set_on(monkeypatch):
    monkeypatch.delenv("AI_REFUSE_REPEATED_READS", raising=False)
    assert repeats.enabled() is False
    monkeypatch.setenv("AI_REFUSE_REPEATED_READS", "no")
    assert repeats.enabled() is False
    for value in (" True ", "yes", "1"):  # app/services/switch.py, the one switch rule
        monkeypatch.setenv("AI_REFUSE_REPEATED_READS", value)
        assert repeats.enabled() is True


def test_the_same_read_within_a_minute_is_held_and_past_it_runs_again():
    now = [100.0]
    guard = repeats.RepeatGuard(clock=lambda: now[0])
    assert guard.earlier("k8s_get_resources", PODS) is None
    guard.note("k8s_get_resources", PODS, step=1, call=0)
    now[0] = 159.0
    # an argument given as null is one not given; the order of the arguments does not count
    seen = guard.earlier("k8s_get_resources", {"namespace": "apps", "resource_type": "pods", "label_selector": None})
    assert seen == repeats.Seen(step=1, call=0, at=100.0) and guard.age(seen) == 59
    assert guard.earlier("k8s_get_resources", {**PODS, "namespace": "shop"}) is None  # other arguments run
    assert guard.earlier("k8s_get_pod_logs", PODS) is None  # another tool runs
    now[0] = 160.0
    assert guard.earlier("k8s_get_resources", PODS) is None  # a rollout may have moved on


def test_writes_and_actions_are_never_held():
    guard = repeats.RepeatGuard(clock=lambda: 0.0)
    for name in ("k8s_delete_resource", "alert_investigate"):
        guard.note(name, {"resource_name": "web"}, step=1)
        assert guard.earlier(name, {"resource_name": "web"}) is None


def test_the_refusal_says_where_the_result_is_and_asks_for_other_arguments():
    told = json.loads(repeats.refusal(repeats.Seen(step=2, call=1, at=0.0), 12, scope="answer"))
    assert told["status"] == "repeated" and told["repeat_of"] == 2
    assert "at step 2 of this answer, 12 seconds ago" in told["message"]
    assert "It was not run again" in told["message"] and "other arguments" in told["message"]
    step_zero = json.loads(repeats.refusal(repeats.Seen(step=0, call=1, at=0.0), 3, scope="investigation"))
    assert "step 0" in step_zero["message"] and "first message" in step_zero["message"]


ASK = ("It was not run again. Use that result, or call with other arguments (another name, namespace, time range or "
       "filter) to read something new.")


def test_without_call_numbers_the_refusal_reads_as_it_did_to_the_byte():
    for numbered in (False, True):  # True with no number kept (the chat's guard) reads the same
        seen = repeats.Seen(step=2, call=None if numbered else 4, at=0.0)
        assert repeats.refusal(seen, 12, scope="investigation", numbered=numbered) == (
            '{"status": "repeated", "repeat_of": 2, "message": "This read, the same tool with the same arguments, was '
            f'already made at step 2 of this investigation, 12 seconds ago; its result is above. {ASK}"}}')
    assert repeats.refusal(repeats.Seen(step=0, call=1, at=0.0), 3, scope="investigation") == (
        '{"status": "repeated", "repeat_of": 0, "message": "This read, the same tool with the same arguments, was '
        f'already made by the server before the investigation started (step 0); its answer is in the first message. {ASK}"}}')
    assert repeats.refusal(repeats.Seen(step=1, call=0, at=0.0), 5, scope="answer") == (
        '{"status": "repeated", "repeat_of": 1, "message": "This read, the same tool with the same arguments, was '
        f'already made at step 1 of this answer, 5 seconds ago; its result is above. {ASK}"}}')


def test_with_call_numbers_the_refusal_names_the_call_the_model_read():
    told = json.loads(repeats.refusal(repeats.Seen(step=1, call=2, at=0.0), 12, scope="investigation", numbered=True))
    assert told == {"status": "repeated", "repeat_of_call": 2,
                    "message": "This read, the same tool with the same arguments, was already made as call 2 of this "
                               f"investigation, 12 seconds ago; its result is the one under [call 2] above. {ASK}"}
    step_zero = json.loads(repeats.refusal(repeats.Seen(step=0, call=1, at=0.0), 3, scope="investigation", numbered=True))
    assert step_zero["repeat_of_call"] == 1 and "repeat_of" not in step_zero
    assert "before the investigation started (call 1); its answer is in the first message" in step_zero["message"]
    assert "step" not in told["message"] and "step" not in step_zero["message"]  # one numbering for the model


# --- the chat's _call_tool, which both chat loops reach ----------------------------------------------------------


def _patch_audit(monkeypatch):
    rows = []

    async def ready():
        return True, None

    async def write_audit(**kw):
        rows.append(kw)
        return True

    monkeypatch.setattr("app.services.audit_writer.audit_ready", ready)
    monkeypatch.setattr("app.services.audit_writer.write_audit", write_audit)
    return rows


class _Service:
    def __init__(self, answers):
        self.answers = list(answers)
        self.tool_server = SimpleNamespace(last_redacted=None)
        self.executed = []

    async def _execute_function_with_context(self, name, args, ctx):
        self.executed.append(name)
        self.tool_server.last_redacted = {"count": 1, "kinds": ["token"]}  # what tool-server masked in this answer
        return self.answers.pop(0)


ACTOR = {"user_id": "u1", "email": "dev@example.com"}


async def _call(service, guard, args, iteration, call_id):
    from app.services.ai import streaming

    return await streaming._call_tool(service, None, None, "s1", [], None, "k8s_get_resources", args,
                                      iteration=iteration, audit_actor=ACTOR, audit_http=None, call_id=call_id, repeats=guard)


@pytest.mark.asyncio
async def test_a_repeated_chat_read_is_not_run_and_its_row_says_which_call_it_repeated(monkeypatch):
    rows = _patch_audit(monkeypatch)
    service = _Service([POD_LIST])
    guard = repeats.RepeatGuard(clock=lambda: 50.0)
    await _call(service, guard, PODS, 1, 0)
    events, entry, text = await _call(service, guard, dict(PODS), 2, 1)
    assert service.executed == ["k8s_get_resources"]  # the cluster was read once
    told = json.loads(text)
    assert told["status"] == "repeated" and told["repeat_of"] == 1
    assert "repeated" in entry["result"] and entry["call_id"] == 1
    assert any('"function_result": "k8s_get_resources"' in e and "repeated" in e for e in events)
    first, second = rows
    assert set(first["after"]) == CHAT_ROW_KEYS and first["after"]["redacted"] == {"count": 1, "kinds": ["token"]}
    assert second["action"] == "ai.tool.call" and second["result"] == "success" and second["error"] is None
    assert second["after"]["status"] == "repeated" and second["after"]["repeat_of"] == 1
    # nothing was read: no identity, no cluster requests, and not the earlier call's masking count
    assert second["after"]["access"] is None and second["after"]["requests"] is None and second["after"]["redacted"] is None


@pytest.mark.asyncio
async def test_a_failed_or_refused_read_can_be_made_again(monkeypatch):
    _patch_audit(monkeypatch)
    service = _Service(['{"error": "timeout"}', '{"status": "forbidden", "message": "no"}', POD_LIST])
    guard = repeats.RepeatGuard(clock=lambda: 50.0)
    for n in range(3):
        _events, _entry, text = await _call(service, guard, PODS, n + 1, n)
    assert service.executed == ["k8s_get_resources"] * 3
    assert json.loads(text) == json.loads(POD_LIST)


@pytest.mark.asyncio
async def test_without_a_guard_the_chat_reads_every_time_and_its_rows_are_as_before(monkeypatch):
    rows = _patch_audit(monkeypatch)
    service = _Service([POD_LIST, POD_LIST])
    texts = [(await _call(service, None, PODS, n + 1, n))[2] for n in range(2)]
    assert service.executed == ["k8s_get_resources"] * 2 and texts[0] == texts[1]
    assert [set(r["after"]) for r in rows] == [CHAT_ROW_KEYS, CHAT_ROW_KEYS]


# --- a whole chat turn, each loop ----------------------------------------------------------------------------------


def _stream(chunks):
    async def gen():
        for c in chunks:
            yield c
    return gen()


def _call_chunk(name, args):
    fn = SimpleNamespace(name=name, arguments=json.dumps(args))
    delta = SimpleNamespace(content=None, tool_calls=[SimpleNamespace(index=0, id="call_1", function=fn)])
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="tool_calls")], usage=None)


def _text_chunk(text):
    delta = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="stop")], usage=None)


TOOLS = [{"type": "function", "function": {"name": "k8s_get_resources", "description": "Get",
                                           "parameters": {"type": "object", "properties": {}}}}]


async def _chat_turn(monkeypatch, *, provider="anthropic", replies=None):
    """One chat turn through session_chat_stream: the stream's payloads, the saved answer, the audit rows, the messages
    each model call got (API-key loop) and the tools run."""
    from app.services.ai import streaming

    saved, rows, sent, executed = [], [], [], []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            saved.append({"role": role, "content": content, **kw})

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content="which pods?")]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

    async def get_db_service():
        return DB()

    async def write_audit(**kw):
        rows.append(kw)
        return True

    async def ready():
        return True, None

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", write_audit)
    monkeypatch.setattr("app.services.audit_writer.audit_ready", ready)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)

    replies = list(replies or [])

    async def create(**kwargs):
        sent.append(json.loads(json.dumps(kwargs["messages"], default=str)))
        return replies.pop(0)

    async def execute(name, args, ctx):
        executed.append((name, args))
        return POD_LIST

    if provider == "claude-code":
        client = SimpleNamespace(claude_code=claude_code.ClaudeCodeChat(model="claude-haiku-5-5", token="t"))
    else:
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    service = SimpleNamespace(
        model="claude-haiku-5-5", provider=provider, user_role="admin", tier="default", cluster_name="self",
        client=client, tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: TOOLS,
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _execute_function_with_context=execute,
    )
    events = [e async for e in streaming.session_chat_stream(
        service, "s1", "which pods?", audit_actor=ACTOR, audit_http={"ip": "10.0.0.1"})]
    assert events[-1] == "data: [DONE]\n\n"
    payloads = [json.loads(e.removeprefix("data: ").strip()) for e in events[:-1]]
    return payloads, saved, rows, sent, executed


def _api_key_replies():
    return [_stream([_call_chunk("k8s_get_resources", PODS)]), _stream([_call_chunk("k8s_get_resources", dict(PODS))]),
            _stream([_text_chunk("One pod, web-0.")])]


def _tool_rows(rows):
    return [r for r in rows if r["action"] == "ai.tool.call"]


@pytest.mark.asyncio
async def test_the_api_key_chat_refuses_the_same_read_in_its_next_step(monkeypatch, refuse):
    payloads, saved, rows, sent, executed = await _chat_turn(monkeypatch, replies=_api_key_replies())
    assert executed == [("k8s_get_resources", PODS)]
    tool_messages = [m for m in sent[2] if m["role"] == "tool"]
    assert json.loads(tool_messages[0]["content"]) == json.loads(POD_LIST)
    assert json.loads(tool_messages[1]["content"])["status"] == "repeated"
    assert "at step 1 of this answer" in json.loads(tool_messages[1]["content"])["message"]
    first, second = _tool_rows(rows)
    assert "repeat_of" not in first["after"] and first["after"]["iteration"] == 1
    assert second["after"]["iteration"] == 2 and second["after"]["repeat_of"] == 1 and second["after"]["status"] == "repeated"
    assert [r["action"] for r in rows] == ["ai.chat.send", "ai.tool.call", "ai.tool.call", "ai.chat.complete"]
    answer = saved[-1]
    assert [c["function"] for c in answer["tool_calls"]] == ["k8s_get_resources"] * 2
    assert "repeated" in answer["tool_calls"][1]["result"] and answer["content"].endswith("One pod, web-0.")
    assert answer["tool_calls"][1]["call_id"] == 1
    assert any(p.get("function_result") == "k8s_get_resources" and p.get("call_id") == 1 and "repeated" in p["result"]
               for p in payloads)


@pytest.mark.asyncio
async def test_the_subscription_chat_refuses_the_same_read_through_the_same_call(monkeypatch, refuse, slots_db):
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_ENABLED", True, raising=False)
    monkeypatch.setattr(claude_code, "_semaphores", {})
    sdk = make_sdk([("call", "k8s_get_resources", dict(PODS)), ("call", "k8s_get_resources", dict(PODS)),
                    ("text", "One pod, web-0."), ("result", OK)])
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    payloads, saved, rows, _sent, executed = await _chat_turn(monkeypatch, provider="claude-code")
    assert executed == [("k8s_get_resources", PODS)]
    first, second = (r["content"][0]["text"] for r in sdk.state["tool_results"])
    assert json.loads(first) == json.loads(POD_LIST)
    assert json.loads(second)["status"] == "repeated" and json.loads(second)["repeat_of"] == 1
    tool_rows = _tool_rows(rows)
    assert [r["after"].get("repeat_of") for r in tool_rows] == [None, 1]
    assert [r["after"]["iteration"] for r in tool_rows] == [1, 2]
    assert "repeated" in saved[-1]["tool_calls"][1]["result"]


@pytest.mark.asyncio
async def test_a_new_turn_reads_again(monkeypatch, refuse):
    """The history drops the tool blocks, so the next answer has no result to point at."""
    for _ in range(2):
        replies = [_stream([_call_chunk("k8s_get_resources", PODS)]), _stream([_text_chunk("One pod.")])]
        _payloads, _saved, rows, _sent, executed = await _chat_turn(monkeypatch, replies=replies)
        assert executed == [("k8s_get_resources", PODS)]
        assert "repeat_of" not in _tool_rows(rows)[0]["after"]


@pytest.mark.asyncio
async def test_off_the_chat_runs_both_reads_and_reads_as_before(monkeypatch, never_guarded):
    _payloads, saved, rows, sent, executed = await _chat_turn(monkeypatch, replies=_api_key_replies())
    assert executed == [("k8s_get_resources", PODS)] * 2
    tool_messages = [m["content"] for m in sent[2] if m["role"] == "tool"]
    assert len(tool_messages) == 2 and tool_messages[0] == tool_messages[1]
    assert json.loads(tool_messages[1]) == json.loads(POD_LIST)
    assert [set(r["after"]) for r in _tool_rows(rows)] == [CHAT_ROW_KEYS, CHAT_ROW_KEYS]
    assert "repeated" not in saved[-1]["content"]


# --- the investigator, each loop -----------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_investigation_refuses_the_same_read_in_its_next_step(monkeypatch, refuse):
    service = FakeService([
        completion(calls=[tool_call("c1", "k8s_get_pod_logs", LOGS)]),
        completion(calls=[tool_call("c2", "k8s_get_pod_logs", dict(LOGS))]),
        completion(content="## Summary\nok"),
    ])
    audits = []
    install_loop(monkeypatch, service, audits)
    out = await runner.investigate(cfg(max_steps=5), row())
    assert service.executed == [("k8s_get_pod_logs", LOGS)]
    assert out["tool_calls"][1] == {"tool": "k8s_get_pod_logs", "args": LOGS, "step": 2, "repeat_of": 1}
    told = json.loads(service.completions.calls[2]["messages"][-1]["content"])
    assert told["status"] == "repeated" and told["repeat_of"] == 1 and "of this investigation" in told["message"]
    assert [a["result"] for a in audits] == ["success", "success"]
    assert set(audits[0]["after"]) == INVESTIGATION_ROW_KEYS
    assert audits[1]["after"]["repeat_of"] == 1 and audits[1]["after"]["iteration"] == 2
    assert audits[1]["after"]["access"] is None and audits[1]["after"]["requests"] is None


@pytest.mark.asyncio
async def test_past_the_minute_an_investigation_reads_again(monkeypatch, refuse):
    monkeypatch.setattr(repeats, "REPEAT_SECONDS", 0.0)
    service = FakeService([
        completion(calls=[tool_call("c1", "k8s_get_pod_logs", LOGS)]),
        completion(calls=[tool_call("c2", "k8s_get_pod_logs", dict(LOGS))]),
        completion(content="## Summary\nok"),
    ])
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5), row())
    assert service.executed == [("k8s_get_pod_logs", LOGS)] * 2
    assert all("repeat_of" not in c for c in out["tool_calls"])


@pytest.mark.asyncio
async def test_a_subscription_investigation_refuses_the_same_read(monkeypatch, refuse):
    cc = FakeClaudeCode([("k8s_get_pod_logs", LOGS), ("k8s_get_pod_logs", dict(LOGS))], finish="max_turns", turns=4)
    service = FakeSubscriptionService(cc)
    audits = []
    install_loop(monkeypatch, service, audits)
    out = await runner.investigate(cfg(max_steps=5), row())
    assert service.executed == [("k8s_get_pod_logs", LOGS)]
    assert out["tool_calls"][1]["repeat_of"] == 1 and audits[1]["after"]["repeat_of"] == 1
    closing = cc.completed[0][0][-1]["content"]  # the results Claude Code had, as the closing call reads them
    assert "NAME READY" in closing and '"status": "repeated"' in closing


@pytest.mark.asyncio
async def test_off_an_investigation_runs_both_reads_and_reads_as_before(monkeypatch, never_guarded):
    service = FakeService([
        completion(calls=[tool_call("c1", "k8s_get_pod_logs", LOGS)]),
        completion(calls=[tool_call("c2", "k8s_get_pod_logs", dict(LOGS))]),
        completion(content="## Summary\nok"),
    ])
    audits = []
    install_loop(monkeypatch, service, audits)
    out = await runner.investigate(cfg(max_steps=5), row())
    assert service.executed == [("k8s_get_pod_logs", LOGS)] * 2
    read = len("NAME READY\npod-1 0/1")  # result_chars, which every read that ran has
    assert out["tool_calls"] == [{"tool": "k8s_get_pod_logs", "args": LOGS, "step": 1, "result_chars": read},
                                 {"tool": "k8s_get_pod_logs", "args": LOGS, "step": 2, "result_chars": read}]
    messages = service.completions.calls[0]["messages"]
    assert messages[0]["content"] == inv_prompt.system_prompt(cluster="self", namespace="apps", language="en")
    assert [m["content"] for m in messages if m["role"] == "tool"] == ["NAME READY\npod-1 0/1"] * 2
    assert [set(a["after"]) for a in audits] == [INVESTIGATION_ROW_KEYS, INVESTIGATION_ROW_KEYS]
    assert out["report"] == "## Summary\nok" and out["iterations"] == 3


# --- an investigation with call numbers (any of rules, changesFirst, evidenceCheck, ledger) ------------------------


@pytest.mark.asyncio
async def test_an_investigation_with_call_numbers_names_the_call_it_repeated_by_its_number(monkeypatch, refuse):
    service = FakeService([
        completion(calls=[tool_call("c1", "k8s_get_resources", PODS), tool_call("c2", "k8s_get_pod_logs", LOGS)]),
        completion(calls=[tool_call("c3", "k8s_get_pod_logs", dict(LOGS))]),
        completion(content="## Summary\nok"),
    ])
    audits = []
    install_loop(monkeypatch, service, audits)
    at_now(monkeypatch)
    out = await runner.investigate(cfg(max_steps=5, rules=True), row(starts_at=STARTED))
    assert service.executed == [("k8s_get_resources", PODS), ("k8s_get_pod_logs", LOGS)]
    # step 1 made calls 1 and 2; the repeat at step 2 is call 3, of call 2
    assert out["tool_calls"][2] == {"tool": "k8s_get_pod_logs", "args": LOGS, "step": 2, "repeat_of": 1, "repeat_of_call": 2}
    text = service.completions.calls[2]["messages"][-1]["content"]
    assert text.startswith("[call 3]\n")
    told = json.loads(text.removeprefix("[call 3]\n"))
    assert told["repeat_of_call"] == 2 and "repeat_of" not in told
    assert "as call 2 of this investigation" in told["message"] and "[call 2]" in told["message"] and "step" not in told["message"]
    assert audits[2]["after"]["repeat_of"] == 1 and audits[2]["after"]["repeat_of_call"] == 2  # the row keeps both
    assert "repeat_of_call" not in audits[1]["after"] and "repeat_of" not in audits[1]["after"]


@pytest.mark.asyncio
async def test_a_repeat_of_step_zero_is_a_repeat_of_call_one(monkeypatch, refuse):
    service = ChangesService([completion(calls=[tool_call("c1", "timeline", dict(STEP_ZERO_ARGS))]),
                              completion(content="## Summary\nok")])
    audits = []
    install_loop(monkeypatch, service, audits)
    at_now(monkeypatch)
    out = await runner.investigate(cfg(max_steps=5, changes_first=True), row(starts_at=STARTED))
    assert service.executed == [("timeline", STEP_ZERO_ARGS)]  # read once, by step 0
    assert out["tool_calls"][1]["repeat_of"] == 0 and out["tool_calls"][1]["repeat_of_call"] == 1
    told = json.loads(service.completions.calls[1]["messages"][-1]["content"].removeprefix("[call 2]\n"))
    assert told["repeat_of_call"] == 1 and "(call 1); its answer is in the first message" in told["message"]
    assert audits[1]["after"]["repeat_of"] == 0 and audits[1]["after"]["repeat_of_call"] == 1
