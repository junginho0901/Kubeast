"""O-27: the ai-service's Postgres engine sets the session limits on each connection (asyncpg server_settings).

PostgreSQL's default for statement_timeout, lock_timeout and idle_in_transaction_session_timeout is 0
(no limit); the same DB_* variables and defaults as the Go services (services/pkg/dbsession).
"""
import pytest

from app import database, db_session

DEFAULTS = {
    "statement_timeout": "30000",
    "lock_timeout": "15000",
    "idle_in_transaction_session_timeout": "300000",
}
VARS = [var for var, _, _ in db_session.SESSION_LIMITS]


@pytest.fixture
def no_limit_vars(monkeypatch):
    for var in VARS:
        monkeypatch.delenv(var, raising=False)


def test_defaults_when_nothing_is_set(no_limit_vars):
    assert db_session.server_settings() == DEFAULTS


def test_values_in_milliseconds_and_zero_not_sent():
    env = {
        "DB_STATEMENT_TIMEOUT_MS": "60000",
        "DB_LOCK_TIMEOUT_MS": "0",
        "DB_IDLE_IN_TRANSACTION_TIMEOUT_MS": "120000",
    }
    assert db_session.server_settings(env) == {
        "statement_timeout": "60000",
        "idle_in_transaction_session_timeout": "120000",
    }


@pytest.mark.parametrize("value", ["-1", "30s", "1.5", "abc", " "])
def test_unreadable_value_keeps_the_default(value):
    assert db_session.server_settings({"DB_STATEMENT_TIMEOUT_MS": value})["statement_timeout"] == "30000"


def test_all_zero_sends_nothing():
    assert db_session.server_settings({var: "0" for var in VARS}) == {}


def test_the_go_services_variables_and_defaults():
    # services/pkg/dbsession: the same names and defaults
    assert [(v, p, d) for v, p, d in db_session.SESSION_LIMITS] == [
        ("DB_STATEMENT_TIMEOUT_MS", "statement_timeout", 30_000),
        ("DB_LOCK_TIMEOUT_MS", "lock_timeout", 15_000),
        ("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", "idle_in_transaction_session_timeout", 300_000),
    ]


def _engine_args(monkeypatch, url):
    seen = {}

    def fake_engine(engine_url, **kwargs):
        seen["url"] = engine_url
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(database, "create_async_engine", fake_engine)
    database.DatabaseService(url)
    return seen


def test_postgres_engine_gets_the_limits(monkeypatch, no_limit_vars):
    seen = _engine_args(monkeypatch, "postgresql+asyncpg://kubeast:pw@db.example:5432/kubeast")
    assert seen["connect_args"] == {"server_settings": DEFAULTS}


def test_postgres_engine_keeps_the_tls_argument_beside_the_limits(monkeypatch, no_limit_vars):
    seen = _engine_args(monkeypatch, "postgresql+asyncpg://kubeast:pw@db.example:5432/kubeast?sslmode=require")
    assert seen["url"] == "postgresql+asyncpg://kubeast:pw@db.example:5432/kubeast"
    assert seen["connect_args"] == {"ssl": "require", "server_settings": DEFAULTS}


def test_postgres_engine_with_every_limit_zero_sends_no_server_settings(monkeypatch):
    for var in VARS:
        monkeypatch.setenv(var, "0")
    seen = _engine_args(monkeypatch, "postgresql+asyncpg://kubeast:pw@db.example:5432/kubeast")
    assert seen["connect_args"] == {}


def test_sqlite_engine_gets_none(monkeypatch, no_limit_vars):
    seen = _engine_args(monkeypatch, "sqlite+aiosqlite:///./kubeast.db")
    assert seen["connect_args"] == {}
