"""The earlier investigations of one alert (features.alertInvestigation.pastReports.window, off by default).

They are read from the alert_investigations rows a run keeps anyway: no table, no column, nothing written. One read takes
the done investigations of the same alert — the same fingerprint on the same cluster in the same namespace (an alert
without one: those without one) — received in the last DAYS days before the one at hand, newest first, at most READ_ROWS
of them and never a report's text. A cluster removed and registered again under its name starts with none.

The alert's window in Alerts lists at most MAX_LINES of them for whoever reads that window (the whole cluster), each with
its outcome and causes as the report's own window shows them; opening one is the report's audited read (api_alert_inbox).
None of it reaches a model: an investigation is not told of them, and reads no stored report through alerts_inbox either,
whatever the switch (asks_for_report).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import DateTime, String, column, select, table

from app.database import AlertInvestigation
from app.services.investigation import rca, verdict

log = logging.getLogger(__name__)

DAYS = 30
MAX_LINES = 5
READ_ROWS = 20
READ_SECONDS = 3
MAX_CAUSES = 3  # of one investigation, in the window

# auth-service's table, read for when the cluster was registered.
_CLUSTERS = table("clusters", column("id", String), column("created_at", DateTime))


@dataclass(frozen=True)
class Cause:
    resource: str
    kind: str
    verified: Optional[bool]       # None: the evidence check did not read it


@dataclass(frozen=True)
class Past:
    id: str
    received_at: datetime
    outcome: Optional[str]         # verdict.OUTCOMES, None without a block the server read
    causes: tuple[Cause, ...]


def _causes(result: dict) -> list[Cause]:
    out = []
    for c in result.get("causes") if isinstance(result.get("causes"), list) else []:
        if not isinstance(c, dict) or not rca.is_cause(c):
            continue
        out.append(Cause(
            resource=str(c.get("resource") or ""), kind=str(c.get("kind") or ""),
            verified=c["verified"] if isinstance(c.get("verified"), bool) else None))
    return out


def _outcome(result: dict, causes: list[Cause]) -> Optional[str]:
    """The outcome the server kept; of a result written without the verdict, what its block says."""
    if result.get("status") != "ok":
        return None
    kept = result.get("verdict")
    if isinstance(kept, dict):
        return kept.get("outcome") if kept.get("outcome") in verdict.OUTCOMES else None
    if causes:
        return verdict.CAUSE_FOUND
    return verdict.NO_FAULT if result.get("no_fault") is True else verdict.CANNOT_TELL


def _past(row) -> Past:
    result = row.result if isinstance(row.result, dict) else {}
    causes = _causes(result)
    return Past(id=row.id, received_at=row.received_at, outcome=_outcome(result, causes), causes=tuple(causes))


def _same_alert(*, cluster: str, fingerprint: str, namespace: str, now: datetime) -> tuple:
    """The done investigations of one alert of the last DAYS days. The first three are idx_alert_investigations_dedupe's
    columns, so the read is of that alert's rows only (test_past_investigations.py)."""
    registered = select(_CLUSTERS.c.created_at).where(_CLUSTERS.c.id == cluster).scalar_subquery()
    return (
        AlertInvestigation.cluster == cluster,
        AlertInvestigation.fingerprint == fingerprint,
        AlertInvestigation.received_at >= now - timedelta(days=DAYS),
        AlertInvestigation.received_at >= registered,
        AlertInvestigation.namespace == namespace,
        AlertInvestigation.status == "done",
    )


def statement(*, cluster: str, fingerprint: str, namespace: str, before: datetime, now: datetime, limit: int):
    return (
        select(AlertInvestigation.id, AlertInvestigation.received_at, AlertInvestigation.result)
        .where(*_same_alert(cluster=cluster, fingerprint=fingerprint, namespace=namespace, now=now),
               AlertInvestigation.received_at < before)
        .order_by(AlertInvestigation.received_at.desc())
        .limit(min(limit, READ_ROWS))
    )


async def read(db, *, cluster: str, fingerprint: str, namespace: str, before: datetime, now: datetime,
               limit: int = READ_ROWS) -> list[Past]:
    q = statement(cluster=cluster, fingerprint=fingerprint, namespace=namespace, before=before, now=now, limit=limit)
    async with db.async_session() as s:
        return [_past(r) for r in (await s.execute(q)).all()]


async def one(db, item, inv_id: str, now: datetime) -> Optional[AlertInvestigation]:
    """One of the investigations an alert's window may list, with its report; None for any other."""
    q = select(AlertInvestigation).where(
        AlertInvestigation.id == inv_id,
        *_same_alert(cluster=item.cluster, fingerprint=item.fingerprint, namespace=item.namespace or "", now=now))
    async with db.async_session() as s:
        return (await s.execute(q)).scalars().first()


# --- the alert's window -----------------------------------------------------------------------------------------------


async def listed(db, item, investigation, now: datetime) -> Optional[list[dict[str, Any]]]:
    """The investigations before the one the window shows (or, without one, before this firing's first notification), as
    the window lists them; None when they could not be read, which does not fail the window."""
    before = investigation.received_at if investigation is not None else item.first_received_at
    try:
        past = await asyncio.wait_for(
            read(db, cluster=item.cluster, fingerprint=item.fingerprint, namespace=item.namespace or "", before=before, now=now,
                 limit=MAX_LINES), timeout=READ_SECONDS)
    except Exception as e:
        log.warning("alert %s: the past investigations could not be read: %s", item.id, type(e).__name__)
        return None
    return [{"id": p.id, "received_at": p.received_at.isoformat() + "Z", "outcome": p.outcome,
             "causes": [{"resource": c.resource, "kind": c.kind, "verified": c.verified} for c in p.causes[:MAX_CAUSES]],
             "causes_total": len(p.causes)} for p in past]


# --- an investigation ------------------------------------------------------------------------------------------------

# alerts_inbox with_report gives a stored report whole: what a model wrote from what it read then, with no call of the run
# at hand behind it and no rule on how old it is. An investigation reads none (runner), whatever the switch.
NO_REPORT = "an investigation does not read the reports of earlier ones. Call alerts_inbox without with_report for the alert itself"


def asks_for_report(tool: str, args: Any) -> bool:
    from app.services.ai.tool_dispatch import _flag

    return tool == "alerts_inbox" and isinstance(args, dict) and _flag(args.get("with_report"))
