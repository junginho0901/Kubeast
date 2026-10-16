import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services.ai import budget


class FakeConn:
    def __init__(self, results, fail=False):
        self.results, self.fail, self.calls = list(results), fail, []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, sql, params):
        self.calls.append((str(sql), params))
        if self.fail:
            raise RuntimeError("connection refused")
        return SimpleNamespace(scalar=lambda: self.results.pop(0))


def _db(results=(), fail=False, url="postgresql+asyncpg://kubeast@postgres/kubeast"):
    conn = FakeConn(results, fail)
    return SimpleNamespace(database_url=url, engine=SimpleNamespace(connect=lambda: conn)), conn


def _limits(monkeypatch, session=0, daily=0):
    monkeypatch.setattr(budget.settings, "AI_CHAT_BUDGET_SESSION_TOKENS", session, raising=False)
    monkeypatch.setattr(budget.settings, "AI_CHAT_BUDGET_USER_DAILY_TOKENS", daily, raising=False)


@pytest.mark.asyncio
async def test_off_by_default_runs_no_query(monkeypatch):
    _limits(monkeypatch)
    db, conn = _db([10**9])
    assert await budget.check(db, "s1", "u1") is None and conn.calls == []
    # A daily budget alone needs a user: a turn without one is not counted.
    _limits(monkeypatch, daily=100)
    assert await budget.check(db, "s1", None) is None and conn.calls == []


@pytest.mark.asyncio
async def test_not_enforced_without_the_postgres_audit_table(monkeypatch):
    _limits(monkeypatch, session=100, daily=100)
    db, conn = _db([10**9, 10**9], url="sqlite+aiosqlite:///./kubeast.db")
    assert await budget.check(db, "s1", "u1") is None and conn.calls == []


@pytest.mark.asyncio
async def test_session_budget_counts_this_sessions_chat_turns(monkeypatch):
    _limits(monkeypatch, session=50_000, daily=1_000_000)
    db, conn = _db([50_000])
    over = await budget.check(db, "s1", "u1")
    assert over == budget.Exceeded("session", 50_000, 50_000)  # reaching the limit is over it
    sql, params = conn.calls[0]
    assert "action = 'ai.chat.complete'" in sql and "target_id = :session_id" in sql and "total_tokens" in sql
    assert params == {"session_id": "s1"} and len(conn.calls) == 1  # the daily query is not needed


@pytest.mark.asyncio
async def test_daily_budget_counts_the_users_tokens_since_utc_midnight(monkeypatch):
    _limits(monkeypatch, session=50_000, daily=200_000)
    db, conn = _db([49_999, 250_000])
    now = datetime(2026, 10, 16, 23, 30, tzinfo=timezone(timedelta(hours=9)))  # 14:30 UTC
    over = await budget.check(db, "s1", "u1", now=now)
    assert over == budget.Exceeded("user_daily", 250_000, 200_000)
    sql, params = conn.calls[1]
    assert "actor_user_id = :user_id" in sql and "created_at >= :since" in sql
    assert params == {"user_id": "u1", "since": datetime(2026, 10, 16, 0, 0)}  # naive UTC, the column's form


@pytest.mark.asyncio
async def test_under_both_budgets_the_turn_goes_on(monkeypatch):
    _limits(monkeypatch, session=50_000, daily=200_000)
    db, conn = _db([49_999, 199_999])
    assert await budget.check(db, "s1", "u1") is None and len(conn.calls) == 2


@pytest.mark.asyncio
async def test_a_failing_usage_query_lets_the_turn_through(monkeypatch):
    _limits(monkeypatch, session=50_000)
    db, conn = _db(fail=True)
    assert await budget.check(db, "s1", "u1") is None and len(conn.calls) == 1


def test_day_start_is_the_utc_date():
    assert budget.day_start(datetime(2026, 10, 17, 1, 0, tzinfo=timezone(timedelta(hours=9)))) == datetime(2026, 10, 16)
    assert budget.day_start(datetime(2026, 10, 16, 0, 0, tzinfo=timezone.utc)) == datetime(2026, 10, 16)


def test_the_refusal_event_carries_a_catalog_key_and_values():
    ev = budget.Exceeded("user_daily", 250_000, 200_000).event()
    assert ev["error_key"] == "budgetUserDaily" and ev["error_args"] == {"used": 250_000, "limit": 200_000}
    assert "250,000" in ev["error"] and "200,000" in ev["error"] and "00:00 UTC" in ev["error"]
    assert budget.Exceeded("session", 1, 1).event()["error_key"] == "budgetSession"


@pytest.mark.asyncio
async def test_a_refused_turn_stores_nothing_calls_no_model_and_is_audited(monkeypatch):
    from app.services.ai import streaming

    added, audits = [], []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid)

        async def add_message(self, *a, **kw):
            added.append(a)

    async def get_db_service():
        return DB()

    async def fake_write_audit(**kw):
        audits.append(kw)
        return True

    async def over(db, sid, user_id, **kw):
        assert user_id == "u1"
        return budget.Exceeded("session", 60_000, 50_000)

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", fake_write_audit)
    monkeypatch.setattr(streaming.budget_mod, "check", over)
    model = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=None)))  # any call would raise
    service = SimpleNamespace(model="m", client=model, cluster_name="self")

    events = [e async for e in streaming.session_chat_stream(
        service, "s1", "hello", audit_actor={"user_id": "u1", "email": "a@b"}, audit_http={"ip": "10.0.0.1"})]

    assert len(events) == 1
    payload = json.loads(events[0].removeprefix("data: ").strip())
    assert payload["error_key"] == "budgetSession" and payload["error_args"] == {"used": 60_000, "limit": 50_000}
    assert added == []  # the message is not stored
    assert [a["action"] for a in audits] == ["ai.chat.budget_exceeded"]  # no ai.chat.send / ai.chat.complete
    row = audits[0]
    assert row["result"] == "failure" and row["target_id"] == "s1" and row["cluster"] == "self"
    assert row["after"] == {"session_id": "s1", "budget": "session", "used": 60_000, "limit": 50_000}
