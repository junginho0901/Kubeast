"""What kind of refusal a failed model call is, from the provider's own answer.

credit      the account has no credit or quota left, or hit a spend limit (does not pass by retrying)
rate        too many requests for now (passes in a while)
auth        the key or token is invalid, expired or lacks permission
unavailable the provider is overloaded, down, timed out or unreachable
other       anything else (a bad request, a model that does not exist …)

Read from the OpenAI SDK's exceptions (OpenAI, Gemini, Azure OpenAI, Ollama and other OpenAI-compatible
endpoints), the Anthropic adapter's AnthropicAPIError and the Claude subscription's ClaudeCodeError, by status,
error code and the wording the providers document (Claude API errors, OpenAI error codes, Gemini API errors).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

CREDIT, RATE, AUTH, UNAVAILABLE, OTHER = "credit", "rate", "auth", "unavailable", "other"

# Catalog keys the screen translates (aiChat.error.<key>).
ERROR_KEYS = {CREDIT: "modelCredit", RATE: "modelRateLimit", AUTH: "modelAuth", UNAVAILABLE: "modelUnavailable", OTHER: "modelCall"}

_CREDIT_WORDS = re.compile(
    r"insufficient_quota|exceeded your current quota|credit balance|billing|spend (limit|cap)|prepay|payment required|"
    r"out of credits",
    re.IGNORECASE,
)
# The subscription CLI's text for a used-up usage window: "Claude AI usage limit reached|<Unix time it lifts>".
_USAGE_WINDOW = re.compile(r"usage limit reached\|(\d{9,11})", re.IGNORECASE)
_AUTH_WORDS = re.compile(r"api key|invalid_api_key|authentication|unauthorized|permission", re.IGNORECASE)
_UNAVAILABLE_WORDS = re.compile(r"overloaded|unavailable|timed? ?out|timeout|connection", re.IGNORECASE)

# The Claude Agent SDK's AssistantMessage.error values.
_SUBSCRIPTION_KINDS = {"billing_error": CREDIT, "rate_limit": RATE, "authentication_failed": AUTH, "server_error": UNAVAILABLE}


@dataclass(frozen=True)
class Refusal:
    kind: str
    # When the provider said the limit lifts (a subscription's usage window), else None.
    retry_at: Optional[datetime] = None

    @property
    def key(self) -> str:
        return "modelUsageWindow" if self.kind == RATE and self.retry_at is not None else ERROR_KEYS[self.kind]

    @property
    def blocks(self) -> bool:
        """A refusal that repeats until someone acts or a window passes: credit, auth, a subscription limit."""
        return self.kind in (CREDIT, AUTH) or (self.kind == RATE and self.retry_at is not None)


def _code(err: Exception) -> str:
    """The provider's error code or type, from the OpenAI SDK (code, body) or the Anthropic adapter (error_type)."""
    for attr in ("code", "error_type"):
        value = getattr(err, attr, None)
        if isinstance(value, str) and value:
            return value
    body = getattr(err, "body", None)
    if isinstance(body, dict):
        inner = body.get("error") if isinstance(body.get("error"), dict) else body
        for key in ("code", "type", "status"):
            if isinstance(inner.get(key), str) and inner.get(key):
                return inner[key]
    return ""


def _status(err: Exception) -> Optional[int]:
    for attr in ("status_code", "api_error_status", "status"):
        value = getattr(err, attr, None)
        if isinstance(value, int):
            return value
    return None


def classify(err: BaseException) -> Refusal:
    """The kind of refusal err is; OTHER when it says nothing the providers document."""
    sub_kind = getattr(err, "subscription_error", None)
    resets_at = getattr(err, "resets_at", None)
    retry_at = datetime.fromtimestamp(resets_at, timezone.utc) if isinstance(resets_at, (int, float)) and resets_at > 0 else None
    window = _USAGE_WINDOW.search(str(err))
    if retry_at is None and window:
        retry_at = datetime.fromtimestamp(int(window.group(1)), timezone.utc)
    if retry_at is not None:
        return Refusal(RATE, retry_at)  # a subscription's usage window: it lifts at the time the CLI gave
    if sub_kind in _SUBSCRIPTION_KINDS:
        return Refusal(_SUBSCRIPTION_KINDS[sub_kind])

    name = type(err).__name__
    if name in ("APITimeoutError", "APIConnectionError", "TimeoutError", "ConnectError", "ConnectTimeout", "ReadTimeout"):
        return Refusal(UNAVAILABLE)
    status, code = _status(err), _code(err).lower()
    text = f"{code} {err}"
    if code == "billing_error" or status == 402:
        return Refusal(CREDIT)
    if status == 429:
        # OpenAI insufficient_quota and Anthropic's monthly spend cap come as 429 too; the code or the words tell.
        return Refusal(CREDIT if _CREDIT_WORDS.search(text) else RATE)
    if status == 400 and _CREDIT_WORDS.search(text):
        return Refusal(CREDIT)  # Anthropic: a spend limit you set; Gemini: FAILED_PRECONDITION on billing
    if status in (401, 403) or code in ("authentication_error", "permission_error", "invalid_api_key"):
        return Refusal(AUTH)
    if status is not None and (status >= 500 or status in (408, 504, 529)):
        return Refusal(UNAVAILABLE)
    if code in ("overloaded_error", "api_error", "timeout_error", "connection_error", "server_is_overloaded"):
        return Refusal(UNAVAILABLE)
    if status is None:
        # No HTTP status (a wrapped error, the subscription CLI): the documented wording.
        if _CREDIT_WORDS.search(text):
            return Refusal(CREDIT)
        if re.search(r"\b(401|403)\b", text) or _AUTH_WORDS.search(text) and "invalid" in text.lower():
            return Refusal(AUTH)
        if re.search(r"\b429\b|rate.?limit", text, re.IGNORECASE):
            return Refusal(RATE)
        if re.search(r"\b(5\d\d|529)\b", text) or _UNAVAILABLE_WORDS.search(text):
            return Refusal(UNAVAILABLE)
    return Refusal(OTHER)
