"""An investigation's structured result (the rca block the server takes out and keeps) and its hypothesis ledger,
behind features.alertInvestigation.ledger."""

import json
from types import SimpleNamespace

import pytest

from app.api_investigations import detail_of
from app.services.investigation import ledger as inv_ledger
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import result as inv_result
from app.services.investigation import runner
from app.services.investigation import settings as inv_settings
from tests.test_alert_investigation import (
    NOW,
    FakeClaudeCode,
    FakeService,
    FakeSubscriptionService,
    cfg,
    completion,
    install_loop,
    row,
    tool_call,
)
from tests.test_investigation_window import STARTED, ChangesService, at_now, step_zero_reads

LOG = [
    {"tool": "timeline", "args": {"view": "changes"}, "step": 0, "result_chars": 40},
    {"tool": "k8s_get_pod_logs", "args": {"name": "web-1"}, "step": 1, "result_chars": 900},
    {"tool": "traces_search", "args": {}, "step": 1, "error": "not offered"},
]


def block_text(obj) -> str:
    return "```rca\n" + json.dumps(obj) + "\n```"


def hypothesis(**kw):
    base = {"id": "h1", "statement": "Image web:1.5 crashes on start", "resource": "Deployment/apps/web", "state": "cause",
            "for": [1, 2], "against": []}
    base.update(kw)
    return base


CLOSED = {"no_fault": False,
          "causes": [{"resource": "Deployment/apps/web", "kind": "Rollout", "started_at": "2026-10-13T11:41:00Z", "evidence": [1]}],
          "path": ["Deployment/apps/web", "Pod/apps/web-1"], "ruled_out": ["Node/kind-worker"],
          "hypotheses": [hypothesis(), hypothesis(id="h2", statement="The node is out of memory", resource="Node/kind-worker",
                                                  state="ruled_out", **{"for": [], "against": [2]})]}


# --- the block ------------------------------------------------------------------------------------------------------

def test_split_takes_the_block_at_the_end_out_of_the_report():
    earlier = block_text({"no_fault": True})
    answer = "## Summary\nweb crashed.\n\n" + earlier + "\n\n" + block_text(CLOSED)
    report, block, status = inv_result.split(answer)
    assert report == "## Summary\nweb crashed.\n\n" + earlier and status == "ok" and block == CLOSED


@pytest.mark.parametrize("answer,status", [
    ("## Summary\nno block", "missing"),
    ("## Summary\n```rca\n{not json\n```", "invalid"),
    ("## Summary\n```rca\n[1, 2]\n```", "invalid"),
])
def test_split_says_when_there_is_no_block_it_can_read(answer, status):
    report, block, got = inv_result.split(answer)
    assert block is None and got == status and report.startswith("## Summary") and "```rca" not in report


def test_call_numbers_name_calls_of_this_run_with_their_tools():
    found, bad = inv_result.calls([1, "#2", "3", 3, 0, 4, True, "two", None], LOG)
    assert found == [{"call": 1, "tool": "timeline"}, {"call": 2, "tool": "k8s_get_pod_logs"},
                     {"call": 3, "tool": "traces_search", "failed": True}]  # a repeat is listed once
    assert bad == [0, 4, True, "two", None]
    assert inv_result.calls("1, 2", LOG) == ([], [])  # not a list


