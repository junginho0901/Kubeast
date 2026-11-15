"""The time windows of one investigation, counted from the alert's start (HolmesGPT's: metrics either side of it, logs
from just before it, changes over the hours before it), and step 0: the timeline tool's changes view over the change
window, read before the first model call."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

CHANGES_TOOL = "timeline"
CHANGES_VIEW = "changes"
# The logs window ends this long after the start at the latest, and is never longer than the log search's longest range
# (LOG_SEARCH_MAX_RANGE, 24 h by default), which refuses a longer one: an alert that started days ago is read near its
# start, not over the days since.
LOGS_AFTER = timedelta(hours=1)
LOGS_MAX_RANGE = timedelta(hours=24)


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


def is_changes_answer(raw: Any) -> bool:
    """The changes view says view "changes" or lists its rows under changes. A timeline that does not know view (or
    a dispatch that drops it) answers its events and rollouts instead, which hold neither."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return False
    return isinstance(data, dict) and (data.get("view") == CHANGES_VIEW or isinstance(data.get("changes"), list))
