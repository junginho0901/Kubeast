"""On PostgreSQL: a use's model is chosen in one statement, so two replicas choosing at once leave one row, and a config
deleted outside ai-service, as the ModelConfig controller deletes it, takes its choices with it.

Same throwaway database as tests/test_approval_interrupted_postgres.py; skipped when DBMIGRATE_TEST_DATABASE_URL is
unset."""

import asyncio
import os

import pytest
from sqlalchemy import text

from app.services import model_uses
from tests.test_approval_interrupted_postgres import URL_ENV, replicas  # noqa: F401

pytestmark = pytest.mark.skipif(not os.getenv(URL_ENV), reason=f"{URL_ENV} not set: needs a PostgreSQL server")


async def _config(db, name):
    return await db.create_model_config({"name": name, "provider": "openai", "model": "m", "api_key_env": "OPENAI_API_KEY"})


async def test_two_replicas_choosing_at_once_leave_one_choice(replicas):
    db, other = replicas
    a, b = await _config(db, "a"), await _config(db, "b")
    answers = await asyncio.gather(*(d.set_model_use(model_uses.OPTIMIZATION, c.id) for d, c in ((db, a), (other, b), (db, b), (other, a))))
    assert answers == [True, True, True, True]
    assert list(await other.get_model_uses()) == [model_uses.OPTIMIZATION]
    assert (await db.get_model_uses())[model_uses.OPTIMIZATION].name in ("a", "b")
    assert await db.set_model_use(model_uses.OPTIMIZATION, b.id + 1000) is False
    assert await db.set_model_use(model_uses.OPTIMIZATION, None) and await other.get_model_uses() == {}


async def test_a_config_deleted_outside_ai_service_takes_its_choices(replicas):
    db, other = replicas
    a, b = await _config(db, "a"), await _config(db, "b")
    await db.set_model_use(model_uses.INVESTIGATION, a.id)
    await db.set_model_use(model_uses.INVESTIGATE_NOW, b.id)
    async with other.engine.begin() as conn:
        await conn.execute(text("DELETE FROM model_configs WHERE name = 'a'"))
    assert {use: config.name for use, config in (await db.get_model_uses()).items()} == {model_uses.INVESTIGATE_NOW: "b"}
