"""alert_investigations rows: the webhook's gates, the worker's queue, the admin API."""

from __future__ import annotations

import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from sqlalchemy import and_, case, func, or_, select, text, update

from app.database import AlertInboxItem, AlertInvestigation, utcnow
from app.services.investigation import outcomes, skip_reasons

# Rows a repeat of the same alert folds into (a skipped one may be tried again).
_DEDUPE_STATUSES = ("queued", "running", "done", "failed")
# Rows that count against the hourly cap.
_CAP_STATUSES = ("queued", "running", "done", "failed")
# An alert's investigation in one of these needs no new one when a person asks ("Investigate now").
BUSY_STATUSES = ("queued", "running", "done")


@asynccontextmanager
async def _session(db, held) -> AsyncIterator[Any]:
    """`held`, the session of a webhook decision (alert_locked), or one of this call's own."""
    if held is not None:
        yield held
        return
    async with db.async_session() as s:
        yield s


async def _written(s, held) -> None:
    """A write's end: committed in its own session, or sent in the held one, which alert_locked commits."""
    if held is None:
        await s.commit()
    else:
        await s.flush()


async def cluster_exists(db, cluster: str) -> bool:
    """The clusters table belongs to auth-service; every service shares the database."""
    async with db.async_session() as s:
        row = (await s.execute(text("SELECT 1 FROM clusters WHERE id = :id"), {"id": cluster})).first()
        return row is not None


async def find_recent(db, cluster: str, fingerprint: str, since: datetime, *, held=None) -> Optional[AlertInvestigation]:
    async with _session(db, held) as s:
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


async def bump_repeat(db, inv_id: str, now: datetime, *, held=None) -> None:
    async with _session(db, held) as s:
        await s.execute(
            update(AlertInvestigation)
            .where(AlertInvestigation.id == inv_id)
            .values(repeat_count=AlertInvestigation.repeat_count + 1, last_seen_at=now)
        )
        await _written(s, held)


async def find_recent_skipped(db, cluster: str, fingerprint: str, since: datetime, *,
                              held=None) -> Optional[AlertInvestigation]:
    """The alert's newest skipped row since `since`: skipping the same alert again folds into it (fold_skip)."""
    async with _session(db, held) as s:
        q = (
            select(AlertInvestigation)
            .where(
                AlertInvestigation.cluster == cluster,
                AlertInvestigation.fingerprint == fingerprint,
                AlertInvestigation.received_at >= since,
                AlertInvestigation.status == "skipped",
            )
            .order_by(AlertInvestigation.received_at.desc())
            .limit(1)
        )
        return (await s.execute(q)).scalars().first()


async def fold_skip(db, inv_id: str, reason: str, now: datetime, *, held=None) -> None:
    async with _session(db, held) as s:
        await s.execute(
            update(AlertInvestigation)
            .where(AlertInvestigation.id == inv_id)
            .values(repeat_count=AlertInvestigation.repeat_count + 1, last_seen_at=now, skip_reason=reason)
        )
        await _written(s, held)


async def count_since(db, since: datetime, *, held=None) -> int:
    """The webhook's investigations since `since` (the hourly cap; the ones people asked for do not count)."""
    async with _session(db, held) as s:
        q = select(func.count()).select_from(AlertInvestigation).where(
            AlertInvestigation.received_at >= since, AlertInvestigation.status.in_(_CAP_STATUSES),
            AlertInvestigation.requested_by == "",
        )
        return int((await s.execute(q)).scalar() or 0)


async def tokens_since(db, since: datetime, *, manual: bool = False, held=None) -> int:
    """The tokens of the webhook's investigations since `since`, or of the ones people asked for (manual): each daily
    budget counts its own. A run counts once it has finished (runner.claim_refusal keeps the next one waiting)."""
    async with _session(db, held) as s:
        q = select(func.coalesce(func.sum(AlertInvestigation.total_tokens), 0)).where(
            AlertInvestigation.received_at >= since,
            AlertInvestigation.requested_by != "" if manual else AlertInvestigation.requested_by == "",
        )
        return int((await s.execute(q)).scalar() or 0)


# The prefix runner.run_one writes before a failed run's error when the model provider refused it.
REFUSAL_PREFIX = "provider refused ("


async def last_refusal(db, *, held=None) -> Optional[AlertInvestigation]:
    """The newest failed run whose model provider refused it (runner.run_one's REFUSAL_PREFIX), or None."""
    async with _session(db, held) as s:
        q = (
            select(AlertInvestigation)
            .where(AlertInvestigation.status == "failed", AlertInvestigation.finished_at.is_not(None))
            .order_by(AlertInvestigation.finished_at.desc())
            .limit(1)
        )
        row = (await s.execute(q)).scalars().first()
        return row if row is not None and (row.error or "").startswith(REFUSAL_PREFIX) else None


_REFUSAL = re.compile(r"^provider refused \((\w+)(?:, until (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ))?\)")


