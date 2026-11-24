"""Opening a card whose approved run is within APPROVED_RUN_LIMIT_SECONDS reads the row only: its age, already in
hand, says no sweep could end it, so neither the audit store's readiness probe (up to two 2 s timeouts while that store
does not answer) nor the sweep's SELECT runs. Past the limit the card is ended as before."""
import copy
from datetime import timedelta
from types import SimpleNamespace

import pytest

import app.database
from app.database import APPROVED_RUN_LIMIT_SECONDS, INTERRUPTED_RESULT, DatabaseService, utcnow
from app.services import audit_writer

ARGS = {"resource_type": "deployment", "resource_name": "web", "namespace": "shop", "replicas": 2}


@pytest.fixture
async def looks(tmp_path, monkeypatch):
    service = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/running.db")
    await service.init_db()
    await service.create_session("s1", user_id="u1", title="t")
    seen = {"probes": 0, "sweeps": 0}
    sweep = service.close_interrupted_tool_approvals

    async def get():
        return service

    async def probe():
        seen["probes"] += 1
        return True, None

    async def counted(*a, **k):
        seen["sweeps"] += 1
        return await sweep(*a, **k)

    async def write(**_kw):
        return True

    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "true")
    monkeypatch.setattr(app.database, "get_db_service", get)
    monkeypatch.setattr(audit_writer, "audit_ready", probe)
    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setattr(service, "close_interrupted_tool_approvals", counted)
    yield service, seen
    await service.engine.dispose()


async def _approved(db, seconds_ago):
    row = await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod",
                                        tool="k8s_scale", args=copy.deepcopy(ARGS))
    assert await db.transition_tool_approval(row.id, "pending", status="approved", decided_at=utcnow() - timedelta(seconds=seconds_ago))
    return row


async def _open(approval_id, monkeypatch):
    import app.api as api

    monkeypatch.setattr(api, "_caller", lambda _auth: SimpleNamespace(user_id="u1"))
    return await api.get_tool_approval(approval_id, authorization="Bearer x")


@pytest.mark.parametrize("seconds_ago", [0, APPROVED_RUN_LIMIT_SECONDS - 30])
async def test_a_running_card_within_the_limit_is_read_without_a_probe_or_a_sweep(looks, monkeypatch, seconds_ago):
    db, seen = looks
    row = await _approved(db, seconds_ago)
    seen.update(probes=0, sweeps=0)  # the new card's own sweep is not under test
    for _ in range(3):
        card = await _open(row.id, monkeypatch)
        assert card["status"] == "approved"
    assert seen == {"probes": 0, "sweeps": 0}


async def test_a_running_card_past_the_limit_is_still_ended(looks, monkeypatch):
    db, seen = looks
    row = await _approved(db, APPROVED_RUN_LIMIT_SECONDS + 30)
    seen.update(probes=0, sweeps=0)
    card = await _open(row.id, monkeypatch)
    assert (card["status"], card["result"]) == ("failed", INTERRUPTED_RESULT)
    assert seen == {"probes": 1, "sweeps": 1}
