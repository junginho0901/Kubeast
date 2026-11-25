"""The earlier investigations of one alert (features.alertInvestigation.pastReports, both switches off by default).

They are read from the alert_investigations rows a run keeps anyway: no table, no column, nothing written. One read takes
the done investigations of the same alert — the same fingerprint on the same cluster in the same namespace (an alert
without one: those without one) — received in the last DAYS days before the one at hand, newest first, at most READ_ROWS
of them and never a report's text. A cluster removed and registered again under its name starts with none.

- `window`: the alert's window in Alerts lists at most MAX_LINES of them for whoever reads that window (the whole
  cluster), each with its outcome and causes as the report's own window shows them; opening one is the report's audited
  read (api_alert_inbox).
- `model`: an investigation's first message holds at most MAX_LINES lines and BLOCK_CHARS characters of them between
  markers (prompt.past_block), made of the server's words and of fields held to a form: the time, that a cause was found,
  and each cause's object (Kind/namespace/name) and kind (rca.KINDS). No text of a report, a hypothesis, a label or a
  note goes in. A line is given only for an investigation whose outcome is a cause found, and a cause only when the
  evidence check verified it on a call that reads more than alerts, rules and names, and only in the alert's own
  namespace when it has one (the investigator's token is limited to it). The lines have no call number, so no cause of
  the run can rest on them. A read that fails leaves the run without them. The run's audit row names the investigations
  it was given; while the switch is on alerts_inbox gives the run no report either (asks_for_report).
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable, Iterable, Optional

from sqlalchemy import DateTime, String, column, select, table

from app.database import AlertInvestigation
from app.services.investigation import rca, verdict
from app.services.redact import Numbers, redact_text

log = logging.getLogger(__name__)

DAYS = 30
MAX_LINES = 5
READ_ROWS = 20
READ_SECONDS = 3
BLOCK_CHARS = 600
LINE_CHARS = 180
MAX_CAUSES = 3  # of one investigation, in the window and in a line

# auth-service's table, read for when the cluster was registered.
_CLUSTERS = table("clusters", column("id", String), column("created_at", DateTime))

# Kind/namespace/name or Kind/name, as Kubernetes writes them: words, spaces and markers do not fit it.
_RESOURCE = re.compile(r"[A-Z][A-Za-z0-9]{1,39}(?:/(?P<namespace>[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))?/"
                       r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?")


@dataclass(frozen=True)
class Cause:
    resource: str
    kind: str
    verified: Optional[bool]       # None: the evidence check did not read it
    tools: tuple[str, ...]         # of the calls given for it that did not fail


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
        refs = c.get("evidence") if isinstance(c.get("evidence"), list) else []
        out.append(Cause(
            resource=str(c.get("resource") or ""), kind=str(c.get("kind") or ""),
            verified=c["verified"] if isinstance(c.get("verified"), bool) else None,
            tools=tuple(str(r.get("tool") or "") for r in refs if isinstance(r, dict) and not r.get("failed"))))
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


# --- an investigation's first message ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Given:
    """What one run was given: the lines as the model reads them, and the investigations they are of."""
    text: str = ""
    ids: tuple[str, ...] = ()
    differ: bool = False           # their first causes are not one object
    failed: bool = False           # they could not be read

    def audit(self) -> dict[str, Any]:
        return {"lines": len(self.ids), "ids": list(self.ids), **({"failed": True} if self.failed else {})}


def _fits(cause: Cause, namespace: str) -> bool:
    form = _RESOURCE.fullmatch(cause.resource)
    if form is None or cause.kind not in rca.KINDS:
        return False
    if cause.verified is not True or not any(tool not in verdict.NO_SYMPTOM for tool in cause.tools):
        return False
    return not (namespace and form["namespace"] and form["namespace"] != namespace)


def _named(causes: Iterable[Cause]) -> str:
    return "; ".join(f"{c.resource} ({c.kind})" for c in causes)


def _lines(past: Iterable[Past], namespace: str) -> list[tuple[str, str, str]]:
    """(the investigation, its line, its first cause), newest first. A cause that does not fit the line is left out, a line
    that does not fit the block ends it."""
    out: list[tuple[str, str, str]] = []
    used = 0
    for p in past:
        causes = [c for c in p.causes if _fits(c, namespace)][:MAX_CAUSES] if p.outcome == verdict.CAUSE_FOUND else []
        line = f"- {p.received_at:%Y-%m-%dT%H:%MZ}: cause found, "
        told: list[Cause] = []
        for c in causes:
            if len(line) + len(_named([*told, c])) <= LINE_CHARS:
                told.append(c)
        if not told:
            continue
        line += _named(told)
        if len(out) == MAX_LINES or used + len(line) + 1 > BLOCK_CHARS:
            break
        used += len(line) + 1
        out.append((p.id, line, told[0].resource))
    return out


async def given(get_db: Callable[[], Awaitable[Any]], row, now: datetime, numbers: Optional[Numbers] = None) -> Given:
    """The lines of a run's first message. Whatever goes wrong here leaves the run without them."""
    async def found() -> list[Past]:
        return await read(await get_db(), cluster=row.cluster, fingerprint=row.fingerprint, namespace=row.namespace or "",
                          before=row.received_at, now=now)

    try:
        lines = _lines(await asyncio.wait_for(found(), timeout=READ_SECONDS), row.namespace or "")
        # the run's own table, as for the alert: a value a stored name holds is masked here too
        text, _ = redact_text("\n".join(line for _, line, _ in lines), numbers=numbers)
    except Exception as e:
        log.warning("investigation %s: the past investigations could not be read: %s", row.id, type(e).__name__)
        return Given(failed=True)
    return Given(text=text, ids=tuple(inv_id for inv_id, _, _ in lines), differ=len({first for _, _, first in lines}) > 1)


# alerts_inbox with_report gives a stored report whole, without the rules above; a run with the lines reads none.
NO_REPORT = ("an investigation does not read the reports of earlier ones; what they concluded is in the first message when "
             "there is any. Call alerts_inbox without with_report for the alert itself")


def asks_for_report(tool: str, args: Any) -> bool:
    from app.services.ai.tool_dispatch import _flag

    return tool == "alerts_inbox" and isinstance(args, dict) and _flag(args.get("with_report"))
