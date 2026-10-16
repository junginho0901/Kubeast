"""Chat token budgets (chart ai.chat.budget.*, 0 = off).

A turn is refused before the model is called once the session's tokens, or the
user's tokens since the start of the UTC day, reach the limit. Usage is the sum
of `total_tokens` on the ai.chat.complete audit rows — the numbers the Admin AI
usage view shows — so there is no separate counter to keep. Without a Postgres
audit table (the sqlite dev database) budgets are not enforced, and a query that
fails lets the turn through: a budget limits cost, it is not an access control.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import text

from app.config import settings

log = logging.getLogger(__name__)

SESSION_SQL = text(
    "SELECT COALESCE(SUM(CAST(after->>'total_tokens' AS BIGINT)), 0) FROM auth_audit_logs "
    "WHERE action = 'ai.chat.complete' AND target_id = :session_id"
)
# created_at is a TIMESTAMP written with NOW() in UTC; the day start is passed as a naive UTC value.
USER_DAY_SQL = text(
    "SELECT COALESCE(SUM(CAST(after->>'total_tokens' AS BIGINT)), 0) FROM auth_audit_logs "
    "WHERE action = 'ai.chat.complete' AND actor_user_id = :user_id AND created_at >= :since"
)


@dataclass
class Exceeded:
    budget: str  # "session" | "user_daily"
    used: int
    limit: int

    @property
    def key(self) -> str:
        """Catalog key the screen translates (aiChat.error.<key>)."""
        return "budgetSession" if self.budget == "session" else "budgetUserDaily"

    def message(self) -> str:
        if self.budget == "session":
            return (f"This conversation has used {self.used:,} tokens, over its budget of {self.limit:,}. "
                    "Start a new conversation to continue.")
        return (f"You have used {self.used:,} tokens today (UTC), over the daily budget of {self.limit:,}. "
                "The budget resets at 00:00 UTC.")

    def event(self) -> dict[str, Any]:
        return {"error": self.message(), "error_key": self.key,
                "error_args": {"used": self.used, "limit": self.limit}}


def limits() -> tuple[int, int]:
    """(session tokens, user tokens per UTC day); 0 = off."""
    def _int(name: str) -> int:
        try:
            return max(0, int(getattr(settings, name, 0) or 0))
        except (TypeError, ValueError):
            return 0
    return _int("AI_CHAT_BUDGET_SESSION_TOKENS"), _int("AI_CHAT_BUDGET_USER_DAILY_TOKENS")


def day_start(now: Optional[datetime] = None) -> datetime:
    """Start of the current UTC day as a naive UTC value (the column's form)."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)


async def check(db: Any, session_id: str, user_id: Optional[str], *,
                now: Optional[datetime] = None) -> Optional[Exceeded]:
    """The budget this turn would go over, or None. No query runs while both
    budgets are off."""
    session_limit, daily_limit = limits()
    if not session_limit and not (daily_limit and user_id):
        return None
    if "postgresql" not in str(getattr(db, "database_url", "")):
        return None
    try:
        async with db.engine.connect() as conn:
            if session_limit:
                used = int((await conn.execute(SESSION_SQL, {"session_id": session_id})).scalar() or 0)
                if used >= session_limit:
                    return Exceeded("session", used, session_limit)
            if daily_limit and user_id:
                used = int((await conn.execute(USER_DAY_SQL, {"user_id": user_id,
                                                              "since": day_start(now)})).scalar() or 0)
                if used >= daily_limit:
                    return Exceeded("user_daily", used, daily_limit)
    except Exception as e:  # cost control, not access control: the turn goes on
        log.warning("chat budget: usage query failed, turn allowed: %s", e)
    return None
