"""alert_inbox rows: every alert Alertmanager sent, firing or resolved, and Kubeast's own handling marks.

One row per cluster + fingerprint + starts_at (Alertmanager keeps starts_at while an alert goes on firing; one that
fires again after it resolved has a new one). The state changes only with what Alertmanager sends: a resolved
notification closes the row, a late firing copy of it (an HA pair) does not open it again.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError

from app.database import AlertInboxItem, AlertInvestigation

FIRING, RESOLVED, STALE = "firing", "resolved", "stale"
STATUSES = (FIRING, STALE, RESOLVED)


async def _row(s, cluster: str, fingerprint: str, starts_at: Optional[datetime]) -> Optional[AlertInboxItem]:
    q = select(AlertInboxItem).where(AlertInboxItem.cluster == cluster, AlertInboxItem.fingerprint == fingerprint)
    if starts_at is not None:
        q = q.where(AlertInboxItem.starts_at == starts_at)
    else:  # a hand-made message without startsAt: the alert's newest row
        q = q.order_by(AlertInboxItem.starts_at.desc()).limit(1)
    return (await s.execute(q)).scalars().first()


async def record(
    db, *, cluster: str, fingerprint: str, firing: bool, starts_at: Optional[datetime], ends_at: Optional[datetime],
    labels: dict, annotations: dict, generator_url: str, alertmanager_url: str, receiver: str, group_key: str, now: datetime,
) -> str:
    """Stores one alert of a webhook message: "new", "repeat" (the same alert again) or "resolved" (closed now)."""
    for attempt in range(2):
        async with db.async_session() as s:
            row = await _row(s, cluster, fingerprint, starts_at)
            if row is not None and (starts_at is not None or row.state == FIRING or not firing):
                row.received_count += 1
                row.last_received_at = now
                row.labels, row.annotations = dict(labels), dict(annotations)
                outcome = "repeat"
                if not firing and row.state == FIRING:
                    row.state, row.resolved_at, outcome = RESOLVED, ends_at or now, "resolved"
                await s.commit()
                return outcome
            s.add(AlertInboxItem(
                id=str(uuid.uuid4()), cluster=cluster, fingerprint=fingerprint, starts_at=starts_at or now,
                alertname=(labels.get("alertname") or "")[:200], severity=(labels.get("severity") or "").strip().lower()[:50],
                namespace=(labels.get("namespace") or "")[:63], labels=dict(labels), annotations=dict(annotations),
                state=FIRING if firing else RESOLVED, resolved_at=None if firing else (ends_at or now),
                first_received_at=now, last_received_at=now, generator_url=generator_url[:2000],
                alertmanager_url=alertmanager_url[:2000], receiver=receiver[:200], group_key=group_key[:2000],
            ))
            try:
                await s.commit()
                return "new" if firing else "resolved"
            except IntegrityError:  # the same alert stored by a parallel delivery: count this one on that row
                await s.rollback()
                if attempt:
                    raise
    return "repeat"


def status_of(row: AlertInboxItem, stale_before: datetime) -> str:
    if row.state != FIRING:
        return RESOLVED
    return STALE if row.last_received_at < stale_before else FIRING


async def list_rows(
    db, *, cluster: str, status: str = "", severity: str = "", assignee: str = "", open_only: bool = False,
    stale_before: datetime, limit: int = 50, offset: int = 0,
) -> tuple[list[AlertInboxItem], int, dict[str, int]]:
    """A cluster's alerts, firing first then newest, and how many there are per status (before the status filter)."""
    base = [AlertInboxItem.cluster == cluster]
    if severity:
        base.append(AlertInboxItem.severity == severity)
    if assignee:
        base.append(AlertInboxItem.assignee == assignee)
    if open_only:
        base.append(AlertInboxItem.done_at.is_(None))
    by_status = {
        FIRING: [AlertInboxItem.state == FIRING, AlertInboxItem.last_received_at >= stale_before],
        STALE: [AlertInboxItem.state == FIRING, AlertInboxItem.last_received_at < stale_before],
        RESOLVED: [AlertInboxItem.state != FIRING],
    }
    async with db.async_session() as s:
        counts = {}
        for name, conds in by_status.items():
            q = select(func.count()).select_from(AlertInboxItem).where(*base, *conds)
            counts[name] = int((await s.execute(q)).scalar() or 0)
        conds = base + by_status.get(status, [])
        total = int((await s.execute(select(func.count()).select_from(AlertInboxItem).where(*conds))).scalar() or 0)
        q = (
            select(AlertInboxItem).where(*conds)
            .order_by(case((AlertInboxItem.state == FIRING, 0), else_=1), AlertInboxItem.last_received_at.desc())
            .limit(limit).offset(offset)
        )
        return list((await s.execute(q)).scalars().all()), total, counts


