"""AI service audit log writer.

Writes to the same `auth_audit_logs` Postgres table that auth/k8s services
use (see services/pkg/audit). The stdout mirror is best-effort; the database
row is what `write_audit` reports back (True when stored). Chat itself keeps
going when a write fails, but a write tool is not run unless the row can be
stored: `require_audit_ready()` before the action, fail-closed by default
(AUDIT_FAIL_CLOSED).

Records only metadata: actor, action, target, result. Chat message content
and LLM responses are stored in the `messages` table, NOT audit, to avoid
duplicating sensitive content.

Action keys:
- ai.chat.send      — chat session received a user message (start of stream)
- ai.chat.complete  — chat turn finished (token usage, tool calls, duration in `after`)
- ai.tool.call      — LLM invoked a readonly tool

Schema columns come from services/pkg/dbmigrate/migrations (auth_audit_logs).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import text

logger = logging.getLogger(__name__)


def stdout_enabled() -> bool:
    """AUDIT_STDOUT (default true): mirror every audit record to stdout as JSON."""
    return os.getenv("AUDIT_STDOUT", "true").strip().lower() not in ("false", "0", "off")


def fail_closed_enabled() -> bool:
    """AUDIT_FAIL_CLOSED (default true): a write tool is refused (503) while the
    audit table cannot take a row, instead of running unrecorded."""
    return os.getenv("AUDIT_FAIL_CLOSED", "true").strip().lower() not in ("false", "0", "off")


class AuditUnavailable(Exception):
    """The audit database cannot take a row right now (fail-closed refusal)."""


# One probe per READY_TTL seconds; a failed write drops the cache (see write_audit).
READY_TTL_SEC = 2.0
_ready_cache: dict[str, Any] = {"at": 0.0, "ok": True, "error": None}
write_failures = 0


async def audit_ready() -> tuple[bool, Optional[str]]:
    """Whether a row written now would land in auth_audit_logs: SELECT 1 through
    the engine, cached READY_TTL_SEC. Always True with fail-closed off or on the
    sqlite dev database (no audit table there)."""
    if not fail_closed_enabled():
        return True, None
    now = time.monotonic()
    if now - _ready_cache["at"] < READY_TTL_SEC:
        return _ready_cache["ok"], _ready_cache["error"]
    ok, error = True, None
    try:
        from app.database import get_db_service

        db = await get_db_service()
        if "postgresql" in str(db.database_url):
            async with db.engine.connect() as conn:
                await asyncio.wait_for(conn.execute(text("SELECT 1")), timeout=2.0)
    except Exception as exc:  # unreachable, timeout, pool exhausted, ...
        ok, error = False, str(exc) or exc.__class__.__name__
    _ready_cache.update(at=time.monotonic(), ok=ok, error=error)
    return ok, error


async def require_audit_ready() -> None:
    """Raise AuditUnavailable when a sensitive action must not run now."""
    ok, error = await audit_ready()
    if not ok:
        raise AuditUnavailable(error or "database unreachable")


def _emit_stdout(record: dict[str, Any]) -> None:
    # Same line shape as services/pkg/audit StdoutTee: one JSON object per line,
    # top-level event "audit" for the cluster log pipeline to route on. Written
    # before the DB insert so a record survives a Postgres outage.
    if not stdout_enabled():
        return
    try:
        line = {
            "time": datetime.now(timezone.utc).isoformat(),
            "level": "INFO",
            "msg": "audit",
            "event": "audit",
            "audit": {k: v for k, v in record.items() if v is not None},
        }
        # Compact separators match the Go services' slog JSON output.
        print(json.dumps(line, ensure_ascii=False, default=str, separators=(",", ":")), flush=True)
    except Exception as exc:  # never block the caller
        logger.warning("audit stdout emit failed (action=%s): %s", record.get("action"), exc)


SERVICE_AI = "ai"


_INSERT_SQL = text(
    """
    INSERT INTO auth_audit_logs
      (service, action,
       actor_user_id, actor_email,
       target_user_id, target_email, target_type, target_id,
       before, after,
       request_ip, user_agent, request_id, path,
       cluster, namespace,
       result, error)
    VALUES
      (:service, :action,
       :actor_user_id, :actor_email,
       NULL, NULL, :target_type, :target_id,
       '{}', :after,
       :request_ip, :user_agent, :request_id, :path,
       :cluster, :namespace,
       :result, :error)
    """
)


async def write_audit(
    *,
    action: str,
    actor_user_id: Optional[str] = None,
    actor_email: Optional[str] = None,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    namespace: Optional[str] = None,
    after: Optional[dict[str, Any]] = None,
    request_ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    request_id: Optional[str] = None,
    path: Optional[str] = None,
    cluster: Optional[str] = None,
    result: str = "success",
    error: Optional[str] = None,
) -> bool:
    """Insert a single audit record. Returns True when the row was stored (or
    there is no Postgres to store it in); a failure is logged, counted and
    returned as False — the caller decides whether the action may go on.

    Postgres-only — when DATABASE_URL points to sqlite (local dev) the table
    doesn't exist and we skip silently. `cluster` is the cluster the request
    acted on; callers that do not know it leave it unset (stored empty).
    """
    global write_failures
    _emit_stdout(
        {
            "service": SERVICE_AI,
            "action": action,
            "result": result,
            "error": error or None,
            "actor_user_id": actor_user_id or None,
            "actor_email": actor_email or None,
            "target_type": target_type or None,
            "target_id": target_id or None,
            "cluster": cluster or None,
            "namespace": namespace or None,
            "path": path or None,
            "request_ip": request_ip or None,
            "user_agent": user_agent or None,
            "request_id": request_id or None,
            "after": after or None,
        }
    )
    try:
        from app.database import get_db_service

        db = await get_db_service()
        if "postgresql" not in str(db.database_url):
            return True

        after_json = json.dumps(after, ensure_ascii=False, default=str) if after else "{}"

        async with db.engine.begin() as conn:
            await conn.execute(
                _INSERT_SQL,
                {
                    "service": SERVICE_AI,
                    "action": action,
                    "actor_user_id": actor_user_id or None,
                    "actor_email": actor_email or None,
                    "target_type": target_type or None,
                    "target_id": target_id or None,
                    "after": after_json,
                    "request_ip": request_ip or None,
                    "user_agent": user_agent or None,
                    "request_id": request_id or None,
                    "path": path or None,
                    "cluster": cluster or None,
                    "namespace": namespace or None,
                    "result": result,
                    "error": error or None,
                },
            )
        return True
    except Exception as exc:
        write_failures += 1
        _ready_cache["at"] = 0.0  # re-probe on the next readiness check
        logger.error("audit write failed (action=%s, failures=%d): %s", action, write_failures, exc)
        return False
