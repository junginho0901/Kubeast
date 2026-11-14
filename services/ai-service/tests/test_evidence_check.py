"""features.alertInvestigation.evidenceCheck (investigation/evidence.py): the report's rca block is held to the run's
tool calls before it is kept; a cause no call shows gets one more model call without tools, then a line under the
report; the block is taken out. Off, the prompt, what the model reads and the report are what they were."""
import json
from datetime import datetime

import pytest

from app.services.investigation import evidence, numbers
from app.services.investigation import rca as rca_block
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import runner
from app.services.investigation.settings import InvestigationSettings, load
from tests.test_alert_investigation import (FakeClaudeCode, FakeService, FakeSubscriptionService, cfg, completion,
                                            install_loop, row, tool_call)

NOW = datetime(2026, 10, 13, 12, 0, 0)  # row()'s alert start
PODS = {"resource_type": "pods", "namespace": "apps"}
POD_TABLE = "NAME READY STATUS\nweb-7d9f4-x2k 0/1 CrashLoopBackOff"


def rca(*causes, no_fault=False):
    block = {"no_fault": no_fault, "causes": list(causes), "path": [], "ruled_out": []}
    return "```rca\n" + json.dumps(block) + "\n```"


def cause(resource, evidence_calls, kind="crash", started_at=None):
    return {"resource": resource, "kind": kind, "started_at": started_at, "evidence": evidence_calls}


WEB_REPORT = "## Summary\nweb crashes."
DB_REPORT = "## Summary\nthe database is down."


# --- the block and the check ---------------------------------------------------------------------------------------


def test_the_switch_is_off_unless_set_to_true(monkeypatch):
    monkeypatch.delenv("ALERT_INVESTIGATION_EVIDENCE_CHECK", raising=False)
    assert InvestigationSettings().evidence_check is False and load().evidence_check is False
    monkeypatch.setenv("ALERT_INVESTIGATION_EVIDENCE_CHECK", "true")
    assert load().evidence_check is True


def test_the_instruction_asks_for_the_block_and_names_the_call_numbers():
    for kind in evidence.KINDS:
        assert kind in evidence.INSTRUCTION
    assert "```rca" in evidence.INSTRUCTION and "[call 3]" in evidence.INSTRUCTION
    assert '"no_fault": true' in evidence.INSTRUCTION and "hypothesis" in evidence.INSTRUCTION
    assert evidence.tag(4, "NAME READY") == "[call 4]\nNAME READY"


def test_split_takes_every_block_out_and_reads_the_last():
    answer = f"{WEB_REPORT}\n\n```rca\n{{\"causes\": []}}\n```\n\nmore\n{rca(no_fault=True)}\n"
    report, block, status = evidence.split(answer)
    assert status == "ok" and block["no_fault"] is True and block["causes"] == []
    assert "```" not in report and report.startswith(WEB_REPORT) and report.endswith("more")


@pytest.mark.parametrize("answer, status", [
    (WEB_REPORT, "missing"),
    (WEB_REPORT + "\n```json\n{\"causes\": []}\n```", "missing"),
    (WEB_REPORT + "\n```rca\nnot json\n```", "invalid"),
    (WEB_REPORT + "\n```rca\n[1, 2]\n```", "invalid"),
    (WEB_REPORT + "\n```rca\n{\"causes\": \"web\"}\n```", "invalid"),
])
def test_a_report_without_a_usable_block(answer, status):
    report, block, got = evidence.split(answer)
    assert (block, got) == (None, status)
    assert report.startswith(WEB_REPORT) and "```rca" not in report


@pytest.mark.parametrize("text, found", [
    ("pod/cart-7d9f4-x2k Running", True), ("cart", True), ("CART is down", True), ("deployment.apps/cart.", True),
    ("mycart", False), ("cartservice", False), ("", False),
])
def test_a_name_counts_only_as_a_whole_name(text, found):
    assert evidence._names(text, "cart") is found


