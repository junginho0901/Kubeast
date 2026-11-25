"""When a failure began (AI_FAULT_ONSET, chart ai.faultOnset, off by default): the chat's section, an investigation's rules
and the words of the two tools whose answers then say since when. Off, the model is sent what it was to the byte."""
import hashlib
import itertools
import re
from types import SimpleNamespace

import pytest

from app.services.ai import features, prompts, tools
from app.services.ai.tools import get_tools_definition
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import settings as inv_settings
from tests.test_cause_questions_switch import BEFORE
from tests.test_prompt_install_values import found
from tests.test_v079_switches_off import V078, V079_SWITCHES, _what_the_model_reads

SWITCH = "AI_FAULT_ONSET"
CAUSE = "AI_CAUSE_QUESTIONS"
OTHERS = ("AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED")
COMBINATIONS = [on for n in range(len(OTHERS) + 1) for on in itertools.combinations(OTHERS, n)]
# What the section adds to any of them, so a longer text is seen here: every model call of an answer sends it.
ADDED_CHARS, ADDED_BYTES = 765, 1751
# An investigation's system prompt before this switch (981d53f65), without the rules and with them: sha256.
INVESTIGATION_BEFORE = {
    False: "0a39f3d9ffc2990bd020f0f25ef3e5e54cc50055e5eaf7c7947abfe74c08ae55",
    True: "d4f4ed5d3d0452ea7333156aa4048f35a32e1d2098f42833f4bcbfe6d43b3609",
}
KW = {"cluster": "self", "namespace": "apps", "language": "en"}


def _set(monkeypatch, *on, value=None):
    for name in (*OTHERS, CAUSE, SWITCH, "AI_TIMELINE_CHANGES_MORE", "NODE_NEIGHBORS_ENABLED", "AI_TOOL_RESULT_DETAILS"):
        monkeypatch.delenv(name, raising=False)
    for name in on:
        monkeypatch.setenv(name, "true")
    if value is not None:
        monkeypatch.setenv(SWITCH, value)


def _prompt(monkeypatch, *on, value=None):
    _set(monkeypatch, *on, value=value)
    return prompts.system_message()


def _section(text):
    return text.split("### 전부터 있던 고장과 물은 고장\n")[1].split("\n### ")[0]


# the one switch rule (app/services/switch.py, fixtures/switch_cases.json)
@pytest.mark.parametrize("value", ["true", "TRUE", " true ", "1", "on", "yes"])
def test_the_switch_is_on_for_the_switch_rules_words(monkeypatch, value):
    monkeypatch.setenv(SWITCH, value)
    assert tools.fault_onset_on() and inv_settings.load().fault_onset


@pytest.mark.parametrize("value", [None, "", "false", "no", "0", "t"])
def test_the_switch_is_off_otherwise(monkeypatch, value):
    _set(monkeypatch, value=value)
    assert not tools.fault_onset_on() and not inv_settings.load().fault_onset


@pytest.mark.parametrize("on", COMBINATIONS, ids=lambda on: "+".join(on) or "none")
@pytest.mark.parametrize("value", [None, "", "false"])
def test_off_the_chats_prompt_is_to_the_byte_what_it_was(monkeypatch, on, value):
    off = _prompt(monkeypatch, *on, value=value)
    assert (len(off), len(off.encode()), hashlib.sha256(off.encode()).hexdigest()) == BEFORE[on]
    assert "전부터 있던" not in off


@pytest.mark.parametrize("cause", [False, True], ids=["", "why questions on"])
@pytest.mark.parametrize("on", COMBINATIONS, ids=lambda on: "+".join(on) or "none")
def test_on_only_the_section_is_added_whichever_other_switches_are_on(monkeypatch, on, cause):
    on = (*on, CAUSE) if cause else on
    off, text = _prompt(monkeypatch, *on), _prompt(monkeypatch, *on, value="true")
    before, after = text.split(prompts.ONSET_SECTION + "\n\n")  # once, a section of its own
    assert before + after == off
    assert (len(text) - len(off), len(text.encode()) - len(off.encode())) == (ADDED_CHARS, ADDED_BYTES)
    # right before the naming rules, after the rules for why questions where they are on
    assert after.startswith("### 네임스페이스/리소스 식별 규칙\n") and before.endswith("\n\n")
    assert ("### 원인을 묻는 질문" in before) is cause
    if cause:
        assert before.rstrip().endswith("증상을 보여 준 호출이 없으면 원인을 지목하지 마세요.")


