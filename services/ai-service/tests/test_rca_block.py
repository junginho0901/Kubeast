"""The rca block as one mechanism for features.alertInvestigation.evidenceCheck and ledger (investigation/rca.py):
with both on, the call numbers come once, the block has one instruction and is split once per answer, the model is
asked again at most once with both checks' problems in one message, the row keeps the result, and the report's
"not verified" list and the ledger each say what their own check found."""
import json

import pytest

from app.services.investigation import evidence, ledger, numbers, rca, runner
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import result as inv_result
from tests.test_alert_investigation import cfg, completion, install_loop, row, tool_call
from tests.test_evidence_check import PODS, POD_TABLE, _reads_pods, _service, cause
from tests.test_investigation_ledger import hypothesis
from tests.test_investigation_window import STARTED, ChangesService, at_now, first_message

BOTH = dict(max_steps=5, evidence_check=True, ledger=True)
WEB = "Deployment/apps/web"
DB = "StatefulSet/apps/db"


def block(causes, hypotheses, no_fault=False):
    return "```rca\n" + json.dumps({"no_fault": no_fault, "causes": causes, "path": [], "ruled_out": [],
                                    "hypotheses": hypotheses}) + "\n```"


def web_cause(n=1):
    return cause(WEB, [n])


def web_hypothesis(n=1, **kw):
    return hypothesis(**{"resource": WEB, "for": [n], **kw})


GOOD = "## Summary\nweb crashes.\n\n" + block([web_cause()], [web_hypothesis()])


@pytest.mark.asyncio
async def test_both_on_number_each_result_once_and_ask_for_the_block_once(monkeypatch):
    service = _service(completion(calls=[tool_call("c1", "k8s_get_resources", PODS),
                                         tool_call("c2", "k8s_get_pod_logs", {"name": "web-1", "namespace": "apps"})]),
                       completion(calls=[tool_call("c3", "k8s_get_events", {"namespace": "apps"})]),
                       completion(content=GOOD))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(**{**BOTH, "max_steps": 3}), row())
    messages = service.completions.calls[-1]["messages"]
    results = [m["content"] for m in messages if m["role"] == "tool"]
    assert [r.split("\n")[0] for r in results] == ["[call 1]", "[call 2]", "[call 3]"]
    assert all(r.count("[call ") == 1 for r in results)  # one number each, not one per switch
    system = messages[0]["content"]
    assert system.endswith(rca.instruction(evidence=True, hypotheses=True))
    assert system.count("```rca") == 1 and system.count(numbers.NOTE.strip()) == 1 and system.count('"hypotheses"') == 1
    assert messages[-1]["content"] == inv_prompt.final_step_message() + rca.FINAL_NOTE  # the note once
    assert out["report"] == "## Summary\nweb crashes." and out["iterations"] == 3 and len(service.completions.calls) == 3


@pytest.mark.asyncio
async def test_both_on_split_the_answer_once_and_keep_the_result(monkeypatch):
    splits = []
    real = rca.split

    def counted(answer):
        splits.append(answer)
        return real(answer)

    monkeypatch.setattr(rca, "split", counted)
    service = _service(_reads_pods(), completion(content=GOOD))
    install_loop(monkeypatch, service, [])
    progress = {}
    out = await runner.investigate(cfg(**BOTH), row(), progress)
    assert splits == [GOOD]  # one split, which both checks read
    assert out["report"] == "## Summary\nweb crashes." and "```rca" not in out["report"]
    result = out["result"]
    assert result["status"] == "ok" and result["asked_again"] is False and result["failures"] == []
    assert result["causes"][0]["evidence"] == [{"call": 1, "tool": "k8s_get_resources"}]
    assert [(h["state"], h["closed"]) for h in result["hypotheses"]] == [("cause", True)]
    assert progress["evidence"] == {"block": "ok", "causes": 1, "unsupported": 0, "asked_again": False,
                                    "block_after": "ok", "causes_after": 1, "unverified": 0}
    json.dumps(result)


