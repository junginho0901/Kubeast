"""kubeast_ai_investigations_total: the alert investigations this ai-service ended, by outcome.

done and failed are a run's end (runner.run_one), a failed one also a row the stopping worker put back once already
(store.requeue_or_fail) or a running row past its time limit (store.fail_stale_running); skipped is a row the webhook
stored skipped (a cap, the daily budget, a provider pause) or the worker skipped when it claimed it. No cluster,
alert or user label: the series are made at import (KubeastAIInvestigationsFailing reads failed against done).
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
