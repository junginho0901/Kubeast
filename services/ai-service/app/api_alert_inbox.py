"""/api/v1/alerts/inbox — every alert Alertmanager sent for a cluster, and Kubeast's handling marks on them.

Who: whoever reads the cluster as a whole (resource.pod.read there and no namespace limit) — the rule the AI's
alerts_list tool and the alert store read follow. The list and one alert are plain reads. Changing a mark
(acknowledged, assignee, note, done) writes alert.inbox.update; opening the alert's investigation report writes
ai.investigation.view. Both are refused with 503 when the audit row cannot be stored (a mark is put back).
"Investigate now" (resource.alert.investigate there too, features.alertInvestigation.manual) queues an investigation
as the webhook does and writes ai.investigation.request, refusals included; 503 and nothing queued without its row.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api_investigations import detail_of as investigation_detail
from app.database import get_db_service, utcnow
from app.security import TokenPayload, require_auth
from app.services.audit_writer import AuditUnavailable, require_audit_ready, write_audit
from app.services.investigation import inbox, skip_reasons, store
from app.services.investigation import settings as inv_settings
from app.services.investigation import webhook

router = APIRouter()

READ_PERMISSION = "resource.pod.read"
# "Investigate now", per cluster; the Admin role's "*" holds it, Read and Write do not (a role may add it)
INVESTIGATE_PERMISSION = "resource.alert.investigate"
NOTE_MAX = 2000


def may_read(payload: TokenPayload, cluster: str) -> bool:
    return bool(cluster) and payload.has_permission_for_cluster(READ_PERMISSION, cluster) and not payload.namespaces.get(cluster)


def _iso(value) -> Optional[str]:
    return value.isoformat() + "Z" if value else None


def _settings() -> inv_settings.InvestigationSettings:
    cfg = inv_settings.load()
    if not cfg.enabled:
        raise HTTPException(status_code=404, detail="the alert inbox is off (features.alertInvestigation.enabled)")
    return cfg


def investigation_of(inv) -> Optional[dict[str, Any]]:
    """The row's investigation as the list shows it: its status and, when skipped, why (with its catalog key); who
    asked for it in the inbox ("" for the webhook's) and when it was queued."""
    if inv is None:
        return None
    key, args = skip_reasons.key_of(inv.skip_reason)
    return {"id": inv.id, "status": inv.status, "skip_reason": inv.skip_reason, "skip_reason_key": key, "skip_reason_args": args,
            "requested_by": inv.requested_by or "", "received_at": _iso(inv.received_at)}


async def investigate_now_of(db, cfg: inv_settings.InvestigationSettings, payload: TokenPayload, row, investigation, now: datetime) -> dict[str, Any]:
    """The alert window's "Investigate now" for this user: allowed, or why not (reason) and when it works again
    (until), with today's manual token budget and use (UTC day). forbidden: no resource.alert.investigate here;
    investigating / investigated: this firing's investigation is queued or running / done; manual_off: the chart
    switch; provider_paused: the model provider refused (store.pause_state); manual_budget: the day's budget is spent."""
    budget = cfg.manual_daily_token_budget
    used = await store.tokens_since(db, store.day_start(now), manual=True) if budget else 0
    out: dict[str, Any] = {"permission": INVESTIGATE_PERMISSION, "allowed": False, "reason": "", "until": None,
                           "automatic": cfg.automatic, "budget": budget, "used": used}
    if not payload.has_permission_for_cluster(INVESTIGATE_PERMISSION, row.cluster):
        out["reason"] = "forbidden"
    elif investigation is not None and investigation.status in store.BUSY_STATUSES:
        out["reason"] = "investigated" if investigation.status == "done" else "investigating"
    elif not cfg.manual:
        out["reason"] = "manual_off"
    elif (pause := await store.pause_state(db, cfg.provider_pause_minutes, now)) is not None:
        out["reason"], out["until"] = "provider_paused", _iso(pause[2])
    elif budget and used >= budget:
        out["reason"], out["until"] = "manual_budget", _iso(store.next_day(now))
    else:
        out["allowed"] = True
    return out


def item_of(row, status: str, investigation=None) -> dict[str, Any]:
    return {
        "id": row.id,
        "cluster": row.cluster,
        "fingerprint": row.fingerprint,
        "alertname": row.alertname,
        "severity": row.severity,
        "namespace": row.namespace,
        "labels": row.labels or {},
        "summary": (row.annotations or {}).get("summary", ""),
        "status": status,
        "starts_at": _iso(row.starts_at),
        "resolved_at": _iso(row.resolved_at),
        "first_received_at": _iso(row.first_received_at),
        "last_received_at": _iso(row.last_received_at),
        "received_count": row.received_count,
        "acknowledged": bool(row.acked_at),
        "acked_by": row.acked_by,
        "acked_at": _iso(row.acked_at),
        "assignee": row.assignee,
        "done": bool(row.done_at),
        "done_by": row.done_by,
        "done_at": _iso(row.done_at),
        "investigation": investigation_of(investigation),
    }


def detail_of(row, status: str, investigation=None) -> dict[str, Any]:
    out = item_of(row, status, investigation)
    out.update({
        "annotations": row.annotations or {},
        "generator_url": row.generator_url,
        "alertmanager_url": row.alertmanager_url,
        "receiver": row.receiver,
        "note": row.note,
        "note_by": row.note_by,
        "note_at": _iso(row.note_at),
    })
    return out


def _http(request: Request) -> dict[str, Any]:
    return {
        # the address the gateway attributed the request to (X-Real-IP), as the other ai-service rows
        "request_ip": request.headers.get("x-real-ip", "").strip() or (request.client.host if request.client else None),
        "user_agent": request.headers.get("user-agent"),
        "request_id": request.headers.get("x-request-id"),
        "path": request.url.path,
    }


async def _readable_row(item_id: str, payload: TokenPayload):
    db = await get_db_service()
    row = await inbox.get(db, item_id)
    if row is None or not may_read(payload, row.cluster):
        raise HTTPException(status_code=404, detail="alert not found")  # one answer for missing and not yours
    return db, row


async def _window(db, cfg: inv_settings.InvestigationSettings, payload: TokenPayload, row) -> dict[str, Any]:
    """One alert as its window shows it: the detail and the "Investigate now" state."""
    now = utcnow()
    stale_before = inbox.stale_cutoff(now, cfg.inbox_stale_hours)
    investigation = (await inbox.investigations_for(db, [row])).get(row.id)
    out = detail_of(row, inbox.status_of(row, stale_before), investigation)
    out["investigate_now"] = await investigate_now_of(db, cfg, payload, row, investigation, now)
    return out


@router.get("/inbox")
async def list_inbox(
    cluster: str = Query(..., min_length=1, max_length=128),
    status: str = Query("", max_length=16),
    severity: str = Query("", max_length=50),
    mine: bool = Query(False),
    open_only: bool = Query(False, alias="open"),
    # matched in the alert name, namespace, assignee, labels and annotations (inbox.search_condition)
    q: str = Query("", max_length=200),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    payload: TokenPayload = Depends(require_auth),
) -> dict[str, Any]:
    cfg = _settings()
    if status and status not in inbox.STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {list(inbox.STATUSES)}")
    if not may_read(payload, cluster):
        raise HTTPException(status_code=403, detail=f"the alert inbox needs {READ_PERMISSION} on the whole cluster")
    db = await get_db_service()
    stale_before = inbox.stale_cutoff(utcnow(), cfg.inbox_stale_hours)
    rows, total, counts = await inbox.list_rows(
        db, cluster=cluster, status=status, severity=severity.strip().lower(), assignee=payload.email if mine else "",
        open_only=open_only, search=q.strip(), stale_before=stale_before, limit=limit, offset=offset,
    )
    investigations = await inbox.investigations_for(db, rows)
    return {
        "items": [item_of(r, inbox.status_of(r, stale_before), investigations.get(r.id)) for r in rows],
        "total": total, "counts": counts, "limit": limit, "offset": offset, "stale_hours": cfg.inbox_stale_hours,
        "severities": await inbox.severities(db, cluster),
    }


@router.get("/inbox/{item_id}")
async def get_inbox_item(item_id: str, payload: TokenPayload = Depends(require_auth)) -> dict[str, Any]:
    cfg = _settings()
    db, row = await _readable_row(item_id, payload)
    return await _window(db, cfg, payload, row)


class MarksIn(BaseModel):
    acknowledged: Optional[bool] = None
    # "me" takes it, "" lets it go: an inbox reader assigns themselves, not others
    assignee: Optional[str] = Field(default=None, pattern=r"^(me)?$")
    note: Optional[str] = Field(default=None, max_length=NOTE_MAX)
    done: Optional[bool] = None


@router.patch("/inbox/{item_id}")
async def set_inbox_marks(item_id: str, body: MarksIn, request: Request, payload: TokenPayload = Depends(require_auth)) -> dict[str, Any]:
    cfg = _settings()
    changes = body.model_dump(exclude_none=True)
    if "assignee" in changes:
        changes["assignee"] = payload.email if changes["assignee"] == "me" else ""
    if "note" in changes:
        changes["note"] = changes["note"].strip()
    if not changes:
        raise HTTPException(status_code=400, detail="nothing to change (acknowledged, assignee, note, done)")
    db, row = await _readable_row(item_id, payload)
    try:
        await require_audit_ready()
    except AuditUnavailable as e:
        raise HTTPException(status_code=503, detail="audit unavailable") from e
    result = await inbox.set_marks(db, row.id, changes, payload.email, utcnow())
    if result is None:
        raise HTTPException(status_code=404, detail="alert not found")
    before, after, columns = result
    if after:
        stored = await write_audit(
            action="alert.inbox.update", actor_user_id=payload.user_id, actor_email=payload.email,
            target_type="alert", target_id=row.id, namespace=row.namespace or None, cluster=row.cluster,
            after={"alertname": row.alertname, "fingerprint": row.fingerprint, "before": before, "after": after},
            **_http(request),
        )
        if not stored:
            await inbox.restore_marks(db, row.id, columns)
            raise HTTPException(status_code=503, detail="audit unavailable")
    return await _window(db, cfg, payload, await inbox.get(db, row.id))


# The status and English sentence of each refusal of "Investigate now"; the screen words it from the code and until.
_REFUSALS = {
    "forbidden": (403, f"permission required: {INVESTIGATE_PERMISSION}"),
    "manual_off": (403, "manual investigations are off (features.alertInvestigation.manual)"),
    "provider_paused": (429, "the AI model provider refused an investigation; none runs until the pause ends"),
    "manual_budget": (429, "the daily token budget of manual investigations is spent (UTC day)"),
}


@router.post("/inbox/{item_id}/investigate")
async def investigate_inbox_item(item_id: str, request: Request, payload: TokenPayload = Depends(require_auth)) -> dict[str, Any]:
    """Queues an investigation of the alert now, as the webhook queues one (the worker runs it), and answers the alert
    window with `started`. Nothing new when this firing's investigation is queued, running or done (started false)."""
    cfg = _settings()

    async def audit(row, *, result: str = "success", error: Optional[str] = None, **after) -> bool:
        return await write_audit(
            action="ai.investigation.request", actor_user_id=payload.user_id, actor_email=payload.email,
            target_type="alert", target_id=row.id if row is not None else item_id,
            namespace=(row.namespace or None) if row is not None else None, cluster=row.cluster if row is not None else None,
            result=result, error=error,
            after={"alertname": row.alertname, "fingerprint": row.fingerprint, **after} if row is not None else after,
            **_http(request),
        )

    try:
        db, row = await _readable_row(item_id, payload)
    except HTTPException as e:
        await audit(None, result="failure", error=str(e.detail), code="not_found")
        raise
    now = utcnow()
    investigation = (await inbox.investigations_for(db, [row])).get(row.id)
    state = await investigate_now_of(db, cfg, payload, row, investigation, now)
    if state["reason"] in _REFUSALS:
        status, message = _REFUSALS[state["reason"]]
        await audit(row, result="failure", error=message, code=state["reason"], until=state["until"])
        headers = None
        if state["until"]:
            wait = datetime.fromisoformat(state["until"].removesuffix("Z")) - now
            headers = {"Retry-After": str(max(1, int(wait.total_seconds())))}
        raise HTTPException(status_code=status, headers=headers, detail={
            "code": state["reason"], "message": message, "until": state["until"], "budget": state["budget"], "used": state["used"]})
    try:
        await require_audit_ready()
    except AuditUnavailable as e:
        raise HTTPException(status_code=503, detail="audit unavailable") from e
    started = False
    if state["allowed"]:
        async def record(inv_id: str) -> bool:
            return await audit(row, investigation_id=inv_id, started=True, status="queued")

        inv_id, started = await store.queue_requested(db, row, requested_by=payload.email or payload.user_id, now=now, record=record)
        if inv_id is None:
            raise HTTPException(status_code=503, detail="audit unavailable")
        if started:
            webhook.wake.set()
        investigation = None if started else await store.get(db, inv_id)  # another press queued it a moment before
    if not started:
        stored = await audit(row, investigation_id=investigation.id, started=False, status=investigation.status)
        if not stored:
            raise HTTPException(status_code=503, detail="audit unavailable")
    out = await _window(db, cfg, payload, row)
    out["started"] = started
    return out


@router.get("/inbox/{item_id}/investigation")
async def get_inbox_investigation(item_id: str, request: Request, payload: TokenPayload = Depends(require_auth)) -> dict[str, Any]:
    _settings()
    try:
        db, row = await _readable_row(item_id, payload)
    except HTTPException as e:
        if e.status_code == 403:  # the refused read of a report is recorded too
            await write_audit(
                action="ai.investigation.view", actor_user_id=payload.user_id, actor_email=payload.email,
                target_type="alert", target_id=item_id, result="failure", error=str(e.detail),
                after={"from": "inbox"}, **_http(request),
            )
        raise
    investigation = (await inbox.investigations_for(db, [row])).get(row.id)
    if investigation is None:
        raise HTTPException(status_code=404, detail="no investigation for this alert")
    stored = await write_audit(
        action="ai.investigation.view", actor_user_id=payload.user_id, actor_email=payload.email,
        target_type="investigation", target_id=investigation.id, namespace=investigation.namespace or None,
        cluster=investigation.cluster, after={"alertname": investigation.alertname, "status": investigation.status, "from": "inbox"},
        **_http(request),
    )
    if not stored:
        raise HTTPException(status_code=503, detail="audit unavailable")
    return investigation_detail(investigation)
