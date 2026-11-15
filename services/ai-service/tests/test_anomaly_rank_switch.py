"""anomaly_rank is named to the model only where it is turned on (ANOMALY_RANK_ENABLED, chart
features.anomalyRank.enabled, off by default): off, the chat's system prompt is SYSTEM_MESSAGE as it was before the tool
and the MCP server does not list it; on, its three lines follow the lines they belong after. The chat's and an
investigation's tool lists follow the cluster's features (features.GATES) either way."""
import pytest

from app.services.ai import prompts, tools


# the one switch rule (app/services/switch.py, fixtures/switch_cases.json)
@pytest.mark.parametrize("value", ["true", "TRUE", " true ", "1", "on", "yes"])
def test_the_switch_is_on_for_the_switch_rules_words(monkeypatch, value):
    monkeypatch.setenv("ANOMALY_RANK_ENABLED", value)
    assert tools.anomaly_rank_on()


@pytest.mark.parametrize("value", [None, "", "false", "no", "0", "t"])
def test_the_switch_is_off_otherwise(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("ANOMALY_RANK_ENABLED", raising=False)
    else:
        monkeypatch.setenv("ANOMALY_RANK_ENABLED", value)
    assert not tools.anomaly_rank_on()


def test_off_the_prompt_names_no_anomaly_rank_and_on_three_lines_follow_their_lines(monkeypatch):
    monkeypatch.delenv("AI_TIMELINE_CHANGES", raising=False)
    monkeypatch.delenv("ANOMALY_RANK_ENABLED", raising=False)
    assert prompts.system_message() == prompts.SYSTEM_MESSAGE and "anomaly_rank" not in prompts.SYSTEM_MESSAGE

    # with timeline's changes view off, the order rule has no step for it
    monkeypatch.setenv("ANOMALY_RANK_ENABLED", "true")
    on = prompts.system_message().split("\n")
    for anchor, line in ((prompts._ISSUES_GUIDE, prompts.ANOMALY_RANK_GUIDE), (prompts._STATE_RULE, prompts.ANOMALY_RANK_RULE_WITHOUT_CHANGES),
                         (prompts._ISSUES_SIGNATURE, prompts.ANOMALY_RANK_SIGNATURE)):
        assert on[on.index(anchor) + 1] == line
    assert [line for line in on if line not in prompts.SYSTEM_MESSAGE.split("\n")] == [
        prompts.ANOMALY_RANK_GUIDE, prompts.ANOMALY_RANK_RULE_WITHOUT_CHANGES, prompts.ANOMALY_RANK_SIGNATURE]
    assert "changes" not in prompts.ANOMALY_RANK_RULE_WITHOUT_CHANGES and "`timeline`" not in prompts.ANOMALY_RANK_RULE_WITHOUT_CHANGES


def test_with_both_switches_on_one_order_rule_names_the_changes_view(monkeypatch):
    monkeypatch.setenv("AI_TIMELINE_CHANGES", "true")
    monkeypatch.setenv("ANOMALY_RANK_ENABLED", "true")
    both = prompts.system_message().split("\n")
    assert both[both.index(prompts._STATE_RULE) + 1] == prompts.ANOMALY_RANK_RULE and '`view: "changes"`' in prompts.ANOMALY_RANK_RULE
    # the changes view's own "changes first" rule gives way to the order rule; its guide and signature lines stay
    assert both[both.index(prompts._TIME_RULE) + 1] != prompts.TIMELINE_CHANGES_LINES[prompts._TIME_RULE].split("\n")[1]
    assert prompts.TIMELINE_CHANGES_LINES[prompts._TIMELINE_GUIDE] in both and prompts.TIMELINE_CHANGES_LINES[prompts._TIMELINE_SIGNATURE] in both
    assert sum("먼저 부를 도구를 정하는 규칙은 이것 하나입니다" in line or "바뀐 것부터 보세요" in line for line in both) == 1
    monkeypatch.delenv("ANOMALY_RANK_ENABLED")
    assert "\n".join(both) != prompts.system_message()
    assert prompts.system_message() == "\n".join(prompts.TIMELINE_CHANGES_LINES.get(line, line) for line in prompts.SYSTEM_MESSAGE.split("\n"))


def test_the_mcp_server_lists_it_only_with_the_switch(monkeypatch):
    from app import mcp_server

    monkeypatch.delenv("ANOMALY_RANK_ENABLED", raising=False)
    off = mcp_server._read_tools()
    assert "anomaly_rank" not in off
    monkeypatch.setenv("ANOMALY_RANK_ENABLED", "true")
    on = mcp_server._read_tools()
    assert set(on) - set(off) == {"anomaly_rank"} and all(on[n] == off[n] for n in off)


@pytest.mark.asyncio
async def test_off_dispatch_answers_anomaly_rank_as_an_unknown_function(monkeypatch):
    import json
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock

    from app.services.ai.tool_dispatch import execute_function_with_context

    def service():
        return SimpleNamespace(user_role="admin", _is_tool_allowed=MagicMock(return_value=True),
                               _call_tool_server=AsyncMock(return_value='{"ok": true}'), k8s_service=MagicMock())

    monkeypatch.delenv("ANOMALY_RANK_ENABLED", raising=False)
    off = service()
    out = await execute_function_with_context(off, "anomaly_rank", {"namespace": "shop"}, SimpleNamespace(state={}, cache={}))
    assert json.loads(out) == {"error": "Unknown function: anomaly_rank"} and off._call_tool_server.await_count == 0
    monkeypatch.setenv("ANOMALY_RANK_ENABLED", "true")
    on = service()
    await execute_function_with_context(on, "anomaly_rank", {"namespace": "shop"}, SimpleNamespace(state={}, cache={}))
    on._call_tool_server.assert_awaited_once_with("anomaly_rank", {"namespace": "shop"})
