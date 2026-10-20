"""POST /api/v1/alerts/webhook?cluster=<id> — Alertmanager's webhook receiver (payload version 4).

Not behind the signed-in-user dependency: Alertmanager sends Authorization:
Bearer <ALERT_WEBHOOK_TOKEN> (http_config.authorization). Every alert, firing
or resolved, goes into the alert inbox (inbox.py). Each firing alert then
passes the severity filter, then folds into a recent row of the same
cluster + fingerprint (Alertmanager repeats a firing group every
repeat_interval), or is skipped by the hourly cap / daily token budget, or is
queued for the worker. The answer comes at once; the investigation runs later.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field, ValidationError

from app.database import get_db_service, utcnow
from app.services.investigation import settings as inv_settings
from app.services.investigation import inbox, store

log = logging.getLogger(__name__)

router = APIRouter()

# Alerts read from one message; Alertmanager's own max_alerts is the place to cut more.
MAX_ALERTS_PER_MESSAGE = 100
# Set by the webhook after queueing, so the worker does not wait for its next poll.
wake = asyncio.Event()


class AmAlert(BaseModel):
    status: str = ""
    labels: dict[str, str] = Field(default_factory=dict)
    annotations: dict[str, str] = Field(default_factory=dict)
    startsAt: Optional[str] = None
    endsAt: Optional[str] = None
    generatorURL: str = ""
    fingerprint: str = ""


class AmWebhook(BaseModel):
    version: str = ""
    groupKey: str = ""
    status: str = ""
    receiver: str = ""
    externalURL: str = ""
    alerts: list[AmAlert] = Field(default_factory=list)


def bearer_matches(authorization: Optional[str], token: str) -> bool:
    if not token or not authorization:
        return False
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return False
    return hmac.compare_digest(value.strip().encode(), token.encode())


def fingerprint_of(alert: AmAlert) -> str:
    """Alertmanager always sends one; a hand-made message may not."""
    if alert.fingerprint:
        return alert.fingerprint[:64]
    raw = json.dumps(sorted(alert.labels.items()), separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def parse_time(value: Optional[str]) -> Optional[datetime]:
    if not value or value.startswith("0001-"):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


async def gate_and_queue(db, cfg: inv_settings.InvestigationSettings, cluster: str, msg: AmWebhook, now: datetime) -> dict[str, int]:
    counts = {"accepted": 0, "duplicate": 0, "filtered": 0, "skipped": 0, "resolved": 0, "dropped": 0, "stored": 0}
    alerts = msg.alerts[:MAX_ALERTS_PER_MESSAGE]
    counts["dropped"] = max(0, len(msg.alerts) - len(alerts))
    for alert in alerts:
        status = (alert.status or msg.status or "").lower()
        await inbox.record(
            db, cluster=cluster, fingerprint=fingerprint_of(alert), firing=status == "firing",
            starts_at=parse_time(alert.startsAt), ends_at=parse_time(alert.endsAt), labels=alert.labels,
            annotations=alert.annotations, generator_url=alert.generatorURL, alertmanager_url=msg.externalURL,
            receiver=msg.receiver, group_key=msg.groupKey, now=now,
        )
        counts["stored"] += 1
        if status != "firing":
            counts["resolved"] += 1
            continue
        severity = (alert.labels.get("severity") or "").strip().lower()
        if cfg.severities and severity not in cfg.severities:
            counts["filtered"] += 1
            continue
        fingerprint = fingerprint_of(alert)
        if cfg.dedupe_hours > 0:
            recent = await store.find_recent(db, cluster, fingerprint, now - timedelta(hours=cfg.dedupe_hours))
            if recent is not None:
                await store.bump_repeat(db, recent.id, now)
                counts["duplicate"] += 1
                continue
        skip_reason = ""
        if cfg.max_per_hour and await store.count_since(db, store.hour_ago(now)) >= cfg.max_per_hour:
            skip_reason = f"hourly cap ({cfg.max_per_hour} per hour)"
        elif cfg.daily_token_budget and await store.tokens_since(db, store.day_start(now)) >= cfg.daily_token_budget:
            skip_reason = f"daily token budget ({cfg.daily_token_budget} tokens, UTC day)"
        else:
            skip_reason = await store.pause_reason(db, cfg.provider_pause_minutes, now)
        await store.insert(
            db,
            cluster=cluster,
            fingerprint=fingerprint,
            alertname=(alert.labels.get("alertname") or "")[:200],
            severity=severity[:50],
            namespace=(alert.labels.get("namespace") or "")[:63],
            status="skipped" if skip_reason else "queued",
            skip_reason=skip_reason,
            labels=dict(alert.labels),
            annotations=dict(alert.annotations),
            starts_at=parse_time(alert.startsAt),
            generator_url=alert.generatorURL[:2000],
            alertmanager_url=msg.externalURL[:2000],
            group_key=msg.groupKey[:2000],
            received_at=now,
        )
        counts["skipped" if skip_reason else "accepted"] += 1
    return counts


@router.post("/webhook")
async def alert_webhook(
    request: Request,
    cluster: str = Query("", max_length=128),
    authorization: Optional[str] = Header(None),
) -> dict[str, Any]:
    cfg = inv_settings.load()
    if not cfg.enabled:
        raise HTTPException(status_code=404, detail="alert investigation is off (features.alertInvestigation.enabled)")
    if not cfg.webhook_token:
        raise HTTPException(status_code=503, detail="webhook token not configured (ALERT_WEBHOOK_TOKEN)")
    if not bearer_matches(authorization, cfg.webhook_token):
        raise HTTPException(status_code=401, detail="invalid webhook token")
    cluster = cluster.strip()
    if not cluster:
        raise HTTPException(status_code=400, detail="cluster query parameter is required (?cluster=<Kubeast cluster id>)")
    try:
        msg = AmWebhook.model_validate(await request.json())
    except (ValidationError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"not an Alertmanager webhook message: {str(e)[:200]}") from e
    db = await get_db_service()
    if not await store.cluster_exists(db, cluster):
        raise HTTPException(status_code=404, detail="unknown cluster")
    counts = await gate_and_queue(db, cfg, cluster, msg, utcnow())
    if counts["accepted"]:
        wake.set()
    log.info("alert webhook: cluster=%s receiver=%s %s", cluster, msg.receiver, counts)
    return counts