def test_each_cause_is_held_to_calls_of_the_run_that_answered_and_name_it():
    reads = [
        evidence.Read("k8s_get_resources", PODS, text=POD_TABLE),
        evidence.Read("k8s_get_pod_logs", {"pod_name": "db-0"}, failed=True),
        evidence.Read("k8s_get_resources", PODS, same_as=1),  # a refused repeat stands for call 1
    ]
    block = {"causes": [
        cause("Deployment/apps/web", [1]),
        cause("Deployment/apps/web", [3]),
        cause("Deployment/apps/web", ["1"]),
        cause("Service/apps/db", [2, 9, "x"], kind="dependency_down"),
        cause("Deployment/apps/cache", [1], kind="oom"),
        cause("Deployment/apps/web", [], kind="rollout"),
        cause("Deployment/apps/web", [1], kind="rollout", started_at="2026-10-13T12:05:00Z"),
        cause("Deployment/apps/web", [1], kind="rollout", started_at="2026-10-13T12:01:00+00:00"),  # within the rounding
        cause("Pod/apps/x", [], kind="none"),  # kind none is not a cause
    ]}
    checked, problems = evidence.check(block, reads, NOW)
    assert checked == 8
    assert [(p.resource, p.reason) for p in problems] == [
        ("Service/apps/db", "bad_calls"), ("Deployment/apps/cache", "name_missing"),
        ("Deployment/apps/web", "no_evidence"), ("Deployment/apps/web", "after_alert")]
    assert evidence.reason_text(problems[0]) == "calls 2, 9, x are not calls of this investigation that answered"
    assert evidence.reason_text(problems[1]) == "cache does not appear in what calls 1 returned"
    assert evidence.reason_text(problems[3]) == "it starts at 2026-10-13T12:05:00Z, after the alert's start at 2026-10-13T12:00:00Z"
    assert evidence.reason_text(problems[2], "ko") == "근거로 댄 호출이 없음"


def test_no_fault_and_an_alert_without_a_start_check_nothing_of_time():
    reads = [evidence.Read("k8s_get_resources", PODS, text=POD_TABLE)]
    assert evidence.check({"no_fault": True, "causes": []}, reads, NOW) == (0, [])
    late = {"causes": [cause("Deployment/apps/web", [1], started_at="2026-10-13T13:00:00Z")]}
    assert evidence.check(late, reads, None) == (1, [])


def test_the_second_ask_lists_what_failed_and_every_call():
    reads = [evidence.Read("k8s_get_resources", PODS, text=POD_TABLE),
             evidence.Read("k8s_get_pod_logs", {"pod_name": "db-0"}, failed=True),
             evidence.Read("k8s_get_resources", PODS, same_as=1)]
    text = evidence.ask_again("ok", [evidence.Problem("Service/apps/db", "bad_calls", {"calls": [2]})], reads)
    assert "- Service/apps/db: calls 2 are not calls of this investigation that answered" in text
    assert '[call 1] k8s_get_resources {"namespace": "apps", "resource_type": "pods"} — answered' in text
    assert '[call 2] k8s_get_pod_logs {"pod_name": "db-0"} — failed' in text
    assert "[call 3] k8s_get_resources" in text and "— the same read as call 1" in text
    assert "No tools now." in text and "hypothesis" in text
    assert evidence.ask_again("missing", [], reads).startswith("Your report did not end with a valid rca block")


# --- one investigation ---------------------------------------------------------------------------------------------


def _service(*replies, answer=POD_TABLE):
    service = FakeService(list(replies))

    async def execute(name, args, ctx):
        service.executed.append((name, args))
        return answer

    service._execute_function_with_context = execute
    return service


def _reads_pods():
    return completion(calls=[tool_call("c1", "k8s_get_resources", PODS)])


@pytest.mark.asyncio
async def test_a_report_whose_causes_the_calls_show_is_kept_without_its_block(monkeypatch):
    service = _service(_reads_pods(), completion(content=f"{WEB_REPORT}\n\n{rca(cause('Deployment/apps/web', [1], started_at='2026-10-13T11:58:00Z'))}"))
    install_loop(monkeypatch, service, [])
    progress = {}
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True), row(), progress)
    assert out["report"] == WEB_REPORT and out["iterations"] == 2
    assert len(service.completions.calls) == 2  # no second ask
    messages = service.completions.calls[0]["messages"]
    assert messages[0]["content"].endswith(evidence.INSTRUCTION)
    assert [m["content"] for m in messages if m["role"] == "tool"] == [f"[call 1]\n{POD_TABLE}"]
    assert progress["evidence"] == {"block": "ok", "causes": 1, "unsupported": 0, "asked_again": False,
                                    "block_after": "ok", "causes_after": 1, "unverified": 0}


