"""AI service audit log writer.

Writes to the same `auth_audit_logs` Postgres table that auth/k8s services
use (see services/pkg/audit). The stdout mirror is best-effort; the database
row is what `write_audit` reports back (True when stored). Chat itself keeps
going when a write fails, but a write tool is not run unless the row can be
stored: `require_audit_ready()` before the action, fail-closed by default
(AUDIT_FAIL_CLOSED).

Records metadata: actor, action, target, result, and for a write tool what it
was asked to do with credentials masked (audit_target.write_tool_input). Chat
message content and LLM responses are stored in the `messages` table, NOT
audit, to avoid duplicating sensitive content.

Action keys:
- ai.chat.send      — chat session received a user message (start of stream)
- ai.chat.complete  — chat turn finished (token usage, tool calls, duration in `after`)
- ai.tool.call      — LLM invoked a tool: a read, or a write parked or refused
- ai.tool.execute   — an approved write tool ran

Schema columns come from services/pkg/dbmigrate/migrations (auth_audit_logs).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import text

from app.services.audit_text import cut_text, refused_for_its_text, storable_json, storable_text

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


# One probe per READY_TTL seconds; a failed write drops the cache and a landed one sets it ready (see write_audit).
READY_TTL_SEC = 2.0
_ready_cache: dict[str, Any] = {"at": 0.0, "ok": True, "error": None}
write_failures = 0
# A write failed and none has landed since: readiness then probes a write (inserted and rolled back), since the
# database can answer SELECT 1 while the audit table takes no row (a full disk, a lock, a trigger).
_write_broken = False
# A row was refused for its text since the last check: the next one probes a write, and until then nothing is refused.
_write_doubt = False
_PROBE_SQL = text("INSERT INTO auth_audit_logs (service, action) VALUES ('ai', 'audit.probe')")


async def audit_ready() -> tuple[bool, Optional[str]]:
    """Whether a row written now would land in auth_audit_logs: SELECT 1 through
    the engine — after a failed write, an insert rolled back — cached
    READY_TTL_SEC. Always True with fail-closed off or on the sqlite dev
    database (no audit table there)."""
    global _write_broken, _write_doubt
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
                if _write_broken or _write_doubt:
                    # SELECT 1 began the connection's transaction (SQLAlchemy autobegin): the insert joins it
                    try:
                        await asyncio.wait_for(conn.execute(_PROBE_SQL), timeout=2.0)
                    finally:
                        await conn.rollback()
        _write_broken = _write_doubt = False
    except Exception as exc:  # unreachable, timeout, pool exhausted, the table refusing rows, ...
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
    # before the DB insert so a record survives a Postgres outage; a row in the
    # caller's transaction only once that commits (commit_row).
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
        print(storable_json(line, separators=(",", ":")), flush=True)
    except Exception as exc:  # never block the caller
        logger.warning("audit stdout emit failed (action=%s): %s", record.get("action"), exc)


SERVICE_AI = "ai"


def _record(
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
) -> dict[str, Any]:
    """A write_audit call's record, its text as the columns take it: what the stdout mirror prints and the row holds."""
    def column(value: Any, indexed: bool = False) -> Optional[str]:
        if not value:
            return None
        stored = storable_text(value)
        return (cut_text(stored) if indexed else stored) or None

    return {
        "service": SERVICE_AI,
        "action": column(action, indexed=True) or "",
        "result": column(result) or "",
        "error": column(error),
        "actor_user_id": column(actor_user_id, indexed=True),
        "actor_email": column(actor_email),
        "target_type": column(target_type),
        "target_id": column(target_id, indexed=True),
        "cluster": column(cluster),
        "namespace": column(namespace),
        "path": column(path),
        "request_ip": column(request_ip),
        "user_agent": column(user_agent),
        "request_id": column(request_id),
        "after": after or None,
    }


def _landed() -> None:
    """A row landed, so the audit table takes rows: writes count as working and a refusal readiness cached a moment
    ago ends now instead of READY_TTL_SEC later."""
    global _write_broken, _write_doubt
    _write_broken = _write_doubt = False
    _ready_cache.update(at=time.monotonic(), ok=True, error=None)


def _write_failed(action: str, exc: BaseException) -> None:
    global write_failures, _write_broken, _write_doubt
    write_failures += 1
    if refused_for_its_text(exc):
        _write_doubt = True
        logger.error("audit row refused for its text (action=%s, failures=%d): %s", action, write_failures, exc)
        return
    _write_broken = True
    _ready_cache["at"] = 0.0  # re-probe (a write this time) on the next readiness check
    logger.error("audit write failed (action=%s, failures=%d): %s", action, write_failures, exc)


async def commit_row(conn: Any, **fields: Any) -> None:
    """Commit the caller's transaction holding the row write_audit(**fields, conn=conn) added. Only then is that row
    mirrored to stdout and counted as landed, so an attempt the table refused, rolled back and tried again later prints
    nothing. A commit that fails counts as a failed write (readiness probes a write next) and raises."""
    try:
        await conn.commit()
    except Exception as exc:
        _write_failed(fields.get("action", ""), exc)
        raise
    _emit_stdout(_record(**fields))
    _landed()


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
    conn: Any = None,
) -> bool:
    """Insert a single audit record. Returns True when the row was stored (or
    there is no Postgres to store it in); a failure is logged, counted and
    returned as False — the caller decides whether the action may go on.
    conn: the caller's connection in a transaction, which the row joins and
    which the caller commits with commit_row (the row is mirrored to stdout
    and counted as landed only then), or rolls back on False.

    Postgres-only — when DATABASE_URL points to sqlite (local dev) the table
    doesn't exist and we skip silently. `cluster` is the cluster the request
    acted on; callers that do not know it leave it unset (stored empty).
    """
    try:
        record = _record(
            action=action, actor_user_id=actor_user_id, actor_email=actor_email, target_type=target_type, target_id=target_id,
            namespace=namespace, after=after, request_ip=request_ip, user_agent=user_agent, request_id=request_id, path=path,
            cluster=cluster, result=result, error=error,
        )
        if conn is None:
            _emit_stdout(record)
        from app.database import get_db_service

        db = await get_db_service()
        if "postgresql" not in str(db.database_url):
            return True

        params = {**record, "after": storable_json(after) if after else "{}"}
        if conn is not None:
            await conn.execute(_INSERT_SQL, params)  # lands, or not, with the caller's commit_row
            return True
        async with db.engine.begin() as own:
            await own.execute(_INSERT_SQL, params)
        _landed()
        return True
    except Exception as exc:
        _write_failed(action, exc)
        return False
