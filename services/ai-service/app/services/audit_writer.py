"""AI service audit log writer.

Writes to the same `auth_audit_logs` Postgres table that auth/k8s services
use (see services/pkg/audit). Best-effort — every helper swallows errors so
audit failures never block chat.

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

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import text

logger = logging.getLogger(__name__)


def stdout_enabled() -> bool:
    """AUDIT_STDOUT (default true): mirror every audit record to stdout as JSON."""
    return os.getenv("AUDIT_STDOUT", "true").strip().lower() not in ("false", "0", "off")


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
DEFAULT_CLUSTER = "default"


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
) -> None:
    """Insert a single audit record. Failures are logged and swallowed.

    Postgres-only — when DATABASE_URL points to sqlite (local dev) the table
    doesn't exist and we skip silently. `cluster` is the cluster the request
    acted on; callers that do not know it leave it unset (DEFAULT_CLUSTER).
    """
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
            "cluster": cluster or DEFAULT_CLUSTER,
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
            return

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
                    "cluster": cluster or DEFAULT_CLUSTER,
                    "namespace": namespace or None,
                    "result": result,
                    "error": error or None,
                },
            )
    except Exception as exc:
        logger.warning("audit write failed (action=%s): %s", action, exc)
