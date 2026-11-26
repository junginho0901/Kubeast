"""The chat's rules for why questions (AI_CAUSE_QUESTIONS, chart ai.causeQuestions, off by default). Off, the system prompt is
to the byte what it was before them, whichever other switches are on. On, the lines that end the reading early give way to
what to check, and the answer names one of three outcomes; the other switches' lines, the tools, the floating chat, an
investigation and the MCP server stay as they are."""
import hashlib
import itertools
import re
from types import SimpleNamespace

import pytest

from app.services.ai import prompts
from app.services.ai.tools import get_tools_definition
from tests.test_prompt_install_values import found
from tests.test_v079_switches_off import V078, V079_SWITCHES, _what_the_model_reads

SWITCH = "AI_CAUSE_QUESTIONS"
OTHERS = ("AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED")
COMBINATIONS = [on for n in range(len(OTHERS) + 1) for on in itertools.combinations(OTHERS, n)]

# The prompt before this switch (81f6eda1e) with each set of the other switches on: characters, bytes, sha256. With
# anomaly_rank's on, 81f6eda1e's with that tool's two lines as test_anomaly_rank_switch.py holds them, and the order rule's
# sentence on no_baseline (prompts.ANOMALY_NO_BASELINE, 104 characters and 230 bytes more).
CHANGES, ANOMALY, CALLS = OTHERS
BEFORE = {
    (): (25850, 35837, "2a1b00a8b9bead52beded5f8b6fbcd11467e8e52c4f7a5578fd4fa9e7b5b9a47"),
    (CHANGES,): (26593, 37030, "9c81984f213c6ed5f8c1c863767f2734bbd63bf85db351e4926ac84ad0b626b6"),
    (ANOMALY,): (27209, 38147, "95b2aa82160e28a3ab7554c7928ce8485e1f6c3744ba0fbed4a4a6624af1fdb4"),
    (CALLS,): (26167, 36481, "94e31865484fa79b751f26f06199159dcda3cc5b57f30b6133ae232658fef857"),
    (CHANGES, ANOMALY): (27814, 39036, "097b479fef746ce96c00024337ca1026a5a2a50448076af89052e64ca97c604d"),
    (CHANGES, CALLS): (26772, 37370, "55d5d6e86f4467c7860ee7c3a49d87017e654af7d6dfdcc5937e86176555d67a"),
    (ANOMALY, CALLS): (27209, 38147, "95b2aa82160e28a3ab7554c7928ce8485e1f6c3744ba0fbed4a4a6624af1fdb4"),
    (CHANGES, ANOMALY, CALLS): (27814, 39036, "097b479fef746ce96c00024337ca1026a5a2a50448076af89052e64ca97c604d"),
}
# What the rules add to any of them, so a longer text is seen here: every model call of an answer sends it.
ADDED_CHARS, ADDED_BYTES = 1942, 4042


def _prompt(monkeypatch, *on, cause=None):
    for name in (*OTHERS, SWITCH):
        monkeypatch.delenv(name, raising=False)
    for name in on:
        monkeypatch.setenv(name, "true")
    if cause is not None:
        monkeypatch.setenv(SWITCH, cause)
    return prompts.system_message()


# the one switch rule (app/services/switch.py, fixtures/switch_cases.json)
@pytest.mark.parametrize("value", ["true", "TRUE", " true ", "1", "on", "yes"])
def test_the_switch_is_on_for_the_switch_rules_words(monkeypatch, value):
    monkeypatch.setenv(SWITCH, value)
    assert prompts.cause_questions_on()


@pytest.mark.parametrize("value", [None, "", "false", "no", "0", "t"])
def test_the_switch_is_off_otherwise(monkeypatch, value):
    if value is None:
        monkeypatch.delenv(SWITCH, raising=False)
    else:
        monkeypatch.setenv(SWITCH, value)
    assert not prompts.cause_questions_on()


@pytest.mark.parametrize("on", COMBINATIONS, ids=lambda on: "+".join(on) or "none")
@pytest.mark.parametrize("value", [None, "", "false"])
def test_off_the_prompt_is_to_the_byte_and_the_size_it_was(monkeypatch, on, value):
    off = _prompt(monkeypatch, *on, cause=value)
    assert (len(off), len(off.encode()), hashlib.sha256(off.encode()).hexdigest()) == BEFORE[on]
    assert "원인을 묻는 질문" not in off and "no fault found" not in off


