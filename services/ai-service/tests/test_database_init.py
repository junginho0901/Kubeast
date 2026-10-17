"""get_db_service on a cold service: requests that arrive together share one initialisation."""

import asyncio

from app import database


async def test_concurrent_first_calls_share_one_initialisation(tmp_path, monkeypatch):
    # A fresh sqlite file: two create_all calls at once fail with "table … already exists".
    monkeypatch.setattr(database, "db_service", database.DatabaseService(f"sqlite+aiosqlite:///{tmp_path / 'cold.db'}"))
    monkeypatch.setattr(database, "db_initialized", False)
    results = await asyncio.gather(*(database.get_db_service() for _ in range(5)))
    assert all(r is database.db_service for r in results)
    assert database.db_initialized
