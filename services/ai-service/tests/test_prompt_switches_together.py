"""The chat's prompt with any set of its switches on: each switch that is on says all of its lines, whichever others are, and
one that is off says none. A switch's lines take the place of lines of SYSTEM_MESSAGE (prompts.system_message), so two that
took the same line would lose one; the ones that do are named here."""
import itertools

import pytest

from app.services.ai import prompts

LINES = {
    "AI_TIMELINE_CHANGES": prompts.TIMELINE_CHANGES_LINES,
    "AI_TIMELINE_CHANGES_MORE": prompts.TIMELINE_CHANGES_MORE_LINES,
    "ANOMALY_RANK_ENABLED": prompts.ANOMALY_RANK_LINES,
    "NODE_NEIGHBORS_ENABLED": prompts.NODE_NEIGHBORS_LINES,
    "AI_CAUSE_QUESTIONS": prompts.CAUSE_QUESTION_LINES,
    "AI_FAULT_ONSET": {prompts._NAMESPACE_HEADING: prompts.ONSET_SECTION + "\n\n" + prompts._NAMESPACE_HEADING},
    "AI_CAUSE_NAMING": prompts.CAUSE_NAMING_LINES,
}
SWITCHES = (*LINES, "CALL_GRAPH_ENABLED")
SETS = [on for n in range(len(SWITCHES) + 1) for on in itertools.combinations(SWITCHES, n)]


def _prompt(monkeypatch, on):
    for name in SWITCHES:
        monkeypatch.delenv(name, raising=False)
    for name in on:
        monkeypatch.setenv(name, "true")
    return prompts.system_message()


def test_only_these_lines_are_taken_by_two_switches():
    shared = {(a, b): sorted(set(LINES[a]) & set(LINES[b])) for a, b in itertools.combinations(LINES, 2) if set(LINES[a]) & set(LINES[b])}
    assert shared == {
        # the further sources are said in the place of the view's own two lines
        ("AI_TIMELINE_CHANGES", "AI_TIMELINE_CHANGES_MORE"): sorted([prompts._TIMELINE_GUIDE, prompts._TIMELINE_SIGNATURE]),
        # the order rule is put after the line as the rules for why questions word it
        ("ANOMALY_RANK_ENABLED", "AI_CAUSE_QUESTIONS"): [prompts._STATE_RULE],
        # when a failure began is a section after the rules for why questions
        ("AI_CAUSE_QUESTIONS", "AI_FAULT_ONSET"): [prompts._NAMESPACE_HEADING],
    }


@pytest.mark.parametrize("on", SETS, ids=lambda on: "+".join(on) or "none")
def test_each_switch_that_is_on_says_its_lines(monkeypatch, on):
    text = _prompt(monkeypatch, on)
    lines = text.split("\n")
    changes, more = "AI_TIMELINE_CHANGES" in on, "AI_TIMELINE_CHANGES_MORE" in on
    anomaly, calls, cause = "ANOMALY_RANK_ENABLED" in on, "CALL_GRAPH_ENABLED" in on, "AI_CAUSE_QUESTIONS" in on
    onset = "AI_FAULT_ONSET" in on
    rule = (prompts.ANOMALY_RANK_RULE_WITH_CHANGES if changes else prompts.ANOMALY_RANK_RULE) if anomaly else (
        prompts.CALL_GRAPH_RULE_WITH_CHANGES if changes else prompts.CALL_GRAPH_RULE) if calls else None
    expected = {}
    if changes:
        expected.update(prompts.TIMELINE_CHANGES_MORE_LINES if more else
                        {k: v for k, v in prompts.TIMELINE_CHANGES_LINES.items() if k != prompts._TIME_RULE})
        if rule is None:  # the view's own order rule gives way to the one order rule
            expected[prompts._TIME_RULE] = prompts.TIMELINE_CHANGES_LINES[prompts._TIME_RULE]
    if anomaly:
        expected.update({k: v for k, v in prompts.ANOMALY_RANK_LINES.items() if k != prompts._STATE_RULE})
    if "NODE_NEIGHBORS_ENABLED" in on:
        expected.update(prompts.NODE_NEIGHBORS_LINES)
    if cause:
        expected.update(prompts.CAUSE_QUESTION_LINES)
    if onset:
        expected[prompts._NAMESPACE_HEADING] = (prompts.CAUSE_SECTION + "\n\n" if cause else "") + prompts.ONSET_SECTION + "\n\n" + prompts._NAMESPACE_HEADING
    if "AI_CAUSE_NAMING" in on:
        expected.update(prompts.CAUSE_NAMING_LINES)
    if rule is not None:
        expected[prompts._STATE_RULE] = (prompts.CAUSE_STATE_RULE if cause else prompts._STATE_RULE) + "\n" + rule
    assert text == "\n".join(expected.get(line, line) for line in prompts.SYSTEM_MESSAGE.split("\n"))
    # what an off switch would say is nowhere
    if not changes:
        assert "Job 생성" not in text and 'view: "changes"' not in text
    if "NODE_NEIGHBORS_ENABLED" not in on:
        assert "get_node_metrics(node" not in text
    if not cause:
        assert "원인을 묻는 질문" not in text
    if not onset:
        assert "전부터 있던" not in text
    if "AI_CAUSE_NAMING" not in on:
        assert "원인을 적는 법" not in text and "dependency_slow" not in text
    if not anomaly:
        assert "anomaly_rank" not in text
    assert (prompts.SYSTEM_MESSAGE == text) is (not set(on) - {"AI_TIMELINE_CHANGES_MORE"})
    assert all(line in lines for line in prompts.SYSTEM_MESSAGE.split("\n") if line not in expected)
