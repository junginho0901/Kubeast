"""Rule cards (chart ai.ruleCards): for a kind of failure, the checks that often find its cause, in order, each with the
tools that answer it. The defaults are rule_cards.json, one card per kind of failure the hard evaluation cases name
(crash, oom, image, config_change, rollout, network_policy, dns, resource_limit, quota, node, dependency_down,
dependency_slow, storage); the chart adds cards (a kind already there is replaced in its place) and removes defaults by
kind.

The server picks at most two cards from what it already holds — never the model, so no tool is added: an alert's name
and labels for an investigation, the question for the chat, and any other text a caller passes (narrowing's findings).
The alert only chooses among the cards; none of its words goes into them. A card reaches the model as text beside the
first message, with only the tools that model is offered: a check none of whose tools is offered is left out, and a
card with no check left. Off (both switches false) nothing is read, the file included.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

from app.services import switch

log = logging.getLogger(__name__)

DEFAULTS_FILE = Path(__file__).with_name("rule_cards.json")

MAX_CARDS = 2
MAX_CHECKS = 6
MAX_TOOLS = 3
MAX_TITLE_CHARS = 80
MAX_CHECK_CHARS = 200
MAX_WORDS = 20  # alert names and terms of one card
# Two cards of the longest a card may be fit; past this the second card is left out.
MAX_BLOCK_CHARS = 4000

_KIND = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
_WORD = re.compile(r"[a-z0-9]+")
# A term this long or longer is also found inside an alert name written as one word ("PaymentsOOMKilled").
_IN_NAME_MIN = 6

# Where a card matched, strongest first.
ALERT_NAME = 0  # the alert's own name is one the card lists
ALERT_WORDS = 1  # a term or listed alert name among the words of the alert's name and labels
TEXT_WORDS = 2  # among the words of the other text: the chat's question, narrowing's findings

INVESTIGATION_SOURCE = "the alert's name and labels"
CHAT_SOURCE = "the failure the question names"


@dataclass(frozen=True)
class Check:
    text: str
    tools: tuple[str, ...]


@dataclass(frozen=True)
class Card:
    kind: str
    title: str
    alerts: tuple[str, ...]
    terms: tuple[str, ...]
    checks: tuple[Check, ...]


@dataclass(frozen=True)
class Settings:
    chat: bool = False
    investigations: bool = False
    cards: tuple[Card, ...] = ()


def words(text: str) -> str:
    """Lower-case ASCII letters and digits, one space between and around: a term matches whole words only, so "node" is
    not found in "nodes" and a Korean ending written after a reason ("OOMKilled가") is not part of it."""
    return " " + " ".join(_WORD.findall(text.lower())) + " "


def _compact(text: str) -> str:
    return "".join(_WORD.findall(text.lower()))


def _text(value: Any, limit: int, where: str) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        raise ValueError(f"{where} is empty")
    if len(text) > limit:
        raise ValueError(f"{where} is longer than {limit} characters")
    return text


def _strings(value: Any, where: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ValueError(f"{where} is not a list of strings")
    out = tuple(" ".join(v.split()) for v in value if v.strip())
    for v in out:
        if not words(v).strip():
            raise ValueError(f"{where}: {v!r} holds no letter or digit")
    return out


def card_of(raw: Any) -> Card:
    """One card from the defaults file or the chart; ValueError says what is wrong with it."""
    if not isinstance(raw, Mapping):
        raise ValueError("a card is not an object")
    kind = str(raw.get("kind") or "").strip()
    if not _KIND.match(kind):
        raise ValueError(f"kind {kind!r} is not lower-case letters, digits, _ and - (at most 40)")
    title = _text(raw.get("title"), MAX_TITLE_CHARS, f"card {kind}: title")
    alerts = _strings(raw.get("alerts"), f"card {kind}: alerts")
    terms = _strings(raw.get("terms"), f"card {kind}: terms")
    if not alerts and not terms:
        raise ValueError(f"card {kind}: no alert name or term picks it")
    if len(alerts) + len(terms) > MAX_WORDS:
        raise ValueError(f"card {kind}: more than {MAX_WORDS} alert names and terms")
    raw_checks = raw.get("checks")
    if not isinstance(raw_checks, list) or not raw_checks:
        raise ValueError(f"card {kind}: no checks")
    if len(raw_checks) > MAX_CHECKS:
        raise ValueError(f"card {kind}: more than {MAX_CHECKS} checks")
    checks = []
    for n, item in enumerate(raw_checks, 1):
        if not isinstance(item, Mapping):
            raise ValueError(f"card {kind}: check {n} is not an object")
        text = _text(item.get("check"), MAX_CHECK_CHARS, f"card {kind}: check {n}")
        tools = _strings(item.get("tools"), f"card {kind}: check {n} tools")
        if not tools:
            raise ValueError(f"card {kind}: check {n} names no tool")
        if len(tools) > MAX_TOOLS:
            raise ValueError(f"card {kind}: check {n} names more than {MAX_TOOLS} tools")
        checks.append(Check(text, tools))
    return Card(kind, title, alerts, terms, tuple(checks))


def defaults() -> tuple[Card, ...]:
    return tuple(card_of(raw) for raw in json.loads(DEFAULTS_FILE.read_text(encoding="utf-8")))


@lru_cache(maxsize=4)
def cards_of(added: str = "", removed: str = "") -> tuple[Card, ...]:
    """The defaults less the kinds in `removed` (comma separated), then the chart's cards (`added`, a JSON list): one of
    a kind already there takes its place. A card the chart got wrong is left out with a log line saying why."""
    by_kind = {card.kind: card for card in defaults()}
    for kind in removed.split(","):
        if kind.strip() and kind.strip() not in by_kind:
            log.warning("ai.ruleCards.remove: no default card of kind %r", kind.strip())
        by_kind.pop(kind.strip(), None)
    try:
        listed = json.loads(added) if added.strip() else []
    except ValueError:
        log.warning("ai.ruleCards.cards is not JSON; no card of the chart's is used")
        listed = []
    if not isinstance(listed, list):
        log.warning("ai.ruleCards.cards is not a list; no card of the chart's is used")
        listed = []
    for raw in listed:
        try:
            card = card_of(raw)
        except ValueError as e:
            log.warning("ai.ruleCards.cards: %s; that card is left out", e)
            continue
        by_kind[card.kind] = card
    return tuple(by_kind.values())


def load() -> Settings:
    chat, investigations = switch.env_on("AI_RULE_CARDS_CHAT"), switch.env_on("AI_RULE_CARDS_INVESTIGATIONS")
    if not (chat or investigations):
        return Settings()
    return Settings(chat, investigations, cards_of(os.getenv("AI_RULE_CARDS", ""), os.getenv("AI_RULE_CARDS_REMOVE", "")))


def pick(cards: Sequence[Card], *, alertname: str = "", labels: Optional[Mapping[str, Any]] = None,
         texts: Iterable[str] = (), limit: int = MAX_CARDS) -> list[Card]:
    """At most `limit` cards: those the alert's own name picks first, then those a word of its name or label values
    picks, then those a word of `texts` picks; in a tie, the card with more matches, then the cards' order."""
    name = (alertname or "").strip().lower()
    name_compact = _compact(alertname or "")
    alert_words = words(" ".join([alertname or "", *(str(v) for v in (labels or {}).values())]))
    other_words = words(" ".join(texts))
    ranked = []
    for index, card in enumerate(cards):
        place, hits = None, 0
        if name and name in (a.lower() for a in card.alerts):
            place, hits = ALERT_NAME, 1
        for term in (*card.alerts, *card.terms):
            found, compact = words(term), _compact(term)
            if found in alert_words or (len(compact) >= _IN_NAME_MIN and compact in name_compact):
                where = ALERT_WORDS
            elif found in other_words:
                where = TEXT_WORDS
            else:
                continue
            place = where if place is None else min(place, where)
            hits += 1
        if place is not None:
            ranked.append((place, -hits, index, card))
    ranked.sort(key=lambda r: r[:3])
    return [r[3] for r in ranked[:max(0, limit)]]