@pytest.mark.asyncio
async def test_a_cause_no_call_shows_is_asked_about_once_without_tools(monkeypatch):
    first = f"{DB_REPORT}\n\n{rca(cause('StatefulSet/apps/db', [1], kind='dependency_down'))}"
    second = f"## Summary\nweb crashes; the database being down is a hypothesis.\n\n{rca(cause('Deployment/apps/web', [1]))}"
    service = _service(_reads_pods(), completion(content=first), completion(content=second))
    install_loop(monkeypatch, service, [])
    progress = {}
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True), row(), progress)
    assert out["report"] == "## Summary\nweb crashes; the database being down is a hypothesis."
    ask = service.completions.calls[2]
    assert "tools" not in ask and ask["messages"][-2] == {"role": "assistant", "content": first}
    assert "- StatefulSet/apps/db: db does not appear in what calls 1 returned" in ask["messages"][-1]["content"]
    assert out["iterations"] == 3 and out["total_tokens"] == 33  # the second ask counts in the run's tokens
    assert progress["evidence"] == {"block": "ok", "causes": 1, "unsupported": 1, "asked_again": True,
                                    "block_after": "ok", "causes_after": 1, "unverified": 0}


@pytest.mark.parametrize("language, head", [
    ("en", "Not verified by the server: no tool result of this investigation shows the causes below, so read them as hypotheses."),
    ("ko", "서버 확인 안 됨: 아래 원인은 이 조사의 도구 결과로 확인되지 않아 가설로 읽어 주세요."),
])
@pytest.mark.asyncio
async def test_what_still_fails_is_listed_under_the_report(monkeypatch, language, head):
    still = f"{DB_REPORT}\n\n{rca(cause('StatefulSet/apps/db', [1], kind='dependency_down'))}"
    service = _service(_reads_pods(), completion(content=still), completion(content=still))
    install_loop(monkeypatch, service, [])
    progress = {}
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True, language=language), row(), progress)
    reason = evidence.reason_text(evidence.Problem("StatefulSet/apps/db", "name_missing", {"name": "db", "calls": [1]}), language)
    assert out["report"] == f"{DB_REPORT}\n\n---\n\n{head}\n- StatefulSet/apps/db: {reason}"
    assert progress["evidence"]["unverified"] == 1 and progress["evidence"]["asked_again"] is True


@pytest.mark.asyncio
async def test_a_report_without_its_block_is_asked_for_again_and_marked_when_it_still_has_none(monkeypatch):
    service = _service(_reads_pods(), completion(content=WEB_REPORT), completion(content="## Summary\nstill no block"))
    install_loop(monkeypatch, service, [])
    progress = {}
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True), row(), progress)
    # the second answer has no block either: the first stands, marked as not checked
    assert out["report"].startswith(WEB_REPORT + "\n\n---\n\n")
    assert out["report"].endswith("the report did not end with a valid rca block, so its causes were not checked against the tool results.")
    assert "did not end with a valid rca block" in service.completions.calls[2]["messages"][-1]["content"]
    assert progress["evidence"] == {"block": "missing", "causes": 0, "unsupported": 0, "asked_again": True,
                                    "block_after": "missing", "causes_after": 0, "unverified": None}


@pytest.mark.asyncio
async def test_a_failed_call_is_no_evidence(monkeypatch):
    first = f"{WEB_REPORT}\n\n{rca(cause('Deployment/apps/web', [1]))}"
    service = _service(_reads_pods(), completion(content=first), completion(content=first),
                       answer=json.dumps({"error": "web-7d9f4-x2k: connection refused"}))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True), row())
    assert out["tool_calls"][0]["error"]
    assert out["report"].endswith("- Deployment/apps/web: calls 1 are not calls of this investigation that answered")


@pytest.mark.asyncio
async def test_a_second_ask_that_fails_leaves_the_first_report_with_the_list(monkeypatch):
    first = f"{DB_REPORT}\n\n{rca(cause('StatefulSet/apps/db', [1], kind='dependency_down'))}"
    service = _service(_reads_pods(), completion(content=first), RuntimeError("provider unavailable"))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True), row())
    assert out["report"].startswith(DB_REPORT + "\n\n---\n\nNot verified by the server")
    assert out["iterations"] == 3


