"""A graph under the answer: prometheus_query with chart=true becomes chart data in the result event and the
saved tool call; the call is numbered on both events."""

import json

import pytest

from app.services.ai import charts, streaming


def range_result(n_series=2, *, truncated=False):
    results = [
        {"metric": {"__name__": "x", "cluster": "kubeast-b", "namespace": "shop", "pod": f"web-{i}"},
         "points": [{"t": 1700000000 + 60 * k, "v": float(i * 10 + k)} for k in range(3)]}
        for i in range(n_series)
    ]
    return json.dumps({"promql": "sum by (pod) (x)", "range": True, "series": n_series, "results": results,
                       "start": "2026-10-19T00:00:00Z", "end": "2026-10-19T01:00:00Z", "step_seconds": 30,
                       **({"truncated": True} if truncated else {})})


def test_chart_names_series_by_the_labels_that_differ():
    c = charts.chart_from_result({"chart": True, "title": " 파드 메모리 ", "unit": "Bytes"}, range_result())
    assert c["title"] == "파드 메모리" and c["unit"] == "bytes" and c["step_seconds"] == 30
    assert c["common_labels"] == {"cluster": "kubeast-b", "namespace": "shop"}
    assert [s["label"] for s in c["series"]] == ["pod=web-0", "pod=web-1"]
    assert c["series"][1]["points"][0] == [1700000000, 10.0]
    assert c["hidden_series"] == 0 and c["truncated"] is False


def test_chart_keeps_the_highest_series_and_counts_the_rest():
    c = charts.chart_from_result({"chart": "true"}, range_result(13, truncated=True))
    assert len(c["series"]) == charts.MAX_SERIES and c["hidden_series"] == 3 and c["truncated"] is True
    assert c["series"][0]["label"] == "pod=web-12"  # highest values first
    assert c["title"] == "sum by (pod) (x)" and c["unit"] == ""  # no title: the expression; no unit given


@pytest.mark.parametrize("args,result", [
    ({}, range_result()),  # not asked for
    ({"chart": False}, range_result()),
    ({"chart": "false"}, range_result()),
    ({"chart": True}, json.dumps({"promql": "up", "range": False, "results": [{"metric": {}, "value": [1, "1"]}]})),  # instant
    ({"chart": True}, json.dumps({"status": "unavailable", "feature": "prometheus"})),
    ({"chart": True}, json.dumps({"promql": "up", "range": True, "results": []})),
    ({"chart": True}, "Error: boom"),
])
def test_no_chart_without_range_points(args, result):
    assert charts.chart_from_result(args, result) is None


def test_the_model_summary_keeps_a_coarse_profile_of_a_long_series():
    long = json.dumps({"promql": "x", "range": True, "start": "s", "end": "e", "step_seconds": 15,
                       "results": [{"metric": {}, "points": [{"t": i, "v": float(i)} for i in range(120)]}]})
    summary = json.loads(charts.for_model(charts.chart_from_result({"chart": True, "title": "t"}, long)))
    s = summary["series"][0]
    assert s["points"] == 120 and len(s["profile"]) == charts.PROFILE_POINTS
    assert s["profile"][0] == ["1970-01-01T00:00:00Z", 0.0] and s["profile"][-1] == ["1970-01-01T00:01:59Z", 119.0]
    assert s["max"] == 119.0 and s["max_at"] == "1970-01-01T00:01:59Z" and s["last"] == 119.0
    assert len(charts.for_model(charts.chart_from_result({"chart": True}, range_result(10)))) < 6000


def test_unknown_unit_is_dropped_and_a_single_series_is_named_by_the_title():
    c = charts.chart_from_result({"chart": True, "unit": "furlongs"}, range_result(1))
    assert c["unit"] == "" and c["series"][0]["label"] == "sum by (pod) (x)"  # no title either: the expression
    c = charts.chart_from_result({"chart": True, "title": "Node CPU"}, range_result(1))
    assert c["series"][0]["label"] == "Node CPU"


class _Service:
    def __init__(self, response):
        self.response = response
        self.tool_server = None

    async def _execute_function_with_context(self, name, args, ctx):
        return self.response


@pytest.mark.asyncio
async def test_call_tool_numbers_the_call_and_carries_the_chart():
    service = _Service(range_result())
    events, entry, llm_text = await streaming._call_tool(
        service, None, None, "s1", [], None, "prometheus_query", {"promql": "x", "chart": True, "title": "t"},
        iteration=1, audit_actor=None, audit_http=None, call_id=3,
    )
    payload = json.loads(events[0].removeprefix("data: "))
    assert payload["call_id"] == 3 and payload["chart"]["series"][0]["label"] == "pod=web-0"
    assert entry["call_id"] == 3 and entry["chart"] == payload["chart"]
    # The model reads a summary it can trust instead of a result cut at its limit.
    summary = json.loads(llm_text)
    assert summary["chart_shown_to_user"] is True and "do not say points are missing" in summary["note"]
    # times as UTC text, the peak's included: a small model misread unix seconds by 15 minutes (23 PR-3 probe)
    assert summary["series"][1] == {"label": "pod=web-1", "points": 3, "min": 10.0, "max": 12.0, "max_at": "2023-11-14T22:15:20Z",
                                    "avg": 11.0, "last": 12.0, "last_at": "2023-11-14T22:15:20Z",
                                    "profile": [["2023-11-14T22:13:20Z", 10.0], ["2023-11-14T22:14:20Z", 11.0], ["2023-11-14T22:15:20Z", 12.0]]}

    service = _Service(range_result())
    events, entry, _ = await streaming._call_tool(
        service, None, None, "s1", [], None, "prometheus_query", {"promql": "x"},
        iteration=1, audit_actor=None, audit_http=None, call_id=0,
    )
    payload = json.loads(events[0].removeprefix("data: "))
    assert "chart" not in payload and "chart" not in entry and payload["call_id"] == 0


