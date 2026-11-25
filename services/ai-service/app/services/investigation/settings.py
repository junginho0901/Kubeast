"""Chart values (features.alertInvestigation.*) as environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from app.services import switch


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class InvestigationSettings:
    enabled: bool = False
    webhook_token: str = ""
    # Refuse the shared token: each cluster posts with its own (webhook.cluster_token). Off keeps every receiver working.
    webhook_cluster_tokens_only: bool = False
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
    # The time windows, the scope groups, facts apart from hypotheses and the six report headings (investigation/prompt.py).
    rules: bool = False
    # Step 0: before the first model call, the timeline tool's changes view over the change window.
    changes_first: bool = False
    # Step 0: then anomaly_rank (features.anomalyRank) over the metrics window of the alert's namespace.
    narrow_first: bool = False
    # The rca block at the report's end (the result the row keeps) and the hypothesis ledger in it (investigation/ledger.py).
    ledger: bool = False
    # Counted from the alert's start: metrics either side of it, logs from before it, changes from before it.
    metrics_window_minutes: int = 15
    logs_window_minutes: int = 5
    changes_window_hours: int = 4
    model: str = ""
    # Where `model` was set, for the error of one not found: the chart, or the screen (app/services/model_uses.py).
    model_from: str = "features.alertInvestigation.model"
    language: str = "en"
    console_url: str = ""
    # The report's causes held to the run's tool calls before it is kept (investigation/evidence.py).
    evidence_check: bool = False
    # The report's outcome — a cause found, no fault found or cannot tell — in the rca block of evidence_check or ledger,
    # with the server's lists of what was and was not looked at (investigation/verdict.py); nothing with both off.
    verdict: bool = False
    token_url: str = "http://auth-service:8004/api/v1/auth/internal/investigator-token"
    internal_token: str = field(default="", repr=False)
    # A firing inbox alert with no notification for this long shows "status unknown" (Alertmanager resends a
    # firing alert every repeat_interval, 4 h by default, so two missed resends).
    inbox_stale_hours: int = 8
    # ai.toolResultDetails: the prompt has an empty search end the search for that name, not the investigation.
    tool_result_details: bool = False
    # features.nodeNeighbors: the prompt of an alert without a namespace asks for what else used the CPU of the node slow
    # pods run on (get_node_metrics node; the token of an alert with one is limited to it and refused the tool).
    node_neighbors: bool = False
    # features.callGraph: the prompt asks for who calls whom (resource_graph include calls) and the cause → … → symptom path.
    call_paths: bool = False
    # ai.faultOnset: the prompt asks when each finding began, and what was there before the alert is not its cause by itself.
    fault_onset: bool = False
    # ai.causeNaming: the rca block's instruction says how its causes are named (app/services/cause_naming.py); nothing with
    # evidence_check and ledger off.
    cause_naming: bool = False
    # features.alertInvestigation.pastReports (investigation/past.py): the alert's window lists the same alert's earlier
    # investigations (window); an investigation's first message holds what they concluded (model).
    past_window: bool = False
    past_model: bool = False


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
        webhook_cluster_tokens_only=os.getenv("ALERT_WEBHOOK_CLUSTER_TOKENS_ONLY", "false").strip().lower() == "true",
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
        rules=switch.env_on("ALERT_INVESTIGATION_RULES"),
        changes_first=switch.env_on("ALERT_INVESTIGATION_CHANGES_FIRST"),
        ledger=switch.env_on("ALERT_INVESTIGATION_LEDGER"),
        narrow_first=switch.env_on("ALERT_INVESTIGATION_NARROW_FIRST"),
        # Prometheus reads at most 168 h, Loki 24 h by default, timeline 90 days back.
        metrics_window_minutes=min(360, max(1, _int("ALERT_INVESTIGATION_METRICS_WINDOW_MINUTES", 15))),
        logs_window_minutes=min(1440, max(0, _int("ALERT_INVESTIGATION_LOGS_WINDOW_MINUTES", 5))),
        changes_window_hours=min(168, max(1, _int("ALERT_INVESTIGATION_CHANGES_WINDOW_HOURS", 4))),
        model=os.getenv("ALERT_INVESTIGATION_MODEL", "").strip(),
        language=(os.getenv("ALERT_INVESTIGATION_LANGUAGE", "en").strip().lower() or "en"),
        console_url=os.getenv("ALERT_INVESTIGATION_CONSOLE_URL", "").strip().rstrip("/"),
        evidence_check=switch.env_on("ALERT_INVESTIGATION_EVIDENCE_CHECK"),
        verdict=switch.env_on("ALERT_INVESTIGATION_VERDICT"),
        token_url=os.getenv(
            "AUTH_INVESTIGATOR_TOKEN_URL", "http://auth-service:8004/api/v1/auth/internal/investigator-token"
        ).strip(),
        internal_token=os.getenv("INTERNAL_API_TOKEN", "").strip(),
        inbox_stale_hours=min(24 * 30, max(1, _int("ALERT_INBOX_STALE_HOURS", 8))),
        tool_result_details=switch.env_on("AI_TOOL_RESULT_DETAILS"),
        node_neighbors=switch.env_on("NODE_NEIGHBORS_ENABLED"),
        call_paths=switch.env_on("CALL_GRAPH_ENABLED"),  # the one switch rule, as tools.call_graph_on
        fault_onset=switch.env_on("AI_FAULT_ONSET"),
        cause_naming=switch.env_on("AI_CAUSE_NAMING"),
        past_window=switch.env_on("ALERT_INVESTIGATION_PAST_WINDOW"),
        past_model=switch.env_on("ALERT_INVESTIGATION_PAST_MODEL"),
    )