def test_on_the_section_says_when_each_failure_began_and_when_an_older_one_is_the_cause(monkeypatch):
    section = _section(_prompt(monkeypatch, value="true"))
    for words in (
        "먼저 눈에 띄는 고장이 물은 고장이라고 여기지 마세요",
        "호출 수를 줄이라는 규칙과 `issues`에 나온 객체만 보라는 규칙보다 먼저",  # the few-calls and only-what-issues-names rules give way
        "찾은 것마다 언제 시작됐는지 말하세요",
        "시작한 때가 안 나온 것은 모르는 것이지 새것이 아닙니다",  # not known is not new
        "가까이에서 시작된 것을 먼저 보세요",
        "무엇이 안 되는지 말하지 않은 질문",  # the symptom is looked for, not taken from what fails loudest
        "요청을 먼저 받는 워크로드부터(Ready여도)",
        "\"전부터 있던 것\"으로 시작한 때와 함께 따로 적으세요",
        "새로 시작된 것을 못 찾았으면** 어디까지 보았는지와 함께",
    ):
        assert words in section, words
    # an old failure is the cause when the question is about it, a call shows the symptom coming from it, or it got worse
    (older,) = [line for line in section.split("\n") if line.startswith("- **전부터 있던 것은 따로**")]
    for words in ("질문이 그것을 물었을 때", "물은 증상이 그것에서 온다는 호출이 있을 때", "그 무렵 더 나빠졌을 때", "나빠진 때가 시작한 때"):
        assert words in older, words
    # it names no outcome and no first call: those stay with the rules for why questions and the order rules
    assert "원인 확인" not in section and "먼저 부를" not in section and "## " not in section


def test_on_the_section_names_only_defined_tools_and_no_value_of_the_install(monkeypatch):
    defined = {t["function"]["name"] for t in get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda offered: offered))}
    named = set(re.findall(r"`([a-z0-9_]+)`", prompts.ONSET_SECTION))
    assert named == {"issues"} and named <= defined
    assert found(_prompt(monkeypatch, value="true")) == []
    for rules in (False, True):
        assert found(inv_prompt.onset_rules(rules)) == []


CHANGED = {"issues": (tools.ISSUES_NUMBERS, tools.ISSUES_SINCE), "anomaly_rank": (tools.ANOMALY_RANK_ORDER, tools.ANOMALY_RANK_SINCE)}


def _described(offered):
    return {t["function"]["name"]: t["function"]["description"] for t in offered}


@pytest.mark.parametrize("value", [None, "", "false"])
def test_off_the_tools_are_the_ones_they_were(monkeypatch, value):
    _set(monkeypatch, value=value)
    assert tools.offer_fault_onset(tools.K8S_READONLY_TOOLS) is tools.K8S_READONLY_TOOLS
    off = _described(tools.K8S_READONLY_TOOLS)
    assert not any(words in off[name] for name, (_, words) in CHANGED.items())


def test_on_the_two_tools_say_what_since_is(monkeypatch):
    _set(monkeypatch, value="true")
    before, after = _described(tools.K8S_READONLY_TOOLS), _described(tools.offer_fault_onset(tools.K8S_READONLY_TOOLS))
    assert {name for name in before if before[name] != after[name]} == set(CHANGED)
    for name, (words, more) in CHANGED.items():
        assert before[name].count(words) == 1
        assert after[name] == before[name].replace(words, words + more)
        assert "since" in more
    assert "no since is not known, not new" in after["issues"] and "already_there" in after["anomaly_rank"] and "worse" in after["anomaly_rank"]
    # the catalog itself and the parameters are left as they are
    for kept, offered in zip(tools.K8S_READONLY_TOOLS, tools.offer_fault_onset(tools.K8S_READONLY_TOOLS), strict=True):
        assert kept["function"]["parameters"] == offered["function"]["parameters"] and kept["function"]["name"] == offered["function"]["name"]
    assert _described(tools.K8S_READONLY_TOOLS) == before


