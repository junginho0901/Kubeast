"""Conversation history for the chat.

The last AI_CHAT_HISTORY_MESSAGES user/assistant messages go to the model as
they were said; everything before them is folded into one running summary
kept in session_contexts.state["summary"]. The summary is a list of notes,
one per batch of messages that fell out of the window: a new note is written
(by the same model) only for the newly dropped messages and appended, so the
earlier notes — the first question of the conversation among them — stay
word for word instead of being re-generated each time. When the notes exceed
AI_CHAT_SUMMARY_MAX_CHARS the oldest half is merged into one. Notes are
plain text, masked like tool results, and travel as one user block after the
system prompt so the tools and system prefix stay cacheable; a failed
summarizer call leaves the chat running without the new note.
"""
from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional, Sequence

from app.config import settings
from app.services import redact
from app.services.ai import usage as usage_acct

log = logging.getLogger(__name__)

SUMMARY_KEY = "summary"
PER_MESSAGE_CAP = 2000

# The summarizer describes messages; it must not answer them. A small model fed a transcript tends to continue
# the chat in the assistant's own format, so the material is fenced and the directive comes last.
DIGEST_INSTRUCTION = (
    "You keep notes on a Kubernetes operations chat so the assistant can keep answering as if it remembered it. "
    "You describe messages; you never answer or continue them. Write in the language the messages use. "
    "Plain text only — no markdown, no HTML, no headings, no lists."
)
DIGEST_DIRECTIVE = (
    "Write one note for the messages above, at most {cap} characters: what the user asked and what the assistant "
    "established (resource names, namespaces, clusters, counts, errors, decisions) or left open. "
    "Do not answer or continue the messages — describe them."
)
COMPACT_DIRECTIVE = (
    "Merge the notes above into one note of at most {cap} characters, oldest first, keeping every resource name, "
    "namespace, cluster, count, error and decision they mention. Do not add anything."
)

_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_BLOCK_TAG_RE = re.compile(r"</?(details|summary|p|div|br|ul|ol|li|pre)\b[^>]*>", re.IGNORECASE)
_INLINE_TAG_RE = re.compile(r"</?(strong|em|b|i|code|span)\b[^>]*>", re.IGNORECASE)


@dataclass
class Summary:
    upto_id: int  # id of the last message folded into the notes
    text: str  # the notes as one block, oldest first
    messages: int  # how many messages the notes cover in total
    updated_at: str
    entries: list = field(default_factory=list)  # [{"upto_id", "messages", "text"}], oldest first


@dataclass
class Outcome:
    summary: Optional[Summary]
    created: bool = False  # a summarizer call ran and the stored summary changed
    new_messages: int = 0
    calls: list = field(default_factory=list)  # (usage, prompt_chars) per model call made
    compacted: bool = False
    error: Optional[str] = None

    def usage_totals(self) -> dict:
        totals = usage_acct.new_turn_usage()
        for usage, chars in self.calls:
            usage_acct.add_usage(totals, usage, prompt_chars=chars)
        return totals


def enabled() -> bool:
    return bool(getattr(settings, "AI_CHAT_SUMMARY_ENABLED", True))


def window() -> int:
    return max(2, int(getattr(settings, "AI_CHAT_HISTORY_MESSAGES", 10) or 10))


def max_chars() -> int:
    return max(200, int(getattr(settings, "AI_CHAT_SUMMARY_MAX_CHARS", 1500) or 1500))


