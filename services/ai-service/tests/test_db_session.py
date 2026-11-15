"""O-27: the ai-service's Postgres engine sets the session limits on each new connection and keeps its pool size.

PostgreSQL's default for statement_timeout, lock_timeout and idle_in_transaction_session_timeout is 0
(no limit); the same DB_* variables and defaults as the Go services (services/pkg/dbsession). The limits
are SET after connecting (the pool's "connect" event), not sent as startup parameters.
"""
import pytest
from sqlalchemy import event

from app import database, db_session

DEFAULTS = [
    "SET statement_timeout = 30000",
    "SET lock_timeout = 15000",
    "SET idle_in_transaction_session_timeout = 300000",
]
VARS = [var for var, _, _ in db_session.SESSION_LIMITS] + [db_session.POOL_MAX_ENV]
PG_URL = "postgresql+asyncpg://kubeast:pw@db.example:5432/kubeast"


@pytest.fixture
def no_db_vars(monkeypatch):
    for var in VARS:
        monkeypatch.delenv(var, raising=False)


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self.closed = False

    def execute(self, stmt):
        self.conn.seen.append(stmt)
        self.conn.autocommit_at.append(self.conn.autocommit)

    def close(self):
        self.closed = True


class FakeDBAPIConnection:
    def __init__(self):
        self.seen = []
        self.autocommit_at = []
        self.autocommit = False
        self.cursors = []

    def cursor(self):
        c = FakeCursor(self)
        self.cursors.append(c)
        return c


def test_defaults_when_nothing_is_set(no_db_vars):
    assert db_session.statements() == DEFAULTS
    assert db_session.pool_args() == {"pool_size": 5, "max_overflow": 10}


def test_values_in_milliseconds_and_zero_not_set():
    env = {
        "DB_STATEMENT_TIMEOUT_MS": "60000",
        "DB_LOCK_TIMEOUT_MS": "0",
        "DB_IDLE_IN_TRANSACTION_TIMEOUT_MS": "120000",
    }
    assert db_session.statements(env) == [
        "SET statement_timeout = 60000",
        "SET idle_in_transaction_session_timeout = 120000",
    ]


@pytest.mark.parametrize("value", ["-1", "30s", "1.5", "abc", " "])
def test_unreadable_value_keeps_the_default(value):
    assert db_session.statements({"DB_STATEMENT_TIMEOUT_MS": value})[0] == "SET statement_timeout = 30000"


def test_all_zero_sets_nothing():
    assert db_session.statements({var: "0" for var, _, _ in db_session.SESSION_LIMITS}) == []


@pytest.mark.parametrize(
    "value, want",
    [("3", {"pool_size": 3, "max_overflow": 0}), ("40", {"pool_size": 5, "max_overflow": 35}),
     ("0", {"pool_size": 5, "max_overflow": 10}), ("x", {"pool_size": 5, "max_overflow": 10})],
)
def test_pool_size_from_the_variable(value, want):
    assert db_session.pool_args({"DB_POOL_MAX_AI": value}) == want


def test_the_go_services_variables_and_defaults():
    # services/pkg/dbsession: the same names and defaults
    assert list(db_session.SESSION_LIMITS) == [
        ("DB_STATEMENT_TIMEOUT_MS", "statement_timeout", 30_000),
        ("DB_LOCK_TIMEOUT_MS", "lock_timeout", 15_000),
        ("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", "idle_in_transaction_session_timeout", 300_000),
    ]


def test_postgres_engine_sets_the_limits_on_each_new_connection(no_db_vars):
    svc = database.DatabaseService(PG_URL)
    assert svc.on_connect is not None
    assert event.contains(svc.engine.sync_engine, "connect", svc.on_connect)
    conn = FakeDBAPIConnection()
    svc.on_connect(conn, None)
    assert conn.seen == DEFAULTS
    assert all(c.closed for c in conn.cursors)


def test_the_limits_are_set_in_autocommit_and_the_mode_is_put_back():
    # A SET inside the transaction the DBAPI begins at its first statement is undone when that transaction rolls
    # back (a first use that only reads, the pool's reset on return): the SETs run in autocommit.
    conn = FakeDBAPIConnection()
    db_session.on_connect(DEFAULTS)(conn, None)
    assert conn.autocommit_at == [True, True, True]
    assert conn.autocommit is False


def test_autocommit_is_put_back_when_a_set_fails():
    class Refused(FakeDBAPIConnection):
        def cursor(self):
            c = super().cursor()

            def execute(stmt):
                raise RuntimeError("refused")

            c.execute = execute
            return c

    conn = Refused()
    with pytest.raises(RuntimeError):
        db_session.on_connect(DEFAULTS)(conn, None)
    assert conn.autocommit is False
    assert all(c.closed for c in conn.cursors)


def test_postgres_engine_pool_size(monkeypatch, no_db_vars):
    pool = database.DatabaseService(PG_URL).engine.sync_engine.pool
    assert (pool.size(), pool._max_overflow) == (5, 10)
    monkeypatch.setenv("DB_POOL_MAX_AI", "8")
    pool = database.DatabaseService(PG_URL).engine.sync_engine.pool
    assert (pool.size(), pool._max_overflow) == (5, 3)


def test_postgres_engine_with_every_limit_zero_has_no_listener(monkeypatch):
    for var, _, _ in db_session.SESSION_LIMITS:
        monkeypatch.setenv(var, "0")
    assert database.DatabaseService(PG_URL).on_connect is None


def test_sqlite_engine_gets_none(no_db_vars, tmp_path):
    svc = database.DatabaseService(f"sqlite+aiosqlite:///{tmp_path / 'limits.db'}")
    assert svc.on_connect is None
