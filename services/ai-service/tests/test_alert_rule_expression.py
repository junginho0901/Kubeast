"""An alert's generatorURL reaches the model as its rule's expression only: the address of the server that sent the
alert (scheme, host, port, path, a user and password) is the install's own and stays out. The screens read the stored
row, which keeps the link as it came."""
import json
from urllib.parse import quote_plus, urlsplit

import pytest

from app.services.investigation import runner
from tests.test_alert_investigation import FakeService, cfg, completion, install_loop, row

EXPR = 'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="apps"}[5m])) > 0.9'
Q = quote_plus(EXPR)  # as Prometheus writes it (Go's url.QueryEscape)

# What each sender writes: Prometheus (its external URL + /graph), Thanos Ruler (--alert.query-url + /graph) and a
# Grafana-managed rule (the rule's page, which holds no expression).
PROMETHEUS = f"http://prometheus-k8s.monitoring.svc:9090/graph?g0.expr={Q}&g0.tab=1"
THANOS = f"https://thanos-query.example.com:10902/query/graph?g0.expr={Q}&g0.tab=1"
GRAFANA = "https://grafana.example.com/alerting/grafana/f2d7c8a1-6b1e-4c3e-9a8f-0d5b7e9c1a22/view?orgId=1"
WITH_PASSWORD = f"https://promreader:not-a-real-password-9@prom.example.com:9443/prometheus/graph?g0.expr={Q}&g0.tab=table"


@pytest.mark.parametrize("url, expected", [
    (PROMETHEUS, [EXPR]),
    (THANOS, [EXPR]),
    (GRAFANA, []),
    (WITH_PASSWORD, [EXPR]),
], ids=["prometheus", "thanos", "grafana", "with-password"])
def test_a_generator_url_gives_its_rules_expression(url, expected):
    assert runner.rule_expressions(url) == expected


@pytest.mark.parametrize("url", [
    "",
    "   ",
    None,
    "/graph",  # a relative path with no expression
    "not a link",
    "g0.expr=up",  # no query
    "http://prometheus:9090/graph?g0.tab=1",
    "http://prometheus:9090/graph?g0.expr=&g0.tab=1",
    "http://prometheus:9090/graph?g0.expr=%20%20",
    "http://[::1/graph?g0.expr=up",  # a broken address: urlsplit refuses the unclosed bracket
    "http://prometheus:9090/graph?expr=up&query=up",  # another tool's keys
    f"http://prometheus:9090/graph?g{'1' * 4}.expr=up",  # past the panel numbers read
], ids=["empty", "spaces", "none", "relative-no-expr", "text", "no-query", "no-expr", "blank-expr", "spaces-expr",
        "broken", "other-keys", "long-panel-number"])
def test_a_value_without_an_expression_gives_none_and_the_alert_has_no_expr(url):
    assert runner.rule_expressions(url) == []
    view = runner.alert_view(row(generator_url=url))
    assert "expr" not in view and "generatorURL" not in view


def test_a_relative_link_or_one_with_a_bad_port_still_gives_only_the_expression():
    assert runner.rule_expressions("/graph?g0.expr=up&g0.tab=1") == ["up"]
    assert runner.rule_expressions("http://prometheus:notaport/graph?g0.expr=up") == ["up"]


def test_several_panels_come_in_their_order():
    url = "http://prometheus:9090/graph?g1.expr=b&g0.tab=1&g0.expr=a&g2.expr=&g10.expr=c"
    assert runner.rule_expressions(url) == ["a", "b", "c"]
    assert runner.alert_view(row(generator_url=url))["expr"] == ["a", "b", "c"]
    assert runner.alert_view(row(generator_url=PROMETHEUS))["expr"] == EXPR


def address_parts(url: str) -> list[str]:
    """What an address says about the server: scheme, host, port, path, user and password."""
    parts = urlsplit(url)
    found = [f"{parts.scheme}://", parts.hostname, parts.path]
    found += [str(parts.port)] if parts.port else []
    found += [parts.username, parts.password] if parts.username else []
    return [p for p in found if p]


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [PROMETHEUS, THANOS, GRAFANA, WITH_PASSWORD],
                         ids=["prometheus", "thanos", "grafana", "with-password"])
async def test_the_model_gets_the_expression_and_no_part_of_the_address(monkeypatch, url):
    service = FakeService([completion(content="## Summary\nCPU is high.")])
    install_loop(monkeypatch, service, [])
    r = row(generator_url=url)
    await runner.investigate(cfg(max_steps=5), r)
    sent = json.dumps(service.completions.calls, ensure_ascii=False, default=str)
    first = service.completions.calls[0]["messages"][1]["content"]
    for part in address_parts(url):
        assert part not in sent, part
    assert "generatorURL" not in sent and "g0.tab" not in sent and "orgId" not in sent
    fenced = first[first.index("<<<ALERT"):first.index("ALERT>>>")]
    if runner.rule_expressions(url):
        assert f'"expr": {json.dumps(EXPR)}' in fenced  # inside the alert's markers, as untrusted data
    else:
        assert '"expr"' not in sent
    # the screens read the row, which keeps the link
    assert r.generator_url == url
