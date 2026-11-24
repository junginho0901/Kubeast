"""An approve or reject press refused before anything runs is a failure row of its action, with the answer's reason in
`error` (docs/audit-log-plan.md §5-2): the approval does not exist or is not the caller's (404), is already decided,
expired or ended (409, also when another press won the race), or, for an approve, the approval token or the model
setting cannot be used (503). One refused because the audit store cannot take a row (D4) has none: it could not be
stored. The refusal itself and the card's state do not change."""
import copy
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import app.database
from app.database import APPROVED_RUN_LIMIT_SECONDS, DatabaseService, utcnow
from app.services import audit_writer

ARGS = {"resource_type": "deployment", "resource_name": "web", "namespace": "shop", "replicas": 2}


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
    monkeypatch.setattr("app.services.approval_token.sign", lambda *a, **k: "tok")
    return written


@pytest.fixture
async def db(tmp_path, rows, monkeypatch):
    service = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/refusals.db")
    await service.init_db()
    await service.create_session("s1", user_id="u1", title="t")

    async def get():
        return service

    monkeypatch.setattr(app.database, "get_db_service", get)
    yield service
    await service.engine.dispose()


def _api(monkeypatch, user="u1", build=None, ran=None):
    import app.api as api

    class Service:
        tool_server = SimpleNamespace(last_access=None, last_requests=None)

        async def _call_tool_server(self, tool, args, **_kw):
            if ran is not None:
                ran.append(tool)
            return "scaled"

    async def built(_authorization, cluster_name=None):
        if build is not None:
            await build()
        return Service()

    monkeypatch.setattr(api, "_caller", lambda _auth: SimpleNamespace(user_id=user))
    monkeypatch.setattr(api, "_extract_audit_meta", lambda _request, _auth: ({"user_id": user, "email": f"{user}@example.com"}, {"ip": "10.0.0.9"}))
    monkeypatch.setattr(api, "_build_ai_service", built)
    monkeypatch.setattr("app.services.ai.permissions.app_permission_error", lambda *a, **k: None)
    return api


async def _card(db):
    return await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod",
                                         tool="k8s_scale", args=copy.deepcopy(ARGS))


async def _press(api, kind, approval_id):
    press = api.approve_tool_approval if kind == "approve" else api.reject_tool_approval
    with pytest.raises(HTTPException) as refused:
        await press(approval_id, request=SimpleNamespace(), authorization="Bearer x")
    return refused.value


def _the_failure(rows, action):
    [row] = rows
    assert row["action"] == action and row["result"] == "failure"
    return row


@pytest.mark.parametrize("kind", ["approve", "reject"])
async def test_an_approval_that_is_not_the_callers_or_does_not_exist_is_a_failure_row(db, rows, monkeypatch, kind):
    card = await _card(db)
    api = _api(monkeypatch, user="u2")
    for approval_id in (card.id, "no-such-approval"):
        rows.clear()
        refusal = await _press(api, kind, approval_id)
        assert (refusal.status_code, refusal.detail) == (404, "Approval not found")
        row = _the_failure(rows, f"ai.tool.{kind}")
        assert row["error"] == "Approval not found" and row["actor_user_id"] == "u2" and row["request_ip"] == "10.0.0.9"
        # nothing of an approval the caller does not own goes into their row
        assert row["after"] == {"approval_id": approval_id} and row.get("cluster") is None and row.get("target_id") is None
    assert (await db.get_tool_approval(card.id)).status == "pending"


@pytest.mark.parametrize("kind", ["approve", "reject"])
@pytest.mark.parametrize("status", ["executed", "rejected", "expired"])
async def test_an_approval_already_decided_is_a_failure_row(db, rows, monkeypatch, kind, status):
    card = await _card(db)
    assert await db.transition_tool_approval(card.id, "pending", status=status, decided_at=utcnow())
    ran = []
    refusal = await _press(_api(monkeypatch, ran=ran), kind, card.id)
    assert (refusal.status_code, refusal.detail) == (409, f"Approval is {status}")
    row = _the_failure(rows, f"ai.tool.{kind}")
    assert row["error"] == f"Approval is {status}" and (row["cluster"], row["target_type"], row["target_id"]) == ("prod", "tool", "k8s_scale")
    assert row["after"] == {"approval_id": card.id, "session_id": "s1", "cluster": "prod"} and ran == []


