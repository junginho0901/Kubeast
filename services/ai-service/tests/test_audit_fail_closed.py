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


# --- chat read tools, investigations and rejections (2026-10-21 audit gaps B2·B5·B6·B7) ---


class _ChatService:
    def __init__(self, response):
        self.response = response
        self.tool_server = None
        self.executed = []

    async def _execute_function_with_context(self, name, args, ctx):
        self.executed.append(name)
        return self.response


def _patch_chat_audit(monkeypatch, ready):
    rows = []

    async def audit_ready():
        return (True, None) if ready else (False, "database unreachable")

    async def write_audit(**kw):
        rows.append(kw)
        return ready

    monkeypatch.setattr(audit_writer, "audit_ready", audit_ready)
    monkeypatch.setattr(audit_writer, "write_audit", write_audit)
    return rows


ACTOR = {"user_id": "u1", "email": "dev@example.com"}


@pytest.mark.asyncio
async def test_a_chat_read_tool_does_not_run_when_its_row_cannot_be_stored(monkeypatch):
    import json

    from app.services.ai import streaming

    rows = _patch_chat_audit(monkeypatch, ready=False)
    service = _ChatService('{"items": []}')
    _events, _entry, llm_text = await streaming._call_tool(
        service, None, None, "s1", [], None, "k8s_get_pod_logs", {"namespace": "apps", "pod_name": "web-0"},
        iteration=1, audit_actor=ACTOR, audit_http=None)
    assert service.executed == []  # the cluster was not read
    assert json.loads(llm_text)["status"] == "audit_unavailable"
    assert rows[-1]["action"] == "ai.tool.call" and rows[-1]["result"] == "failure" and rows[-1]["error"] == "audit_unavailable"


@pytest.mark.asyncio
async def test_a_chat_tool_row_says_how_the_call_ended(monkeypatch):
    from app.services.ai import streaming

    rows = _patch_chat_audit(monkeypatch, ready=True)
    for response, result, status in [
        ('{"count": 3, "resource_type": "pods"}', "success", None),
        ('{"status": "not_found", "similar": ["web-1"]}', "success", "not_found"),  # the tool answered
        ('{"error": "권한 없음"}', "failure", None),
        ('{"status": "forbidden", "message": "no"}', "failure", "forbidden"),
    ]:
        await streaming._call_tool(
            _ChatService(response), None, None, "s1", [], None, "k8s_count", {"resource_type": "pods"},
            iteration=1, audit_actor=ACTOR, audit_http=None)
        assert (rows[-1]["result"], rows[-1]["after"]["status"]) == (result, status), response


def test_tool_outcome_reads_errors_refusals_and_answers():
    from app.services.ai.streaming import tool_outcome

    assert tool_outcome('{"error": "boom"}') == ("failure", "boom", None)
    assert tool_outcome('{"status": "not_permitted"}') == ("failure", "not_permitted", "not_permitted")
    assert tool_outcome('{"status": "rate_limited"}')[0] == "failure"
    assert tool_outcome('{"status": "unavailable"}') == ("success", None, "unavailable")
    assert tool_outcome("NAME READY\npod-1 1/1") == ("success", None, None)  # kubectl text
    assert tool_outcome('[1, 2]') == ("success", None, None)


@pytest.mark.asyncio
async def test_an_investigation_does_not_start_while_the_audit_store_is_down(monkeypatch):
    from app.services.investigation import runner

    async def down():
        return False, "database unreachable"

    monkeypatch.setattr(runner, "audit_ready", down)
    with pytest.raises(runner.InvestigationError, match="audit log unavailable"):
        await runner.investigate(SimpleNamespace(timeout_seconds=60), SimpleNamespace(id="inv-1"))


@pytest.mark.asyncio
async def test_reject_refuses_before_leaving_pending(monkeypatch):
    from fastapi import HTTPException

    import app.api as api
    import app.database

    monkeypatch.setattr(app.database, "get_db_service", _pg_db(fail=True))
    transitions = []

    class _DB:
        async def transition_tool_approval(self, *a, **k):
            transitions.append((a, k))
            return None

    approval = SimpleNamespace(id="ap1", user_id="u1", cluster="self", tool="k8s_scale", args={}, session_id="s1")

    async def load(approval_id, payload):
        return _DB(), approval

    monkeypatch.setattr(api, "_load_own_pending_approval", load)
    monkeypatch.setattr(api, "_caller", lambda auth: SimpleNamespace(user_id="u1"))
    with pytest.raises(HTTPException) as exc:
        await api.reject_tool_approval("ap1", request=SimpleNamespace(), authorization="Bearer x")
    assert exc.value.status_code == 503 and transitions == []


@pytest.mark.asyncio
async def test_after_a_failed_write_readiness_probes_a_write(monkeypatch):
    """The database answers SELECT 1 but the audit table takes no row: after a failed write, readiness probes an
    insert (rolled back) and refuses until one lands; no probe before any failure."""
    import app.database

    state = {"insert_fails": True, "statements": [], "rollbacks": 0}

    class _Trans:
        async def rollback(self):
            state["rollbacks"] += 1

    class _ProbeConn:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def begin(self):
            return _Trans()

        async def execute(self, stmt, *_a, **_k):
            sql = str(stmt).strip()
            state["statements"].append(sql.split()[0])
            if sql.startswith("INSERT") and state["insert_fails"]:
                raise RuntimeError("audit table refuses rows")

    class _ProbeEngine:
        def connect(self):
            return _ProbeConn()

        def begin(self):  # write_audit's transaction
            return _ProbeConn()

    async def db():
        return SimpleNamespace(database_url="postgresql+asyncpg://x", engine=_ProbeEngine())

    monkeypatch.setattr(app.database, "get_db_service", db)
    monkeypatch.setattr(audit_writer, "_write_broken", False)
    assert await audit_writer.audit_ready() == (True, None)
    assert state["statements"] == ["SELECT"]  # healthy: no probe

    assert await audit_writer.write_audit(action="ai.tool.call") is False  # the row is refused
    ok, err = await audit_writer.audit_ready()
    assert ok is False and "refuses rows" in err and state["rollbacks"] == 1

    state["insert_fails"] = False
    audit_writer._ready_cache["at"] = 0.0
    assert await audit_writer.audit_ready() == (True, None)
    assert audit_writer._write_broken is False
    before = len(state["statements"])
    audit_writer._ready_cache["at"] = 0.0
    assert await audit_writer.audit_ready() == (True, None)
    assert state["statements"][before:] == ["SELECT"]  # no probe once healthy again
    # a row that lands clears it without a probe
    state["insert_fails"] = True
    assert await audit_writer.write_audit(action="ai.tool.call") is False and audit_writer._write_broken is True
    state["insert_fails"] = False
    assert await audit_writer.write_audit(action="ai.tool.call") is True and audit_writer._write_broken is False
