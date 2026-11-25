"""How an answer names its causes (AI_CAUSE_NAMING, chart ai.causeNaming, off by default; app/services/cause_naming.py). Off,
the chat's system prompt and the rca block's instruction are to the byte what they were before it, whichever other switches
are on. On, the chat has one section more and the rca instruction one part more, between the block's shape and its other
sentences; the shape, what reads a block and what the row keeps of its first cause stay as they were."""
import hashlib
import itertools
import json
import re
from types import SimpleNamespace

import pytest

from app.services import cause_naming
from app.services.ai import prompts
from app.services.ai.tools import get_tools_definition
from app.services.investigation import evidence, rca, runner
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import result as inv_result
from app.services.investigation.settings import InvestigationSettings, load
from tests.test_alert_investigation import cfg, completion, install_loop, row
from tests.test_evidence_check import PODS, POD_TABLE, _reads_pods, _service, cause
from tests.test_investigation_ledger import hypothesis
from tests.test_prompt_install_values import found
from tests.test_v079_switches_off import V078, V079_SWITCHES, _what_the_model_reads

SWITCH = "AI_CAUSE_NAMING"
OTHERS = ("AI_TIMELINE_CHANGES", "AI_TIMELINE_CHANGES_MORE", "ANOMALY_RANK_ENABLED", "NODE_NEIGHBORS_ENABLED", "AI_CAUSE_QUESTIONS",
          "CALL_GRAPH_ENABLED")
COMBINATIONS = [on for n in range(len(OTHERS) + 1) for on in itertools.combinations(OTHERS, n)]
PARTS = [p for p in itertools.product((False, True), repeat=3) if p[0] or p[1]]  # evidence, hypotheses, verdict

# 981d53f65, before this switch: every set of the other chat switches and its prompt, every set of the rca block's parts and
# its instruction, as one sha256 each.
CHAT_BEFORE = "bcea6b1a6aa84a1706adfd68927a9f396fd7a08125c5094f0d028116373a64d8"
RCA_BEFORE = "84809f765b2e6512dbb830aac3143e75ad3d4071efe80086f555ff32fa6ce714"
# What it adds, so a longer text is seen here: every model call of a chat answer or of an investigation sends it.
CHAT_ADDED = (2054, 3022)  # characters, bytes
RCA_ADDED = 2511

API, WEB, SETTINGS = "Service/apps/api", "Deployment/apps/web", "ConfigMap/apps/web-settings"


def _prompt(monkeypatch, *on, naming=None):
    for name in (*OTHERS, SWITCH):
        monkeypatch.delenv(name, raising=False)
    for name in on:
        monkeypatch.setenv(name, "true")
    if naming is not None:
        monkeypatch.setenv(SWITCH, naming)
    return prompts.system_message()


def _section(text):
    return text.split("### 원인을 적는 법\n")[1].split("\n\n## ")[0]


# --- the switch ------------------------------------------------------------------------------------------------------


# the one switch rule (app/services/switch.py, fixtures/switch_cases.json)
@pytest.mark.parametrize("value,on", [("true", True), (" TRUE ", True), ("1", True), ("on", True), ("yes", True), (None, False), ("", False),
                                      ("false", False), ("no", False), ("0", False), ("t", False)])
def test_the_chat_and_an_investigation_read_it_by_the_one_switch_rule(monkeypatch, value, on):
    monkeypatch.delenv(SWITCH, raising=False)
    if value is not None:
        monkeypatch.setenv(SWITCH, value)
    assert cause_naming.on() is on and load().cause_naming is on
    assert InvestigationSettings().cause_naming is False


# --- off: to the byte ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [None, "", "false"])
def test_off_the_chat_prompt_is_to_the_byte_what_it_was_with_every_set_of_the_other_switches(monkeypatch, value):
    digest = hashlib.sha256()
    for on in COMBINATIONS:
        off = _prompt(monkeypatch, *on, naming=value)
        assert "원인을 적는 법" not in off and "dependency_slow" not in off
        digest.update("+".join(on).encode() + b"\0" + off.encode() + b"\0")
    assert digest.hexdigest() == CHAT_BEFORE


def test_off_the_rca_instruction_is_to_the_byte_what_it_was_with_every_set_of_its_parts():
    for naming in ({}, {"naming": False}):
        digest = hashlib.sha256()
        for e, h, v in PARTS:
            digest.update(f"{e} {h} {v}".encode() + b"\0" + rca.instruction(evidence=e, hypotheses=h, verdict=v, **naming).encode() + b"\0")
        assert digest.hexdigest() == RCA_BEFORE


@pytest.mark.asyncio
async def test_off_the_model_is_sent_what_it_was_and_on_only_the_chats_system_prompt_changes(monkeypatch):
    """The chat's and the floating chat's messages and tools, an investigation without the block, the MCP tools, the masking."""
    for name in (*V079_SWITCHES, SWITCH):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("REDACTION_PII", "true")
    monkeypatch.setenv(SWITCH, "false")
    assert await _what_the_model_reads(monkeypatch) == V078
    monkeypatch.setenv(SWITCH, "true")
    on = await _what_the_model_reads(monkeypatch)
    assert sorted(name for name in V078 if on[name] != V078[name]) == [
        "chat messages en", "chat messages fr", "chat messages ko", "chat second call"]
    assert on.keys() == V078.keys()