def test_the_stored_result_has_one_shape_whatever_the_model_wrote():
    out = inv_result.shape(CLOSED, "ok", LOG, [], asked_again=True)
    assert out == {
        "version": 1, "status": "ok", "no_fault": False,
        "causes": [{"resource": "Deployment/apps/web", "kind": "rollout", "started_at": "2026-10-13T11:41:00Z",
                    "evidence": [{"call": 1, "tool": "timeline"}], "raw_evidence": [1]}],
        "path": ["Deployment/apps/web", "Pod/apps/web-1"], "ruled_out": ["Node/kind-worker"], "hypotheses": [],
        "asked_again": True,
    }
    assert "ask_failed" not in out
    assert inv_result.shape(None, "missing", LOG, [])["causes"] == []
    odd = inv_result.shape({"no_fault": "yes", "causes": "web", "path": [1, "", "x" * 400] * 10, "ruled_out": None}, "ok", LOG, [],
                           ask_failed=True)
    assert odd["no_fault"] is None and odd["causes"] == [] and odd["ruled_out"] == [] and odd["ask_failed"] is True
    assert len(odd["path"]) <= inv_result.MAX_PATH and all(len(p) <= inv_result.MAX_TEXT for p in odd["path"])
    many = inv_result.shape({"causes": [{"resource": f"Pod/apps/p{i}", "evidence": list(range(1, 40))} for i in range(30)]}, "ok", LOG, [])
    assert len(many["causes"]) == inv_result.MAX_CAUSES and len(many["causes"][0]["evidence"]) == 3
    assert many["causes"][0]["raw_evidence"] == list(range(1, inv_result.MAX_CALLS + 1))  # as given, the bad ones too


# --- the ledger -----------------------------------------------------------------------------------------------------

def test_closed_hypotheses_keep_their_calls_and_close():
    hyps = inv_ledger.check(CLOSED, LOG)
    assert [h["state"] for h in hyps] == ["cause", "ruled_out"] and all(h["closed"] for h in hyps)
    assert hyps[0]["for"] == [{"call": 1, "tool": "timeline"}, {"call": 2, "tool": "k8s_get_pod_logs"}]
    assert hyps[1]["against"] == [{"call": 2, "tool": "k8s_get_pod_logs"}] and "problems" not in hyps[1]
    assert not inv_ledger.needs_asking("ok", CLOSED, hyps)


@pytest.mark.parametrize("h,problems", [
    (hypothesis(state="maybe"), [{"reason": "open"}]),
    (hypothesis(state=None), [{"reason": "open"}]),
    (hypothesis(**{"for": []}), [{"reason": "no_evidence", "side": "for"}]),
    (hypothesis(state="symptom", **{"for": [3]}), [{"reason": "no_evidence", "side": "for"}]),  # a failed call shows nothing
    (hypothesis(state="ruled_out", **{"for": [1], "against": []}), [{"reason": "no_evidence", "side": "against"}]),
    (hypothesis(state="blocked", **{"for": [3]}), [{"reason": "no_reason"}]),
    (hypothesis(**{"for": [1, 9]}), [{"reason": "bad_calls", "calls": ["9"]}]),
])
def test_a_hypothesis_closes_only_with_what_its_state_needs(h, problems):
    (got,) = inv_ledger.check({"hypotheses": [h]}, LOG)
    assert got["closed"] is False and got["problems"] == problems
    assert inv_ledger.needs_asking("ok", {"hypotheses": [h]}, [got])


def test_a_blocked_hypothesis_closes_with_its_reason_and_may_give_the_refused_call():
    (got,) = inv_ledger.check({"hypotheses": [hypothesis(state="Blocked", blocked="traces_search is not offered", **{"for": [3]})]}, LOG)
    assert got["closed"] and got["state"] == "blocked" and got["blocked"] == "traces_search is not offered"
    assert got["for"] == [{"call": 3, "tool": "traces_search", "failed": True}]
    (cause,) = inv_ledger.check({"hypotheses": [hypothesis(blocked="ignored for a cause")]}, LOG)
    assert "blocked" not in cause


def test_the_ledger_reads_states_loosely_and_keeps_at_most_twelve():
    hyps = inv_ledger.check({"hypotheses": [hypothesis(state="Ruled out", id="", **{"against": [2]}), "not an object"]
                                          + [hypothesis()] * 20}, LOG)
    assert hyps[0]["state"] == "ruled_out" and hyps[0]["id"] == "h1" and hyps[0]["closed"]
    assert len(hyps) == inv_ledger.MAX_HYPOTHESES - 1  # twelve read, one of them not an object
    assert inv_ledger.check(None, LOG) == [] and inv_ledger.check({"hypotheses": "h1"}, LOG) == []


