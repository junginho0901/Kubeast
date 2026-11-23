"""ai.toolResultDetails in ai-service (app/services/ai/console_links.py): a read tool's result starts with the console
paths of what it names. The paths are relative, on pages the console routes and kinds its drawer opens, and no value a
result or the model's arguments carry can point one at another host. Off, every result is byte for byte what came."""
import json
import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.ai import console_links
from app.services.ai.tool_dispatch import execute_function_with_context
from tests.test_switch_cases import CASES

FRONTEND = Path(__file__).resolve().parents[3] / "frontend" / "src"

ISSUES = json.dumps({
    "namespace": "shop",
    "issues": [
        {"kind": "Pod", "namespace": "shop", "name": "web-7d9f8c6b5-x2k9p", "severity": "critical"},
        {"kind": "Deployment", "namespace": "shop", "name": "web", "severity": "warning"},
        {"kind": "Collector", "namespace": "", "name": "nodes", "severity": "info"},
    ],
})
TIMELINE = json.dumps({
    "namespace": "shop",
    "events": [{"reason": "BackOff", "involved_object": {"kind": "Pod", "name": "web-1", "namespace": "shop"}}],
})
# what the dispatch sends on and what each read answers, for the results that must stay as they came
CALLS = [
    ("issues", {"namespace": "shop"}, ISSUES),
    ("timeline", {"namespace": "shop"}, TIMELINE),
    ("k8s_get_pod_logs", {"namespace": "shop", "pod_name": "web-1", "container": "app"}, "line one\nline two"),
    ("prometheus_query", {"promql": "up"}, '{"promql":"up","results":[],"series":0}'),
    ("resource_graph", {"namespace": "shop"}, '{"summary":{"nodes":0},"nodes":[]}'),
    ("alerts_inbox", {"alert_id": "42"}, '{"alerts":[]}'),
]


def _service(result):
    service = SimpleNamespace()
    service.user_role = "admin"
    service.cluster_name = "self"
    service._is_tool_allowed = MagicMock(return_value=True)
    service._call_tool_server = AsyncMock(return_value=result)
    service.k8s_service = MagicMock()
    return service


def _ctx():
    return SimpleNamespace(state={}, cache={})


@pytest.fixture
def on(monkeypatch):
    monkeypatch.setenv(console_links.ENV, "true")


@pytest.fixture
def off(monkeypatch):
    monkeypatch.delenv(console_links.ENV, raising=False)


def test_the_switch_is_off_unset(monkeypatch):
    monkeypatch.delenv(console_links.ENV, raising=False)
    assert console_links.enabled() is False


@pytest.mark.parametrize("case", CASES, ids=lambda c: repr(c["value"]))
def test_the_switch_reads_the_one_switch_rule(monkeypatch, case):
    monkeypatch.setenv(console_links.ENV, case["value"])
    assert console_links.enabled() is case["on"]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,result", CALLS)
async def test_off_every_result_is_what_came(off, name, args, result):
    service = _service(result)
    out = await execute_function_with_context(service, name, args, _ctx())
    assert out == result


@pytest.mark.asyncio
async def test_on_the_links_come_first_and_the_result_after_them_is_what_came(on):
    service = _service(ISSUES)
    ctx = _ctx()
    out = await execute_function_with_context(service, "issues", {"namespace": "shop"}, ctx)
    assert out.startswith('{"console_links":')
    data = json.loads(out)
    assert {k: v for k, v in data.items() if k != "console_links"} == json.loads(ISSUES)
    assert out.endswith(ISSUES[1:])  # the result's own text, byte for byte
    paths = [link["path"] for link in data["console_links"]["links"]]
    assert paths == [
        "/workloads/pods?cluster=self&detail=Pod/shop/web-7d9f8c6b5-x2k9p",
        "/workloads/deployments?cluster=self&detail=Deployment/shop/web",
    ]
    assert data["console_links"]["links"][0]["for"] == "Pod shop/web-7d9f8c6b5-x2k9p"
    assert "[text](path)" in data["console_links"]["note"]
    assert list(ctx.cache.values()) == [out]  # the cache keeps what the model read


