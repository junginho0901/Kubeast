"""Why an investigation row was skipped: the English sentence kept in alert_investigations.skip_reason (written only
here), and the catalog key and values the screen shows it with (investigations.skip.<key>, investigations.skipWhy.<key>).
Rows written before the keys existed hold the same sentences, so they read the same way; any other text has no key."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

INVESTIGATION_CAP = "investigation_cap"
HOURLY_CAP = "hourly_cap"
DAILY_TOKEN_BUDGET = "daily_token_budget"
PROVIDER_PAUSED = "provider_paused"


def _utc(t: datetime) -> str:
    return f"{t:%Y-%m-%dT%H:%M:%S}Z"


def investigation_cap(limit: int) -> str:
    return f"investigation cap ({limit} new per webhook message)"


def hourly_cap(limit: int) -> str:
    return f"hourly cap ({limit} per hour)"


def daily_token_budget(limit: int) -> str:
    return f"daily token budget ({limit} tokens, UTC day)"


def provider_paused(kind: str, at: datetime, until: datetime) -> str:
    return f"paused: the AI model provider refused ({kind}) at {_utc(at)}; no investigation until {_utc(until)}"


_TIME = r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"
_READ = (
    (INVESTIGATION_CAP, re.compile(r"investigation cap \((?P<limit>\d+) new per webhook message\)")),
    (HOURLY_CAP, re.compile(r"hourly cap \((?P<limit>\d+) per hour\)")),
    (DAILY_TOKEN_BUDGET, re.compile(r"daily token budget \((?P<limit>\d+) tokens, UTC day\)")),
    (PROVIDER_PAUSED, re.compile(rf"paused: the AI model provider refused \((?P<kind>\w+)\) at (?P<at>{_TIME}); no investigation until (?P<until>{_TIME})")),
)


def key_of(text: str) -> tuple[str, dict[str, Any]]:
    """The catalog key and values of a stored reason, or ("", {}) for text written some other way."""
    for key, pattern in _READ:
        match = pattern.fullmatch(text or "")
        if match:
            args: dict[str, Any] = match.groupdict()
            if "limit" in args:
                args["limit"] = int(args["limit"])
            return key, args
    return "", {}