def test_asking_again_follows_the_block():
    assert inv_ledger.needs_asking("missing", None, [])
    assert inv_ledger.needs_asking("ok", {"no_fault": False}, [])  # a fault with no hypothesis weighed
    assert not inv_ledger.needs_asking("ok", {"no_fault": True}, [])


def test_the_second_ask_names_what_is_open_and_every_call():
    hyps = inv_ledger.check({"hypotheses": [hypothesis(id="h7", state="open"), hypothesis(id="h8", **{"for": [9]})]}, LOG)
    text = inv_ledger.ask_again("ok", {}, hyps, LOG)
    assert "- h7 (Image web:1.5 crashes on start): its state is not one of cause, symptom, ruled_out or blocked" in text
    assert '- h8 (Image web:1.5 crashes on start): no call that answered is given under "for"; 9 name no call' in text
    assert '[call 1] timeline {"view": "changes"} — answered' in text and "[call 3] traces_search {} — failed" in text
    assert text.endswith("No tools now.")
    assert inv_ledger.ask_again("missing", None, [], []).startswith("Your report did not end with a valid rca block")
    assert "(none)" in inv_ledger.ask_again("missing", None, [], [])


# --- the switch -----------------------------------------------------------------------------------------------------

def test_the_switch_is_off_unless_set(monkeypatch):
    monkeypatch.delenv("ALERT_INVESTIGATION_LEDGER", raising=False)
    assert inv_settings.load().ledger is False and inv_settings.InvestigationSettings().ledger is False
    monkeypatch.setenv("ALERT_INVESTIGATION_LEDGER", "true")
    assert inv_settings.load().ledger is True


@pytest.mark.asyncio
async def test_with_the_switch_off_the_run_reads_as_before(monkeypatch):
    answer = "## Summary\nCrash looping.\n\n" + block_text(CLOSED)  # a block the model wrote on its own stays
    service = FakeService([completion(calls=[tool_call("c1", "k8s_get_resources", {"resource_type": "pods", "namespace": "apps"})]),
                           completion(content=answer)])
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5), row())
    messages = service.completions.calls[0]["messages"]
    assert messages[0]["content"] == inv_prompt.system_prompt(cluster="self", namespace="apps", language="en")
    assert "rca" not in messages[0]["content"]
    tool_results = [m["content"] for m in messages if m["role"] == "tool"]
    assert len(tool_results) == 1 and not tool_results[0].startswith("[call")  # no call number
    assert out["report"] == answer and "result" not in out and out["iterations"] == 2
    assert len(service.completions.calls) == 2


@pytest.mark.asyncio
async def test_the_last_step_asks_for_the_block_only_with_the_switch(monkeypatch):
    one_call = {**CLOSED, "hypotheses": [hypothesis(**{"for": [1]})]}
    for on in (False, True):
        service = FakeService([completion(calls=[tool_call("c1", "k8s_get_resources", {"resource_type": "pods"})]),
                               completion(content="## Summary\nx\n" + block_text(one_call))])
        install_loop(monkeypatch, service, [])
        await runner.investigate(cfg(max_steps=2, ledger=on), row())
        final = service.completions.calls[1]["messages"][-1]["content"]
        assert final == inv_prompt.final_step_message(False) + (" End it with the rca block." if on else "")
        assert len(service.completions.calls) == 2  # a closed ledger is not asked again


# --- the run with the ledger ----------------------------------------------------------------------------------------

def reads_logs_then(*answers):
    return [completion(calls=[tool_call("c1", "k8s_get_resources", {"resource_type": "pods", "namespace": "apps"}),
                              tool_call("c2", "k8s_get_pod_logs", {"name": "web-1", "namespace": "apps"})])] + [
        completion(content=a) for a in answers]