def test_on_with_the_result_details_both_words_are_said(monkeypatch):
    _set(monkeypatch, "AI_TOOL_RESULT_DETAILS", value="true")
    issues = _described(tools.offer_fault_onset(tools.offer_result_details(tools.K8S_READONLY_TOOLS)))["issues"]
    assert tools.ISSUES_SINCE in issues and issues.endswith(tools.ISSUES_EMPTY_DETAILS)


@pytest.mark.asyncio
@pytest.mark.parametrize("on", [False, True])
async def test_the_chat_and_an_investigation_are_offered_them_by_the_switch(monkeypatch, on):
    _set(monkeypatch, value="true" if on else "false")
    features_on = {"anomalyRank": {"enabled": True}}

    async def fetched(*_args):
        return features_on

    monkeypatch.setattr(features, "fetch_features", fetched)
    offered = _described(await features.gate_tools(tools.K8S_READONLY_TOOLS, SimpleNamespace(cluster_name="", token=None, k8s_service=object())))
    assert (tools.ISSUES_SINCE in offered["issues"]) is on
    if "anomaly_rank" in offered:
        assert (tools.ANOMALY_RANK_SINCE in offered["anomaly_rank"]) is on


def test_the_mcp_server_lists_them_by_the_switch(monkeypatch):
    from app import mcp_server

    _set(monkeypatch, "ANOMALY_RANK_ENABLED")
    off = mcp_server._read_tools()
    _set(monkeypatch, "ANOMALY_RANK_ENABLED", value="true")
    on = mcp_server._read_tools()
    assert {name for name in off if off[name] != on[name]} == set(CHANGED)


@pytest.mark.parametrize("rules", [False, True])
def test_off_an_investigations_prompt_is_to_the_byte_what_it_was(rules):
    for off in (inv_prompt.system_prompt(**KW, rules=rules), inv_prompt.system_prompt(**KW, rules=rules, fault_onset=False)):
        assert hashlib.sha256(off.encode()).hexdigest() == INVESTIGATION_BEFORE[rules]


@pytest.mark.parametrize("rules,verdict,call_paths,node_neighbors", list(itertools.product([False, True], repeat=4)))
def test_on_an_investigations_prompt_gets_two_rules_and_nothing_else_changes(rules, verdict, call_paths, node_neighbors):
    kw = {**KW, "rules": rules, "verdict": verdict, "call_paths": call_paths, "node_neighbors": node_neighbors}
    off, on = inv_prompt.system_prompt(**kw), inv_prompt.system_prompt(**kw, fault_onset=True)
    added = inv_prompt.onset_rules(rules)
    before, after = on.split(added)
    assert before + after == off and before.endswith("\n") and added.count("\n- ") == 1
    heading = "Ruled out" if rules else "What I checked"
    assert f'List it under "{heading}" as "Already there before" with its time.' in added
    assert heading in inv_prompt.report_headings(rules)


def test_an_investigations_rules_say_when_an_older_failure_is_the_cause():
    added = inv_prompt.onset_rules(True)
    for words in ("Say when each thing you found began", "the minutes before the start count as near it", "not known, which is not new",
                  "Look first at what began near the alert's start", "do not name it as the cause unless the alert is about it",
                  "a result shows the alert's symptom coming from it", "or it got worse near the alert's start", "it then began when it got worse"):
        assert words in added, words


@pytest.mark.asyncio
async def test_off_the_model_is_sent_what_it_was_and_on_the_chats_and_the_investigations_texts_change(monkeypatch):
    """The chat's and the floating chat's messages and tools, an investigation, the MCP tools and the masking."""
    for name in (*V079_SWITCHES, SWITCH):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("REDACTION_PII", "true")
    monkeypatch.setenv(SWITCH, "false")
    assert await _what_the_model_reads(monkeypatch) == V078
    monkeypatch.setenv(SWITCH, "true")
    on = await _what_the_model_reads(monkeypatch)
    # what tool-server is asked stays (it asks k8s-service for since by itself), and so do the floating chat's instructions
    assert sorted(name for name in V078 if on[name] != V078[name]) == [
        "chat messages en", "chat messages fr", "chat messages ko", "chat second call", "chat tools", "floating tools",
        "investigation first call", "investigation second call", "mcp tools"]
    assert on.keys() == V078.keys()
