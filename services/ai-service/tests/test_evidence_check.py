"""features.alertInvestigation.evidenceCheck (investigation/evidence.py): the report's rca block is held to the run's
tool calls before it is kept; a cause no call shows gets one more model call without tools, then a line under the
report; the block is taken out. Off, the prompt, what the model reads and the report are what they were."""
import json
from datetime import datetime

import pytest

from app.services.investigation import answers, evidence, numbers, verdict
from app.services.investigation import rca as rca_block
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import result as inv_result
from app.services.investigation import runner
from app.services.investigation.settings import InvestigationSettings, load
from tests.test_alert_investigation import (FakeClaudeCode, FakeService, FakeSubscriptionService, cfg, completion,
                                            install_loop, row, tool_call)
from tests.test_tool_results_json import RESULTS_END, RESULTS_HEAD

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


def test_split_reads_only_the_block_at_the_very_end():
    quoted = "```rca\n{\"causes\": [{\"resource\": \"Deployment/apps/other\", \"kind\": \"crash\"}]}\n```"
    answer = f"{WEB_REPORT}\n\n{quoted}\n\nmore\n{rca(no_fault=True)}\n  \n"
    report, block, status = evidence.split(answer)
    assert status == "ok" and block["no_fault"] is True and block["causes"] == []
    assert report == f"{WEB_REPORT}\n\n{quoted}\n\nmore"  # an rca fence before the end stays in the report
    # a quoted rca block after the block is no block at the end: asked for again, and no rca block stays in the report
    after = f"{WEB_REPORT}\n{rca(no_fault=True)}\n\nThe quoted text: {quoted}\nend"
    assert evidence.split(after) == (f"{WEB_REPORT}\n\n\nThe quoted text:\n\nend", None, "missing")
    # with the provider stopped at the length it is cut, again with no rca block left
    assert evidence.split(after, "length") == (f"{WEB_REPORT}\n\n\nThe quoted text:\n\nend", None, "cut")


def test_closing_words_after_the_only_block_stay_in_the_report():
    answer = f"{WEB_REPORT}\n\n{rca(no_fault=True)}\n\nLet me know if you want me to dig further."
    report, block, status = evidence.split(answer)
    assert status == "ok" and block["no_fault"] is True
    assert report == f"{WEB_REPORT}\n\nLet me know if you want me to dig further."
    # the words cut at the length: the block is whole, so it is read
    report, block, status = evidence.split(f"{WEB_REPORT}\n\n{rca(no_fault=True)}\n\nAlso note that the", "length")
    assert (status, report) == ("ok", f"{WEB_REPORT}\n\nAlso note that the") and block is not None
    # a fence after the block (a command to run) is no block at the end, and the block leaves the report
    fenced = f"{WEB_REPORT}\n\n{rca(no_fault=True)}\n\nRun:\n```bash\nkubectl get pods\n```"
    report, block, status = evidence.split(fenced)
    assert (block, status) == (None, "missing") and "```rca" not in report and report.endswith("```bash\nkubectl get pods\n```")
    # three backticks inside the JSON on its own line do not end the block
    inside = WEB_REPORT + '\n```rca\n{"causes": [], "ruled_out": ["log said ```oops```"]}\n```'
    assert evidence.split(inside)[1:] == ({"causes": [], "ruled_out": ["log said ```oops```"]}, "ok")
    # nor do they leave a JSON tail when a fence after the block makes it missing: only that block leaves the report
    tail = (WEB_REPORT + '\n\n```rca\n{"causes": [], "hypotheses": [{"statement": "panic``` at start"}]}\n```\n\n'
            "Run:\n```bash\nkubectl rollout undo\n```")
    assert evidence.split(tail) == (WEB_REPORT + "\n\nRun:\n```bash\nkubectl rollout undo\n```", None, "missing")


@pytest.mark.parametrize("close", ["```json", "````", "```  "])
def test_a_closing_line_of_backticks_or_a_language_name_goes_with_the_block(close):
    report, block, status = evidence.split(f"{WEB_REPORT}\n\n```rca\n{{\"causes\": []}}\n{close}\n")
    assert (report, block, status) == (WEB_REPORT, {"causes": []}, "ok")


def test_an_rca_fence_with_no_json_in_it_is_a_quoted_one_and_its_text_stays():
    quoted = f"{WEB_REPORT}\nlog line: ```rca\nsomething\n## Evidence\n```\nkubectl get pods\n```\n## Next steps\nrestart"
    assert evidence.split(quoted) == (quoted, None, "missing")  # the code block's fence does not make it a block
    # words that are not JSON at all after an rca line: a fence quoted from a tool result, not a broken block
    words = WEB_REPORT + "\n```rca\nnot json\n```"
    assert evidence.split(words) == (words, None, "missing")