@pytest.mark.parametrize("on", COMBINATIONS, ids=lambda on: "+".join(on) or "none")
def test_on_only_its_own_lines_change_whichever_other_switches_are_on(monkeypatch, on):
    off, text = _prompt(monkeypatch, *on), _prompt(monkeypatch, *on, cause="true")
    expected = off
    for line, instead in prompts.CAUSE_QUESTION_LINES.items():
        before, after = ("\n" + expected).split("\n" + line + "\n")  # the line is there once
        expected = (before + "\n" + instead + "\n" + after)[1:]
    assert text == expected
    assert (len(text) - len(off), len(text.encode()) - len(off.encode())) == (ADDED_CHARS, ADDED_BYTES)
    # at most one rule says what to call first: the other switches' own
    lines = text.split("\n")
    assert sum("먼저 부를 도구를 정하는 규칙은 이것 하나입니다" in line or "바뀐 것부터 보세요" in line for line in lines) == bool(on)
    # the order rule stays right after the state rule
    if ANOMALY in on or CALLS in on:
        assert lines[lines.index(prompts.CAUSE_STATE_RULE) + 1].startswith("- **\"왜 깨졌어?\"·\"뭐가 달라졌어?\"처럼 넓게 물으면 이 차례로 보세요**")
        assert prompts._STATE_RULE not in lines


def test_every_line_it_takes_the_place_of_is_a_line_of_the_prompt_and_changes():
    lines = prompts.SYSTEM_MESSAGE.split("\n")
    for line, instead in prompts.CAUSE_QUESTION_LINES.items():
        assert lines.count(line) == 1 and instead != line, line


def test_a_line_that_lost_the_words_to_change_is_an_error():
    assert prompts._swapped("a b c", "b", "x") == "a x c"
    for line in ("a c", "b b"):
        with pytest.raises(ValueError):
            prompts._swapped(line, "b", "x")


def test_on_no_line_ends_a_why_question_early(monkeypatch):
    """The words that stopped the reading: a number of calls, the first source that explains it, only what issues names, a
    log alone, every section filled."""
    off, on = _prompt(monkeypatch), _prompt(monkeypatch, cause="true")
    for words in ("**도구 호출은 최소한으로**: 보통 1~3회면 충분합니다", "하나의 소스로 원인 파악이 되면 바로 분석하세요", "거기 나온 객체만 describe/logs로",
                  "- 로그를 받았으면 바로 분석하세요", "6. Analyze → Determine root cause\n7. Provide solution with commands"):
        assert words in off and words not in on, words
    # what is left of them is for the other questions
    assert "목록·상태·값을 묻는 질문은 보통 1~3회면 충분합니다" in on
    assert "거기 나온 객체부터 describe/logs로 파세요(원인을 묻는 질문이면 거기 안 나온 객체도 봅니다)" in on
    assert "왜 그런지 물었으면 하나의 소스에서 멈추지 말고" in on
    assert "### 효율적 도구 사용 (최우선 규칙. 원인을 묻는 질문은 아래 \"원인을 묻는 질문\"이 먼저)" in on
    # and the state questions still start with one issues call, without listing every pod
    assert "`issues` **한 번**으로 시작" in on and "파드를 전부 나열해 훑지 마세요" in on


def test_on_a_name_not_found_ends_the_search_for_it_and_not_the_reading(monkeypatch):
    """The same direction as k8s_find_resource's own hint with AI_TOOL_RESULT_DETAILS: no repeat of the search, go on with
    what is known, and ask only for the object asked about. The other questions still say where was looked and ask one question."""
    off, on = _prompt(monkeypatch), _prompt(monkeypatch, cause="true")

    def rules(text):
        return text.split("### 못 찾았을 때")[1].split("\n### ")[0].split("\n")

    for words in ("**검색을 멈추고**", "검색을 멈추고"):
        assert words in off and words not in on, words
    (not_found,) = [line for line in rules(on) if line.startswith("- 도구가 `{\"status\": \"not_found\"")]
    (nothing,) = [line for line in rules(on) if line.startswith("- 그래도 없으면")]
    assert not_found.startswith(prompts._NOT_FOUND_RULE) and "지워진 객체의 그 시각 이벤트·로그·지표를 읽는 것은 반복이 아닙니다" in not_found
    assert nothing.startswith("- 그래도 없으면 **같은 검색을 반복하지 마세요.** 원인을 묻는 질문이면 그 이름 찾기만 끝내고 아는 것")
    assert "으로 계속하세요. 물은 대상 자체가 없거나 다른 질문이면 어디를 봤는지(클러스터·종류·네임스페이스)를 말한 뒤 질문 하나만 하세요" in nothing
    assert nothing.endswith(prompts._SEARCH_RULE.split("질문 하나만 하세요")[1])
    # the rest of the protocol is as it was
    assert [line for line in rules(on) if line not in (not_found, nothing)] == [
        line for line in rules(off) if line not in (prompts._NOT_FOUND_RULE, prompts._SEARCH_RULE)]


