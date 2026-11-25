"""get_node_metrics takes a node only where it is turned on (NODE_NEIGHBORS_ENABLED, chart features.nodeNeighbors.enabled,
off by default): off, the tool is offered, listed over MCP and dispatched as it was before its node parameters, and the
chat's prompt names none of them."""
import copy
import itertools
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import mcp_server
from app.services.ai import features, prompts, tools
from app.services.ai.tool_dispatch import execute_function_with_context

BEFORE = {
    "name": "get_node_metrics",
    "description": """Get node resource usage (CPU and memory) - equivalent to 'kubectl top nodes'.
                    
                    Use this to:
                    - Check node resource utilization
                    - Identify nodes under heavy load
                    - Monitor cluster capacity
                    - Diagnose node-level performance issues""",
    "parameters": {"type": "object", "properties": {}},
}
ON = {"nodeNeighbors": {"enabled": True}}


def _definition():
    return next(t for t in tools.CLUSTER_METRICS_TOOLS if t["function"]["name"] == "get_node_metrics")


@pytest.mark.parametrize("served", [None, {}, {"nodeNeighbors": {"enabled": False}}, {"nodeNeighbors": {}}])
def test_off_the_tool_is_offered_as_it_was(served):
    assert features.filter_tools([copy.deepcopy(_definition())], served, "self") == [{"type": "function", "function": BEFORE}]


def test_on_the_tool_takes_a_node_and_a_window():
    offered = features.filter_tools([copy.deepcopy(_definition())], ON, "self")[0]["function"]
    assert tuple(offered["parameters"]["properties"]) == tools.NODE_PARAMS and "required" not in offered["parameters"]
    assert offered["description"] == BEFORE["description"] + tools.NODE_DESCRIPTION


@pytest.mark.parametrize("value", ["", "false", "0"])
def test_mcp_lists_the_node_parameters_only_with_the_switch(monkeypatch, value):
    monkeypatch.setenv("NODE_NEIGHBORS_ENABLED", value)
    off = mcp_server._read_tools()
    assert set(off["get_node_metrics"].input_schema["properties"]) == {"cluster"}
    assert off["get_node_metrics"].description == " ".join(BEFORE["description"].split())
    monkeypatch.setenv("NODE_NEIGHBORS_ENABLED", "true")
    on = mcp_server._read_tools()
    assert set(on["get_node_metrics"].input_schema["properties"]) == {"cluster", *tools.NODE_PARAMS}
    assert {n: t.description for n, t in on.items() if n != "get_node_metrics"} == {n: t.description for n, t in off.items() if n != "get_node_metrics"}


@pytest.mark.parametrize("value, sent", [("", {}), ("true", {"node": "n1", "since_time": "1h"})])
async def test_the_node_arguments_reach_tool_server_only_with_the_switch(monkeypatch, value, sent):
    monkeypatch.setenv("NODE_NEIGHBORS_ENABLED", value)
    service = SimpleNamespace(_call_tool_server=AsyncMock(return_value="{}"), cluster_name="self", _is_tool_allowed=lambda name: True)
    args = {"node": " n1 ", "since_time": "1h", "until_time": "", "extra": "x"}
    await execute_function_with_context(service, "get_node_metrics", args, SimpleNamespace(state={}, cache={}, session_id="s"))
    service._call_tool_server.assert_awaited_once_with("get_node_metrics", sent)


async def test_without_a_node_the_call_is_the_one_before(monkeypatch):
    monkeypatch.setenv("NODE_NEIGHBORS_ENABLED", "true")
    service = SimpleNamespace(_call_tool_server=AsyncMock(return_value="[]"), cluster_name="self", _is_tool_allowed=lambda name: True)
    await execute_function_with_context(service, "get_node_metrics", {}, SimpleNamespace(state={}, cache={}, session_id="s"))
    service._call_tool_server.assert_awaited_once_with("get_node_metrics", {})


OTHERS = ("AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED", "AI_CAUSE_QUESTIONS")


@pytest.mark.parametrize("others", [on for n in range(len(OTHERS) + 1) for on in itertools.combinations(OTHERS, n)], ids=lambda on: "+".join(on) or "none")
def test_the_prompt_says_it_after_its_two_lines_only_with_the_switch(monkeypatch, others):
    for name in (*OTHERS, "AI_TIMELINE_CHANGES_MORE", "NODE_NEIGHBORS_ENABLED"):
        monkeypatch.delenv(name, raising=False)
    for name in others:
        monkeypatch.setenv(name, "true")
    off = prompts.system_message()
    assert "get_node_metrics(node" not in off
    monkeypatch.setenv("NODE_NEIGHBORS_ENABLED", "true")
    on = prompts.system_message().split("\n")
    added = [line for line in on if "get_node_metrics(node" in line]
    assert [on[on.index(line) - 1] for line in added] == [prompts._NODE_METRICS_GUIDE, prompts._NODE_METRICS_SIGNATURE]
    assert "\n".join(line for line in on if line not in added) == off
    assert all(word in added[0] for word in ("since_time", "의심 가해자", "피해자", "자기 한도"))
