"""Debug output for the AI path.

Model responses, tool arguments and tool results used to go to stdout in full.
That text can carry Secret values and credentials (a manifest the model wrote,
a ConfigMap a tool returned), and stdout is the cluster's log pipeline. So:

- ``log`` — ordinary progress lines (model name, counts, iterations) at DEBUG,
  errors at WARNING/ERROR with ``safe_error`` so exception text is masked too.
- ``dump`` — the content dumps, written only when ``AI_DEBUG_DUMP=true`` and
  even then after ``redact_text`` (Secret documents stripped, credential-looking
  values masked) and a length cap.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

from app.config import settings
from app.services.redact import redact_text

log = logging.getLogger("kubeast.ai")
# The service configures no logging of its own and uvicorn only configures its
# loggers, so without a handler INFO/DEBUG records here would be dropped.
if not log.handlers:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    log.addHandler(_handler)
log.setLevel(logging.DEBUG if getattr(settings, "DEBUG", False) else logging.INFO)

_LIMIT = 4000


def dump_enabled() -> bool:
    return bool(getattr(settings, "AI_DEBUG_DUMP", False))


def dump(label: str, payload: Any = None, limit: int = _LIMIT) -> None:
    """Log ``payload`` under ``label`` when AI_DEBUG_DUMP is on, redacted."""
    if not dump_enabled():
        return
    if payload is None:
        text = ""
    elif isinstance(payload, str):
        text = payload
    else:
        try:
            text = json.dumps(payload, ensure_ascii=False, default=str)
        except Exception:
            text = str(payload)
    text, _ = redact_text(text)
    if len(text) > limit:
        text = text[:limit] + f"… ({len(text)} chars)"
    log.info("%s %s", label, text)


def safe_error(err: Any) -> str:
    """str(err) with credentials masked — provider errors can echo the request."""
    text, _ = redact_text(str(err))
    return text
