"""The chat's card of a read that found nothing: with ai.toolResultDetails tool-server's answer says why it may be empty
(empty_reason) and the card shows it under the table; off, the card is as it was."""
import json

import pytest

from app.services.ai.formatters import _build_tool_display, _format_tool_result

REASON = "No event matched. The API server keeps an event for about an hour by default."
NONE = "No resources found."
SERVICE = {"namespace": "shop", "service": "web", "type": "ClusterIP", "ports": [{"name": "http", "port": 80, "protocol": "TCP"}],
           "port_check": {}, "endpoints": {"ready": 0, "not_ready": 0, "total": 0}, "status": "NotReady"}
SERVICE_TABLE = ("NAMESPACE  SERVICE  TYPE       PORT(S)      ENDPOINTS  STATUS  \n"
                 "shop       web      ClusterIP  http:80/TCP  0/0        NotReady")
LIST = {"apiVersion": "v1", "items": [], "kind": "List", "metadata": {"resourceVersion": ""}}
LINKS = {"console_links": {"note": "n", "links": [{"for": "Pod shop/web-1", "path": "/workloads/pods"}]}}

# name: tool, arguments, the answer, the card as it was, and the table the reason goes under
CASES = {
    "events": ("k8s_get_events", {"namespace": "shop"}, {"empty_reason": REASON, "events": []}, NONE, NONE),
    "events with links": ("k8s_get_events", {"kind": "Pod", "name": "web-1"}, {**LINKS, "empty_reason": REASON, "events": []}, NONE, NONE),
    "pod metrics": ("get_pod_metrics", {"namespace": "shop"}, {"empty_reason": REASON, "pods": []}, None, NONE),
    "a JSON list": ("k8s_get_resources", {"resource_type": "configmaps", "output": "json"}, {"empty_reason": REASON, **LIST}, NONE, NONE),
    "a JSON list of pods": ("k8s_get_resources", {"resource_type": "pods", "output": "json"}, {"empty_reason": REASON, **LIST}, NONE, NONE),
    "a Service": ("k8s_check_service_connectivity", {"service_name": "web"}, {**SERVICE, "empty_reason": REASON}, SERVICE_TABLE, SERVICE_TABLE),
}


def card(tool, args, answer):
    text, is_json, is_yaml = _format_tool_result(tool, args, answer if isinstance(answer, str) else json.dumps(answer))
    return _build_tool_display(tool, args, text, is_json, is_yaml)


@pytest.mark.parametrize("name", CASES)
@pytest.mark.parametrize("value", [None, "", "false", "0"])
def test_off_the_card_is_as_it_was(monkeypatch, name, value):
    monkeypatch.delenv("AI_TOOL_RESULT_DETAILS", raising=False)
    if value is not None:
        monkeypatch.setenv("AI_TOOL_RESULT_DETAILS", value)
    tool, args, answer, was, _ = CASES[name]
    assert card(tool, args, answer) == was


@pytest.mark.parametrize("name", CASES)
def test_on_the_card_shows_why_under_the_table(monkeypatch, name):
    monkeypatch.setenv("AI_TOOL_RESULT_DETAILS", "true")
    tool, args, answer, _, table = CASES[name]
    assert card(tool, args, answer) == f"{table}\n{REASON}"


# What off answers, and what on answers where something was found: no reason in it, the same card on and off.
WITHOUT = {
    "no events": ("k8s_get_events", {}, [], NONE),
    "events": ("k8s_get_events", {}, [{"type": "Warning", "reason": "BackOff", "message": "m", "namespace": "shop", "object": {"kind": "Pod", "name": "web-1"}}],
               "NAMESPACE  LAST SEEN  TYPE     REASON   OBJECT     MESSAGE\nshop       -          Warning  BackOff  Pod/web-1  m      "),
    "more events than listed": ("k8s_get_events", {}, {"events": [], "total": 9, "shown": 0, "note": "the newest 0 of 9 events"}, NONE + "\nthe newest 0 of 9 events"),
    "no pod metrics": ("get_pod_metrics", {}, [], NONE),
    "pod metrics": ("get_pod_metrics", {}, [{"name": "web-1", "cpu": "5m", "memory": "20Mi"}], "NAME   CPU(cores)  MEMORY(bytes)\nweb-1  5m          20Mi         "),
    "pod metrics refused": ("get_pod_metrics", {}, {"status": "unavailable", "feature": "metrics-server"}, None),
    "pods that are no list": ("get_pod_metrics", {}, {"pods": "x", "empty_reason": REASON}, None),
    "pods without a reason": ("get_pod_metrics", {}, {"pods": []}, None),
    "a reason that is no text": ("get_pod_metrics", {}, {"pods": [], "empty_reason": {"a": 1}}, None),
    "a blank reason": ("k8s_get_events", {}, {"events": [], "empty_reason": "  "}, NONE),
    "a JSON list": ("k8s_get_resources", {"resource_type": "configmaps", "output": "json"}, LIST, NONE),
    "a table": ("k8s_get_resources", {"resource_type": "configmaps"}, f"No resources found in shop namespace.\n{REASON}\n", None),
    "a Service": ("k8s_check_service_connectivity", {}, SERVICE, SERVICE_TABLE),
    "an object with the key": ("k8s_get_resources", {"resource_type": "foos", "namespace": "shop", "output": "json"},
                               {"kind": "Foo", "metadata": {"name": "web"}, "empty_reason": REASON}, "NAME  AGE\nweb   -  "),
}


@pytest.mark.parametrize("name", WITHOUT)
@pytest.mark.parametrize("value", ["", "true"])
def test_a_card_without_a_reason_is_the_same_on_and_off(monkeypatch, name, value):
    monkeypatch.setenv("AI_TOOL_RESULT_DETAILS", value)
    tool, args, answer, want = WITHOUT[name]
    assert card(tool, args, answer) == want
