"""features.nodeNeighbors in an alert investigation: the prompt says when to read the node slow pods run on
(get_node_metrics with node), for an alert without a namespace: the token of one with a namespace is limited to it and is
refused the tool. Off, the prompt is what it was, to the byte."""
import itertools
from types import SimpleNamespace

import pytest

from app.services.ai.permissions import namespace_scope_error
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import runner
from app.services.investigation.settings import InvestigationSettings, load
from app.services.tool_whitelists import READONLY_TOOL_NAMES
from tests.test_alert_investigation import FakeService, cfg, completion, install_loop, row
from tests.test_switch_cases import CASES


def test_the_line_is_added_once_and_only_with_the_switch():
    for rules, call_paths, verdict in itertools.product((False, True), repeat=3):
        kw = dict(cluster="self", namespace="apps", language="en", rules=rules, call_paths=call_paths, verdict=verdict)
        off, on = inv_prompt.system_prompt(**kw), inv_prompt.system_prompt(**kw, node_neighbors=True)
        assert on.replace(inv_prompt._NODE_READ, "", 1) == off and "get_node_metrics" not in off
        assert on.count(inv_prompt._NODE_READ) == 1 and inv_prompt._NODE_READ.endswith("\n")
    assert {"get_node_metrics", "k8s_describe_resource"} <= READONLY_TOOL_NAMES  # what the line tells it to call


@pytest.mark.parametrize("case", CASES, ids=lambda c: repr(c["value"]))
def test_the_switch_reads_the_one_switch_rule(monkeypatch, case):
    monkeypatch.setenv("NODE_NEIGHBORS_ENABLED", case["value"])
    assert load().node_neighbors is case["on"]


def test_the_switch_is_off_by_default(monkeypatch):
    monkeypatch.delenv("NODE_NEIGHBORS_ENABLED", raising=False)
    assert InvestigationSettings().node_neighbors is False and load().node_neighbors is False


@pytest.mark.parametrize("namespace", ["apps", ""])
@pytest.mark.parametrize("on", [False, True])
@pytest.mark.asyncio
async def test_a_run_has_the_line_only_with_the_switch_and_a_token_that_spans_the_cluster(monkeypatch, on, namespace):
    service = FakeService([completion(content="## Summary\nok")])
    install_loop(monkeypatch, service, [])

    async def token(cfg, cluster, ns):
        assert (cluster, ns) == ("self", namespace)
        return "investigator-token"

    monkeypatch.setattr(runner, "fetch_token", token)
    await runner.investigate(cfg(node_neighbors=on), row(namespace=namespace))
    system = service.completions.calls[0]["messages"][0]["content"]
    said = on and not namespace
    assert system == inv_prompt.system_prompt(cluster="self", namespace=namespace, language="en", node_neighbors=said)
    assert (inv_prompt._NODE_READ in system) is said


def test_the_token_of_an_alert_with_a_namespace_is_refused_the_tool():
    def scoped(*namespaces):
        return SimpleNamespace(namespaces={"self": namespaces}, has_permission=lambda p: True)

    assert "spans the cluster" in namespace_scope_error(scoped("apps"), "self", "get_node_metrics", {"node": "n1"})
    assert namespace_scope_error(scoped(), "self", "get_node_metrics", {"node": "n1"}) is None
