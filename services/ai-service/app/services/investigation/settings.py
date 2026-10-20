"""Chart values (features.alertInvestigation.*) as environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class InvestigationSettings:
    enabled: bool = False
    webhook_token: str = ""
    severities: tuple[str, ...] = ("critical", "warning")
    dedupe_hours: int = 24
    max_per_hour: int = 6
    daily_token_budget: int = 200_000
    # Minutes no investigation runs after the model provider refused for credit or the key (0 = never pause).
    provider_pause_minutes: int = 30
    max_steps: int = 8
    timeout_seconds: int = 300
    model: str = ""
    language: str = "en"
    console_url: str = ""
    token_url: str = "http://auth-service:8004/api/v1/auth/internal/investigator-token"
    internal_token: str = field(default="", repr=False)
    # A firing inbox alert with no notification for this long shows "status unknown" (Alertmanager resends a
    # firing alert every repeat_interval, 4 h by default, so two missed resends).
    inbox_stale_hours: int = 8


def load() -> InvestigationSettings:
    severities = tuple(
        s.strip().lower() for s in os.getenv("ALERT_INVESTIGATION_SEVERITIES", "critical,warning").split(",") if s.strip()
    )
    return InvestigationSettings(
        enabled=os.getenv("ALERT_INVESTIGATION_ENABLED", "false").strip().lower() == "true",
        webhook_token=os.getenv("ALERT_WEBHOOK_TOKEN", "").strip(),
        severities=severities,
        dedupe_hours=max(0, _int("ALERT_INVESTIGATION_DEDUPE_HOURS", 24)),
        max_per_hour=max(0, _int("ALERT_INVESTIGATION_MAX_PER_HOUR", 6)),
        daily_token_budget=max(0, _int("ALERT_INVESTIGATION_DAILY_TOKEN_BUDGET", 200_000)),
        provider_pause_minutes=max(0, _int("ALERT_INVESTIGATION_PROVIDER_PAUSE_MINUTES", 30)),
        max_steps=min(20, max(1, _int("ALERT_INVESTIGATION_MAX_STEPS", 8))),
        timeout_seconds=min(1800, max(30, _int("ALERT_INVESTIGATION_TIMEOUT_SECONDS", 300))),
        model=os.getenv("ALERT_INVESTIGATION_MODEL", "").strip(),
        language=(os.getenv("ALERT_INVESTIGATION_LANGUAGE", "en").strip().lower() or "en"),
        console_url=os.getenv("ALERT_INVESTIGATION_CONSOLE_URL", "").strip().rstrip("/"),
        token_url=os.getenv(
            "AUTH_INVESTIGATOR_TOKEN_URL", "http://auth-service:8004/api/v1/auth/internal/investigator-token"
        ).strip(),
        internal_token=os.getenv("INTERNAL_API_TOKEN", "").strip(),
        inbox_stale_hours=min(24 * 30, max(1, _int("ALERT_INBOX_STALE_HOURS", 8))),
    )