async def pause_state(db, minutes: int, now: datetime, *, held=None) -> Optional[tuple[str, datetime, datetime]]:
    """(kind, refused at, until) while no investigation runs, else None: the model provider refused the newest failed
    run for credit or the key less than `minutes` ago, or for a usage window that has not lifted yet."""
    if minutes <= 0:
        return None
    row = await last_refusal(db, held=held)
    match = _REFUSAL.match(row.error or "") if row is not None else None
    if match is None or row.finished_at is None:
        return None
    kind, lifts = match.group(1), match.group(2)
    until = datetime.strptime(lifts, "%Y-%m-%dT%H:%M:%SZ") if lifts else row.finished_at + timedelta(minutes=minutes)
    if now >= until:
        return None
    return kind, row.finished_at, until


async def pause_reason(db, minutes: int, now: datetime, *, held=None) -> str:
    """Why no investigation runs now (pause_state as the skip reason), or ""."""
    state = await pause_state(db, minutes, now, held=held)
    return skip_reasons.provider_paused(*state) if state else ""


async def skip(db, inv_id: str, reason: str) -> None:
    """A queued row the worker will not run (a pause began after it came)."""
    async with db.async_session() as s:
        await s.execute(update(AlertInvestigation).where(AlertInvestigation.id == inv_id).values(status="skipped", skip_reason=reason))
        await s.commit()
    outcomes.ended(outcomes.SKIPPED)


async def insert(db, *, held=None, **fields: Any) -> str:
    inv_id = fields.pop("id", None) or f"inv-{uuid.uuid4().hex[:16]}"
    now = utcnow()
    row = AlertInvestigation(id=inv_id, received_at=fields.pop("received_at", now), last_seen_at=now, **fields)
    async with _session(db, held) as s:
        s.add(row)
        await _written(s, held)
    return inv_id


def alert_row_lock(cluster: str, fingerprint: str, starts_at: Optional[datetime]):
    """The FOR UPDATE of an alert's inbox row, the row inbox.record stored it in (without starts_at, the newest)."""
    q = select(AlertInboxItem.id).where(AlertInboxItem.cluster == cluster, AlertInboxItem.fingerprint == fingerprint)
    if starts_at is not None:
        q = q.where(AlertInboxItem.starts_at == starts_at)
    else:
        q = q.order_by(AlertInboxItem.starts_at.desc()).limit(1)
    return q.with_for_update()


@asynccontextmanager
async def alert_locked(db, cluster: str, fingerprint: str, starts_at: Optional[datetime]) -> AsyncIterator[Any]:
    """Holds the alert's inbox row lock, as queue_requested does, until the block ends: two deliveries of one alert
    at one moment, on one replica or two, decide one after the other, so the second finds the first one's row.

    On PostgreSQL it yields the session holding the lock, which the block passes as held= to every read and write
    of its decision: a delivery holds that one connection however long it waits for this lock or hourly_cap_locked
    (the holder needs no second one, so waiters cannot leave it without a connection), and its writes commit when the
    block ends, which lets the locks go. Under READ COMMITTED, PostgreSQL's default, each statement reads what was
    committed before it began, so a delivery that waited reads the rows of the one before it. A block that raises
    commits nothing. On sqlite (one process: local dev and tests) it yields None and each call commits in a session
    of its own, as before."""
    async with db.async_session() as s:
        (await s.execute(alert_row_lock(cluster, fingerprint, starts_at))).first()
        if not _postgres(db):
            yield None
            return
        yield s
        await s.commit()


# The pg_advisory_xact_lock key of the hourly cap: a fixed number no other lock of the database uses (auth-service's
# auditchain takes 7_432_119_027 and 7_432_119_028, its audit sinks 0x6b62617564736e6b; k8s-service's
# healthStatusLockKey 0x6b62686c74687374, through internal/pglock, is the replica writing clusters.health_status).
HOURLY_CAP_LOCK = 0x4B55424541535448  # "KUBEASTH"
# lock_timeout and statement_timeout while the hourly cap's lock is waited for and held: the deliveries of every
# replica queue on it, so its wait sets its own limits, kept to the transaction, over the connections' 15 s and 30 s
# (postgresql.sessionLimits, app/db_session.py).
HOURLY_CAP_LOCK_WAIT = "90s"


def _postgres(db) -> bool:
    return getattr(getattr(getattr(db, "engine", None), "dialect", None), "name", "") == "postgresql"


@asynccontextmanager
async def hourly_cap_locked(db, lock) -> AsyncIterator[None]:
    """While the block runs no other webhook delivery, on any replica, counts the past hour's investigations or
    writes its row: two different alerts at one moment on two replicas would each count without the other's row and
    both be queued past max_per_hour. On PostgreSQL a transaction lock taken in `lock`, the session alert_locked
    holds, so it needs no connection of its own and goes when that session commits the decision's writes; on sqlite
    (lock is None: one process, local dev and tests) nothing. The webhook enters it only while the cap is on."""
    if lock is not None and _postgres(db):
        await lock.execute(
            text("SELECT set_config('lock_timeout', :wait, true), set_config('statement_timeout', :wait, true)"),
            {"wait": HOURLY_CAP_LOCK_WAIT},
        )
        await lock.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": HOURLY_CAP_LOCK})
    yield


