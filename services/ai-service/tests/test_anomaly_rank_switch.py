"""anomaly_rank is named to the model only where it is turned on (ANOMALY_RANK_ENABLED, chart
features.anomalyRank.enabled, off by default): off, the chat's system prompt is SYSTEM_MESSAGE as it was before the tool
and the MCP server does not list it; on, its three lines follow the lines they belong after. The chat's and an
investigation's tool lists follow the cluster's features (features.GATES) either way; off, dispatch and an investigation
answer a call of it as they did before the tool."""
import hashlib

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


# sha256 of the chat's system prompt of this pull request as written (bc7ed386), before its lines went behind the switch
V079_ANOMALY_RANK_PROMPT = "04927b8a0fc893f4cf6d7a727f7533a006a15dcc82a40035b0fa5c1f770138c7"
SWITCHES = ("AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED")


def _only(monkeypatch, *on):
    for name in SWITCHES:
        monkeypatch.delenv(name, raising=False)
    for name in on:
        monkeypatch.setenv(name, "true")
    return prompts.system_message().split("\n")


def test_off_the_prompt_names_no_anomaly_rank_and_on_it_is_this_pull_requests_prompt_to_the_byte(monkeypatch):
    assert "\n".join(_only(monkeypatch)) == prompts.SYSTEM_MESSAGE and "anomaly_rank" not in prompts.SYSTEM_MESSAGE
    on = _only(monkeypatch, "ANOMALY_RANK_ENABLED")
    assert hashlib.sha256("\n".join(on).encode()).hexdigest() == V079_ANOMALY_RANK_PROMPT
    for anchor, line in ((prompts._ISSUES_GUIDE, prompts.ANOMALY_RANK_GUIDE), (prompts._STATE_RULE, prompts.ANOMALY_RANK_RULE),
                         (prompts._ISSUES_SIGNATURE, prompts.ANOMALY_RANK_SIGNATURE)):
        assert on[on.index(anchor) + 1] == line
    # step 2 reads timeline's events and rollouts, which every install offers; no changes view
    assert "`timeline`에서 그동안 바뀐 것" in prompts.ANOMALY_RANK_RULE and "view" not in prompts.ANOMALY_RANK_RULE
    # resource_graph's calls on as well: the same words (step 3 says "where offered")
    assert _only(monkeypatch, "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED") == on


def test_with_anomaly_rank_and_the_changes_view_on_one_order_rule_names_the_view(monkeypatch):
    both = _only(monkeypatch, "AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED")
    assert both[both.index(prompts._STATE_RULE) + 1] == prompts.ANOMALY_RANK_RULE_WITH_CHANGES
    assert '`view: "changes"`' in prompts.ANOMALY_RANK_RULE_WITH_CHANGES
    # the changes view's own "changes first" rule gives way to the order rule; its guide and signature lines stay
    assert both[both.index(prompts._TIME_RULE) + 1] != prompts.TIMELINE_CHANGES_LINES[prompts._TIME_RULE].split("\n")[1]
    assert prompts.TIMELINE_CHANGES_LINES[prompts._TIMELINE_GUIDE] in both and prompts.TIMELINE_CHANGES_LINES[prompts._TIMELINE_SIGNATURE] in both
    assert sum("먼저 부를 도구를 정하는 규칙은 이것 하나입니다" in line or "바뀐 것부터 보세요" in line for line in both) == 1
    # the changes view alone is #873's prompt
    assert "\n".join(_only(monkeypatch, "AI_TIMELINE_CHANGES")) == "\n".join(
        prompts.TIMELINE_CHANGES_LINES.get(line, line) for line in prompts.SYSTEM_MESSAGE.split("\n"))


def test_with_resource_graphs_calls_on_and_anomaly_rank_off_the_order_rule_names_no_anomaly_rank(monkeypatch):
    calls = _only(monkeypatch, "CALL_GRAPH_ENABLED")
    assert calls[calls.index(prompts._STATE_RULE) + 1] == prompts.CALL_GRAPH_RULE
    assert [line for line in calls if line not in prompts.SYSTEM_MESSAGE.split("\n")] == [prompts.CALL_GRAPH_RULE]
    for rule in (prompts.CALL_GRAPH_RULE, prompts.CALL_GRAPH_RULE_WITH_CHANGES):
        assert "anomaly_rank" not in rule and 'include: ["calls"]' in rule and rule.index("`timeline`") < rule.index("resource_graph")
    assert "view" not in prompts.CALL_GRAPH_RULE
    both = _only(monkeypatch, "CALL_GRAPH_ENABLED", "AI_TIMELINE_CHANGES")
    assert both[both.index(prompts._STATE_RULE) + 1] == prompts.CALL_GRAPH_RULE_WITH_CHANGES and '`view: "changes"`' in prompts.CALL_GRAPH_RULE_WITH_CHANGES
    assert sum("먼저 부를 도구를 정하는 규칙은 이것 하나입니다" in line or "바뀐 것부터 보세요" in line for line in both) == 1


def test_the_changes_views_description_says_first_only_without_anomaly_rank(monkeypatch):
    def description():
        (timeline,) = [t for t in tools.offer_timeline_changes(tools.K8S_READONLY_TOOLS) if t["function"]["name"] == "timeline"]
        return timeline["function"]["description"]

    _only(monkeypatch, "AI_TIMELINE_CHANGES")
    assert description().endswith(tools.TIMELINE_FIRST)
    _only(monkeypatch, "AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED")
    assert description().endswith(tools.TIMELINE_AFTER_ANOMALY_RANK) and "Use it first" not in description()


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


@pytest.mark.asyncio
@pytest.mark.parametrize("on", [False, True])
async def test_an_investigation_runs_it_only_with_the_switch_and_off_refuses_it_as_before_it_was_read_only(monkeypatch, on):
    import json

    from app.services.investigation import runner
    from tests.test_alert_investigation import FakeService, cfg, completion, install_loop, row, tool_call

    if on:
        monkeypatch.setenv("ANOMALY_RANK_ENABLED", "true")
    else:
        monkeypatch.delenv("ANOMALY_RANK_ENABLED", raising=False)
    service = FakeService([completion(calls=[tool_call("c1", "anomaly_rank", {"namespace": "apps"})]), completion(content="## Summary\nok")])
    audits = []
    install_loop(monkeypatch, service, audits)
    out = await runner.investigate(cfg(max_steps=3), row())
    assert service.executed == ([("anomaly_rank", {"namespace": "apps"})] if on else [])
    assert ("error" not in out["tool_calls"][0]) if on else out["tool_calls"][0]["error"] == "not a read-only tool"
    answered = [m for m in service.completions.calls[1]["messages"] if m.get("role") == "tool"][0]["content"]
    if not on:  # 0.7.8's words
        assert json.loads(answered) == {"error": "'anomaly_rank' is not a read-only tool; investigations only read"}
    assert [a["action"] for a in audits] == ["ai.tool.call"]
