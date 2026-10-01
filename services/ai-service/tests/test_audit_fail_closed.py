"""N1: the audit database is a precondition for write tools. audit_ready probes
the engine (cached), require_audit_ready refuses when the probe fails, and the
approve endpoint answers 503 before the approval leaves `pending`."""
from types import SimpleNamespace

import pytest

from app.services import audit_writer


class _Conn:
    def __init__(self, fail):
        self.fail = fail

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, *_args, **_kwargs):
        if self.fail:
            raise ConnectionRefusedError("connection refused")
        return None


class _Engine:
    def __init__(self, fail):
        self.fail = fail

    def connect(self):
        return _Conn(self.fail)


def _pg_db(fail):
    async def get():
        return SimpleNamespace(database_url="postgresql+asyncpg://x", engine=_Engine(fail))

    return get


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    monkeypatch.delenv("AUDIT_FAIL_CLOSED", raising=False)
    audit_writer._ready_cache.update(at=0.0, ok=True, error=None)
    yield
    audit_writer._ready_cache.update(at=0.0, ok=True, error=None)


@pytest.mark.asyncio
async def test_ready_when_select_succeeds(monkeypatch):
    import app.database

    monkeypatch.setattr(app.database, "get_db_service", _pg_db(fail=False))
    assert await audit_writer.audit_ready() == (True, None)
    await audit_writer.require_audit_ready()  # no raise


@pytest.mark.asyncio
async def test_refuses_when_select_fails_and_caches(monkeypatch):
    import app.database

    calls = {"n": 0}
    original = _pg_db(fail=True)

    async def counting():
        calls["n"] += 1
        return await original()

    monkeypatch.setattr(app.database, "get_db_service", counting)
    ok, err = await audit_writer.audit_ready()
    assert ok is False and "connection refused" in err
    with pytest.raises(audit_writer.AuditUnavailable):
        await audit_writer.require_audit_ready()
    # Second check inside READY_TTL_SEC reuses the probe result.
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_fail_closed_off_never_probes(monkeypatch):
    import app.database

    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "false")

    async def boom():
        raise AssertionError("must not probe")

    monkeypatch.setattr(app.database, "get_db_service", boom)
    assert await audit_writer.audit_ready() == (True, None)


@pytest.mark.asyncio
async def test_sqlite_dev_database_is_always_ready(monkeypatch):
    import app.database

    async def sqlite():
        return SimpleNamespace(database_url="sqlite+aiosqlite:///:memory:")

    monkeypatch.setattr(app.database, "get_db_service", sqlite)
    assert await audit_writer.audit_ready() == (True, None)


@pytest.mark.asyncio
async def test_write_audit_reports_the_row_and_drops_the_cache(monkeypatch, capsys):
    import app.database

    class _Begin(_Conn):
        pass

    class _EngineBegin:
        def __init__(self, fail):
            self.fail = fail

        def begin(self):
            return _Begin(self.fail)

    async def ok_db():
        return SimpleNamespace(database_url="postgresql+asyncpg://x", engine=_EngineBegin(False))

    async def bad_db():
        return SimpleNamespace(database_url="postgresql+asyncpg://x", engine=_EngineBegin(True))

    monkeypatch.setattr(app.database, "get_db_service", ok_db)
    assert await audit_writer.write_audit(action="ai.tool.approve") is True

    audit_writer._ready_cache.update(at=10**9, ok=True, error=None)  # pretend a fresh "ready"
    before = audit_writer.write_failures
    monkeypatch.setattr(app.database, "get_db_service", bad_db)
    assert await audit_writer.write_audit(action="ai.tool.call") is False
    assert audit_writer.write_failures == before + 1
    assert audit_writer._ready_cache["at"] == 0.0  # next readiness check probes again
    capsys.readouterr()  # stdout mirror lines are not under test here


@pytest.mark.asyncio
async def test_approve_refuses_before_leaving_pending(monkeypatch):
    """With the audit database down, POST /tool-approvals/{id}/approve is 503
    and the approval is still pending (no transition, no tool run)."""
    from fastapi import HTTPException

    import app.api as api
    import app.database

    monkeypatch.setattr(app.database, "get_db_service", _pg_db(fail=True))

    transitions = []

    class _DB:
        async def transition_tool_approval(self, *a, **k):
            transitions.append((a, k))
            return None

    approval = SimpleNamespace(id="ap1", user_id="u1", cluster="self", tool="k8s_scale", args={"replicas": 2}, session_id="s1")

    async def load(approval_id, payload):
        return _DB(), approval

    monkeypatch.setattr(api, "_load_own_pending_approval", load)
    monkeypatch.setattr(api, "_caller", lambda auth: SimpleNamespace(user_id="u1"))
    monkeypatch.setattr("app.services.approval_token.sign", lambda *a, **k: "tok")

    with pytest.raises(HTTPException) as exc:
        await api.approve_tool_approval("ap1", request=SimpleNamespace(), authorization="Bearer x")
    assert exc.value.status_code == 503 and "audit unavailable" in exc.value.detail
    assert transitions == []  # still pending