def test_an_rca_fence_that_never_closes_is_cut_only_when_the_answer_stopped_inside_a_block():
    quoted = f"{WEB_REPORT}\nlog line: ```rca\nsomething\n## Next steps\nrestart"
    assert evidence.split(quoted) == (quoted, None, "missing")  # a quoted fence: the text after it stays
    assert evidence.split(quoted, "length") == (f"{WEB_REPORT}\nlog line:", None, "cut")
    started = f"{WEB_REPORT}\n\n```rca\n  {{\"no_fault\": false, \"causes\": [{{\"resource\": \"Deployment/apps/web\""
    assert evidence.split(started) == (WEB_REPORT, None, "cut")  # JSON follows the fence
    # the provider said it stopped by itself: the fence was left open, not cut
    assert evidence.split(started, "stop") == (WEB_REPORT, None, "missing")
    assert rca_block.unclosed(started) and not rca_block.unclosed(quoted)
    # a whole object with only its closing fence missing is the block
    whole = f"{WEB_REPORT}\n\n```rca\n{{\"no_fault\": true, \"causes\": []}}\n"
    assert evidence.split(whole, "stop") == (WEB_REPORT, {"no_fault": True, "causes": []}, "ok")
    assert evidence.split(whole, "length")[2] == "cut"


@pytest.mark.parametrize("answer, status", [
    (WEB_REPORT, "missing"),
    (WEB_REPORT + "\n```json\n{\"causes\": []}\n```", "missing"),
    (WEB_REPORT + "\n```rca\n[1, 2]\n```", "invalid"),  # JSON the model meant as its block, the wrong shape
    (WEB_REPORT + "\n```rca\n\"causes\": []\n```", "invalid"),  # JSON that parses in part: still its block
    (WEB_REPORT + "\n```rca\n{\"causes\": \"web\"}\n```", "invalid"),
    (WEB_REPORT + "\n```rca\n{\"causes\": {}}\n```", "invalid"),
    (WEB_REPORT + "\n```rca\n{\"causes\": null}\n```", "invalid"),
    (WEB_REPORT + "\n```rca\n{\"no_fault\": false}\n```", "invalid"),
    (WEB_REPORT + "\n```rca\n{\"causes\": [\"StatefulSet/apps/db\"]}\n```", "invalid"),
    (WEB_REPORT + "\n```rca\n{\"causes\": [{\"resource\": \"Deployment/apps/web\"}, 3]}\n```", "invalid"),
    (WEB_REPORT + "\n```rca\n{\"no_fault\": false, \"causes\": [{\"resource\": \"Deployment/apps/web\", \"kind\": \"cr", "cut"),
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


def test_only_kind_none_leaves_an_entry_out_of_the_causes():
    reads = [evidence.Read("k8s_get_resources", PODS, text=POD_TABLE)]
    block = {"causes": [
        {"resource": "StatefulSet/apps/db", "kind": None, "evidence": [9]},  # a null kind is still a cause
        {"resource": "StatefulSet/apps/db", "evidence": [9]},  # so is a missing one
        {"resource": "Pod/apps/x", "kind": " None", "evidence": []},
        {"resource": "Pod/apps/y", "kind": 0, "evidence": []},
    ]}
    checked, problems = evidence.check(block, reads, NOW)
    assert checked == 3
    assert [(p.resource, p.reason, p.index) for p in problems] == [
        ("StatefulSet/apps/db", "bad_calls", 0), ("StatefulSet/apps/db", "bad_calls", 1), ("Pod/apps/y", "no_evidence", 3)]
    assert rca_block.not_in_ledger(block, []) == ["StatefulSet/apps/db", "StatefulSet/apps/db", "Pod/apps/y"]


def test_a_number_that_names_no_call_fails_a_cause_beside_one_that_shows_it():
    # [1, 999]: call 1 answered and names the cause, 999 names no call of the run
    reads = [evidence.Read("k8s_get_resources", {}, text="Deployment/shop/cart")]
    log = [{"tool": "k8s_get_resources"}]
    block = {"no_fault": False, "causes": [{"resource": "Deployment/shop/cart", "kind": "rollout", "evidence": [1, 999]}]}
    checked = rca_block.check("# Report\nObserved rollout\n```rca\n" + json.dumps(block) + "\n```", tool_log=log, reads=reads,
                              alert_start=None, evidence=True, ledger=False)
    assert checked.failures == [{"kind": "cause_bad_calls", "resource": "Deployment/shop/cart"}]
    assert evidence.reason_text(checked.cause_problems[0]) == "calls 999 are not calls of this investigation that answered"
    stored = inv_result.shape(checked.block, checked.status, log, [], cause_problems=checked.cause_problems,
                              failures=checked.failures)["causes"][0]
    assert (stored["verified"], stored["reason"]) == (False, "bad_calls")
    assert stored["evidence"] == [{"call": 1, "tool": "k8s_get_resources"}] and stored["raw_evidence"] == [1, 999]
    # a failed call beside one that answered is no evidence either; a reason found before it stays the cause's reason
    reads.append(evidence.Read("k8s_get_pod_logs", {}, failed=True))
    assert [(p.reason, p.values) for p in evidence.check({"causes": [cause("Deployment/shop/cart", [1, 2])]}, reads, NOW)[1]] == [
        ("bad_calls", {"calls": [2]})]
    assert [p.reason for p in evidence.check({"causes": [cause("Deployment/shop/db", [1, 999])]}, reads, NOW)[1]] == ["name_missing"]
    assert evidence.check({"causes": [cause("Deployment/shop/cart", [1, "1"])]}, reads, NOW) == (1, [])


def test_no_fault_and_an_alert_without_a_start_check_nothing_of_time():
    reads = [evidence.Read("k8s_get_resources", PODS, text=POD_TABLE)]
    assert evidence.check({"no_fault": True, "causes": []}, reads, NOW) == (0, [])
    late = {"causes": [cause("Deployment/apps/web", [1], started_at="2026-10-13T13:00:00Z")]}
    assert evidence.check(late, reads, None) == (1, [])


ALERT_TEXT = "alert KubePodCrashLooping firing: Deployment/apps/web, pod web-7d9f4-x2k in apps"


@pytest.mark.parametrize("tool", sorted(answers.NO_SYMPTOM))
def test_a_cause_given_only_reads_of_alerts_rules_or_names_is_not_verified(tool):
    """What an alert or its rule says, or a list of names, holds the name of what the alert is about, not what is wrong
    with it: with the verdict off too (`nothing` unset), whatever names the answer holds."""
    reads = [
        evidence.Read(tool, {}, text=ALERT_TEXT),
        evidence.Read("k8s_get_resources", PODS, text=POD_TABLE),
        evidence.Read("k8s_get_resources", PODS, text="NAME READY STATUS\nother-1 1/1 Running"),
        evidence.Read(tool, {}, same_as=1),  # a refused repeat of it
        evidence.Read("timeline", {"view": "changes", "namespace": "apps"}, text="Deployment/apps/web revision 4"),
    ]
    for calls in ([1], [4], [1, 4]):
        checked, problems = evidence.check({"causes": [cause("Deployment/apps/web", calls)]}, reads, NOW)
        assert (checked, [(p.reason, p.values) for p in problems]) == (1, [("empty_answer", {"calls": calls})]), calls
    assert evidence.reason_text(problems[0]) == "calls 1, 4 read nothing, hold nothing, or read only alerts, rules or names"
    assert evidence.reason_text(problems[0], "ko") == "1, 4번 호출은 읽은 것이 없거나, 답에 담긴 것이 없거나, 알림·규칙·이름만 읽음"
    # beside a read that shows it the cause stands on that read; beside one that does not name it, its name is missing there
    assert evidence.check({"causes": [cause("Deployment/apps/web", [1, 2])]}, reads, NOW) == (1, [])
    assert [(p.reason, p.values) for p in evidence.check({"causes": [cause("Deployment/apps/web", [1, 3])]}, reads, NOW)[1]] == [
        ("name_missing", {"name": "web", "calls": [3]})]
    # what changed is no symptom, but it shows a cause: a rollout stands on the changes view
    assert evidence.check({"causes": [cause("Deployment/apps/web", [5], kind="rollout")]}, reads, NOW) == (1, [])


def test_the_reads_that_show_no_cause_are_those_that_show_no_symptom():
    assert verdict.NO_SYMPTOM is answers.NO_SYMPTOM
    assert {"alerts_inbox", "alerts_list", "prometheus_rules", "k8s_find_resource"} <= answers.NO_SYMPTOM
    assert not answers.NO_SYMPTOM & {"k8s_get_resources", "k8s_get_events", "k8s_describe_resource", "k8s_get_pod_logs", "timeline",
                                     "prometheus_query", "issues", "anomaly_rank"}


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
                                    "ask_failed": False, "block_after": "ok", "causes_after": 1, "unverified": 0}


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
    assert "Tool results so far" not in ask["messages"][-1]["content"]  # the messages hold them on this path
    assert out["iterations"] == 3 and out["total_tokens"] == 33  # the second ask counts in the run's tokens
    assert progress["evidence"] == {"block": "ok", "causes": 1, "unsupported": 1, "asked_again": True,
                                    "ask_failed": False, "block_after": "ok", "causes_after": 1, "unverified": 0}


@pytest.mark.asyncio
async def test_a_cause_that_also_names_no_call_is_asked_about_and_stays_not_verified(monkeypatch):
    mixed = f"{WEB_REPORT}\n\n{rca(cause('Deployment/apps/web', [1, 999]))}"
    service = _service(_reads_pods(), completion(content=mixed), completion(content=f"{WEB_REPORT}\n\n{rca(cause('Deployment/apps/web', [1]))}"))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True), row())
    line = "- Deployment/apps/web: calls 999 are not calls of this investigation that answered"
    assert line in service.completions.calls[2]["messages"][-1]["content"]
    assert out["report"] == WEB_REPORT and out["result"]["asked_again"] is True and out["result"]["causes"][0]["verified"] is True

    service = _service(_reads_pods(), completion(content=mixed), completion(content=mixed))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True), row())
    assert out["report"].endswith(line)
    assert (out["result"]["causes"][0]["verified"], out["result"]["causes"][0]["reason"]) == (False, "bad_calls")


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
                                    "ask_failed": False, "block_after": "missing", "causes_after": 0, "unverified": None}


