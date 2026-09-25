"""H2: write tools are parked for the user's approval, never run from the stream."""
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services.tool_whitelists import READONLY_TOOL_NAMES, WRITE_TOOL_NAMES, write_approval_required


def test_write_and_readonly_sets_are_disjoint_and_cover_dispatch():
    assert not (WRITE_TOOL_NAMES & READONLY_TOOL_NAMES)
    assert {"k8s_delete_resource", "k8s_scale", "k8s_apply_manifest", "k8s_execute_command"} <= WRITE_TOOL_NAMES


def test_write_approval_flag_defaults_on(monkeypatch):
    monkeypatch.delenv("AI_WRITE_APPROVAL", raising=False)
    assert write_approval_required()
    monkeypatch.setenv("AI_WRITE_APPROVAL", "false")
    assert not write_approval_required()


class _FakeDB:
    def __init__(self, approval):
        self.approval = approval
        self.updates = []

    async def get_tool_approval(self, approval_id):
        return self.approval if self.approval and self.approval.id == approval_id else None

    async def update_tool_approval(self, approval_id, **fields):
        self.updates.append(fields)
        for k, v in fields.items():
            setattr(self.approval, k, v)
        return self.approval


def _approval(**over):
    base = dict(
        id="ap1", session_id="s1", user_id="u1", user_email="u1@example.com", cluster="test2",
        tool="k8s_scale", args={"resource_type": "deployment", "name": "web", "replicas": 2},
        status="pending", result=None, created_at=datetime.utcnow(),
        expires_at=datetime.utcnow() + timedelta(minutes=10), decided_at=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


async def _patch_db(monkeypatch, db):
    from app import database

    async def fake_get_db_service():
        return db

    monkeypatch.setattr(database, "get_db_service", fake_get_db_service)


async def test_only_the_requesting_user_can_decide(monkeypatch):
    from app.api import _load_own_pending_approval

    db = _FakeDB(_approval())
    await _patch_db(monkeypatch, db)
    with pytest.raises(HTTPException) as exc:
        await _load_own_pending_approval("ap1", SimpleNamespace(user_id="someone-else"))
    assert exc.value.status_code == 404


async def test_expired_pending_is_marked_and_refused(monkeypatch):
    from app.api import _load_own_pending_approval

    db = _FakeDB(_approval(expires_at=datetime.utcnow() - timedelta(seconds=1)))
    await _patch_db(monkeypatch, db)
    with pytest.raises(HTTPException) as exc:
        await _load_own_pending_approval("ap1", SimpleNamespace(user_id="u1"))
    assert exc.value.status_code == 409
    assert db.approval.status == "expired"


async def test_decided_approval_cannot_be_reused(monkeypatch):
    from app.api import _load_own_pending_approval

    db = _FakeDB(_approval(status="executed"))
    await _patch_db(monkeypatch, db)
    with pytest.raises(HTTPException) as exc:
        await _load_own_pending_approval("ap1", SimpleNamespace(user_id="u1"))
    assert exc.value.status_code == 409


async def test_pending_own_approval_loads(monkeypatch):
    from app.api import _load_own_pending_approval

    db = _FakeDB(_approval())
    await _patch_db(monkeypatch, db)
    got_db, approval = await _load_own_pending_approval("ap1", SimpleNamespace(user_id="u1"))
    assert got_db is db and approval.id == "ap1" and approval.status == "pending"


async def test_call_tool_server_sends_approval_header(monkeypatch):
    from app.services.ai_service import AIService

    seen = {}

    class FakeToolServer:
        async def call_tool(self, name, arguments=None, headers=None):
            seen["name"], seen["args"], seen["headers"] = name, arguments, headers
            return "ok"

    svc = AIService.__new__(AIService)
    svc.tool_server = FakeToolServer()
    svc.cluster_name = "test2"
    from app.services.ai import permissions

    monkeypatch.setattr(permissions, "effective_cluster", lambda service: "test2")
    await svc._call_tool_server("k8s_scale", {"name": "web"}, approval_id="ap1")
    assert seen["headers"] == {"X-Kubeast-Approval-Id": "ap1"}
    assert seen["args"]["cluster"] == "test2"
    await svc._call_tool_server("k8s_get_resources", {"resource_type": "pods"})
    assert seen["headers"] is None