@pytest.mark.asyncio
async def test_both_checks_problems_go_in_one_second_ask(monkeypatch):
    first = "## Summary\nthe database is down.\n\n" + block([cause(DB, [1], kind="dependency_down")],
                                                            [hypothesis(id="h3", state="maybe", resource=DB)])
    service = _service(_reads_pods(), completion(content=first), completion(content=GOOD))
    install_loop(monkeypatch, service, [])
    progress = {}
    out = await runner.investigate(cfg(**BOTH), row(), progress)
    assert len(service.completions.calls) == 3  # two steps and one second ask, not one per check
    ask = service.completions.calls[2]
    assert "tools" not in ask and ask["messages"][-2] == {"role": "assistant", "content": first}
    text = ask["messages"][-1]["content"]
    assert "- StatefulSet/apps/db: db does not appear in what calls 1 returned" in text  # the evidence check
    assert "- h3 (Image web:1.5 crashes on start): its state is not one of cause, symptom, ruled_out or blocked" in text  # the ledger
    assert "These causes are not a hypothesis of state cause:\n- StatefulSet/apps/db" in text  # both: the cause has no cause hypothesis
    assert text.count("The calls of this investigation:") == 1 and text.endswith("No tools now.")
    assert "leave it out of \"causes\"" in text and "Close every hypothesis" in text
    assert out["iterations"] == 3 and out["total_tokens"] == 33  # the second ask once, counted once
    assert out["report"] == "## Summary\nweb crashes."  # the second answer passed both: no note
    assert out["result"]["asked_again"] is True and out["result"]["failures"] == []
    assert progress["evidence"]["asked_again"] is True and progress["evidence"]["unverified"] == 0
    # the ledger's counts name why it asked: both checks' kinds, as the one second ask carried them
    assert progress["ledger"]["asked_because"] == ["cause_name_missing", "cause_not_in_ledger", "hypothesis_open",
                                                   "hypothesis_bad_calls"]  # h3's "for" names call 2 of a run of one
    assert progress["ledger"]["failures"] == [] and progress["ledger"]["states"]["cause"] == 1


@pytest.mark.asyncio
async def test_what_still_fails_after_the_one_ask_is_listed_under_the_report_and_kept_in_the_ledger(monkeypatch):
    still = "## Summary\nthe database is down.\n\n" + block([cause(DB, [1], kind="dependency_down")],
                                                            [hypothesis(id="h3", state="cause", resource=DB, **{"for": [7]})])
    service = _service(_reads_pods(), completion(content=still), completion(content=still))
    install_loop(monkeypatch, service, [])
    progress = {}
    out = await runner.investigate(cfg(**BOTH, language="ko"), row(), progress)
    assert len(service.completions.calls) == 3  # asked once, not again
    reason = evidence.reason_text(evidence.Problem(DB, "name_missing", {"name": "db", "calls": [1]}), "ko")
    assert out["report"] == ("## Summary\nthe database is down.\n\n---\n\n"
                             "서버 확인 안 됨: 아래 원인은 이 조사의 도구 결과로 확인되지 않아 가설로 읽어 주세요.\n"
                             f"- {DB}: {reason}")  # the evidence check's list: its cause only
    (h,) = out["result"]["hypotheses"]
    assert h["closed"] is False and h["problems"] == [{"reason": "no_evidence", "side": "for"}, {"reason": "bad_calls", "calls": ["7"]}]
    assert [f["kind"] for f in out["result"]["failures"]] == ["cause_name_missing", "hypothesis_no_evidence", "hypothesis_bad_calls"]
    assert all(f["kind"] in rca.FAILURES for f in out["result"]["failures"])
    assert progress["evidence"]["unverified"] == 1 and out["result"]["asked_again"] is True


@pytest.mark.asyncio
async def test_a_second_answer_without_a_block_keeps_the_first_with_both_marks(monkeypatch):
    service = _service(_reads_pods(), completion(content="## Summary\nno block"), completion(content="## Summary\nstill none"))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(**BOTH), row())
    assert len(service.completions.calls) == 3
    assert service.completions.calls[2]["messages"][-1]["content"].startswith("Your report did not end with a valid rca block")
    assert out["report"].startswith("## Summary\nno block\n\n---\n\n")
    assert out["report"].endswith("so its causes were not checked against the tool results.")
    assert out["result"]["status"] == "missing" and out["result"]["failures"] == [{"kind": "block_missing"}]


@pytest.mark.asyncio
async def test_a_failed_second_ask_keeps_the_first_report_once(monkeypatch):
    first = "## Summary\nfirst\n\n" + block([web_cause()], [web_hypothesis(state="open")])
    service = _service(_reads_pods(), completion(content=first), RuntimeError("provider unavailable"))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(**BOTH), row())
    assert out["report"] == "## Summary\nfirst"  # the causes passed the evidence check: no note
    assert out["result"]["ask_failed"] is True and out["result"]["asked_again"] is True and out["iterations"] == 3
    # an open hypothesis is not a cause hypothesis, so the cause has none either
    assert [f["kind"] for f in out["result"]["failures"]] == ["cause_not_in_ledger", "hypothesis_open"]


