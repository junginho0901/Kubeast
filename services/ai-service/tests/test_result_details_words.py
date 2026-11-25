"""The tools whose words follow their answers (tools._RESULT_DETAILS) are offered with them: with AI_TOOL_RESULT_DETAILS on
(chart ai.toolResultDetails, off by default) k8s_find_resource looks among the namespaces' names and an empty search does not
end the work, and issues says what not_read is; off, the tools are the ones they were."""
from types import SimpleNamespace

import pytest

from app.services.ai import features, tools

SWITCH = "AI_TOOL_RESULT_DETAILS"
CHANGED = {"k8s_find_resource": (tools.FIND_ONCE, tools.FIND_ONCE_DETAILS), "issues": (tools.ISSUES_EMPTY, tools.ISSUES_EMPTY_DETAILS)}


def _described(offered):
    return {t["function"]["name"]: t["function"]["description"] for t in offered}


@pytest.mark.parametrize("value", [None, "", "false", "0"])
def test_off_the_tools_are_the_ones_they_were(monkeypatch, value):
    if value is None:
        monkeypatch.delenv(SWITCH, raising=False)
    else:
        monkeypatch.setenv(SWITCH, value)
    assert tools.offer_result_details(tools.K8S_READONLY_TOOLS) is tools.K8S_READONLY_TOOLS
    off = _described(tools.K8S_READONLY_TOOLS)
    assert off["k8s_find_resource"].endswith(tools.FIND_ONCE) and off["issues"].endswith(tools.ISSUES_EMPTY)


def test_on_only_their_last_words_change(monkeypatch):
    monkeypatch.setenv(SWITCH, "true")
    before, after = _described(tools.K8S_READONLY_TOOLS), _described(tools.offer_result_details(tools.K8S_READONLY_TOOLS))
    assert {name for name in before if before[name] != after[name]} == set(CHANGED)
    for name, (words, instead) in CHANGED.items():
        assert before[name].count(words) == 1 and before[name].endswith(words)  # the words are the tool's, once
        assert after[name] == before[name].replace(words, instead) and after[name].endswith(instead)
    assert "Namespace names" in after["k8s_find_resource"] and "do not keep guessing" not in after["k8s_find_resource"]
    assert "not_read" in after["issues"] and "not_read" not in before["issues"]
    # the catalog itself is left as it is, and the parameters are the offered tools'
    for kept, offered in zip(tools.K8S_READONLY_TOOLS, tools.offer_result_details(tools.K8S_READONLY_TOOLS), strict=True):
        assert kept["function"]["parameters"] == offered["function"]["parameters"] and kept["function"]["name"] == offered["function"]["name"]
    assert _described(tools.K8S_READONLY_TOOLS) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("on", [False, True])
async def test_the_chat_and_an_investigation_are_offered_them_by_the_switch(monkeypatch, on):
    # both take their list from gate_tools
    monkeypatch.setenv(SWITCH, "true" if on else "false")
    offered = _described(await features.gate_tools(tools.K8S_READONLY_TOOLS, SimpleNamespace(cluster_name="", token=None, k8s_service=None)))
    for name, (words, instead) in CHANGED.items():
        assert offered[name].endswith(instead if on else words)


def test_the_mcp_server_lists_them_by_the_switch(monkeypatch):
    from app import mcp_server

    monkeypatch.delenv(SWITCH, raising=False)
    off = mcp_server._read_tools()
    monkeypatch.setenv(SWITCH, "true")
    on = mcp_server._read_tools()
    assert {name for name in off if off[name] != on[name]} == set(CHANGED)
    for name, (_words, instead) in CHANGED.items():
        assert on[name].description.endswith(instead)