@pytest.mark.asyncio
async def test_a_closed_ledger_is_kept_as_the_result_and_taken_out_of_the_report(monkeypatch):
    service = FakeService(reads_logs_then("## Summary\nThe image changed.\n\n" + block_text(CLOSED)))
    audits = []
    install_loop(monkeypatch, service, audits)
    out = await runner.investigate(cfg(max_steps=5, ledger=True), row())
    messages = service.completions.calls[0]["messages"]
    assert messages[0]["content"].endswith(inv_ledger.INSTRUCTION)
    assert [m["content"].split("\n")[0] for m in messages if m["role"] == "tool"] == ["[call 1]", "[call 2]"]
    assert out["report"] == "## Summary\nThe image changed."
    assert len(service.completions.calls) == 2 and out["iterations"] == 2  # nothing asked again
    result = out["result"]
    assert result["status"] == "ok" and result["asked_again"] is False and result["no_fault"] is False
    assert result["causes"][0]["evidence"] == [{"call": 1, "tool": "k8s_get_resources"}]
    assert [(h["id"], h["state"], h["closed"]) for h in result["hypotheses"]] == [("h1", "cause", True), ("h2", "ruled_out", True)]
    assert result["hypotheses"][0]["for"] == [{"call": 1, "tool": "k8s_get_resources"}, {"call": 2, "tool": "k8s_get_pod_logs"}]
    json.dumps(result)  # the row keeps it as JSON
    assert [a["action"] for a in audits] == ["ai.tool.call", "ai.tool.call"]  # the second ask reads nothing


@pytest.mark.asyncio
async def test_an_open_hypothesis_is_asked_once_more_without_tools(monkeypatch):
    open_block = {**CLOSED, "hypotheses": [hypothesis(id="h3", state="open", **{"for": []})]}
    service = FakeService(reads_logs_then("## Summary\nfirst\n" + block_text(open_block),
                                          "## Summary\nsecond\n" + block_text(CLOSED)))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, ledger=True), row())
    assert len(service.completions.calls) == 3
    again = service.completions.calls[2]
    assert "tools" not in again and "tool_choice" not in again
    assert again["messages"][-2] == {"role": "assistant", "content": "## Summary\nfirst\n" + block_text(open_block)}
    assert "- h3 (Image web:1.5 crashes on start): its state is not one of" in again["messages"][-1]["content"]
    assert out["report"] == "## Summary\nsecond" and out["iterations"] == 3
    assert out["result"]["asked_again"] is True and all(h["closed"] for h in out["result"]["hypotheses"])
    assert out["total_tokens"] == 33  # three model calls of 11


@pytest.mark.asyncio
async def test_what_is_still_open_after_the_second_ask_stays_marked(monkeypatch):
    open_block = {**CLOSED, "hypotheses": [hypothesis(id="h3", state="symptom", **{"for": [7]})]}
    service = FakeService(reads_logs_then("## Summary\nfirst\n" + block_text(open_block),
                                          "## Summary\nsecond\n" + block_text(open_block)))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, ledger=True), row())
    assert len(service.completions.calls) == 3  # asked once, not again
    (h,) = out["result"]["hypotheses"]
    assert h["closed"] is False and h["problems"] == [{"reason": "no_evidence", "side": "for"}, {"reason": "bad_calls", "calls": ["7"]}]
    assert out["report"] == "## Summary\nsecond"


@pytest.mark.asyncio
async def test_a_second_answer_without_a_block_keeps_the_first_report(monkeypatch):
    service = FakeService(reads_logs_then("## Summary\nno block at all", "## Summary\nstill none"))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, ledger=True), row())
    assert out["report"] == "## Summary\nno block at all"
    assert out["result"]["status"] == "missing" and out["result"]["hypotheses"] == [] and out["result"]["asked_again"] is True
    assert service.completions.calls[2]["messages"][-1]["content"].startswith("Your report did not end with a valid rca block")