def offered_names(tools: Iterable[Mapping[str, Any]]) -> set[str]:
    return {(t.get("function") or {}).get("name") for t in tools} - {None}


def render(picked: Sequence[Card], offered: Iterable[str], *, source: str) -> tuple[str, list[str]]:
    """The cards as the model reads them, with only the tools it is offered, and the kinds that made it in ("" and none
    when no check is left)."""
    offered = set(offered)
    head = (
        f"Rule cards, picked by the server from {source}: checks that often find the cause of this kind of failure, in "
        "order, each with the tools that answer it. Follow those that fit what the results show and skip the rest. A card "
        "is where to look, not a finding: name a cause only from what a tool showed."
    )
    parts: list[str] = []
    kinds: list[str] = []
    size = len(head)
    for card in picked:
        lines: list[str] = []
        for check in card.checks:
            tools = [t for t in check.tools if t in offered]
            if tools:
                lines.append(f"{len(lines) + 1}. {check.text} — {', '.join(tools)}")
        if not lines:
            continue
        part = f'Card "{card.kind}" — {card.title}:\n' + "\n".join(lines)
        if size + 2 + len(part) > MAX_BLOCK_CHARS:
            break
        size += 2 + len(part)
        parts.append(part)
        kinds.append(card.kind)
    if not parts:
        return "", []
    return "\n\n".join([head, *parts]), kinds


def investigation_cards(settings: Settings, *, alertname: str, labels: Optional[Mapping[str, Any]],
                        tools: Iterable[Mapping[str, Any]], texts: Iterable[str] = ()) -> tuple[str, list[str]]:
    """What goes into an investigation's first message ("" with the switch off or no card picked)."""
    if not settings.investigations:
        return "", []
    picked = pick(settings.cards, alertname=alertname, labels=labels, texts=texts)
    return render(picked, offered_names(tools), source=INVESTIGATION_SOURCE)


def chat_cards(message: str, tools: Iterable[Mapping[str, Any]],
               settings: Optional[Settings] = None) -> tuple[Optional[str], Optional[list[str]]]:
    """A system message for this chat turn (None when the question names no failure a card knows) and the kinds in it
    for the turn's ai.chat.complete row; (None, None) with the switch off. Only this turn reads it; the history keeps
    none."""
    settings = settings if settings is not None else load()
    if not settings.chat:
        return None, None
    text, kinds = render(pick(settings.cards, texts=[message or ""]), offered_names(tools), source=CHAT_SOURCE)
    return text or None, kinds