@pytest.mark.parametrize("kind", ["approve", "reject"])
async def test_an_interrupted_approval_pressed_again_is_a_failure_row(db, rows, monkeypatch, kind):
    card = await _card(db)
    assert await db.transition_tool_approval(card.id, "pending", status="approved",
                                             decided_at=utcnow() - timedelta(seconds=APPROVED_RUN_LIMIT_SECONDS + 60))
    ran = []
    refusal = await _press(_api(monkeypatch, ran=ran), kind, card.id)
    assert (refusal.status_code, refusal.detail) == (409, "Approval is failed")
    assert [(r["action"], r.get("result", "success")) for r in rows] == [("ai.tool.interrupt", "success"), (f"ai.tool.{kind}", "failure")]
    assert rows[1]["error"] == "Approval is failed" and ran == []


async def test_a_model_setting_that_cannot_be_used_is_a_failure_row_and_the_card_waits(db, rows, monkeypatch):
    async def unusable():
        raise HTTPException(status_code=503, detail="No model is configured.")

    card, ran = await _card(db), []
    refusal = await _press(_api(monkeypatch, build=unusable, ran=ran), "approve", card.id)
    assert (refusal.status_code, refusal.detail) == (503, "No model is configured.")
    row = _the_failure(rows, "ai.tool.approve")
    assert row["error"] == "No model is configured." and row["target_id"] == "k8s_scale"
    assert (await db.get_tool_approval(card.id)).status == "pending" and ran == []


async def test_an_approval_token_that_cannot_be_signed_is_a_failure_row(db, rows, monkeypatch):
    from app.services.approval_token import ApprovalTokenUnavailable

    def unsigned(*_a, **_k):
        raise ApprovalTokenUnavailable("AI_APPROVAL_SECRET is not configured")

    card, ran = await _card(db), []
    api = _api(monkeypatch, ran=ran)
    monkeypatch.setattr("app.services.approval_token.sign", unsigned)
    refusal = await _press(api, "approve", card.id)
    assert refusal.status_code == 503
    assert _the_failure(rows, "ai.tool.approve")["error"] == "AI_APPROVAL_SECRET is not configured"
    assert (await db.get_tool_approval(card.id)).status == "pending" and ran == []


@pytest.mark.parametrize("kind", ["approve", "reject"])
async def test_a_press_another_press_beat_is_a_failure_row(db, rows, monkeypatch, kind):
    card, ran = await _card(db), []
    api = _api(monkeypatch, ran=ran)
    real = db.transition_tool_approval

    async def beaten(approval_id, from_status, **fields):
        if from_status == "pending":  # the other press moves the row first
            await real(approval_id, "pending", status="rejected", decided_at=utcnow())
        return await real(approval_id, from_status, **fields)

    monkeypatch.setattr(db, "transition_tool_approval", beaten)
    refusal = await _press(api, kind, card.id)
    assert (refusal.status_code, refusal.detail) == (409, "Approval is no longer pending")
    assert _the_failure(rows, f"ai.tool.{kind}")["error"] == "Approval is no longer pending" and ran == []


async def test_a_press_refused_because_the_audit_store_is_down_has_no_row(db, rows, monkeypatch):
    async def down():
        raise audit_writer.AuditUnavailable("database unreachable")

    card = await _card(db)
    api = _api(monkeypatch)
    monkeypatch.setattr(audit_writer, "require_audit_ready", down)
    for kind in ("approve", "reject"):
        refusal = await _press(api, kind, card.id)
        assert (refusal.status_code, refusal.detail) == (503, "audit unavailable")
    assert rows == [] and (await db.get_tool_approval(card.id)).status == "pending"
