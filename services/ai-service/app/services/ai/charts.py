"""A graph under the answer: when the model runs prometheus_query with chart=true, the range result becomes chart
data the chat draws (and the saved message keeps), so the user sees the trend the answer talks about."""

from __future__ import annotations

import json
from typing import Any, Optional

CHART_UNITS = frozenset({"bytes", "percent", "cores", "seconds", "count", "rate"})
MAX_SERIES = 10
MAX_TITLE = 80
PROFILE_POINTS = 12


def for_model(chart: dict[str, Any]) -> str:
    """What the model reads instead of every point of a result it charted: per series the low, high, average and last
    value with a coarse profile — the whole result would be cut at the model's limit and read as missing data."""
    def profile(points: list) -> list:
        if len(points) <= PROFILE_POINTS:
            return points
        step = (len(points) - 1) / (PROFILE_POINTS - 1)
        return [points[round(i * step)] for i in range(PROFILE_POINTS)]

    series = []
    for s in chart["series"]:
        values = [v for _, v in s["points"]]
        series.append({
            "label": s["label"], "points": len(values), "min": min(values), "max": max(values),
            "avg": round(sum(values) / len(values), 6), "last": values[-1], "profile": profile(s["points"]),
        })
    return json.dumps({
        "chart_shown_to_user": True,
        "note": "The user sees every point of this result as a graph under your answer. Describe what it shows "
                "(levels, peaks and when, the last value); do not say points are missing.",
        "title": chart["title"], "unit": chart["unit"], "promql": chart["promql"],
        "start": chart["start"], "end": chart["end"], "step_seconds": chart["step_seconds"],
        "common_labels": chart["common_labels"], "series": series,
        "hidden_series": chart["hidden_series"], "truncated": chart["truncated"],
    }, ensure_ascii=False)


def _label(metric: dict[str, str], keys: list[str]) -> str:
    return ", ".join(f"{k}={metric[k]}" for k in keys if k in metric)


def chart_from_result(args: dict[str, Any], result: str) -> Optional[dict[str, Any]]:
    """Chart data for a prometheus_query result the model asked to show, or None (not asked, not a range, no
    series). Series are named by the labels that differ between them; the ones all series share go to
    common_labels. More than MAX_SERIES keeps the highest and counts the rest in hidden_series."""
    if not args.get("chart") or str(args.get("chart")).lower() in ("false", "0", ""):
        return None
    try:
        data = json.loads(result)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict) or not data.get("range"):
        return None
    raw = [r for r in data.get("results") or [] if isinstance(r, dict) and r.get("points")]
    if not raw:
        return None
    series = []
    for r in raw:
        metric = {k: str(v) for k, v in (r.get("metric") or {}).items() if k != "__name__"}
        points = [[p["t"], p["v"]] for p in r["points"] if isinstance(p, dict) and "t" in p and "v" in p]
        if points:
            series.append((metric, points))
    if not series:
        return None
    hidden = 0
    if len(series) > MAX_SERIES:
        series.sort(key=lambda s: max(v for _, v in s[1]), reverse=True)
        hidden = len(series) - MAX_SERIES
        series = series[:MAX_SERIES]
    keys = sorted({k for m, _ in series for k in m})
    common = {k: series[0][0][k] for k in keys if all(m.get(k) == series[0][0].get(k) for m, _ in series)}
    differing = [k for k in keys if k not in common]
    promql = str(data.get("promql") or args.get("promql") or "")
    unit = str(args.get("unit") or "").strip().lower()
    title = str(args.get("title") or "").strip()[:MAX_TITLE] or promql[:MAX_TITLE]
    return {
        "title": title,
        "unit": unit if unit in CHART_UNITS else "",
        "promql": promql,
        "start": data.get("start"),
        "end": data.get("end"),
        "step_seconds": data.get("step_seconds"),
        "common_labels": common,
        "series": [{"label": _label(m, differing) or title, "points": pts} for m, pts in series],
        "hidden_series": hidden,
        "truncated": bool(data.get("truncated")),
    }
