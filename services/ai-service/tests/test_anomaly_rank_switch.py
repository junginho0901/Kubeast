"""anomaly_rank is named to the model only where it is turned on (ANOMALY_RANK_ENABLED, chart
features.anomalyRank.enabled, off by default): off, the chat's system prompt is SYSTEM_MESSAGE as it was before the tool
and the MCP server does not list it; on, its three lines follow the lines they belong after. The chat's and an
investigation's tool lists follow the cluster's features (features.GATES) either way."""
import pytest

from app.services.ai import prompts, tools


@pytest.mark.parametrize("value", ["true", "TRUE", " true "])
def test_the_switch_is_on_only_for_true(monkeypatch, value):
    monkeypatch.setenv("ANOMALY_RANK_ENABLED", value)
    assert tools.anomaly_rank_on()


@pytest.mark.parametrize("value", [None, "", "false", "yes", "1"])
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

    monkeypatch.setenv("ANOMALY_RANK_ENABLED", "true")
    on = prompts.system_message().split("\n")
    for anchor, line in ((prompts._ISSUES_GUIDE, prompts.ANOMALY_RANK_GUIDE), (prompts._STATE_RULE, prompts.ANOMALY_RANK_RULE),
                         (prompts._ISSUES_SIGNATURE, prompts.ANOMALY_RANK_SIGNATURE)):
        assert on[on.index(anchor) + 1] == line
    assert [line for line in on if line not in prompts.SYSTEM_MESSAGE.split("\n")] == [
        prompts.ANOMALY_RANK_GUIDE, prompts.ANOMALY_RANK_RULE, prompts.ANOMALY_RANK_SIGNATURE]


def test_with_both_switches_on_the_prompt_has_the_lines_of_each(monkeypatch):
    monkeypatch.setenv("AI_TIMELINE_CHANGES", "true")
    monkeypatch.setenv("ANOMALY_RANK_ENABLED", "true")
    both = prompts.system_message()
    for line in (prompts.ANOMALY_RANK_GUIDE, prompts.ANOMALY_RANK_RULE, prompts.ANOMALY_RANK_SIGNATURE, *prompts.TIMELINE_CHANGES_LINES.values()):
        assert line in both
    monkeypatch.delenv("ANOMALY_RANK_ENABLED")
    assert prompts.system_message() == "\n".join(prompts.TIMELINE_CHANGES_LINES.get(line, line) for line in prompts.SYSTEM_MESSAGE.split("\n"))


def test_the_mcp_server_lists_it_only_with_the_switch(monkeypatch):
    from app import mcp_server

    monkeypatch.delenv("ANOMALY_RANK_ENABLED", raising=False)
    off = mcp_server._read_tools()
    assert "anomaly_rank" not in off
    monkeypatch.setenv("ANOMALY_RANK_ENABLED", "true")
    on = mcp_server._read_tools()
    assert set(on) - set(off) == {"anomaly_rank"} and all(on[n] == off[n] for n in off)