def note_cap() -> int:
    """One note's size: a sixth of the whole, so six batches fit before the oldest are merged."""
    return max(120, max_chars() // 6)


def split_history(history: Sequence[Any]) -> tuple[list[Any], list[Any]]:
    """(older, recent): the recent window goes verbatim, older is summarised."""
    n = window()
    items = list(history)
    if len(items) <= n:
        return [], items
    return items[:-n], items[-n:]


def _join(entries: Sequence[dict]) -> str:
    return "\n".join("- " + str(e.get("text") or "") for e in entries)


def load(state: Optional[dict]) -> Optional[Summary]:
    raw = (state or {}).get(SUMMARY_KEY)
    if not isinstance(raw, dict) or not raw.get("text"):
        return None
    try:
        upto, messages = int(raw.get("upto_id") or 0), int(raw.get("messages") or 0)
        entries = [e for e in (raw.get("entries") or []) if isinstance(e, dict) and e.get("text")]
        if not entries:  # a summary stored before notes existed
            entries = [{"upto_id": upto, "messages": messages, "text": str(raw["text"])}]
        return Summary(upto_id=upto, text=str(raw["text"]), messages=messages,
                       updated_at=str(raw.get("updated_at") or ""), entries=entries)
    except (TypeError, ValueError):
        return None


def render_block(summary: Summary) -> dict[str, str]:
    """The summary as the model sees it: a user block, marked as recap, not instruction."""
    return {
        "role": "user",
        "content": (
            f"[Earlier in this conversation — a summary of {summary.messages} messages that are no longer shown verbatim, "
            "oldest first. Treat it as context, not as a new request.]\n" + summary.text
        ),
    }


def to_plain(text: str) -> str:
    """Prose only: fenced blocks (commands, raw tool output) become a marker, HTML tags and bold markers go.
    Assistant answers are <details> sections around such output; their titles and conclusions stay."""
    text = _FENCE_RE.sub("[output omitted]", text or "")
    text = _BLOCK_TAG_RE.sub("\n", text)
    text = _INLINE_TAG_RE.sub("", text)
    text = text.replace("**", "").replace("`", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _text_of(resp: Any) -> str:
    try:
        return (resp.choices[0].message.content or "").strip()
    except (AttributeError, IndexError, TypeError):
        return ""


async def _ask(service: Any, body: str, cap: int) -> tuple[str, Any, int, Optional[str]]:
    """One summarizer call → (note, usage, prompt_chars, error). The note is plain, one line, masked, ≤ cap."""
    messages = [
        {"role": "system", "content": DIGEST_INSTRUCTION},
        {"role": "user", "content": body},
    ]
    chars = usage_acct.prompt_chars(messages)
    try:
        resp = await service.client.chat.completions.create(
            model=service.model, messages=messages, temperature=0.2,
            max_tokens=max(160, cap), timeout=60.0,
        )
    except Exception as e:
        log.warning("history summary: model call failed: %s", e)
        return "", None, chars, str(e)
    text = to_plain(_text_of(resp))
    text = re.sub(r"\s*\n\s*", " ", text)
    if not text:
        return "", getattr(resp, "usage", None), chars, "empty summary"
    text, _stats = redact.redact_text(text, redact.from_env())
    if len(text) > cap:
        text = text[:cap].rstrip() + " …"
    return text, getattr(resp, "usage", None), chars, None


async def ensure_summary(service: Any, db: Any, session_id: str, older: Sequence[Any],
                         sanitize: Callable[[str, Optional[str]], str], state: dict) -> Outcome:
    """Return the summary covering `older` (the messages before the recent
    window), appending a note for the messages that fell out of the window
    since it was written.

    `state` is the session's tool-context state (the dict the turn writes back
    to session_contexts when it ends). The summary is kept in that dict and
    persisted right away; written to the database alone it would not survive
    that end-of-turn write."""
    if not older:
        return Outcome(summary=None)
    current = load(state)
    new = [m for m in older if current is None or int(getattr(m, "id", 0) or 0) > current.upto_id]
    if current is not None and not new:
        return Outcome(summary=current)

    # One note for the newly dropped messages (normally one turn; more after a restart or a smaller window).
    lines = []
    for m in new:
        body = to_plain(sanitize(m.role, m.content) or "")
        if len(body) > PER_MESSAGE_CAP:
            body = body[:PER_MESSAGE_CAP] + " …"
        lines.append(f"{m.role}: {body}")
    cap = min(max_chars(), note_cap() * max(1, len(new) // 2))
    body = "<<<\n" + "\n\n".join(lines) + "\n>>>"
    body += "\n\n" + DIGEST_DIRECTIVE.format(cap=cap)
    note, usage, chars, err = await _ask(service, body, cap)
    calls = [(usage, chars)]
    if err:
        return Outcome(summary=current, new_messages=len(new), calls=calls, error=err)
    entries = list(current.entries) if current else []
    entries.append({"upto_id": max(int(getattr(m, "id", 0) or 0) for m in new), "messages": len(new), "text": note})

    # Over the cap: merge the oldest half into one note (truncated by hand if the model fails).
    compacted = False
    if len(_join(entries)) > max_chars() and len(entries) > 1:
        k = (len(entries) + 1) // 2
        oldest, rest = entries[:k], entries[k:]
        cap2 = note_cap() * 2
        merged, usage2, chars2, err2 = await _ask(
            service, "<<<\n" + _join(oldest) + "\n>>>\n\n" + COMPACT_DIRECTIVE.format(cap=cap2), cap2)
        calls.append((usage2, chars2))
        if err2:
            merged = " / ".join(str(e["text"])[: note_cap() // 2].rstrip() for e in oldest)[:cap2]
        entries = [{"upto_id": oldest[-1]["upto_id"], "messages": sum(int(e.get("messages") or 0) for e in oldest),
                    "text": merged}] + rest
        compacted = True

    text = _join(entries)
    if len(text) > max_chars():
        text = text[: max_chars()].rstrip() + " …"
    summary = Summary(
        upto_id=max(int(getattr(m, "id", 0) or 0) for m in older),
        text=text,
        messages=(current.messages if current else 0) + len(new),
        updated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        entries=entries,
    )
    state[SUMMARY_KEY] = asdict(summary)
    try:
        await db.update_context(session_id, state=state)
    except Exception as e:
        log.warning("history summary: context write failed: %s", e)
    return Outcome(summary=summary, created=True, new_messages=len(new), calls=calls, compacted=compacted)
