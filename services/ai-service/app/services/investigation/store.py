"""alert_investigations rows: the webhook's gates, the worker's queue, the admin API."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import func, select, text, update

from app.database import AlertInvestigation, utcnow

# Rows a repeat of the same alert folds into (a skipped one may be tried again).
_DEDUPE_STATUSES = ("queued", "running", "done", "failed")
# Rows that count against the hourly cap.
_CAP_STATUSES = ("queued", "running", "done", "failed")


async def cluster_exists(db, cluster: str) -> bool:
    """The clusters table belongs to auth-service; every service shares the database."""
    async with db.async_session() as s:
        row = (await s.execute(text("SELECT 1 FROM clusters WHERE id = :id"), {"id": cluster})).first()
        return row is not None


async def find_recent(db, cluster: str, fingerprint: str, since: datetime) -> Optional[AlertInvestigation]:
    async with db.async_session() as s:
        q = (
            select(AlertInvestigation)
            .where(
                AlertInvestigation.cluster == cluster,
                AlertInvestigation.fingerprint == fingerprint,
                AlertInvestigation.received_at >= since,
                AlertInvestigation.status.in_(_DEDUPE_STATUSES),
            )
            .order_by(AlertInvestigation.received_at.desc())
            .limit(1)
        )
        return (await s.execute(q)).scalars().first()


async def bump_repeat(db, inv_id: str, now: datetime) -> None:
    async with db.async_session() as s:
        await s.execute(
            update(AlertInvestigation)
            .where(AlertInvestigation.id == inv_id)
            .values(repeat_count=AlertInvestigation.repeat_count + 1, last_seen_at=now)
        )
        await s.commit()


async def count_since(db, since: datetime) -> int:
    async with db.async_session() as s:
        q = select(func.count()).select_from(AlertInvestigation).where(
            AlertInvestigation.received_at >= since, AlertInvestigation.status.in_(_CAP_STATUSES)
        )
        return int((await s.execute(q)).scalar() or 0)


async def tokens_since(db, since: datetime) -> int:
    async with db.async_session() as s:
        q = select(func.coalesce(func.sum(AlertInvestigation.total_tokens), 0)).where(
            AlertInvestigation.received_at >= since
        )
        return int((await s.execute(q)).scalar() or 0)


async def insert(db, **fields: Any) -> str:
    inv_id = fields.pop("id", None) or f"inv-{uuid.uuid4().hex[:16]}"
    now = utcnow()
    row = AlertInvestigation(id=inv_id, received_at=fields.pop("received_at", now), last_seen_at=now, **fields)
    async with db.async_session() as s:
        s.add(row)
        await s.commit()
    return inv_id


async def claim_next(db) -> Optional[AlertInvestigation]:
    """Oldest queued row → running. SKIP LOCKED: replicas never take the same row."""
    async with db.async_session() as s:
        q = (
            select(AlertInvestigation)
            .where(AlertInvestigation.status == "queued")
            .order_by(AlertInvestigation.received_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        row = (await s.execute(q)).scalars().first()
        if row is None:
            await s.rollback()
            return None
        row.status = "running"
        row.started_at = utcnow()
        await s.commit()
        await s.refresh(row)
        s.expunge(row)
        return row


async def finish(db, inv_id: str, **fields: Any) -> None:
    fields.setdefault("finished_at", utcnow())
    async with db.async_session() as s:
        await s.execute(update(AlertInvestigation).where(AlertInvestigation.id == inv_id).values(**fields))
        await s.commit()


async def fail_stale_running(db, started_before: datetime) -> int:
    """Running rows started before the time limit: the process running them stopped.
    Only stale ones, so a replica never fails a row another replica is still on."""
    async with db.async_session() as s:
        res = await s.execute(
            update(AlertInvestigation)
            .where(AlertInvestigation.status == "running", AlertInvestigation.started_at < started_before)
            .values(status="failed", error="interrupted: the investigation outlived its time limit (ai-service stopped?)", finished_at=utcnow())
        )
        await s.commit()
        return int(res.rowcount or 0)


async def model_config_id(db, name: str) -> Optional[int]:
    from app.database import ModelConfig

    async with db.async_session() as s:
        row = (await s.execute(select(ModelConfig.id).where(ModelConfig.name == name, ModelConfig.enabled.is_(True)))).first()
        return int(row[0]) if row else None


async def list_rows(
    db, *, status: str = "", cluster: str = "", limit: int = 50, offset: int = 0
) -> tuple[list[AlertInvestigation], int]:
    async with db.async_session() as s:
        conds = []
        if status:
            conds.append(AlertInvestigation.status == status)
        if cluster:
            conds.append(AlertInvestigation.cluster == cluster)
        total = int((await s.execute(select(func.count()).select_from(AlertInvestigation).where(*conds))).scalar() or 0)
        q = select(AlertInvestigation).where(*conds).order_by(AlertInvestigation.received_at.desc()).limit(limit).offset(offset)
        return list((await s.execute(q)).scalars().all()), total


async def get(db, inv_id: str) -> Optional[AlertInvestigation]:
    async with db.async_session() as s:
        return (await s.execute(select(AlertInvestigation).where(AlertInvestigation.id == inv_id))).scalars().first()


def day_start(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def hour_ago(now: datetime) -> datetime:
    return now - timedelta(hours=1)
