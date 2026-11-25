"""The chat's cards of what two more switches add to tool-server's answers, which the cards show under their table: the line
of where to read further back (AI_PAST_HINTS, chart ai.pastHints) and the nodes' busiest CPU (NODE_NEIGHBORS_BUSIEST_CPU,
chart features.nodeNeighbors.busiestCPU). What the model reads of those answers is tool-server's own text; off, the answers
hold neither, and the cards, the tools and the calls are as they were."""
import json

import pytest

from app.services.ai.formatters import _build_tool_display, _format_tool_result
from app.services.ai.tools import CLUSTER_METRICS_TOOLS, K8S_READONLY_TOOLS, offer_node_neighbors, offer_result_details

SWITCHES = ("AI_PAST_HINTS", "NODE_NEIGHBORS_BUSIEST_CPU", "AI_TOOL_RESULT_DETAILS", "NODE_NEIGHBORS_ENABLED")
REASON = "No event matched. What reaches further back, over a window that holds that time: loki_query (where offered) …"
POLICY = {"type": "Warning", "reason": "PolicyViolation", "message": "m", "namespace": "shop", "object": {"kind": "Pod", "name": "web-1"}}
POLICY_TABLE = "NAMESPACE  LAST SEEN  TYPE     REASON           OBJECT     MESSAGE\nshop       -          Warning  PolicyViolation  Pod/web-1  m      "
NODES = [{"name": "n1", "cpu": "1205m", "cpu_percent": "15%", "memory": "1809Mi", "memory_percent": "2%"}]
NODES_TABLE = "NAME  CPU(cores)  MEMORY(bytes)\nn1    1205m       1809Mi       "
LINE = "Busiest CPU in the last hour over 1 node (30 steps of 2m): CPU 1 of Node/n1, 100% busy at its highest."


def only(monkeypatch, *on):
    for name in SWITCHES:
        monkeypatch.delenv(name, raising=False)
    for name in on:
        monkeypatch.setenv(name, "true")


def card(tool, args, answer):
    text, is_json, is_yaml = _format_tool_result(tool, args, json.dumps(answer))
    return _build_tool_display(tool, args, text, is_json, is_yaml)


@pytest.mark.parametrize("on", [("AI_PAST_HINTS",), ("AI_PAST_HINTS", "AI_TOOL_RESULT_DETAILS"), ("AI_TOOL_RESULT_DETAILS",)])
def test_an_empty_event_read_shows_why_with_either_switch(monkeypatch, on):
    only(monkeypatch, *on)
    assert card("k8s_get_events", {"namespace": "shop"}, {"empty_reason": REASON, "events": []}) == f"No resources found.\n{REASON}"


def test_events_of_an_admission_policy_alone_show_where_to_read_further_back(monkeypatch):
    only(monkeypatch, "AI_PAST_HINTS")
    assert card("k8s_get_events", {}, {"past_hint": REASON, "events": [POLICY]}) == f"{POLICY_TABLE}\n{REASON}"


def test_the_nodes_usage_shows_the_busiest_cpu_under_it(monkeypatch):
    only(monkeypatch, "NODE_NEIGHBORS_ENABLED", "NODE_NEIGHBORS_BUSIEST_CPU")
    assert card("get_node_metrics", {}, {"busiest_cpu": LINE, "nodes": NODES}) == f"{NODES_TABLE}\n{LINE}"


@pytest.mark.parametrize("answer, want", [
    ([], "No resources found."),
    (NODES, NODES_TABLE),
    # one node's neighbours, whose busiest CPU is no sentence, and a refusal: no table, as before
    ({"node": {"busiest_cpu": {"cpu": "1"}}, "containers": []}, None),
    ({"status": "unavailable", "feature": "metrics-server"}, None),
    ({"busiest_cpu": LINE}, None),
    ({"busiest_cpu": LINE, "nodes": "x"}, None),
    ({"nodes": NODES}, None),
])
@pytest.mark.parametrize("on", [(), ("NODE_NEIGHBORS_ENABLED", "NODE_NEIGHBORS_BUSIEST_CPU")])
def test_the_other_node_answers_are_the_cards_they_were(monkeypatch, on, answer, want):
    only(monkeypatch, *on)
    assert card("get_node_metrics", {}, answer) == want


def test_off_a_reason_in_an_answer_is_not_shown(monkeypatch):
    only(monkeypatch)
    assert card("k8s_get_events", {}, {"empty_reason": REASON, "events": []}) == "No resources found."


def test_neither_switch_changes_a_tool_the_model_is_offered(monkeypatch):
    only(monkeypatch)
    off = json.dumps(offer_node_neighbors(offer_result_details([*CLUSTER_METRICS_TOOLS, *K8S_READONLY_TOOLS])))
    only(monkeypatch, "AI_PAST_HINTS", "NODE_NEIGHBORS_BUSIEST_CPU")
    assert json.dumps(offer_node_neighbors(offer_result_details([*CLUSTER_METRICS_TOOLS, *K8S_READONLY_TOOLS]))) == off
