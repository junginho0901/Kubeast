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
    assert s["profile"][0] == [0, 0.0] and s["profile"][-1] == [119, 119.0] and s["max"] == 119.0 and s["last"] == 119.0
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
    assert summary["series"][1] == {"label": "pod=web-1", "points": 3, "min": 10.0, "max": 12.0, "avg": 11.0, "last": 12.0,
                                    "profile": [[1700000000, 10.0], [1700000060, 11.0], [1700000120, 12.0]]}

    service = _Service(range_result())
    events, entry, _ = await streaming._call_tool(
        service, None, None, "s1", [], None, "prometheus_query", {"promql": "x"},
        iteration=1, audit_actor=None, audit_http=None, call_id=0,
    )
    payload = json.loads(events[0].removeprefix("data: "))
    assert "chart" not in payload and "chart" not in entry and payload["call_id"] == 0