@pytest.mark.asyncio
async def test_a_loki_metric_query_draws_too_and_a_log_query_does_not():
    metric = json.dumps({"logql": 'sum by (k8s_pod_name) (count_over_time({app="web"} |= "error" [5m]))', "kind": "metric", "range": True,
                         "series": 1, "results": [{"metric": {"k8s_pod_name": "web-1"}, "points": [{"t": 1700000000, "v": 3}, {"t": 1700000060, "v": 5}]}],
                         "step_seconds": 60})
    events, entry, llm_text = await streaming._call_tool(
        _Service(metric), None, None, "s1", [], None, "loki_query", {"logql": "x", "chart": True, "title": "에러 수", "unit": "count"},
        iteration=1, audit_actor=None, audit_http=None, call_id=1,
    )
    chart = json.loads(events[0].removeprefix("data: "))["chart"]
    assert chart["title"] == "에러 수" and chart["unit"] == "count" and chart["promql"].startswith("sum by (k8s_pod_name)")
    assert chart["series"] == [{"label": "에러 수", "points": [[1700000000, 3], [1700000060, 5]]}] and entry["chart"] == chart
    assert json.loads(llm_text)["chart_shown_to_user"] is True

    lines = json.dumps({"logql": '{app="web"}', "kind": "log", "returned": 1, "lines": [{"line": "boom"}]})
    events, entry, _ = await streaming._call_tool(
        _Service(lines), None, None, "s1", [], None, "loki_query", {"logql": "x", "chart": True},
        iteration=1, audit_actor=None, audit_http=None, call_id=2,
    )
    assert "chart" not in json.loads(events[0].removeprefix("data: ")) and "chart" not in entry


@pytest.mark.asyncio
async def test_a_range_result_too_long_to_read_reaches_the_model_summed_up():
    # 30 series × 120 points is far past the model's limit: it gets the ten highest summed up, not a cut result
    results = [{"metric": {"k8s_pod_name": f"web-{i}"}, "points": [{"t": 1700000000 + 60 * k, "v": float(i)} for k in range(120)]} for i in range(30)]
    long = json.dumps({"logql": "sum by (k8s_pod_name) (rate({app=\"web\"}[5m]))", "kind": "metric", "range": True, "series": 30, "results": results})
    events, entry, llm_text = await streaming._call_tool(
        _Service(long), None, None, "s1", [], None, "loki_query", {"logql": "x"},
        iteration=1, audit_actor=None, audit_http=None, call_id=0,
    )
    assert "chart" not in json.loads(events[0].removeprefix("data: ")) and "chart" not in entry
    summed = json.loads(llm_text)
    assert summed["chart_shown_to_user"] is False and "aggregate" in summed["note"] and "graph" not in summed["note"]
    assert summed["hidden_series"] == 20 and [s["label"] for s in summed["series"]][:2] == ["k8s_pod_name=web-29", "k8s_pod_name=web-28"]
    assert summed["series"][0]["max"] == 29.0 and len(summed["series"][0]["profile"]) == charts.PROFILE_POINTS

    # a short one is read as it is
    _, _, llm_text = await streaming._call_tool(
        _Service(range_result()), None, None, "s1", [], None, "prometheus_query", {"promql": "x"},
        iteration=1, audit_actor=None, audit_http=None, call_id=1,
    )
    assert json.loads(llm_text)["results"][0]["metric"]["pod"] == "web-0"


@pytest.mark.asyncio
async def test_traces_metrics_draws_with_its_traceql():
    res = json.dumps({"traceql": "{ status = error } | rate() by (resource.service.name)", "kind": "metric", "range": True, "series": 1,
                      "results": [{"metric": {"resource.service.name": "cart"}, "points": [{"t": 1700000000, "v": 0.5}, {"t": 1700000060, "v": 1.5}]}]})
    events, entry, _ = await streaming._call_tool(
        _Service(res), None, None, "s1", [], None, "traces_metrics", {"traceql": "x", "chart": True, "title": "오류율", "unit": "rate"},
        iteration=1, audit_actor=None, audit_http=None, call_id=0,
    )
    chart = json.loads(events[0].removeprefix("data: "))["chart"]
    assert chart["promql"].startswith("{ status = error }") and chart["unit"] == "rate" and chart["series"][0]["points"][1] == [1700000060, 1.5]
