"""An alert's generatorURL reaches the model as its rule's expression only: the address of the server that sent the
alert (scheme, host, port, path, a user and password) is the install's own and stays out. The screens read the stored
row, which keeps the link as it came. The rule's cases are shared with tool-server (fixtures/alert_expr_cases.json),
whose alerts_inbox and investigations tools give the same expr."""
import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from app.services.investigation import runner
from tests.test_alert_investigation import FakeService, cfg, completion, install_loop, row

CASES = json.loads((Path(__file__).parent / "fixtures" / "alert_expr_cases.json").read_text())["cases"]
LINKS = {c["name"]: c["link"] for c in CASES}
EXPR = 'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="apps"}[5m])) > 0.9'


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_each_shared_case(case):
    assert runner.rule_expressions(case["link"]) == case["expr"]
    view = runner.alert_view(row(generator_url=case["link"]))
    assert "generatorURL" not in view
    if not case["expr"]:
        assert "expr" not in view
    else:
        assert view["expr"] == (case["expr"][0] if len(case["expr"]) == 1 else case["expr"])


def test_no_value_reads_as_none():
    assert runner.rule_expressions(None) == []
    assert "expr" not in runner.alert_view(row(generator_url=None))


def address_parts(url: str) -> list[str]:
    """What an address says about the server: scheme, host, port, path, user and password."""
    parts = urlsplit(url)
    found = [f"{parts.scheme}://", parts.hostname, parts.path]
    found += [str(parts.port)] if parts.port else []
    found += [parts.username, parts.password] if parts.username else []
    return [p for p in found if p]


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["Prometheus", "Thanos Ruler", "a Grafana-managed rule's page",
                                  "a user and password in the address"])
async def test_the_model_gets_the_expression_and_no_part_of_the_address(monkeypatch, name):
    url = LINKS[name]
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
