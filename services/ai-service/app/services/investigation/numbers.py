"""Call numbers in an investigation, on while any of its v0.7.9 switches is: features.alertInvestigation.rules,
changesFirst, evidenceCheck, ledger or narrowFirst, or features.callGraph (the last two read as off where the settings
do not have them yet).

Each tool result the model reads starts with its call number, [call 3]: the call's place in the run's tool_calls,
from 1, step 0's read included (call 1 when it ran). The rules, the rca block and the second ask name calls by that
number, so the model, the stored tool calls and the AI evaluation count the same way. With every switch off the
results reach the model as they did.
"""

from __future__ import annotations

NOTE = "\n\nEach tool result starts with its call number, as [call 3]; name a call by that number."


def on(cfg) -> bool:
    return bool(cfg.rules or cfg.changes_first or cfg.evidence_check or cfg.ledger
                or getattr(cfg, "call_paths", False) or getattr(cfg, "narrow_first", False))


def tag(number: int, text: str) -> str:
    """A tool result as the model reads it: its call number first."""
    return f"[call {number}]\n{text}"
