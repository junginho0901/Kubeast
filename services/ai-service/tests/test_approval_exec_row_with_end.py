"""An approved exec's k8s.pod.exec row goes in the transaction of the run's end, with its ai.tool.execute row
(DatabaseService.end_tool_run's also): a process stopped before it landed leaves the approval approved, which the first
look past APPROVED_RUN_LIMIT_SECONDS ends with an ai.tool.interrupt row, never ended with no k8s.pod.exec row. A row the
audit table refuses does not hold the approval, since the run has run: it ends on its own and both rows are written
after it. Both rows are mirrored to stdout only once the transaction has committed."""
from datetime import timedelta

import pytest

from app.database import APPROVED_RUN_LIMIT_SECONDS, utcnow
from app.services import audit_writer
from tests.test_approval_end_transaction import _Stopped, _actions, _answered, _api, _press, db, rows  # noqa: F401

EXEC = "k8s_execute_command"
ARGS = {"pod_name": "web-0", "namespace": "shop", "command": ["date"]}


async def _exec_card(db):
    return await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod",
                                         tool=EXEC, args=dict(ARGS))


async def test_the_exec_row_is_in_the_ends_transaction(db, rows, monkeypatch):
    mirrored = []
    monkeypatch.setattr(audit_writer, "_emit_stdout", lambda record: mirrored.append(record["action"]))
    api = _api(monkeypatch, _answered)
    row = await _exec_card(db)
    card = await _press(api, row)
    assert card["status"] == "executed" and (await db.get_tool_approval(row.id)).status == "executed"
    assert _actions(rows) == ["ai.tool.approve", "ai.tool.execute", "k8s.pod.exec"]
    outcome, pod_exec = rows[-2], rows[-1]
    assert outcome["conn"] is not None and pod_exec["conn"] is outcome["conn"], "one transaction for both"
    assert (pod_exec["target_type"], pod_exec["target_id"], pod_exec["namespace"], pod_exec["result"]) == (
        "pod", "web-0", "shop", "success")
    assert pod_exec["after"]["approval_id"] == row.id and pod_exec["after"]["command"] == ["date"]
    assert mirrored == ["ai.tool.execute", "k8s.pod.exec"], "both mirrored once committed"


async def test_a_process_stopped_before_the_exec_row_landed_leaves_the_approval_approved(db, rows, monkeypatch):
    async def write(**kw):
        if kw["action"] == "k8s.pod.exec":
            raise _Stopped()
        rows.append(kw)
        return True

    monkeypatch.setattr(audit_writer, "write_audit", write)
    api = _api(monkeypatch, _answered)
    row = await _exec_card(db)
    with pytest.raises(_Stopped):
        await _press(api, row)
    kept = await db.get_tool_approval(row.id)
    assert (kept.status, kept.result) == ("approved", None), "the end went with the exec row it never wrote"

    await db.update_tool_approval(row.id, decided_at=utcnow() - timedelta(seconds=APPROVED_RUN_LIMIT_SECONDS + 1))
    assert await db.close_interrupted_tool_approvals() == 1
    assert [(r["action"], r.get("conn") is not None) for r in rows] == [
        ("ai.tool.approve", False), ("ai.tool.execute", True), ("ai.tool.interrupt", True)], (
        "the execute row went with the rolled back transaction; the next look gives the run an outcome row")


async def test_an_exec_row_the_audit_table_refuses_still_ends_the_run(db, rows, monkeypatch):
    async def write(**kw):
        rows.append(kw)
        return kw.get("conn") is None or kw["action"] != "k8s.pod.exec"  # refused in the end's transaction only

    monkeypatch.setattr(audit_writer, "write_audit", write)
    api = _api(monkeypatch, _answered)
    row = await _exec_card(db)
    card = await _press(api, row)
    assert card["status"] == "executed" and (await db.get_tool_approval(row.id)).status == "executed"
    assert [(r["action"], r.get("conn") is not None) for r in rows] == [
        ("ai.tool.approve", False), ("ai.tool.execute", True), ("k8s.pod.exec", True),
        ("ai.tool.execute", False), ("k8s.pod.exec", False)]


async def test_a_refused_exec_writes_no_exec_row(db, rows, monkeypatch):
    api = _api(monkeypatch, _answered)
    monkeypatch.setattr("app.services.ai.permissions.app_permission_error", lambda *a, **k: "no resource.pod.exec")
    row = await _exec_card(db)
    await _press(api, row)
    assert _actions(rows) == ["ai.tool.approve", "ai.tool.execute"], "nothing ran in the pod"
