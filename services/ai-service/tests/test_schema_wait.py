"""ai-service does not run DDL against Postgres any more: it waits for the goose
schema version that auth-service's migrations write (services/pkg/dbmigrate)."""
import pytest

from app import database


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class _Conn:
    def __init__(self, answers):
        self._answers = answers

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, stmt):
        sql = str(stmt)
        if "information_schema.tables" in sql:
            return _Result(self._answers["exists"])
        if "goose_db_version" in sql:
            return _Result(self._answers["version"])
        raise AssertionError(f"unexpected SQL: {sql}")


class _Engine:
    def __init__(self, answers):
        self.answers = answers

    def connect(self):
        return _Conn(self.answers)


@pytest.mark.asyncio
async def test_read_schema_version_without_table_is_zero():
    assert await database.read_schema_version(_Engine({"exists": False, "version": None})) == 0


@pytest.mark.asyncio
async def test_read_schema_version_reads_latest_applied():
    assert await database.read_schema_version(_Engine({"exists": True, "version": 2})) == 2


@pytest.mark.asyncio
async def test_wait_for_schema_returns_when_ready():
    assert await database.wait_for_schema(_Engine({"exists": True, "version": 2}), required=2, timeout_seconds=1, poll_seconds=0.01) == 2


@pytest.mark.asyncio
async def test_wait_for_schema_times_out_with_versions_in_message():
    with pytest.raises(RuntimeError) as exc:
        await database.wait_for_schema(_Engine({"exists": True, "version": 1}), required=2, timeout_seconds=0.05, poll_seconds=0.01)
    assert "version 2 required" in str(exc.value) and "database is at 1" in str(exc.value)


def test_required_version_matches_go_migrations():
    # Keep in step with services/pkg/dbmigrate.Required.
    assert database.REQUIRED_SCHEMA_VERSION == 3