@pytest.mark.asyncio
async def test_a_second_ask_that_fails_keeps_the_first_report(monkeypatch):
    open_block = {**CLOSED, "hypotheses": []}
    service = FakeService(reads_logs_then("## Summary\nfirst\n" + block_text(open_block)) + [RuntimeError("provider down")])
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, ledger=True), row())
    assert out["report"] == "## Summary\nfirst"
    assert out["result"]["asked_again"] is True and out["result"]["ask_failed"] is True and out["result"]["status"] == "ok"


@pytest.mark.asyncio
async def test_step_zero_is_call_one_of_the_ledger(monkeypatch):
    one_call = {**CLOSED, "hypotheses": [hypothesis(**{"for": [1]})]}
    service = ChangesService([completion(content="## Summary\nThe image changed.\n" + block_text(one_call))])
    install_loop(monkeypatch, service, [])
    at_now(monkeypatch)
    out = await runner.investigate(cfg(max_steps=5, changes_first=True, ledger=True), row(starts_at=STARTED))
    assert step_zero_reads(service)[1][0].startswith("[call 1]\n")
    assert out["result"]["causes"][0]["evidence"] == [{"call": 1, "tool": "timeline"}]
    assert out["result"]["hypotheses"][0]["for"] == [{"call": 1, "tool": "timeline"}] and out["result"]["asked_again"] is False
    assert out["tool_calls"][0]["step"] == 0 and len(service.completions.calls) == 1


@pytest.mark.asyncio
async def test_the_ledger_runs_on_a_claude_subscription(monkeypatch):
    open_block = {**CLOSED, "hypotheses": [hypothesis(state="open")]}
    cc = FakeClaudeCode([("k8s_get_resources", {"resource_type": "pods", "namespace": "apps"}),
                         ("k8s_get_pod_logs", {"name": "web-1", "namespace": "apps"})],
                        text="## Summary\nfirst\n" + block_text(open_block), turns=3,
                        closing="## Summary\nsecond\n" + block_text(CLOSED))
    service = FakeSubscriptionService(cc)
    seen = []
    run = service._execute_function_with_context

    async def execute(name, args, ctx):
        seen.append(name)
        return await run(name, args, ctx)

    service._execute_function_with_context = execute
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, ledger=True), row())
    assert seen == ["k8s_get_resources", "k8s_get_pod_logs"]
    (messages, lane), = cc.completed  # the second ask, through complete(): no tools
    assert lane == "investigation" and messages[-1]["role"] == "user" and "No tools now." in messages[-1]["content"]
    assert messages[0]["content"].endswith(inv_ledger.INSTRUCTION)
    assert out["report"] == "## Summary\nsecond" and out["result"]["asked_again"] is True
    assert out["total_tokens"] == 47  # the turn's 35 and the second ask's 12
    assert out["iterations"] == 4


# --- the run's audit row --------------------------------------------------------------------------------------------

# what ai.investigation.run's after held before the v0.7.9 switches
RUN_ROW_KEYS = {"investigation_id", "alertname", "severity", "status", "provider", "model", "prompt_tokens",
                "completion_tokens", "total_tokens", "tool_calls", "iterations", "duration_ms", "summary", "link",
                "requested_by"}
NO_STATES = {"cause": 0, "symptom": 0, "ruled_out": 0, "blocked": 0, "open": 0}


async def run_row(monkeypatch, answers, **on):
    audits = []

    async def finish(db, inv_id, **f):
        pass

    monkeypatch.setattr(runner.store, "finish", finish)
    install_loop(monkeypatch, FakeService(answers), audits)
    assert await runner.run_one(cfg(max_steps=5, **on), None, row()) == "done"
    (run,) = [a for a in audits if a["action"] == "ai.investigation.run"]
    json.dumps(run["after"])  # the audit row keeps it as JSON
    return run["after"]