@pytest.mark.asyncio
async def test_step_zero_is_call_one_for_both_checks(monkeypatch):
    service = ChangesService([completion(content="## Summary\nThe image changed.\n" + block([web_cause()], [web_hypothesis()]))])
    install_loop(monkeypatch, service, [])
    at_now(monkeypatch)
    out = await runner.investigate(cfg(**BOTH, changes_first=True), row(starts_at=STARTED))
    assert "<<<CHANGES\n[call 1]\n" in first_message(service)
    assert len(service.completions.calls) == 1  # the cause names web, which step 0's answer holds: nothing asked
    assert out["result"]["causes"][0]["evidence"] == [{"call": 1, "tool": "timeline"}] and out["result"]["failures"] == []


@pytest.mark.asyncio
async def test_a_refused_repeat_stands_for_the_call_it_repeated_in_both_checks(monkeypatch):
    monkeypatch.setenv("AI_REFUSE_REPEATED_READS", "true")
    answer = "## Summary\nweb crashes.\n\n" + block([web_cause(2)], [web_hypothesis(2)])
    service = _service(_reads_pods(), completion(calls=[tool_call("c2", "k8s_get_resources", dict(PODS))]),
                       completion(content=answer))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(**BOTH), row())
    assert service.executed == [("k8s_get_resources", PODS)] and out["tool_calls"][1]["repeat_of"] == 1
    assert len(service.completions.calls) == 3  # call 2 shows web through call 1's answer; the ledger counts it as answered
    assert out["result"]["failures"] == [] and out["result"]["hypotheses"][0]["closed"] is True
    log = [{"tool": "k8s_get_resources", "args": PODS}, {"tool": "k8s_get_resources", "args": PODS}]
    assert rca.calls_text(rca.rows(log, {2: 1})).endswith("— the same read as call 1")


@pytest.mark.asyncio
async def test_each_switch_alone_stores_the_result_and_asks_only_its_own(monkeypatch):
    first = "## Summary\nfirst\n\n" + block([cause(DB, [1], kind="dependency_down")], [web_hypothesis(state="open")])
    for on, kinds in (({"evidence_check": True}, ["cause_name_missing"]), ({"ledger": True}, ["hypothesis_open"])):
        service = _service(_reads_pods(), completion(content=first), completion(content=first))
        install_loop(monkeypatch, service, [])
        out = await runner.investigate(cfg(max_steps=5, **on), row())
        text = service.completions.calls[2]["messages"][-1]["content"]
        assert ("StatefulSet/apps/db" in text) is ("evidence_check" in on) and ("- h1 (" in text) is ("ledger" in on)
        assert "not a hypothesis of state cause" not in text  # the cross check needs both
        assert [f["kind"] for f in out["result"]["failures"]] == kinds
        assert (out["result"]["hypotheses"] == []) is ("evidence_check" in on)  # without the ledger no hypotheses are read


def test_one_list_of_failure_kinds_and_one_block_shape():
    assert {f"cause_{r}" for r in evidence._REASONS["en"]} <= set(rca.FAILURES)
    assert set(evidence._REASONS["en"]) == set(evidence._REASONS["ko"])
    assert {f"hypothesis_{r}" for r in ledger._REASONS} <= set(rca.FAILURES)
    assert {"block_missing", "block_invalid", "cause_not_in_ledger", "no_hypotheses"} <= set(rca.FAILURES)
    assert len(rca.FAILURES) == len(set(rca.FAILURES))
    assert evidence.KINDS is rca.KINDS and evidence.split is rca.split and inv_result.split is rca.split
    assert evidence.INSTRUCTION == rca.instruction(evidence=True, hypotheses=False)
    assert ledger.INSTRUCTION == rca.instruction(evidence=False, hypotheses=True)
    both = rca.instruction(evidence=True, hypotheses=True)
    assert both.startswith(numbers.NOTE) and '"hypotheses"' in both and "is a hypothesis" in both
    assert "hypothesis of state cause about the same object" in both
    for kind in rca.KINDS:
        assert kind in both
    assert rca.split("x\n```rca\n{\"causes\": \"web\"}\n```") == ("x", None, "invalid")  # the strict reading, for both


def test_a_cause_matches_a_cause_hypothesis_by_its_objects_name():
    hyps = ledger.check({"hypotheses": [web_hypothesis(resource="deployment/apps/web"),
                                        hypothesis(id="h2", resource="Pod/apps/db-0", state="symptom")]},
                        [{"tool": "k8s_get_resources"}])
    block_ = {"causes": [cause(WEB, [1]), cause("Pod/apps/db-0", [1]), cause("Pod/apps/x", [], kind="none")]}
    assert rca.not_in_ledger(block_, hyps) == ["Pod/apps/db-0"]  # a symptom is not a cause; kind none is not a cause
