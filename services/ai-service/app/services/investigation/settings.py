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
    # The webhook queues investigations (off: it only stores the alerts in the inbox).
    automatic: bool = True
    # "Investigate now" in the Alerts inbox.
    manual: bool = True
    dedupe_hours: int = 24
    # The webhook's investigations only: the hourly cap and daily_token_budget.
    max_per_hour: int = 6
    daily_token_budget: int = 200_000
    # The tokens of investigations people asked for, per UTC day (0 = no budget).
    manual_daily_token_budget: int = 0
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


def _on(name: str) -> bool:
    """On unless set to false (an install without the variable keeps the switch on)."""
    return os.getenv(name, "true").strip().lower() != "false"


def load() -> InvestigationSettings:
    severities = tuple(
        s.strip().lower() for s in os.getenv("ALERT_INVESTIGATION_SEVERITIES", "critical,warning").split(",") if s.strip()
    )
    return InvestigationSettings(
        enabled=os.getenv("ALERT_INVESTIGATION_ENABLED", "false").strip().lower() == "true",
        webhook_token=os.getenv("ALERT_WEBHOOK_TOKEN", "").strip(),
        severities=severities,
        automatic=_on("ALERT_INVESTIGATION_AUTOMATIC"),
        manual=_on("ALERT_INVESTIGATION_MANUAL"),
        dedupe_hours=max(0, _int("ALERT_INVESTIGATION_DEDUPE_HOURS", 24)),
        max_per_hour=max(0, _int("ALERT_INVESTIGATION_MAX_PER_HOUR", 6)),
        daily_token_budget=max(0, _int("ALERT_INVESTIGATION_DAILY_TOKEN_BUDGET", 200_000)),
        manual_daily_token_budget=max(0, _int("ALERT_INVESTIGATION_MANUAL_DAILY_TOKEN_BUDGET", 0)),
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