@pytest.mark.asyncio
async def test_the_run_row_counts_the_ledger_with_the_switch_and_holds_no_text(monkeypatch):
    open_block = {**CLOSED, "hypotheses": [hypothesis(id="h3", state="open", **{"for": []})]}
    after = await run_row(monkeypatch, reads_logs_then("## Summary\nfirst\n" + block_text(open_block),
                                                       "## Summary\nsecond\n" + block_text(CLOSED)), ledger=True)
    assert set(after) == RUN_ROW_KEYS | {"ledger"}  # the ledger alone: no evidence counts
    assert after["ledger"] == {"hypotheses": 2, "states": {**NO_STATES, "cause": 1, "ruled_out": 1}, "not_closed": 0,
                               "asked_again": True, "asked_because": ["hypothesis_open"], "ask_failed": False,
                               "failures": []}
    kept = json.dumps(after["ledger"])
    for model_text in ("h1", "h3", "Image web", "Deployment/apps/web", "Node/kind-worker", "first", "second"):
        assert model_text not in kept


@pytest.mark.asyncio
async def test_the_run_row_says_what_is_still_wrong_and_a_second_ask_that_failed(monkeypatch):
    still = {**CLOSED, "hypotheses": [hypothesis(id="h3", state="symptom", **{"for": [7]}), hypothesis(id="h4", state="maybe")]}
    after = await run_row(monkeypatch, reads_logs_then("## Summary\nfirst\n" + block_text(still),
                                                       "## Summary\nsecond\n" + block_text(still)), ledger=True)
    assert after["ledger"] == {"hypotheses": 2, "states": {**NO_STATES, "symptom": 1, "open": 1}, "not_closed": 2,
                               "asked_again": True, "asked_because": ["hypothesis_open", "hypothesis_no_evidence", "hypothesis_bad_calls"],
                               "ask_failed": False, "failures": ["hypothesis_open", "hypothesis_no_evidence", "hypothesis_bad_calls"]}
    none = {**CLOSED, "hypotheses": []}
    after = await run_row(monkeypatch, reads_logs_then("## Summary\nfirst\n" + block_text(none)) + [RuntimeError("provider down")],
                          ledger=True)
    assert after["ledger"] == {"hypotheses": 0, "states": NO_STATES, "not_closed": 0, "asked_again": True,
                               "asked_because": ["no_hypotheses"], "ask_failed": True, "failures": ["no_hypotheses"]}
    after = await run_row(monkeypatch, reads_logs_then("## Summary\nno block"), ledger=True)
    assert after["ledger"]["asked_because"] == ["block_missing"] and after["ledger"]["hypotheses"] == 0


@pytest.mark.asyncio
async def test_without_the_ledger_the_run_row_is_as_before(monkeypatch):
    after = await run_row(monkeypatch, reads_logs_then("## Summary\nok"))
    assert set(after) == RUN_ROW_KEYS
    answer = "## Summary\nok\n" + block_text(CLOSED)
    after = await run_row(monkeypatch, reads_logs_then(answer, answer), evidence_check=True)
    assert set(after) == RUN_ROW_KEYS | {"evidence"}  # evidenceCheck's own counts, not the ledger's


# --- what the API and the MCP read return ---------------------------------------------------------------------------

def stored(**kw):
    base = dict(id="inv-1", cluster="self", fingerprint="fp1", alertname="A", severity="critical", namespace="apps", status="done",
                skip_reason="", received_at=NOW, started_at=NOW, finished_at=NOW, repeat_count=1, last_seen_at=NOW, requested_by="",
                model="m", total_tokens=1, iterations=1, tool_calls=[], labels={}, annotations={}, starts_at=None, generator_url="",
                alertmanager_url="", provider="p", prompt_tokens=1, completion_tokens=0, report="## Summary", error="")
    base.update(kw)
    return SimpleNamespace(**base)


def test_the_detail_returns_the_result_only_when_the_row_has_one():
    assert "result" not in detail_of(stored(result=None))
    assert "result" not in detail_of(stored())  # a row read before the column
    kept = inv_result.shape(CLOSED, "ok", LOG, inv_ledger.check(CLOSED, LOG))
    assert detail_of(stored(result=kept))["result"] == kept
