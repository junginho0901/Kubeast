"""features.callGraph in an alert investigation: off, the prompt reads as before; on, it asks for who calls whom
(resource_graph include calls) when several workloads fail and for the cause → … → symptom path with the call behind
each link."""

from app.services.ai.tools import K8S_READONLY_TOOLS
from app.services.investigation import prompt, settings


def _prompt(**kw):
    return prompt.system_prompt(cluster="c1", namespace="shop", language="en", **kw)


def test_off_by_default_and_the_prompt_is_unchanged():
    off = _prompt()
    assert off == _prompt(call_paths=False)
    assert "include [\"calls\"]" not in off and "cause → … → symptom" not in off and "calls.suspects" not in off
    assert off.count("\n- ") == _prompt(call_paths=True).count("\n- ") - 3
    assert "failing_outside" not in off and "root cause" not in off


def test_on_asks_for_the_calls_and_the_path():
    on = _prompt(call_paths=True)
    rule = on.index("include [\"calls\"]")
    assert on.index("When alerts_list is offered") < rule < on.index("When prometheus_rules is offered")
    assert "calls.suspects" in on and "calls.paths" in on and "more often its victim than its cause" in on
    assert "cause → … → symptom" in on and "the [call N] number shown before the result that showed it" in on and "marked as a guess" in on
    # a failing call outside the graph may hold the cause
    assert "failing_outside" in on and "cause may be outside the graph" in on
    # what changed at the first workload is the root cause, read with timeline
    change = on.index("Find what changed at a path's first workload")
    assert on.index("calls.paths lists") < change < on.index("Under \"Likely cause\"")
    assert "with timeline" in on[change:] and "root cause" in on[change:] and "a rollout" in on[change:]
    # the headings stay the four the report screen and the unit test read
    for heading in prompt.REPORT_HEADINGS:
        assert f"## {heading}" in on


def test_the_names_it_uses_are_the_tools():
    graph = next(t for t in K8S_READONLY_TOOLS if t["function"]["name"] == "resource_graph")["function"]
    assert {"include", "since"} <= set(graph["parameters"]["properties"])
    assert graph["parameters"]["properties"]["include"]["items"]["enum"] == ["calls"]


def test_the_switch_is_the_chart_value(monkeypatch):
    monkeypatch.delenv("CALL_GRAPH_ENABLED", raising=False)
    assert settings.load().call_paths is False
    monkeypatch.setenv("CALL_GRAPH_ENABLED", "true")
    assert settings.load().call_paths is True
    monkeypatch.setenv("CALL_GRAPH_ENABLED", "no")
    assert settings.load().call_paths is False