def test_on_the_section_says_what_to_check_and_when_to_stop(monkeypatch):
    on = _prompt(monkeypatch, cause="true")
    section = on.split("### 원인을 묻는 질문\n")[1].split("\n### ")[0]
    assert on.index("### 효율적 도구 사용") < on.index("### 원인을 묻는 질문") < on.index("### 네임스페이스/리소스 식별 규칙")
    for words in (
        "더 읽어도 결론이 바뀌지 않으면 멈추고 답하세요",  # when to stop, in place of a number of calls
        "물은 시각에 그 증상이 있었는지",  # whether there was a symptom at all
        "메커니즘이 있고, 증상보다 먼저였고, 다른 후보를 확인해 제쳤을 때만 원인입니다",  # a change is a candidate
        "질문이 짚은 원인도 후보입니다",
        "그것을 부르는 쪽과 그것이 부르는 쪽의 같은 시각 로그도",  # the caller's and the callee's logs
        "파드가 크래시하면 직전 로그와 종료 이유에 더해, 그 파드의 설정",  # the configuration of a crashing pod
        "서로 관계없는 워크로드 여럿이 같은 때 느려졌고 어느 것도 CPU 제한에 걸리지(throttled) 않았으면",  # the node and its other namespaces
        "다른 네임스페이스 파드의 사용량",
        "\"못 봤다\"입니다",  # not read is not normal
    ):
        assert words in section, words
    # it does not choose the first call
    assert "먼저 부를지 정한 규칙이 있으면 그 차례를 따르세요" in section


def test_on_the_answer_is_one_of_three_outcomes_and_the_other_answer_rules_agree(monkeypatch):
    on = _prompt(monkeypatch, cause="true")
    section = on.split("### 원인을 묻는 질문\n")[1].split("\n### ")[0]
    outcomes = [line for line in section.split("\n") if re.match(r"^\d\. \*\*", line)]
    assert [line.split("**")[1] for line in outcomes] == ["원인 확인", "이상 없음", "알 수 없음"]
    assert "증상을 보여 준 호출" in outcomes[0] and "추정" in outcomes[0]
    assert "무엇을 어느 기간 보았고" in outcomes[1]
    assert "무엇이 없거나 안 읽혀서" in outcomes[2] and "볼 수 있는 것을 보고도 못 가릴 때만" in outcomes[2]
    assert section.rstrip().endswith("증상을 보여 준 호출이 없으면 원인을 지목하지 마세요.")
    # the answer rules elsewhere in the prompt: no heading, no repeated results, one line of evidence, no section to fill
    assert "불필요한 섹션 구조(## 제목) 사용하지 않기" in on and "## " not in section
    assert "도구 결과를 나열하거나 그대로 되풀이하지 마세요" in on and "값·시각 한 줄이면 됩니다" in section
    assert "2. **문제가 있다면**: 문제점과 원인을 명확히 설명 (왜 그런지 물은 질문의 원인은 \"원인을 묻는 질문\"의 세 결론 중 하나로)" in on
    rules = on.split("**🚨 COMPLETION REQUIREMENT:**\n")[1].split("\n\n")[0]
    assert "\"no fault found\" with what you checked, or \"cannot tell\" with what is missing, is complete" in rules
    assert "may be shorter; never fill it with a guess" in rules and "NEVER end your response prematurely" in rules
    assert "6. Analyze → Cause found (with the call that showed it), no fault found, or cannot tell (with what is missing)" in on
    assert "7. Cause found → Provide solution with commands; otherwise → the next check" in on
    assert "NEVER guess" in on


def test_on_the_added_words_name_only_defined_tools_and_no_value_of_the_install(monkeypatch):
    defined = {t["function"]["name"] for t in get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))}

    def named(text):
        return set(re.findall(r"`([a-z0-9_]+)`", text))

    added = set().union(*(named(instead) - named(line) for line, instead in prompts.CAUSE_QUESTION_LINES.items()))
    assert added == {"issues", "timeline"} and added <= defined
    assert found(_prompt(monkeypatch, cause="true")) == []


@pytest.mark.asyncio
async def test_off_the_model_is_sent_what_it_was_and_on_only_the_chats_system_prompt_changes(monkeypatch):
    """The chat's and the floating chat's messages and tools, an investigation, the MCP tools and the masking."""
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
