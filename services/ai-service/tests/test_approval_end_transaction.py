"""An approved run's end (the approval leaving approved) and its ai.tool.execute row are one transaction
(DatabaseService.end_tool_run): a process stopped between the two leaves the approval approved, which the first look
past APPROVED_RUN_LIMIT_SECONDS ends with an ai.tool.interrupt row, never ended with no outcome row. An outcome row the
audit table refuses does not hold the approval, since the run has run: it ends on its own and the row is written after."""
import copy
from datetime import timedelta
from types import SimpleNamespace

import pytest

import app.database
from app.database import APPROVED_RUN_LIMIT_SECONDS, DatabaseService, utcnow
from app.services import audit_writer

FAKE = "fake-secret-value"
TOOL = "k8s_patch_resource"
PATCH = {
    "resource_type": "deployment", "resource_name": "web", "namespace": "shop",
    "patch": {"spec": {"template": {"spec": {"containers": [{"name": "app", "env": [{"name": "DB_PASSWORD", "value": FAKE}]}]}}}},
}


class _Stopped(BaseException):
    """The process going away in the middle of a statement (out of memory, a lost node): nothing after it runs."""


@pytest.fixture
def rows(monkeypatch):
    written = []

    async def ready():
        return None

    async def probe():
        return True, None

    async def write(**kw):
        written.append(kw)
        return True

    monkeypatch.setattr(audit_writer, "require_audit_ready", ready)
    monkeypatch.setattr(audit_writer, "audit_ready", probe)
    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setenv("AI_WRITE_APPROVAL", "true")
    monkeypatch.setattr("app.services.approval_token.sign", lambda *a, **k: "tok")
    return written


@pytest.fixture
async def db(tmp_path, rows, monkeypatch):
    service = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/end.db")
    await service.init_db()
    await service.create_session("s1", user_id="u1", title="t")

    async def get():
        return service

    monkeypatch.setattr(app.database, "get_db_service", get)
    yield service
    await service.engine.dispose()


def _api(monkeypatch, call):
    import app.api as api

    class Service:
        tool_server = SimpleNamespace(last_access=None, last_requests=None)

        async def _call_tool_server(self, tool, args, **_kw):
            return await call()

    async def built(_authorization, cluster_name=None):
        return Service()

    monkeypatch.setattr(api, "_caller", lambda _auth: SimpleNamespace(user_id="u1"))
    monkeypatch.setattr(api, "_extract_audit_meta", lambda _request, _auth: ({"user_id": "u1", "email": "u1@example.com"}, {}))
    monkeypatch.setattr(api, "_build_ai_service", built)
    monkeypatch.setattr("app.services.ai.permissions.app_permission_error", lambda *a, **k: None)
    return api


async def _card(db):
    return await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod",
                                         tool=TOOL, args=copy.deepcopy(PATCH))


async def _press(api, row):
    return await api.approve_tool_approval(row.id, request=SimpleNamespace(), authorization="Bearer x")


async def _answered():
    return "deployment.apps/web patched"


def _actions(rows):
    return [r["action"] for r in rows]


async def test_a_process_stopped_before_the_outcome_row_landed_leaves_the_approval_approved(db, rows, monkeypatch):
    async def write(**kw):
        if kw["action"] == "ai.tool.execute":
            raise _Stopped()
        rows.append(kw)
        return True

    monkeypatch.setattr(audit_writer, "write_audit", write)
    api = _api(monkeypatch, _answered)
    row = await _card(db)
    with pytest.raises(_Stopped):
        await _press(api, row)
    kept = await db.get_tool_approval(row.id)
    assert (kept.status, kept.result) == ("approved", None), "the end's move went with the row it never wrote"

    await db.update_tool_approval(row.id, decided_at=utcnow() - timedelta(seconds=APPROVED_RUN_LIMIT_SECONDS + 1))
    assert await db.close_interrupted_tool_approvals() == 1
    assert _actions(rows) == ["ai.tool.approve", "ai.tool.interrupt"], "the next look gives it an outcome row"


async def test_the_end_and_its_outcome_row_are_written_together(db, rows, monkeypatch):
    api = _api(monkeypatch, _answered)
    row = await _card(db)
    card = await _press(api, row)
    assert card["status"] == "executed" and (await db.get_tool_approval(row.id)).status == "executed"
    assert _actions(rows) == ["ai.tool.approve", "ai.tool.execute"]
    assert rows[-1]["conn"] is not None, "in the end's transaction"


async def test_an_outcome_row_the_audit_table_refuses_still_ends_the_run(db, rows, monkeypatch):
    async def write(**kw):
        rows.append(kw)
        return kw.get("conn") is None  # refused in the end's transaction, stored on its own after

    monkeypatch.setattr(audit_writer, "write_audit", write)
    api = _api(monkeypatch, _answered)
    row = await _card(db)
    card = await _press(api, row)
    assert card["status"] == "executed" and (await db.get_tool_approval(row.id)).status == "executed"
    assert [(r["action"], r.get("conn") is not None) for r in rows] == [
        ("ai.tool.approve", False), ("ai.tool.execute", True), ("ai.tool.execute", False)]