@pytest.mark.asyncio
async def test_on_the_call_names_its_own_objects(on):
    cases = [
        ("k8s_get_pod_logs", {"namespace": "shop", "pod_name": "web-1", "container": "app"}, '{"lines":[]}',
         "/workloads/pods?cluster=self&detail=Pod/shop/web-1"),
        ("logsearch", {"namespace": "shop", "workload_kind": "StatefulSet", "workload_name": "db"}, '{"lines":[]}',
         "/workloads/statefulsets?cluster=self&detail=StatefulSet/shop/db"),
        ("k8s_describe_resource", {"resource_type": "svc", "resource_name": "web", "namespace": "shop"}, '{"x":1}',
         "/network/services?cluster=self&detail=Service/shop/web"),
        ("nodes_log", {"node": "kind-worker"}, '{"entries":[]}', "/cluster/nodes?cluster=self&detail=Node/kind-worker"),
        ("alerts_inbox", {"alert_id": "42"}, '{"alerts":[]}', "/alerts?cluster=self&alert=42"),
        ("resource_graph", {"namespace": "shop"}, '{"nodes":[]}', "/cluster/resource-graph?cluster=self&namespace=shop"),
        ("timeline", {"namespace": "shop"}, TIMELINE, "/workloads/pods?cluster=self&detail=Pod/shop/web-1"),
    ]
    for name, args, result, path in cases:
        out = await execute_function_with_context(_service(result), name, args, _ctx())
        assert path in [link["path"] for link in json.loads(out)["console_links"]["links"]], name


@pytest.mark.asyncio
async def test_on_a_result_that_is_not_an_object_or_names_nothing_stays_as_it_came(on):
    for name, args, result in [
        ("k8s_get_pod_logs", {"namespace": "shop", "pod_name": "web-1", "container": "app"}, "line one\nline two"),
        ("prometheus_query", {"promql": "up"}, '{"promql":"up","results":[],"series":0}'),
        ("k8s_get_resources", {"resource_type": "pods", "namespace": "shop"}, "[1, 2]"),
        ("prometheus_query", {"promql": "up"}, "{not json"),
    ]:
        assert await execute_function_with_context(_service(result), name, args, _ctx()) == result


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", [
    {"status": "not_found", "reason": "pods \"web-1\" not found"},
    {"status": "unavailable", "feature": "prometheus"},
    {"status": "forbidden", "reason": "no"},
    {"error": "boom"},
])
async def test_on_a_result_with_a_status_or_an_error_gets_no_links(on, answer):
    refusal = json.dumps(answer)
    out = await execute_function_with_context(_service(refusal), "k8s_describe_resource",
                                              {"resource_type": "pod", "resource_name": "web-1", "namespace": "shop"}, _ctx())
    assert out == refusal


@pytest.mark.parametrize("namespace,name", [
    ("shop", "//other.example.com"),
    ("shop", "https://other.example.com/x"),
    ("shop", "web/../../admin"),
    ("shop", "Web"),
    ("shop", "web?x=1"),
    ("shop", "web#x"),
    ("shop", "web 1"),
    ("shop", "a" * 254),
    ("..", "web"),
    ("shop/x", "web"),
    ("", "web"),
])
def test_a_name_outside_kubernetes_rules_gets_no_link(namespace, name):
    assert console_links.object_path("self", "Pod", namespace, name) is None


def test_a_cluster_or_alert_id_outside_the_rules_gets_no_link():
    assert console_links.object_path("//x", "Pod", "shop", "web") is None
    assert console_links.object_path("a b", "Pod", "shop", "web") is None
    links = console_links.links_for("alerts_inbox", {"alert_id": "//other.example.com"}, {}, "self")
    assert links == []
    assert console_links.links_for("resource_graph", {"namespace": "Shop"}, {}, "self") == []


def test_a_kind_with_no_page_gets_no_link():
    for kind in ("Secret", "Collector", "Widget", None, "pod"):
        assert console_links.object_path("self", kind, "shop", "web") is None


def test_every_link_is_a_path_on_the_console():
    data = json.loads(ISSUES)
    data["issues"] += [{"kind": k, "namespace": "shop", "name": "x"} for k in console_links.LIST_PAGES]
    links = console_links.links_for("issues", {"namespace": "shop", "node": "n1", "alert_id": "7"}, data, "self")
    assert links
    for link in links:
        path = link["path"]
        assert path.startswith("/") and not path.startswith("//") and "\\" not in path and "://" not in path
        assert re.match(r"^/[a-z/-]+\?[A-Za-z0-9=&%/._-]+$", path), path


