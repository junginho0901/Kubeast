"""A run that outlives APPROVED_RUN_LIMIT_SECONDS: another server's sweep takes it for one a stopped ai-service left and
ends the approval failed as interrupted while the call is still going. When the call then comes back, its outcome is
known after all: the ai.tool.execute row is written with late_after_interrupt, and the approval row, the answer and
the chat message say the run finished after the approval was ended — never "approved and executed" over a failed row."""
import copy
import json
from datetime import timedelta
from types import SimpleNamespace

import pytest

import app.database
from app.database import APPROVED_RUN_LIMIT_SECONDS, INTERRUPTED_RESULT, DatabaseService, utcnow
from app.services import audit_writer

FAKE = "fake-secret-value"
PATCH = {
    "resource_type": "deployment", "resource_name": "web", "namespace": "shop",
    "patch": {"spec": {"template": {"spec": {"containers": [{"name": "app", "env": [{"name": "DB_PASSWORD", "value": FAKE}]}]}}}},
}


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
    service = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/late.db")
    await service.init_db()
    await service.create_session("s1", user_id="u1", title="t")

    async def get():
        return service

    monkeypatch.setattr(app.database, "get_db_service", get)
    yield service
    await service.engine.dispose()


def _api(monkeypatch, db, answer):
    import app.api as api

    class Service:
        tool_server = SimpleNamespace(last_access=None, last_requests=None)

        async def _call_tool_server(self, tool, args, approval_id=None, **_kw):
            # the call takes past the limit; meanwhile another server's sweep ends the approval as interrupted
            await db.update_tool_approval(approval_id, decided_at=utcnow() - timedelta(seconds=APPROVED_RUN_LIMIT_SECONDS + 1))
            assert await db.close_interrupted_tool_approvals() == 1
            return answer

    async def built(_authorization, cluster_name=None):
        return Service()

    monkeypatch.setattr(api, "_caller", lambda _auth: SimpleNamespace(user_id="u1"))
    monkeypatch.setattr(api, "_extract_audit_meta", lambda _request, _auth: ({"user_id": "u1", "email": "u1@example.com"}, {}))
    monkeypatch.setattr(api, "_build_ai_service", built)
    monkeypatch.setattr("app.services.ai.permissions.app_permission_error", lambda *a, **k: None)
    return api


@pytest.mark.parametrize("answer,outcome,result,said", [
    ("deployment.apps/web patched", "executed", "success", "was executed"),
    (json.dumps({"error": "the server rejected the patch"}), "failed", "failure", "failed"),
], ids=["executed", "failed"])
async def test_a_run_that_outlives_the_limit_says_it_finished_after_its_approval_was_ended(db, rows, monkeypatch, answer, outcome, result, said):
    api = _api(monkeypatch, db, answer)
    row = await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod",
                                        tool="k8s_patch_resource", args=copy.deepcopy(PATCH))

    card = await api.approve_tool_approval(row.id, request=SimpleNamespace(), authorization="Bearer x")

    assert [r["action"] for r in rows] == ["ai.tool.approve", "ai.tool.interrupt", "ai.tool.execute"]
    execute = rows[-1]
    assert execute.get("result", "success") == result, "the run's own outcome"
    assert execute["after"]["late_after_interrupt"] is True and execute["after"]["approval_id"] == row.id

    stored = await db.get_tool_approval(row.id)
    assert card["status"] == stored.status == "failed", "the approval stays ended as the sweep ended it"
    assert card["result"] == stored.result and stored.result != INTERRUPTED_RESULT
    assert stored.result.startswith(f"{outcome} after this approval was ended as interrupted")
    assert FAKE not in json.dumps(card["args"]) and FAKE not in json.dumps(stored.args)

    [message] = await db.get_messages("s1")
    assert "was approved and executed" not in message.content and "was approved and failed" not in message.content
    assert message.content.startswith(f"⚠️ `k8s_patch_resource` on `prod` {said} after its approval was ended as interrupted")
    assert stored.result in message.content
    [call] = message.tool_calls
    assert call["approval_status"] == "failed" and call["result"] == stored.result
    assert FAKE not in json.dumps(message.tool_calls)


async def test_a_run_whose_approval_is_still_its_own_ends_as_before(db, rows, monkeypatch):
    import app.api as api

    class Service:
        tool_server = SimpleNamespace(last_access=None, last_requests=None)

        async def _call_tool_server(self, *_a, **_kw):
            return "deployment.apps/web patched"

    async def built(_authorization, cluster_name=None):
        return Service()

    monkeypatch.setattr(api, "_caller", lambda _auth: SimpleNamespace(user_id="u1"))
    monkeypatch.setattr(api, "_extract_audit_meta", lambda _request, _auth: ({"user_id": "u1", "email": "u1@example.com"}, {}))
    monkeypatch.setattr(api, "_build_ai_service", built)
    monkeypatch.setattr("app.services.ai.permissions.app_permission_error", lambda *a, **k: None)
    row = await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod",
                                        tool="k8s_patch_resource", args=copy.deepcopy(PATCH))

    card = await api.approve_tool_approval(row.id, request=SimpleNamespace(), authorization="Bearer x")

    assert card["status"] == "executed" and card["result"] == "deployment.apps/web patched"
    assert [r["action"] for r in rows] == ["ai.tool.approve", "ai.tool.execute"]
    assert "late_after_interrupt" not in rows[-1]["after"]
    [message] = await db.get_messages("s1")
    assert "was approved and executed" in message.content
