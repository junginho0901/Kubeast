"""audit_writer mirrors every record to stdout as one JSON line (event: audit),
in the same shape as services/pkg/audit StdoutTee, before the DB insert."""
import json
from types import SimpleNamespace

import pytest

from app.services import audit_writer


async def _sqlite_db():
    # Non-Postgres URL → write_audit skips the insert after emitting stdout.
    return SimpleNamespace(database_url="sqlite+aiosqlite:///:memory:")


@pytest.fixture(autouse=True)
def _no_db(monkeypatch):
    import app.database

    monkeypatch.setattr(app.database, "get_db_service", _sqlite_db)


@pytest.mark.asyncio
async def test_write_audit_emits_one_json_line(monkeypatch, capsys):
    monkeypatch.delenv("AUDIT_STDOUT", raising=False)
    await audit_writer.write_audit(
        action="ai.tool.call",
        actor_user_id="u1",
        actor_email="a@example.com",
        target_type="tool",
        target_id="k8s_get_resource_yaml",
        namespace="app",
        after={"tool": "k8s_get_resource_yaml", "redacted": {"count": 2}},
        request_ip="10.0.0.1",
        request_id="req-1",
        path="/api/v1/ai/sessions/s1/chat",
    )
    lines = [l for l in capsys.readouterr().out.splitlines() if l.strip()]
    assert len(lines) == 1
    got = json.loads(lines[0])
    assert got["msg"] == "audit" and got["event"] == "audit" and got["level"] == "INFO"
    a = got["audit"]
    assert a["service"] == "ai" and a["action"] == "ai.tool.call" and a["result"] == "success"
    assert a["actor_email"] == "a@example.com" and a["target_id"] == "k8s_get_resource_yaml"
    assert a["namespace"] == "app" and a["request_ip"] == "10.0.0.1" and a["request_id"] == "req-1"
    assert a["after"]["redacted"]["count"] == 2
    assert "error" not in a and "user_agent" not in a  # None fields are dropped


@pytest.mark.asyncio
async def test_write_audit_failure_carries_error(monkeypatch, capsys):
    monkeypatch.delenv("AUDIT_STDOUT", raising=False)
    await audit_writer.write_audit(action="ai.chat.send", result="failure", error="provider timeout")
    a = json.loads(capsys.readouterr().out.strip())["audit"]
    assert a["result"] == "failure" and a["error"] == "provider timeout"


@pytest.mark.asyncio
async def test_write_audit_stdout_switch_off(monkeypatch, capsys):
    monkeypatch.setenv("AUDIT_STDOUT", "false")
    await audit_writer.write_audit(action="ai.chat.send")
    assert capsys.readouterr().out.strip() == ""
    assert audit_writer.stdout_enabled() is False
    monkeypatch.setenv("AUDIT_STDOUT", "0")
    assert audit_writer.stdout_enabled() is False
    monkeypatch.delenv("AUDIT_STDOUT")
    assert audit_writer.stdout_enabled() is True
