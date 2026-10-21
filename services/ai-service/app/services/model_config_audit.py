"""Audit rows for the AI model settings (docs/audit-log-plan.md §5-2 ai.model_config.*).

A model config decides where every question and tool result goes, so adding, changing and removing one, and the
calls that use the server's own key against an address (connection test, model list), are recorded. A row names the
key's variable and the header names, never a key, a header value or a CA."""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

_FIELDS = ("provider", "model", "base_url", "api_key_env", "api_key_secret_name", "api_key_secret_key",
           "tls_verify", "enabled", "is_default", "tier")


def view(cfg: Any) -> Optional[dict]:
    """What a row keeps of a stored config or a request body."""
    if cfg is None:
        return None
    get = cfg.get if isinstance(cfg, dict) else (lambda f, d=None: getattr(cfg, f, d))
    out = {f: get(f, None) for f in _FIELDS if get(f, None) is not None}
    headers = get("extra_headers", None) or {}
    if headers:  # names only; a view passed again keeps its list
        out["extra_headers"] = sorted(headers.keys() if isinstance(headers, dict) else headers)
    return out


def _http(raw: Optional[Request]) -> dict:
    if raw is None:
        return {}
    headers = raw.headers
    return {
        "request_ip": headers.get("x-real-ip", "").strip() or (raw.client.host if raw.client else None),
        "user_agent": headers.get("user-agent") or None,
        "request_id": headers.get("x-request-id") or None,
        "path": str(raw.url.path),
    }


async def ready_or_503(what: str) -> None:
    """A model config is changed only when its row can be stored (D4)."""
    from app.services.audit_writer import AuditUnavailable, require_audit_ready

    try:
        await require_audit_ready()
    except AuditUnavailable as e:
        logger.warning("audit: refusing unrecorded %s: %s", what, e)
        raise HTTPException(status_code=503, detail="audit unavailable")


async def record(action: str, payload: Any, raw: Optional[Request], name: Optional[str], *,
                 before: Any = None, after: Any = None, extra: Optional[dict] = None,
                 result: str = "success", error: Optional[str] = None) -> bool:
    from app.services.audit_writer import write_audit

    body: dict = {}
    if before is not None:
        body["before"] = view(before)
    if after is not None:
        body["after"] = view(after)
    body.update(extra or {})
    return await write_audit(
        action=action,
        actor_user_id=getattr(payload, "user_id", None),
        actor_email=getattr(payload, "email", None),
        target_type="model_config",
        target_id=name or None,
        after=body or None,
        result=result,
        error=(error or "")[:300] or None,
        **_http(raw),
    )