def test_at_most_eight_links_each_once():
    data = {"items": [{"kind": "Pod", "namespace": "shop", "name": f"web-{i}"} for i in range(30)]
            + [{"kind": "Pod", "namespace": "shop", "name": "web-0"}]}
    links = console_links.links_for("k8s_get_resources", {"resource_type": "pods"}, data, "self")
    assert len(links) == console_links.MAX_LINKS
    assert len({link["path"] for link in links}) == len(links)


def test_rows_without_a_kind_take_the_calls_resource_type():
    data = {"items": [{"namespace": "shop", "name": "web-0"}]}
    links = console_links.links_for("k8s_get_resources", {"resource_type": "pods", "namespace": "shop"}, data, "self")
    assert [link["path"] for link in links] == ["/workloads/pods?cluster=self&detail=Pod/shop/web-0"]


def test_an_empty_object_takes_the_block_alone():
    out = console_links.with_links("{}", [{"for": "Pod shop/web", "path": "/workloads/pods?cluster=self&detail=Pod/shop/web"}])
    assert json.loads(out)["console_links"]["links"][0]["for"] == "Pod shop/web"


def test_the_pages_are_routes_of_the_console_and_the_kinds_open_a_drawer():
    """Held to frontend/src: each page is a Route of App.tsx and each kind one the drawer draws (by name or by its set)."""
    app = (FRONTEND / "App.tsx").read_text(encoding="utf-8")
    routes = set(re.findall(r'<Route path="([^"*:]+)"', app))
    pages = set(console_links.LIST_PAGES.values()) | {console_links.ALERTS_PAGE, console_links.GRAPH_PAGE}
    for page in pages:
        assert page.lstrip("/") in routes, page
    drawer = (FRONTEND / "components" / "ResourceDetailDrawer.tsx").read_text(encoding="utf-8")
    sets = (FRONTEND / "components" / "resource-detail" / "utils.ts").read_text(encoding="utf-8")
    drawn = set(re.findall(r"kind === '([A-Za-z]+)'", drawer))
    for name in ("WORKLOAD_KINDS", "NETWORK_KINDS", "CONFIG_STORAGE_KINDS"):
        listed = re.search(name + r" = new Set\(\[([^\]]*)\]\)", sets)
        assert listed, name
        drawn |= set(re.findall(r"'([A-Za-z]+)'", listed.group(1)))
    assert set(console_links.LIST_PAGES) <= drawn, set(console_links.LIST_PAGES) - drawn
    param = (FRONTEND / "components" / "ResourceDetailProvider.tsx").read_text(encoding="utf-8")
    assert "const DETAIL = 'detail'" in param


def test_a_result_longer_than_is_read_stays_as_it_came(monkeypatch, on):
    monkeypatch.setattr(console_links, "MAX_PARSE_CHARS", 10)
    assert console_links.add("issues", {"namespace": "shop", "pod": "web"}, ISSUES, "self") == ISSUES


def test_a_summed_range_result_keeps_what_tool_server_said_of_the_cut_and_the_window():
    """The chat reads a long or charted range result as charts.for_model's summary: the details go on with it, and a
    result without them is summed up as before."""
    from app.services.ai import charts

    result = {"promql": "x", "range": True, "start": "s", "end": "e", "step_seconds": 15,
              "results": [{"metric": {"pod": "a"}, "points": [{"t": 1, "v": 1.0}, {"t": 2, "v": 2.0}]}]}
    before = charts.for_model(charts.chart_from_result({"chart": True}, json.dumps(result)))
    assert "result_details" not in charts.chart_from_result({"chart": True}, json.dumps(result))
    detailed = dict(result, cut="100 of 340 series", default_window="No window was given (since): the last 1h was read (the default).")
    chart = charts.chart_from_result({"chart": True}, json.dumps(detailed))
    summary = json.loads(charts.for_model(chart))
    assert summary["cut"] == "100 of 340 series" and summary["default_window"].startswith("No window")
    assert {k: v for k, v in summary.items() if k not in ("cut", "default_window")} == json.loads(before)
