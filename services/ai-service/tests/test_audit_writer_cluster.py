"""write_audit fills the `cluster` column from the caller and falls back to DEFAULT_CLUSTER."""
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


async def test_cluster_column_defaults_when_unset_or_empty(captured):
    await audit_writer.write_audit(action="ai.chat.send")
    await audit_writer.write_audit(action="ai.chat.send", cluster="")
    assert [c["cluster"] for c in captured] == [audit_writer.DEFAULT_CLUSTER] * 2
