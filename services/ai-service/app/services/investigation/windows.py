"""The time windows of one investigation, counted from the alert's start (HolmesGPT's: metrics either side of it, logs
from just before it, changes over the hours before it), and step 0: the timeline tool's changes view over the change
window and anomaly_rank over the metrics window, read before the first model call."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

CHANGES_TOOL = "timeline"
CHANGES_VIEW = "changes"
# features.alertInvestigation.narrowFirst: the narrowing over the metrics window, which anomaly_rank compares with the
# window of the same length before it. Its window is 5 minutes to 24 hours on whole minutes (its trace checks need them).
NARROW_TOOL = "anomaly_rank"
NARROW_MIN = timedelta(minutes=5)
LOGS_AFTER = timedelta(hours=1)  # the logs window's end after the start at the latest
LOGS_MAX_RANGE = timedelta(hours=24)  # the log search's longest range by default (LOG_SEARCH_MAX_RANGE)


@dataclass(frozen=True)
class Window:
    start: datetime
    end: datetime


@dataclass(frozen=True)
class Windows:
    anchor: datetime  # the alert's start, or now when it has none or names a later time
    now: datetime
    metrics: Window
    logs: Window
    changes: Window
    note: str = ""  # why the anchor is not the alert's start


def stamp(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _utc(t: datetime) -> datetime:
    """Rows keep UTC without a zone; a time with one is turned into that."""
    return t.astimezone(timezone.utc).replace(tzinfo=None) if t.tzinfo else t


def of(starts_at: Optional[datetime], now: datetime, cfg) -> Windows:
    """Ends never pass now: nothing is stored there yet. The logs window ends an hour after the start at the latest."""
    now = _utc(now)
    note = ""
    if starts_at is None:
        anchor, note = now, "the alert carries no start time, so the windows count from now"
    elif _utc(starts_at) > now:
        anchor, note = now, "the alert's start is later than now, so the windows count from now"
    else:
        anchor = _utc(starts_at)
    either_side = timedelta(minutes=cfg.metrics_window_minutes)
    logs_start = anchor - timedelta(minutes=cfg.logs_window_minutes)
    return Windows(
        anchor=anchor,
        now=now,
        metrics=Window(anchor - either_side, min(anchor + either_side, now)),
        logs=Window(logs_start, min(now, anchor + LOGS_AFTER, logs_start + LOGS_MAX_RANGE)),
        changes=Window(anchor - timedelta(hours=cfg.changes_window_hours), now),
        note=note,
    )


def describe(w: Windows, cfg) -> str:
    start = f"the alert's start, {stamp(w.anchor)}" if not w.note else f"{stamp(w.anchor)} ({w.note})"
    return (
        f"Time windows, counted from {start}; now is {stamp(w.now)}:\n"
        f"- metrics: {stamp(w.metrics.start)} to {stamp(w.metrics.end)} ({cfg.metrics_window_minutes} minutes either side of the start)\n"
        f"- logs: {stamp(w.logs.start)} to {stamp(w.logs.end)} (from {cfg.logs_window_minutes} minutes before the start, "
        "to an hour after it at the latest)\n"
        f"- changes: {stamp(w.changes.start)} to {stamp(w.changes.end)} (from {cfg.changes_window_hours} hours before the start)"
    )


def changes_args(w: Windows, namespace: str) -> dict[str, Any]:
    """The investigation's scope: the alert's namespace, or every namespace its token reads. A window that ends now
    leaves until_time to the tool, whose default end is now: the call then holds only times counted from the alert's
    start, so a recorded answer (AI_TOOL_REPLAY_MODE) is found again for the same alert."""
    args: dict[str, Any] = {"view": CHANGES_VIEW, "since_time": stamp(w.changes.start)}
    if w.changes.end != w.now:
        args["until_time"] = stamp(w.changes.end)
    if namespace:
        args["namespace"] = namespace
    return args


def _minute(t: datetime) -> datetime:
    return t.replace(second=0, microsecond=0)


def narrow_args(w: Windows, namespace: str) -> dict[str, Any]:
    """anomaly_rank over the metrics window, cut to whole minutes and at least NARROW_MIN long. A window that ends now leaves
    until_time to the tool, which ends it at the minute, as changes_args leaves it."""
    end = _minute(w.metrics.end)
    start = min(_minute(w.metrics.start), end - NARROW_MIN)
    args: dict[str, Any] = {"namespace": namespace, "since_time": stamp(start)}
    if w.metrics.end != w.now:
        args["until_time"] = stamp(end)
    return args


def is_narrowing_answer(raw: Any) -> bool:
    """anomaly_rank's answer lists its findings and the checks it could not run."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return False
    return isinstance(data, dict) and isinstance(data.get("findings"), list) and isinstance(data.get("not_run"), list)


def is_changes_answer(raw: Any) -> bool:
    """The changes view says view "changes" or lists its rows under changes. A timeline that does not know view (or
    a dispatch that drops it) answers its events and rollouts instead, which hold neither."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return False
    return isinstance(data, dict) and (data.get("view") == CHANGES_VIEW or isinstance(data.get("changes"), list))
