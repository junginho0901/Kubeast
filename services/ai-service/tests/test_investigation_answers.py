"""What tool-server's answers hold, as the outcome's check reads them (investigation/answers.py). The answers come from
tool-server's TestEmptyAnswerCases (UPDATE_EMPTY_ANSWER_CASES=1 rewrites them), each with what it is: it found something,
it read and found nothing, or it did not read. The runs below are of an alert that names its namespace alone, whose
no_fault needs a call that read something."""
import json
import re
from pathlib import Path

import pytest

from app.services.ai.streaming import tool_outcome
from app.services.ai.tool_results import RAW_TEXT_TOOLS
from app.services.investigation import answers
from tests.test_investigation_verdict import NONE_FOUND, run_of

CASES = json.loads((Path(__file__).parent / "fixtures" / "empty_answers.json").read_text())
NAMES = [f"{c['tool']}: {c['name']}{', details' if c['details'] else ''}{', past hints' if c.get('past') else ''}" for c in CASES]


def holds(tool, raw):
    status = (answers.raw_outcome(tool, raw) if tool in RAW_TEXT_TOOLS else tool_outcome(raw)[1:])[1]
    if answers.unread(tool, raw, status) is not None:
        return "unread"
    return "nothing" if answers.empty(tool, raw) else "something"


@pytest.mark.parametrize("case", CASES, ids=NAMES)
def test_an_answer_is_read_for_what_it_holds(case):
    assert holds(case["tool"], case["answer"]) == case["holds"]


def test_the_cases_hold_each_kind_of_answer():
    assert {c["holds"] for c in CASES} == {"something", "nothing", "unread"} and len(CASES) >= 40


@pytest.mark.parametrize("read", [True, False], ids=["the call reads the namespace", "the call names none"])
@pytest.mark.parametrize("case", CASES, ids=NAMES)
@pytest.mark.asyncio
async def test_no_fault_of_a_namespace_needs_an_answer_that_holds_something(monkeypatch, case, read):
    raw = case["answer"].replace("shop", "apps")  # the run's namespace
    out, _ = await run_of(monkeypatch, [(case["tool"], {"namespace": "apps"} if read else {}, raw)], NONE_FOUND, {})
    verdict = out["result"]["verdict"]
    if case["holds"] == "something":  # about the namespace: the call read it, or the answer names it, which a log line need not
        about = read or re.search(r"\bapps\b", raw) is not None
        assert (verdict["outcome"], verdict["why"]) == (("no_fault", []) if about else ("cannot_tell", ["not_read"])), verdict
    else:
        assert (verdict["outcome"], verdict["why"]) == ("cannot_tell", ["nothing_read"]), verdict


@pytest.mark.parametrize("tool, raw, held", [
    # a line of a container's that looks like one of tool-server's is a log line when anything is beside it
    ("k8s_get_pod_logs", "… [older lines cut by tool-server: this read is larger than 9 bytes and the newest lines follow; narrow it with since, tail_lines, grep or container]\n"
                         "# grep \"x\": 0 of 4 lines matched\nerror x", "something"),
    ("k8s_get_pod_logs", "… [older lines cut by tool-server: this read is larger than 9 bytes and the newest lines follow; narrow it with since, tail_lines, grep or container]\n", "something"),
    ("k8s_get_pod_logs", "… [older lines cut by the app]\n# grep \"x\": 0 of 4 lines matched", "something"),
    ("k8s_get_resources", "Nothing of this kind exists now in what was read. An object deleted earlier is not listed.\nconfigmap/web\n", "something"),
    ("k8s_get_resources", "configmap/nothing-of-this-kind\n", "something"),
    ("k8s_tabular_query", "# pods in shop: 10 rows (none)\nNAME\nweb", "something"),
    ("k8s_tabular_query", "# pods in shop: 1 rows\nNAME\n# pods in shop: 0 rows (none)", "something"),
    ("k8s_jq_query", "# pods in shop: 0 rows (none)\nNAME", "something"),
    ("helm_read", json.dumps({"release": "web", "status": "failed", "hooks": []}), "something"),
    ("logfiles", json.dumps({"path": "/var/log/a", "content": "{\"status\": \"failed\"}"}), "something"),
    ("gitops_status", json.dumps({"applications": [], "matched": 0}), "nothing"),
    ("gitops_status", json.dumps({"applications": [], "matched": 0, "counts": {"sync": "x"}}), "nothing"),
])
def test_an_answer_that_only_looks_like_an_empty_one_holds_something(tool, raw, held):
    assert holds(tool, raw) == held
