"""resource_graph's words about the callers' p90 (CALL_GRAPH_CLIENT_LATENCY, chart features.callGraph.clientLatency, off by
default): said after its words about the calls, and only where the calls are offered; off, every tool is the one it was."""
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import mcp_server
from app.services.ai import features, prompts, tools

SWITCH = "CALL_GRAPH_CLIENT_LATENCY"
CALLS_ON = {"callGraph": {"enabled": True}}


def _set(monkeypatch, value, calls="true"):
    monkeypatch.setenv("CALL_GRAPH_ENABLED", calls)
    if value is None:
        monkeypatch.delenv(SWITCH, raising=False)
    else:
        monkeypatch.setenv(SWITCH, value)


def _graph():
    return next(t for t in tools.K8S_READONLY_TOOLS if t["function"]["name"] == "resource_graph")


async def _offered(served):
    """What the chat, the floating chat and an investigation offer (all take their list from gate_tools)."""
    features.clear_cache()
    service = SimpleNamespace(cluster_name="c1", token=None, k8s_service=SimpleNamespace(get_features=AsyncMock(return_value=served)))
    out = await features.gate_tools(copy.deepcopy(tools.K8S_READONLY_TOOLS), service)
    features.clear_cache()
    return {t["function"]["name"]: t["function"] for t in out}


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [None, "", "false", "0", "enabled"])
async def test_off_the_tools_are_the_ones_they_were(monkeypatch, value):
    _set(monkeypatch, value)
    assert tools.offer_client_latency(tools.K8S_READONLY_TOOLS) is tools.K8S_READONLY_TOOLS
    offered = await _offered(CALLS_ON)
    assert offered["resource_graph"] == _graph()["function"] and offered["resource_graph"]["description"].endswith(tools.CALLS_DESCRIPTION)
    assert "client_p90_ms" not in mcp_server._read_tools()["resource_graph"].description


@pytest.mark.asyncio
async def test_on_the_calls_words_go_on_to_the_callers_p90(monkeypatch):
    _set(monkeypatch, None)
    before = await _offered(CALLS_ON)
    _set(monkeypatch, "true")
    after = await _offered(CALLS_ON)
    assert {name for name in after if after[name] != before[name]} == {"resource_graph"} and set(before) == set(after)
    assert after["resource_graph"] == {**before["resource_graph"], "description": before["resource_graph"]["description"] + tools.CALLS_CLIENT_DESCRIPTION}
    # the catalogue itself is left as it is
    assert "client_p90_ms" not in _graph()["function"]["description"]


@pytest.mark.asyncio
@pytest.mark.parametrize("served", [None, {}, {"callGraph": {"enabled": False}}])
async def test_where_the_calls_are_not_offered_neither_are_the_words(monkeypatch, served):
    _set(monkeypatch, None, calls="")
    off = await _offered(served)
    _set(monkeypatch, "true", calls="")
    assert await _offered(served) == off
    assert "calls" not in off["resource_graph"]["description"]


@pytest.mark.parametrize("calls, said", [("true", True), ("", False)])
def test_the_mcp_server_lists_them_with_both_switches(monkeypatch, calls, said):
    _set(monkeypatch, None, calls=calls)
    off = mcp_server._read_tools()
    _set(monkeypatch, "true", calls=calls)
    on = mcp_server._read_tools()
    assert {name for name in on if on[name] != off[name]} == ({"resource_graph"} if said else set())
    if said:
        assert on["resource_graph"].description == off["resource_graph"].description + tools.CALLS_CLIENT_DESCRIPTION
        assert on["resource_graph"].input_schema == off["resource_graph"].input_schema


def test_the_prompt_says_nothing_of_it(monkeypatch):
    _set(monkeypatch, None)
    off = prompts.system_message()
    _set(monkeypatch, "true")
    assert prompts.system_message() == off


def test_the_words_name_the_answers_fields():
    # k8s-service's field names (internal/callgraph): a renamed one changes the words
    for words in ("p90_ms", "client_p90_ms", "time_outside_callee", "name both ends", "no longer than the slow time"):
        assert words in tools.CALLS_CLIENT_DESCRIPTION