async def get(db, item_id: str) -> Optional[AlertInboxItem]:
    async with db.async_session() as s:
        return (await s.execute(select(AlertInboxItem).where(AlertInboxItem.id == item_id))).scalars().first()


async def investigations_for(db, rows: list[AlertInboxItem]) -> dict[str, AlertInvestigation]:
    """The newest investigation of each row's alert since it started (a repeat folded into an older investigation
    within the dedupe window counts: its last_seen_at moved on)."""
    if not rows:
        return {}
    async with db.async_session() as s:
        q = (
            select(AlertInvestigation)
            .where(AlertInvestigation.cluster == rows[0].cluster, AlertInvestigation.fingerprint.in_({r.fingerprint for r in rows}))
            .order_by(AlertInvestigation.received_at.desc())
        )
        found = list((await s.execute(q)).scalars().all())
    out = {}
    for r in rows:
        for inv in found:
            if inv.fingerprint == r.fingerprint and (inv.received_at >= r.starts_at or inv.last_seen_at >= r.starts_at):
                out[r.id] = inv
                break
    return out


MARKS = ("acknowledged", "assignee", "note", "done")


def marks_of(row: AlertInboxItem) -> dict[str, Any]:
    return {"acknowledged": bool(row.acked_at), "assignee": row.assignee, "note": row.note, "done": bool(row.done_at)}


MARK_COLUMNS = ("acked_by", "acked_at", "assignee", "note", "note_by", "note_at", "done_by", "done_at")


async def set_marks(db, item_id: str, changes: dict[str, Any], actor: str, now: datetime) -> Optional[tuple[dict, dict, dict]]:
    """Applies the handling marks in changes (a key of MARKS → its new value). Returns the marks that changed as
    (before, after) and the columns as they were (for restore_marks), or None when the row is gone."""
    async with db.async_session() as s:
        row = (await s.execute(select(AlertInboxItem).where(AlertInboxItem.id == item_id))).scalars().first()
        if row is None:
            return None
        before, columns = marks_of(row), {c: getattr(row, c) for c in MARK_COLUMNS}
        if "acknowledged" in changes and bool(changes["acknowledged"]) != before["acknowledged"]:
            row.acked_by, row.acked_at = (actor, now) if changes["acknowledged"] else ("", None)
        if "assignee" in changes:
            row.assignee = changes["assignee"]
        if "note" in changes and changes["note"] != row.note:
            row.note, row.note_by, row.note_at = changes["note"], actor, now
        if "done" in changes and bool(changes["done"]) != before["done"]:
            row.done_by, row.done_at = (actor, now) if changes["done"] else ("", None)
        after = marks_of(row)
        await s.commit()
    changed = [k for k in MARKS if before[k] != after[k]]
    return {k: before[k] for k in changed}, {k: after[k] for k in changed}, columns


async def restore_marks(db, item_id: str, columns: dict[str, Any]) -> None:
    """Puts the mark columns back as set_marks found them (the audit row for the change could not be stored)."""
    async with db.async_session() as s:
        row = (await s.execute(select(AlertInboxItem).where(AlertInboxItem.id == item_id))).scalars().first()
        if row is not None:
            for col, value in columns.items():
                setattr(row, col, value)
            await s.commit()


def stale_cutoff(now: datetime, hours: int) -> datetime:
    return now - timedelta(hours=hours)