# --- on: what is added, and where ------------------------------------------------------------------------------------


@pytest.mark.parametrize("on", COMBINATIONS, ids=lambda on: "+".join(on) or "none")
def test_on_the_chat_prompt_has_one_section_more_before_the_language_rules(monkeypatch, on):
    off, text = _prompt(monkeypatch, *on), _prompt(monkeypatch, *on, naming="true")
    before, after = text.split(cause_naming.CHAT_SECTION + "\n\n")
    assert before + after == off and after.startswith("## Language / 언어\n")
    assert (len(text) - len(off), len(text.encode()) - len(off.encode())) == CHAT_ADDED


@pytest.mark.parametrize("e,h,v", PARTS)
def test_on_the_rca_instruction_has_one_part_more_after_the_blocks_shape(e, h, v):
    off, on = (rca.instruction(evidence=e, hypotheses=h, verdict=v, naming=n) for n in (False, True))
    before, after = on.split(cause_naming.INVESTIGATION)
    assert before + after == off and len(on) - len(off) == RCA_ADDED
    assert before.endswith("}\n```\n") and after.startswith('"evidence" lists the numbers of the calls')
    # the shape the model fills is the one it was, with one fence
    assert on.split("```rca\n")[1].split("```")[0] == off.split("```rca\n")[1].split("```")[0] and on.count("```") == 2


def test_every_kind_the_block_takes_has_one_line_of_meaning_in_both_prompts(monkeypatch):
    assert tuple(cause_naming.KIND_MEANINGS) == rca.KINDS
    lines = [f"  - {kind}: {meaning}" for kind, meaning in cause_naming.KIND_MEANINGS.items()]
    assert all(meaning and "\n" not in meaning for meaning in cause_naming.KIND_MEANINGS.values())
    for text in (_prompt(monkeypatch, naming="true"), rca.instruction(evidence=True, hypotheses=True, naming=True)):
        assert "\n".join(lines) in text
        assert [line for line in text.split("\n") if re.match(r"^  - [a-z_]+: ", line)] == lines


def test_both_say_the_same_four_rules(monkeypatch):
    chat, block = _section(_prompt(monkeypatch, naming="true")), cause_naming.INVESTIGATION
    for korean, english in (
        # the object that holds what is wrong, not the one the symptom shows on
        ("잘못된 것을 가진 객체", "the object that holds what is wrong"),
        ("바뀐 것, 또는 그 앞에 바뀌거나 고장 난 것 없이 고장 난 것", "the one that was changed, or that fails with nothing before it changed or failing"),
        ("증상이 보이는 객체는 경로(path)의 끝이고", 'The object the symptom shows on ends "path"'),
        ("ConfigMap·Secret에서 읽는 설정이면 그 ConfigMap·Secret", "a setting read from a ConfigMap or Secret it is that ConfigMap or Secret"),
        ("지금 읽는 것", "the one it reads now"),
        ("워크로드 자신의 이미지·명령·env·requests·limits면 그 워크로드", "requests or limits in a workload's own template it is that workload"),
        ("NetworkPolicy가 막는 트래픽이면 그 정책", "traffic a NetworkPolicy stops that policy"),
        # what is wrong with it, not how the symptom looks
        ("증상의 모양이 아니라", "not how the symptom looks"),
        ("바뀐 설정이 낳은 크래시·OOM·느려짐은 config_change", "that a changed setting brought about are config_change"),
        # both ends of a call, or the one the results show
        ("불리는 쪽과 부르는 쪽을 둘 다", "name both ends as causes"),
        ("불리는 쪽 먼저", "the callee first"),
        ("한쪽 탓이나 둘 사이의 객체 탓인 것이 보이면 그것만", "one end, or an object between the two, makes it so, name that one only"),
        # every independent cause, the main one first, and none added
        ("하나도 빼지 말고", "List every independent cause the results show"),
        ("증상을 가장 많이 설명하는 것부터", "the one that explains most of the symptom first"),
        ("경로는 그 첫 원인의 것", '"path" is that one\'s'),
        ("다른 원인이 아니라 경로에", "is not another cause: it goes in \"path\""),
        ("혹시 몰라서 더 적지는 마세요", "Never add one to be on the safe side"),
    ):
        assert korean in chat, korean
        assert english in block, english


def test_the_chats_section_is_for_words_and_for_a_form_the_question_asks_for(monkeypatch):
    on = _prompt(monkeypatch, "AI_CAUSE_QUESTIONS", naming="true")
    section = _section(on)
    assert "글이든 질문이 달라고 한 표·JSON이든" in section
    assert "글로 답할 때는 낱말 대신 뜻을 쓰세요" in section  # a kind word is for a form that asks for one
    assert "```" not in section and "\n## " not in section  # it asks for no block and no heading of its own
    # with the rules for why questions: they say whether a cause is named at all, this how
    assert on.index("### 원인을 묻는 질문") < on.index("### 원인을 적는 법") < on.index("## Language / 언어")
    assert "증상을 보여 준 호출이 없으면 원인을 지목하지 마세요." in on