@pytest.mark.asyncio
async def test_a_subscription_investigation_asks_again_through_claude_code(monkeypatch):
    first = f"{DB_REPORT}\n\n{rca(cause('StatefulSet/apps/db', [1], kind='dependency_down'))}"
    fixed = f"{WEB_REPORT}\n\n{rca(cause('Deployment/apps/web', [1]))}"
    cc = FakeClaudeCode([("k8s_get_resources", PODS)], text=first, turns=2, closing=fixed)
    service = FakeSubscriptionService(cc)

    async def execute(name, args, ctx):
        service.executed.append((name, args))
        return POD_TABLE

    service._execute_function_with_context = execute
    install_loop(monkeypatch, service, [])
    progress = {}
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True), row(), progress)
    assert out["report"] == WEB_REPORT and out["iterations"] == 3
    messages, lane = cc.completed[0]
    assert lane == "investigation" and messages[-2] == {"role": "assistant", "content": first}
    assert "StatefulSet/apps/db" in messages[-1]["content"] and messages[0]["content"].endswith(evidence.INSTRUCTION)
    assert progress["evidence"]["asked_again"] is True and progress["evidence"]["unverified"] == 0


@pytest.mark.asyncio
async def test_the_last_step_asks_for_the_block_too(monkeypatch):
    keeps_calling = completion(calls=[tool_call("c", "k8s_get_pod_logs", {"namespace": "apps", "pod_name": "p"})])
    service = _service(keeps_calling, completion(content=f"{WEB_REPORT}\n\n{rca(cause('Deployment/apps/web', [1]))}"))
    install_loop(monkeypatch, service, [])
    await runner.investigate(cfg(max_steps=2, evidence_check=True), row())
    assert service.completions.calls[-1]["messages"][-1]["content"] == inv_prompt.final_step_message() + evidence.FINAL_NOTE


# --- off ---------------------------------------------------------------------------------------------------------


@pytest.fixture
def never_checked(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("the evidence check ran with evidenceCheck off")

    # what the runner calls for the check: the shared block (rca), the numbers and the check's own parts
    for name in ("split", "check", "instruction", "ask_again"):
        monkeypatch.setattr(rca_block, name, boom)
    for name in ("check", "ask_again", "note"):
        monkeypatch.setattr(evidence, name, boom)
    monkeypatch.setattr(numbers, "tag", boom)
    monkeypatch.setattr(runner, "settle", boom)


@pytest.mark.asyncio
async def test_off_the_prompt_the_results_and_the_report_are_as_before(monkeypatch, never_checked):
    answer = f"{WEB_REPORT}\n\n{rca(cause('StatefulSet/apps/db', [7]))}"  # a block the model wrote on its own stays
    keeps_calling = completion(calls=[tool_call("c1", "k8s_get_resources", PODS)])
    service = _service(keeps_calling, completion(content=answer))
    install_loop(monkeypatch, service, [])
    progress = {}
    out = await runner.investigate(cfg(max_steps=2), row(), progress)
    messages = service.completions.calls[0]["messages"]
    assert messages[0]["content"] == inv_prompt.system_prompt(cluster="self", namespace="apps", language="en")
    assert [m["content"] for m in messages if m["role"] == "tool"] == [POD_TABLE]
    assert messages[-1]["content"] == inv_prompt.final_step_message()
    assert out["report"] == answer and out["iterations"] == 2 and len(service.completions.calls) == 2
    assert "evidence" not in progress


@pytest.mark.asyncio
async def test_the_run_row_carries_the_check_only_when_it_ran(monkeypatch):
    audits, finished = [], []
    found = {"block": "ok", "causes": 1, "unsupported": 1, "asked_again": True, "block_after": "ok", "causes_after": 1,
             "unverified": 0}

    def investigate_with(evidence_found):
        async def ok(c, r, progress=None):
            if evidence_found:
                progress["evidence"] = dict(evidence_found)
            return {"report": "## Summary\nok", "tool_calls": [], "iterations": 3}
        return ok

    async def finish(db, inv_id, **f):
        finished.append(f)

    async def audit(**kw):
        audits.append(kw)
        return True

    monkeypatch.setattr(runner.store, "finish", finish)
    monkeypatch.setattr(runner, "write_audit", audit)
    monkeypatch.setattr(runner, "investigate", investigate_with(found))
    await runner.run_one(cfg(evidence_check=True), None, row())
    assert audits[-1]["after"]["evidence"] == found and "evidence" not in finished[-1]
    monkeypatch.setattr(runner, "investigate", investigate_with(None))
    await runner.run_one(cfg(), None, row())
    assert "evidence" not in audits[-1]["after"]
