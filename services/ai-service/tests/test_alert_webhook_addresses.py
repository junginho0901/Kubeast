"""The webhook keeps an alert's generatorURL and the message's externalURL only when it is an http or https URL with a
host, and stores "" otherwise (webhook.stored_address). The cases are the frontend's
(frontend/src/utils/safeHttpHref.cases.json, which ExternalHttpLink.test.ts runs for what the screens link)."""

import json
import logging
from datetime import datetime
from pathlib import Path

import pytest

from app.services.investigation import inbox, store, webhook
from app.services.investigation.settings import InvestigationSettings

CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "frontend" / "src" / "utils" / "safeHttpHref.cases.json").read_text(encoding="utf-8")
)["cases"]

NOW = datetime(2026, 11, 19, 3, 0, 0)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_address_cases(case):
    assert webhook.stored_address(case["address"]) == case["stored"]


def test_the_webhook_keeps_no_address_the_screens_would_not_link():
    assert [c["name"] for c in CASES if c["stored"] and c["href"] is None] == []
    assert {bool(c["stored"]) for c in CASES} == {True, False}


@pytest.fixture
async def sqlite_db(tmp_path):
    from app.database import DatabaseService

    db = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/addresses.db")
    await db.init_db()
    yield db
    await db.engine.dispose()


def message(external_url, *generator_urls):
    return webhook.AmWebhook(
        version="4", groupKey="{}:{alertname=\"X\"}", status="firing", receiver="kubeast", externalURL=external_url,
        alerts=[
            webhook.AmAlert(status="firing", labels={"alertname": f"A{i}", "severity": "critical", "namespace": "apps"},
                            annotations={"summary": "s"}, startsAt="2026-11-19T02:50:00Z", fingerprint=f"fp{i}", generatorURL=url)
            for i, url in enumerate(generator_urls)
        ],
    )


async def stored(db):
    """Each alert's addresses by fingerprint, in the inbox and in its investigation."""
    rows, _, _ = await inbox.list_rows(db, cluster="self", stale_before=NOW)
    investigations, _ = await store.list_rows(db)
    return (
        {r.fingerprint: (r.generator_url, r.alertmanager_url) for r in rows},
        {r.fingerprint: (r.generator_url, r.alertmanager_url) for r in investigations},
    )


SETTINGS = InvestigationSettings(enabled=True, max_per_hour=0, daily_token_budget=0)


@pytest.mark.asyncio
async def test_a_message_of_other_addresses_is_stored_with_them_empty_and_logged_by_scheme(monkeypatch, sqlite_db, caplog):
    monkeypatch.setattr(store, "utcnow", lambda: NOW)
    msg = message(
        "data:text/html,<script>alert(1)</script>",
        "javascript:alert(2)",
        "http://prometheus:9090/graph?g0.expr=up",
        "/graph?g0.expr=up",
    )
    with caplog.at_level(logging.WARNING, logger=webhook.log.name):
        counts = await webhook.gate_and_queue(sqlite_db, SETTINGS, "self", msg, NOW)
    assert (counts["stored"], counts["accepted"]) == (3, 3)
    expected = {"fp0": ("", ""), "fp1": ("http://prometheus:9090/graph?g0.expr=up", ""), "fp2": ("", "")}
    assert await stored(sqlite_db) == (expected, expected)
    lines = [r.getMessage() for r in caplog.records if r.name == webhook.log.name and r.levelno == logging.WARNING]
    assert lines == [
        "alert webhook: cluster=self externalURL stored empty: not an http or https URL with a host (scheme data)",
        "alert webhook: cluster=self generatorURL stored empty: not an http or https URL with a host (scheme javascript,none)",
    ]
    assert not any("alert(" in line or "<script>" in line or "graph" in line for line in lines)


@pytest.mark.asyncio
async def test_http_and_https_addresses_are_stored_as_sent_without_a_log_line(monkeypatch, sqlite_db, caplog):
    monkeypatch.setattr(store, "utcnow", lambda: NOW)
    msg = message(" https://Alertmanager.example.com:9093 ", "http://[::1]:9090/graph?g0.expr=up", "")
    with caplog.at_level(logging.WARNING, logger=webhook.log.name):
        await webhook.gate_and_queue(sqlite_db, SETTINGS, "self", msg, NOW)
    sender = "https://Alertmanager.example.com:9093"
    expected = {"fp0": ("http://[::1]:9090/graph?g0.expr=up", sender), "fp1": ("", sender)}
    assert await stored(sqlite_db) == (expected, expected)
    assert [r for r in caplog.records if r.name == webhook.log.name and r.levelno == logging.WARNING] == []


@pytest.mark.parametrize(("value", "scheme"), [
    ("javascript:alert(1)", "javascript"),
    ("VBScript:msgbox(1)", "vbscript"),
    ("http://a b/", "http"),
    ("java\tscript:alert(1)", "none"),
    ("/graph?g0.expr=a:b", "none"),
    ("no scheme", "none"),
    ("", "none"),
])
def test_the_log_names_a_scheme_and_nothing_else(value, scheme):
    assert webhook.scheme_of(value) == scheme
