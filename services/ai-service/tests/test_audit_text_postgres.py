"""A row is stored whatever text it holds, on PostgreSQL: the shared cases, each text a caller can send, and the codes
PostgreSQL answers for a text it refuses, as SQLAlchemy and asyncpg hand them to the writer.

Runs against the server named by DBMIGRATE_TEST_DATABASE_URL, as tests/test_audit_ready_postgres.py does, in a
throwaway database holding the audit table of migration 00001 and its indexes; skipped when it is unset."""

import json
import os
import random
import string
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import pytest
from sqlalchemy import text

import app.database
from app.services import audit_writer
from app.services.audit_text import INDEXED_MAX, refused_for_its_text

URL_ENV = "DBMIGRATE_TEST_DATABASE_URL"

pytestmark = pytest.mark.skipif(not os.getenv(URL_ENV), reason=f"{URL_ENV} not set: needs a PostgreSQL server")

CASES = json.loads((Path(__file__).parent / "fixtures" / "audit_text_cases.json").read_text())
COLUMNS = ("actor_user_id", "actor_email", "target_type", "target_id", "namespace", "request_ip", "user_agent", "request_id", "path", "cluster", "error")
HALF = chr(0xD800)
NUL = chr(0)

# services/pkg/dbmigrate/migrations/00001_baseline.sql
AUDIT_TABLE = """
CREATE TABLE auth_audit_logs (
    id SERIAL PRIMARY KEY, service VARCHAR, action VARCHAR NOT NULL, actor_user_id VARCHAR, actor_email VARCHAR,
    target_user_id VARCHAR, target_email VARCHAR, target_type VARCHAR, target_id VARCHAR,
    before JSONB DEFAULT '{}', after JSONB DEFAULT '{}', request_ip VARCHAR, user_agent VARCHAR, request_id VARCHAR,
    path VARCHAR, cluster VARCHAR, namespace VARCHAR, result VARCHAR NOT NULL DEFAULT 'success', error TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
)
"""
INDEXES = ("action", "actor_user_id", "service", "target_id")


@pytest.fixture
async def db(monkeypatch):
    import asyncpg

    from app.database import DatabaseService

    raw = os.environ[URL_ENV]
    name = f"ai_audit_text_test_{uuid.uuid4().hex[:12]}"
    admin = await asyncpg.connect(raw)
    await admin.execute(f'CREATE DATABASE "{name}"')
    service = DatabaseService(urlunsplit(urlsplit(raw)._replace(scheme="postgresql+asyncpg", path="/" + name)))
    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "true")
    monkeypatch.setattr(app.database, "db_service", service)
    monkeypatch.setattr(app.database, "db_initialized", True)
    monkeypatch.setattr(app.database, "interrupted_checked", True)
    monkeypatch.setattr(audit_writer, "_write_broken", False)
    monkeypatch.setattr(audit_writer, "_write_doubt", False)
    monkeypatch.setattr(audit_writer, "_ready_cache", {"at": 0.0, "ok": True, "error": None})
    try:
        async with service.engine.begin() as conn:
            await conn.execute(text(AUDIT_TABLE))
            for column in INDEXES:
                await conn.execute(text(f"CREATE INDEX idx_audit_{column} ON auth_audit_logs ({column})"))
        yield service
    finally:
        await service.engine.dispose()
        await admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        await admin.close()


async def _last(db):
    async with db.engine.connect() as conn:
        return (await conn.execute(text("SELECT * FROM auth_audit_logs ORDER BY id DESC LIMIT 1"))).mappings().one()


async def test_the_shared_cases_are_stored(db, capsys):
    for case in CASES["json"]:
        assert await audit_writer.write_audit(action="ai.tool.call", after=json.loads(case["input"])) is True, case["name"]
        row = await _last(db)
        stored = row["after"] if isinstance(row["after"], dict) else json.loads(row["after"])
        assert stored == json.loads(case["want"]), case["name"]
    for case in CASES["text"]:
        sent = bytes.fromhex(case["hex"]).decode(errors="surrogateescape")
        assert await audit_writer.write_audit(action="ai.tool.call", **{c: sent for c in COLUMNS}) is True, case["name"]
        row = await _last(db)
        assert {row[c] for c in COLUMNS} == {case["want"] or None}, case["name"]
    capsys.readouterr()


async def test_a_long_text_is_stored(db, capsys):
    r = random.Random(3)
    noise = "".join(r.choices(string.ascii_letters + string.digits, k=20000))  # it does not compress
    assert await audit_writer.write_audit(action="ai.tool.call", **{c: noise for c in COLUMNS}) is True
    row = await _last(db)
    for column in COLUMNS:
        assert row[column] == (noise[:INDEXED_MAX] if column in INDEXES else noise), column
    for after in ({"replicas": float("inf")}, {"v": HALF + NUL}, {NUL: [HALF]}):
        assert await audit_writer.write_audit(action="ai.tool.call", after=after, target_id=["a"], namespace=3) is True
    capsys.readouterr()


async def test_the_codes_postgresql_answers_for_a_text_it_refuses(db):
    for code, params in {
        "22021": {"path": "a" + NUL, "after": "{}"}, "22000": {"path": HALF, "after": "{}"},
        "22P05": {"path": "a", "after": r'{"a":"\u0000"}'}, "22P02": {"path": "a", "after": r'{"a":"\ud800"}'},
    }.items():
        with pytest.raises(Exception) as caught:
            async with db.engine.begin() as conn:
                await conn.execute(text("INSERT INTO auth_audit_logs (action, path, after) VALUES ('a', :path, :after)"), params)
        assert caught.value.orig.sqlstate == code and refused_for_its_text(caught.value) is True
    with pytest.raises(Exception) as caught:
        async with db.engine.begin() as conn:
            await conn.execute(text("ALTER SEQUENCE auth_audit_logs_id_seq MAXVALUE 100 RESTART 100"))
            await conn.execute(text("SELECT nextval('auth_audit_logs_id_seq'), nextval('auth_audit_logs_id_seq')"))
    assert caught.value.orig.sqlstate == "2200H" and refused_for_its_text(caught.value) is False
