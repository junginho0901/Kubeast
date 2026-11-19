"""kubeast_ai_investigations_total: the alert investigations this ai-service ended, by outcome.

Counted where the row's end is stored: done or failed with a run's end (store.finish), failed also for a row the
stopping worker had put back once already (store.requeue_or_fail) and for running rows past their time limit
(store.fail_stale_running), skipped for a row the worker skipped when it took it (store.skip) or the webhook stored
skipped (a cap, the daily budget, a provider pause). No cluster, alert or user label: the series are made at import
(KubeastAIInvestigationsFailing reads failed against done).
"""
from __future__ import annotations

from prometheus_client import Counter

from app.metrics import SERVICE

DONE, FAILED, SKIPPED = "done", "failed", "skipped"

INVESTIGATIONS = Counter(
    "kubeast_ai_investigations_total",
    "Alert investigations this ai-service ended, by outcome (done, failed, skipped).",
    ["service", "outcome"],
)
for _outcome in (DONE, FAILED, SKIPPED):
    INVESTIGATIONS.labels(SERVICE, _outcome)


def ended(outcome: str, n: int = 1) -> None:
    """Counts n investigations that ended as outcome; an outcome other than the three, or n below 1, counts nothing."""
    if outcome in (DONE, FAILED, SKIPPED) and n > 0:
        INVESTIGATIONS.labels(SERVICE, outcome).inc(n)
