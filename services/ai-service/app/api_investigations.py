"""GET /api/v1/ai/investigations[/{id}] — alert investigation reports (admin.investigations.read).

The list is a plain read. Opening one report is a sensitive read — it can quote
pod logs — so it writes ai.investigation.view first and refuses with 503 when
the audit row cannot be stored (docs/audit-log-plan.md D1, D4).
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.database import get_db_service
from app.security import TokenPayload, require_auth
from app.services.audit_writer import write_audit
from app.services.investigation import store

router = APIRouter()

PERMISSION = "admin.investigations.read"
STATUSES = {"queued", "running", "done", "failed", "skipped"}


def require_reader(payload: TokenPayload = Depends(require_auth)) -> TokenPayload:
    if not payload.has_permission(PERMISSION):
        raise HTTPException(status_code=403, detail=f"permission required: {PERMISSION}")
    return payload


def _iso(value) -> Optional[str]:
    return value.isoformat() + "Z" if value else None


def summary_of(row) -> dict[str, Any]:
    duration_ms = None
    if row.started_at and row.finished_at:
        duration_ms = int((row.finished_at - row.started_at).total_seconds() * 1000)
    return {
        "id": row.id,
        "cluster": row.cluster,
        "alertname": row.alertname,
        "severity": row.severity,
        "namespace": row.namespace,
        "status": row.status,
        "skip_reason": row.skip_reason,
        "received_at": _iso(row.received_at),
        "started_at": _iso(row.started_at),
        "finished_at": _iso(row.finished_at),
        "repeat_count": row.repeat_count,
        "last_seen_at": _iso(row.last_seen_at),
        "model": row.model,
        "total_tokens": row.total_tokens,
        "iterations": row.iterations,
        "tool_call_count": len(row.tool_calls or []),
        "duration_ms": duration_ms,
    }


def detail_of(row) -> dict[str, Any]:
    out = summary_of(row)
    out.update({
        "fingerprint": row.fingerprint,
        "labels": row.labels or {},
        "annotations": row.annotations or {},
        "starts_at": _iso(row.starts_at),
        "generator_url": row.generator_url,
        "alertmanager_url": row.alertmanager_url,
        "provider": row.provider,
        "prompt_tokens": row.prompt_tokens,
        "completion_tokens": row.completion_tokens,
        "tool_calls": row.tool_calls or [],
        "report": row.report,
        "error": row.error,
    })
    return out


@router.get("")
async def list_investigations(
    status: str = Query("", max_length=16),
    cluster: str = Query("", max_length=128),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _payload: TokenPayload = Depends(require_reader),
) -> dict[str, Any]:
    if status and status not in STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(STATUSES)}")
    db = await get_db_service()
    rows, total = await store.list_rows(db, status=status, cluster=cluster, limit=limit, offset=offset)
    return {"items": [summary_of(r) for r in rows], "total": total, "limit": limit, "offset": offset}


@router.get("/{inv_id}")
async def get_investigation(inv_id: str, request: Request, payload: TokenPayload = Depends(require_auth)) -> dict[str, Any]:
    if not payload.has_permission(PERMISSION):  # a report can quote pod logs: the refused read is recorded too
        await write_audit(
            action="ai.investigation.view", actor_user_id=payload.user_id, actor_email=payload.email,
            target_type="investigation", target_id=inv_id, result="failure", error=f"permission required: {PERMISSION}",
            request_ip=request.headers.get("x-real-ip", "").strip() or (request.client.host if request.client else None),
            user_agent=request.headers.get("user-agent"), request_id=request.headers.get("x-request-id"), path=request.url.path,
        )
        raise HTTPException(status_code=403, detail=f"permission required: {PERMISSION}")
    db = await get_db_service()
    row = await store.get(db, inv_id)
    if row is None:
        raise HTTPException(status_code=404, detail="investigation not found")
    stored = await write_audit(
        action="ai.investigation.view",
        actor_user_id=payload.user_id,
        actor_email=payload.email,
        target_type="investigation",
        target_id=row.id,
        namespace=row.namespace or None,
        cluster=row.cluster,
        after={"alertname": row.alertname, "status": row.status},
        # the address the gateway attributed the request to (X-Real-IP), as the other ai-service rows
        request_ip=request.headers.get("x-real-ip", "").strip() or (request.client.host if request.client else None),
        user_agent=request.headers.get("user-agent"),
        request_id=request.headers.get("x-request-id"),
        path=request.url.path,
    )
    if not stored:
        raise HTTPException(status_code=503, detail="audit unavailable")
    return detail_of(row)