@pytest.mark.asyncio
async def test_a_failed_call_is_no_evidence(monkeypatch):
    first = f"{WEB_REPORT}\n\n{rca(cause('Deployment/apps/web', [1]))}"
    service = _service(_reads_pods(), completion(content=first), completion(content=first),
                       answer=json.dumps({"error": "web-7d9f4-x2k: connection refused"}))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True), row())
    assert out["tool_calls"][0]["error"]
    assert out["report"].endswith("- Deployment/apps/web: calls 1 are not calls of this investigation that answered")


ALERT_READ = json.dumps({"alerts": [{"labels": {"alertname": "KubePodCrashLooping", "namespace": "apps", "deployment": "web"},
                                     "state": "firing", "summary": "Deployment/apps/web restarts"}]})


@pytest.mark.parametrize("on", [False, True], ids=["the verdict off", "the verdict on"])
@pytest.mark.asyncio
async def test_a_cause_only_an_alert_read_is_given_for_is_asked_about_and_stays_not_verified(monkeypatch, on):
    """The list of alerts names the alert's workload: the server does not take it for the cause, the model is asked once more
    and the window and the floating chat read the cause as not verified."""
    given = f"{WEB_REPORT}\n\n{rca(cause('Deployment/apps/web', [1]))}"
    service = _service(completion(calls=[tool_call("c1", "alerts_list", {})]), completion(content=given), completion(content=given),
                       answer=ALERT_READ)
    service._get_tools_definition = lambda: [{"type": "function", "function": {"name": "alerts_list"}}]
    install_loop(monkeypatch, service, [])
    from app.services.ai import features

    async def all_offered(tools, svc):  # the alert store's switch, which the cluster's features say
        return tools

    monkeypatch.setattr(features, "gate_tools", all_offered)
    progress = {}
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True, verdict=on), row(), progress)
    assert service.executed == [("alerts_list", {})] and not out["tool_calls"][0].get("error")
    line = "- Deployment/apps/web: calls 1 read nothing, hold nothing, or read only alerts, rules or names"
    assert line in service.completions.calls[2]["messages"][-1]["content"] and line in out["report"]
    c = out["result"]["causes"][0]
    assert (c["verified"], c["reason"]) == (False, "empty_answer")
    assert {"kind": "cause_empty_answer", "resource": "Deployment/apps/web"} in out["result"]["failures"]
    assert progress["evidence"]["unverified"] == 1 and progress["evidence"]["asked_again"] is True


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
async def test_a_subscription_second_ask_carries_the_tool_results_its_messages_lack(monkeypatch):
    first = f"{DB_REPORT}\n\n{rca(cause('StatefulSet/apps/db', [1], kind='dependency_down'))}"
    cc = FakeClaudeCode([("k8s_get_resources", PODS)], text=first, turns=2,
                        closing=f"{WEB_REPORT}\n\n{rca(cause('Deployment/apps/web', [1]))}")
    service = FakeSubscriptionService(cc)

    async def execute(name, args, ctx):
        service.executed.append((name, args))
        return POD_TABLE

    service._execute_function_with_context = execute
    install_loop(monkeypatch, service, [])
    await runner.investigate(cfg(max_steps=5, evidence_check=True), row())
    ((messages, _lane),) = cc.completed
    assert [m["role"] for m in messages] == ["system", "user", "assistant", "user"]
    ask = messages[-1]["content"]
    # as the closing call gives them: each result under its tool and arguments, with its call number
    table = POD_TABLE.replace("\n", "\n| ")
    assert ask.startswith(RESULTS_HEAD + '| k8s_get_resources {"resource_type": "pods", "namespace": "apps"}\n'
                          f"| [call 1]\n| {table}" + RESULTS_END + "\n\n")
    assert "- StatefulSet/apps/db: db does not appear in what calls 1 returned" in ask and ask.endswith("No tools now.")


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
