"""write_audit fills the `cluster` column from the caller and leaves it empty when unknown."""
import pytest

from app.services import audit_writer


class _Conn:
    def __init__(self, calls):
        self.calls = calls

    async def execute(self, sql, params):
        self.calls.append(params)


class _Begin:
    def __init__(self, calls):
        self.calls = calls

    async def __aenter__(self):
        return _Conn(self.calls)

    async def __aexit__(self, *exc):
        return False


class _Engine:
    def __init__(self, calls):
        self.calls = calls

    def begin(self):
        return _Begin(self.calls)


class _DB:
    def __init__(self, calls):
        self.database_url = "postgresql+asyncpg://kubeast@postgres/kubeast"
        self.engine = _Engine(calls)


@pytest.fixture
def captured(monkeypatch):
    calls: list[dict] = []

    async def fake_get_db_service():
        return _DB(calls)

    import app.database

    monkeypatch.setattr(app.database, "get_db_service", fake_get_db_service)
    return calls


async def test_cluster_column_from_caller(captured):
    await audit_writer.write_audit(action="ai.chat.complete", cluster="prod-a", after={"x": 1})
    assert len(captured) == 1
    assert captured[0]["cluster"] == "prod-a"
    assert captured[0]["action"] == "ai.chat.complete"


async def test_cluster_column_empty_when_unset(captured):
    # Not a cluster that happens to be called "default".
    await audit_writer.write_audit(action="ai.chat.send")
    await audit_writer.write_audit(action="ai.chat.send", cluster="")
    assert [c["cluster"] for c in captured] == [None] * 2


async def test_stdout_mirror_carries_the_same_cluster(captured, monkeypatch, capsys):
    import json

    monkeypatch.setenv("AUDIT_STDOUT", "true")
    await audit_writer.write_audit(action="ai.chat.complete", cluster="prod-a")
    lines = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.strip()]
    assert len(lines) == 1
    assert lines[0]["event"] == "audit"
    assert lines[0]["audit"]["cluster"] == "prod-a" == captured[0]["cluster"]