def test_the_added_words_name_no_tool_and_no_value_of_the_install(monkeypatch):
    defined = {t["function"]["name"] for t in get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))}
    for text in (cause_naming.CHAT_SECTION, cause_naming.INVESTIGATION):
        assert not set(re.findall(r"[a-z0-9_]+", text)) & defined
        assert found(text) == []
    assert found(_prompt(monkeypatch, naming="true")) == []


# --- an investigation ------------------------------------------------------------------------------------------------

READS = [evidence.Read("k8s_get_resources", PODS, text="api web-settings web-7d9f4-x2k"),
         evidence.Read("timeline", {"namespace": "apps"}, text="web-settings changed; api restarted")]
LOG = [{"tool": r.tool, "args": r.args, "step": 1} for r in READS]


def _answer(causes, hypotheses=(), **extra):
    return "## Summary\nweb fails.\n\n```rca\n" + json.dumps(
        {"no_fault": False, "causes": causes, "path": [SETTINGS, WEB], "ruled_out": [], "hypotheses": list(hypotheses), **extra}) + "\n```"


def _kept(causes, **checks):
    on = {"evidence": True, "ledger": True, **checks}
    h = [hypothesis(id=f"h{i}", resource=c["resource"], **{"for": c["evidence"]}) for i, c in enumerate(causes, 1)]
    checked = rca.check(_answer(causes, h), tool_log=LOG, reads=READS, alert_start=None, **on)
    return checked, inv_result.shape(checked.block, checked.status, LOG, checked.hypotheses, failures=checked.failures,
                                     cause_problems=checked.cause_problems if on["evidence"] else None, checks=on)


@pytest.mark.parametrize("more", [[cause(API, [2], kind="dependency_slow")], [cause(API, [2]), cause(WEB, [1]), cause("Job/apps/x", [9])]],
                         ids=["two", "four, one not shown"])
def test_more_causes_leave_what_is_read_and_kept_of_the_first_as_it_was(more):
    """ "causes" was always a list: one that reads its first entry, the path or the other keys reads what it read."""
    first = cause(SETTINGS, [2], kind="config_change", started_at="2026-10-13T11:41:00Z")
    (one, alone), (checked, several) = _kept([first]), _kept([first, *more])
    assert one.failures == [] and alone["causes"][0]["verified"] is True
    assert several["causes"][0] == alone["causes"][0]
    assert [c["resource"] for c in several["causes"]] == [SETTINGS, *(c["resource"] for c in more)]
    assert {k: v for k, v in several.items() if k not in ("causes", "hypotheses", "failures")} == {
        k: v for k, v in alone.items() if k not in ("causes", "hypotheses", "failures")}
    assert several["hypotheses"][0] == alone["hypotheses"][0] and list(several) == list(alone)
    # each cause is held to the calls on its own: one that no call shows leaves the first as it is
    assert [p.resource for p in checked.cause_problems] == [c["resource"] for c in more if c["evidence"] == [9]]


@pytest.mark.asyncio
async def test_on_a_run_asks_for_it_once_and_keeps_both_ends_of_a_call(monkeypatch):
    both = _answer([cause(WEB, [1], kind="dependency_slow"), cause("Pod/apps/web-7d9f4-x2k", [1], kind="dependency_slow")],
                   outcome="cause_found", symptom={"resource": WEB, "evidence": [1]})
    service = _service(_reads_pods(), completion(content=both))
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=5, evidence_check=True, verdict=True, cause_naming=True), row())
    (first, second) = service.completions.calls
    system = first["messages"][0]["content"]
    assert system == (inv_prompt.system_prompt(cluster="self", namespace="apps", language="en", verdict=True, go_on=True)
                      + rca.instruction(evidence=True, hypotheses=False, verdict=True, naming=True))
    assert system.count(cause_naming.INVESTIGATION) == 1 and second["messages"][0]["content"] == system
    assert [(c["resource"], c["verified"]) for c in out["result"]["causes"]] == [(WEB, True), ("Pod/apps/web-7d9f4-x2k", True)]
    assert out["result"]["failures"] == [] and out["result"]["verdict"]["outcome"] == "cause_found" and out["iterations"] == 2


@pytest.mark.parametrize("switches", [{}, {"rules": True}, {"call_paths": True}, {"verdict": True}], ids=lambda s: "+".join(s) or "none")
@pytest.mark.asyncio
async def test_on_with_no_block_a_run_is_sent_what_it_was(monkeypatch, switches):
    sent = []
    for naming in (False, True):
        service = _service(_reads_pods(), completion(content="## Summary\nweb crashes."))
        install_loop(monkeypatch, service, [])
        out = await runner.investigate(cfg(max_steps=5, cause_naming=naming, **switches), row())
        sent.append((json.dumps([c["messages"] for c in service.completions.calls], default=str), json.dumps(out, default=str)))
    assert sent[0] == sent[1] and "How to fill" not in sent[1][0] and POD_TABLE.split("\n")[0] in sent[1][0]