async def queue_requested(
    db, item: AlertInboxItem, *, requested_by: str, now: datetime, record: Callable[[str], Awaitable[bool]],
) -> tuple[Optional[str], bool]:
    """A person's "Investigate now" on an inbox alert: (the id of this firing's investigation, as
    inbox.investigations_for picks it, False) when one is queued, running or done, else (a new queued row's id, True)
    — written as the webhook writes a row, and kept only when record(id) stored its audit row ((None, False) when it
    did not). The inbox row stays locked meanwhile, so two presses at once queue one investigation."""
    async with db.async_session() as s:
        await s.execute(select(AlertInboxItem.id).where(AlertInboxItem.id == item.id).with_for_update())
        q = (
            select(AlertInvestigation)
            .where(
                AlertInvestigation.cluster == item.cluster,
                AlertInvestigation.fingerprint == item.fingerprint,
                or_(
                    AlertInvestigation.starts_at == item.starts_at,
                    and_(
                        or_(AlertInvestigation.starts_at.is_(None), AlertInvestigation.starts_at <= item.starts_at),
                        or_(AlertInvestigation.received_at >= item.first_received_at, AlertInvestigation.last_seen_at >= item.first_received_at),
                    ),
                ),
            )
            # the one holding this firing's starts_at first (a NULL starts_at sorts with the others)
            .order_by(case((AlertInvestigation.starts_at == item.starts_at, 0), else_=1), AlertInvestigation.received_at.desc())
            .limit(1)
        )
        current = (await s.execute(q)).scalars().first()
        if current is not None and current.status in BUSY_STATUSES:
            return current.id, False
        inv_id = f"inv-{uuid.uuid4().hex[:16]}"
        labels = item.labels or {}
        s.add(AlertInvestigation(
            id=inv_id, cluster=item.cluster, fingerprint=item.fingerprint, alertname=(item.alertname or "")[:200],
            severity=(item.severity or "")[:50], namespace=(item.namespace or "")[:63], status="queued", skip_reason="",
            labels=dict(labels), annotations=dict(item.annotations or {}), starts_at=item.starts_at,
            generator_url=(item.generator_url or "")[:2000], alertmanager_url=(item.alertmanager_url or "")[:2000],
            group_key=(item.group_key or "")[:2000], received_at=now, last_seen_at=now, requested_by=requested_by[:320],
        ))
        await s.flush()
        if not await record(inv_id):
            await s.rollback()
            return None, False
        await s.commit()
        return inv_id, True


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


STOPPED_TWICE = "interrupted: the server stopped twice"


async def requeue_or_fail(db, inv_id: str) -> str:
    """A running row whose ai-service is stopping before the run ended: back in the queue the first time (a replica or
    the pod that replaces it takes it from the start, stop_requeues counts it), failed the second time. Only while it
    is still running, so a row that ended stays as it ended. Answers "queued", "failed" or "" (nothing changed)."""
    async with db.async_session() as s:
        res = await s.execute(
            update(AlertInvestigation)
            .where(
                AlertInvestigation.id == inv_id,
                AlertInvestigation.status == "running",
                AlertInvestigation.stop_requeues == 0,
            )
            .values(status="queued", started_at=None, stop_requeues=AlertInvestigation.stop_requeues + 1)
        )
        if res.rowcount:
            await s.commit()
            return "queued"
        res = await s.execute(
            update(AlertInvestigation)
            .where(AlertInvestigation.id == inv_id, AlertInvestigation.status == "running")
            .values(status="failed", error=STOPPED_TWICE, finished_at=utcnow())
        )
        await s.commit()
        if res.rowcount:
            outcomes.ended(outcomes.FAILED)
        return "failed" if res.rowcount else ""


async def finish(db, inv_id: str, **fields: Any) -> None:
    fields.setdefault("finished_at", utcnow())
    async with db.async_session() as s:
        await s.execute(update(AlertInvestigation).where(AlertInvestigation.id == inv_id).values(**fields))
        await s.commit()
    outcomes.ended(fields.get("status", ""))  # a run's end: done or failed


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
        outcomes.ended(outcomes.FAILED, int(res.rowcount or 0))
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
        # id after the time: rows of one webhook share received_at, and pages must not repeat or skip them
        q = (select(AlertInvestigation).where(*conds)
             .order_by(AlertInvestigation.received_at.desc(), AlertInvestigation.id.desc()).limit(limit).offset(offset))
        return list((await s.execute(q)).scalars().all()), total


async def get(db, inv_id: str) -> Optional[AlertInvestigation]:
    async with db.async_session() as s:
        return (await s.execute(select(AlertInvestigation).where(AlertInvestigation.id == inv_id))).scalars().first()


def day_start(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def next_day(now: datetime) -> datetime:
    """When the daily token budgets start over: the next UTC midnight."""
    return day_start(now) + timedelta(days=1)


def hour_ago(now: datetime) -> datetime:
    return now - timedelta(hours=1)
