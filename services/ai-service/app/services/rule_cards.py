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

With ai.ruleCards.symptoms a card is also picked by what a person or an alert says is wrong, in English or Korean: its
`symptoms` hold the alert names and the phrases for it, and the cards that have nothing else (error_rate, latency,
resource_pressure) are read. The phrases are looked for in the alert's name, in the labels that describe (reason, ...),
in its summary and description and in the question. A phrase is never one word: it is what it is about with how that
is, near each other in one sentence ("latency" and "high"), or a run of two words or more ("error spike"). Off, the
`symptoms` of every card and those cards are not read.
"""

from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
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

MAX_PHRASES = 8  # of one card
MAX_PHRASE_WORDS = 80  # in each list of a phrase, a shared list counted once
MAX_ENTRY_WORDS = 5  # of one entry of such a list: each space between two Hangul words doubles the strings to look for
# What bounds the search: the characters of one text it reads (its start and its end), the places in it where the words of
# one list are looked at, and the characters between two places that may be one phrase (looked at before the words).
MAX_TEXT_CHARS = 8000
MAX_FOUND = 50
MAX_BETWEEN = 200
# The words that may stand between what a phrase is about and how it is: after it ("latency of the search service is
# high"), after it in Korean, where the two stand closer, and before it ("high p99 latency").
WORDS_AFTER, WORDS_AFTER_KO, WORDS_BEFORE = 8, 4, 2

# Where a card matched, strongest first.
ALERT_NAME = 0  # the alert's own name is one the card lists
ALERT_WORDS = 1  # a term or listed alert name among the words of the alert's name and labels
ALERT_SYMPTOM = 2  # a phrase in the alert's name or a label that describes
TEXT_WORDS = 3  # among the words of the other text: the chat's question, the alert's description, narrowing's findings
TEXT_SYMPTOM = 4  # a phrase in the other text

INVESTIGATION_SOURCE = "the alert's name and labels"
CHAT_SOURCE = "the failure the question names"
# With ai.ruleCards.symptoms
INVESTIGATION_SYMPTOMS_SOURCE = "the alert's name, labels and description"
CHAT_SYMPTOMS_SOURCE = "the failure or symptom the question names"

# An alert's annotations that say what is wrong, and the labels that do (the others name a thing).
TELLING_ANNOTATIONS = ("summary", "description", "message")
TELLING_LABELS = frozenset({"reason", "condition", "symptom", "category", "type", "status", *TELLING_ANNOTATIONS})

# The words of a symptom's text: Latin and Hangul apart ("latency가" is two), the end of a sentence a word of its own.
# One mark at a time: "[.!?;]+" before a lookahead tries every length of a long run of them at every place.
_SAID = re.compile(r"[a-z0-9]+|[가-힣]+|[.!?;](?=\s|$)|\n")
_HANGUL = re.compile(r"[가-힣]")
# "latency > 500ms", "success rate < 99%"
_COMPARED = re.compile(r"(?<=\s)([<>≤≥])=?(?=\s*\d)")
# The words of an alert name written as one: "HTTP5xxRateHigh", "HighP99Latency".
_NAME_WORDS = re.compile(r"\d[xX]{2}|[pP]\d{2,3}|[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+|[가-힣]+")

# Words several phrases use; a list of a phrase takes one in by "@<name>".
WORD_LISTS: dict[str, tuple[str, ...]] = {
    # a number that is up
    "high": (
        "high", "higher", "elevated", "increased", "increasing", "increases", "increase in", "rising", "growing", "climbing",
        "jumped", "doubled", "spike", "spikes", "spiked", "spiking", "surge", "surged", "surging", "above", "exceeds",
        "exceeded", "exceeding", "breached", "breaching",
        "높아", "높은", "높다", "높습", "높네", "높음", "높고", "높았", "높게 나", "늘어", "늘었", "증가", "급증", "급등", "치솟",
        "튀어", "튀었", "튀는", "상승", "올라", "올랐", "초과", "넘어", "넘었", "넘는", "넘습",
        "커졌", "커지", "배가 됐", "배가 되", "배로 늘", "배로 뛰",
    ),
    "slow": (
        "slow", "slower", "slowly", "sluggish", "slowness", "slowdown", "slowed", "slowing", "laggy", "takes too long",
        "taking too long", "take too long", "taking so long", "takes so long", "taking longer", "takes longer", "longer than usual",
        "longer than before",
        "느려", "느리", "느립", "느린", "느렸", "오래 걸", "지연되", "지연돼", "지연됩", "지연됐", "지연 발생", "지연이 발생",
        "지연이 심", "버벅", "늦어", "늦습", "늦는",
    ),
    "timing out": (
        "timing out", "timed out", "times out", "timeout errors", "hang", "hangs", "hanging",
        "타임아웃이 나", "타임아웃 나", "타임아웃이 발생", "타임아웃 발생", "타임아웃이 계속", "타임아웃이 자주",
        "타임아웃 에러", "타임아웃 오류",
    ),
    "not answering": (
        "unavailable", "unreachable", "not reachable", "not responding", "unresponsive", "is down", "are down", "went down",
        "been down",
        "응답이 없", "응답 없", "응답하지 않", "다운됐", "다운되", "다운돼", "다운된", "죽었", "죽어", "먹통",
        "멈춰", "멈췄",
    ),
    # what serves requests
    "service": (
        "service", "services", "api", "apis", "app", "apps", "application", "applications", "site", "website", "page", "pages",
        "endpoint", "endpoints", "backend", "frontend",
        "서비스", "사이트", "홈페이지", "페이지", "접속", "앱", "애플리케이션", "어플리케이션",
    ),
    # what a service calls
    "dependency": (
        "dependency", "dependencies", "upstream", "upstreams", "downstream", "database", "databases", "db", "cache", "redis",
        "postgres", "postgresql", "mysql", "mariadb", "mongodb", "kafka", "rabbitmq", "elasticsearch", "broker",
        "message queue", "external service", "external api", "third party",
        "데이터베이스", "디비", "레디스", "카프카", "메시지 큐", "캐시", "업스트림", "다운스트림", "외부 api", "외부 서비스",
        "외부 연동", "연동 서비스", "의존 서비스", "의존성",
    ),
    "slo": (
        "error budget", "slo", "slos", "sli", "service level objective", "에러 버짓", "에러 예산", "오류 예산", "오류 버짓",
    ),
    "missed": (
        "burn", "burns", "burning", "burned", "burnt", "exhausted", "violation", "violations", "violated", "violating", "breach",
        "breached", "breaching", "missed", "at risk", "consumed", "used up",
        "빠르게 쓰", "빨리 쓰", "소진", "소모", "위반", "번 레이트", "미달", "깨졌", "다 썼", "다 쓴",
    ),
    # work that is slow or fails without a request being served, and slow where nothing is wrong
    "other work": (
        "rollout", "rollouts", "deploy", "deploys", "deploying", "pull", "pulls", "pulling", "build", "builds", "building",
        "pipeline", "startup", "start up", "starts", "boot", "boots", "schedule", "scheduling", "backup", "backups", "restore",
        "upgrade", "upgrades", "migration", "migrations", "sync", "syncing", "download", "upload", "install", "installation",
        "provisioning", "scaling", "autoscaling", "snapshot", "job", "jobs", "cronjob", "terminal", "kubectl", "helm",
        "terraform", "slow start", "slow log", "slow logs", "slow query log", "slow to start", "slow to terminate",
        "slow to schedule", "slow to pull",
    ),
    "other work ko": (
        "배포", "롤아웃", "빌드", "풀링", "이미지 풀", "이미지 받", "기동", "부팅", "구동", "시작", "스케줄", "스케일", "백업", "복원",
        "복구", "동기화", "싱크", "업그레이드", "마이그레이션", "스냅샷", "생성", "삭제", "설치", "적용", "다운로드", "업로드",
        "파이프라인", "재시작", "프로비저닝", "크론잡", "잡이", "잡은", "작업", "조인", "터미널", "느려도", "느리더라도",
    ),
    # the same as what a sentence is about, for a phrase that starts after it ("배포가 왜 느려"; "배포 후 느려졌어" is not one)
    "other work ko is": (
        "배포가", "배포 속도", "롤아웃이", "빌드가", "빌드 속도", "풀링이", "이미지 풀이", "기동이", "부팅이", "구동이", "시작이",
        "스케줄링이", "스케일링이", "백업이", "복원이", "복구가", "동기화가", "싱크가", "업그레이드가", "마이그레이션이", "생성이",
        "삭제가", "설치가", "적용이", "다운로드가", "업로드가", "파이프라인이", "재시작이", "프로비저닝이", "작업이", "조인이", "터미널이",
    ),
}


@dataclass(frozen=True)
class Check:
    text: str
    tools: tuple[str, ...]


@dataclass(frozen=True)
class Phrase:
    """What a symptom sounds like, as strings to look for in a text of said(): what it is about and how that is, or (with no
    `state`) the whole phrase. It is not there where one of `unless` stands in it or right before it."""
    subject: tuple[str, ...]
    state: tuple[str, ...] = ()
    unless: tuple[str, ...] = ()


@dataclass(frozen=True)
class Card:
    kind: str
    title: str
    alerts: tuple[str, ...]
    terms: tuple[str, ...]
    checks: tuple[Check, ...]
    phrases: tuple[Phrase, ...] = ()


@dataclass(frozen=True)
class Settings:
    chat: bool = False
    investigations: bool = False
    cards: tuple[Card, ...] = ()
    symptoms: bool = False


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


def _listed(value: Any, where: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ValueError(f"{where} is not a list of strings")
    return tuple(" ".join(v.split()) for v in value if v.strip())


def _strings(value: Any, where: str) -> tuple[str, ...]:
    out = _listed(value, where)
    for v in out:
        if not words(v).strip():
            raise ValueError(f"{where}: {v!r} holds no letter or digit")
    return out


def _cut(text: str) -> str:
    """The start and the end of a text longer than MAX_TEXT_CHARS."""
    half = MAX_TEXT_CHARS // 2
    return text if len(text) <= MAX_TEXT_CHARS else text[:half] + "\n" + text[-half:]


def said(text: str) -> str:
    """A text as phrases are looked for in it: lower case, its words one space apart, a sentence's end a line break."""
    text = unicodedata.normalize("NFKC", _cut(text)).lower()
    text = _COMPARED.sub(lambda m: "above" if m[1] in ">≥" else "below", text)
    found = _SAID.findall(_cut(text))  # again: NFKC makes three characters of "…" and eighteen of some others
    return " " + " ".join(w if w[0].isalnum() else "\n" for w in found) + " "


def name_said(name: str) -> str:
    """An alert name as words: "HTTP5xxRateHigh" is "http 5xx rate high"."""
    return said(" ".join(_NAME_WORDS.findall(name[:MAX_TEXT_CHARS])))


def _needles(listed: Sequence[str]) -> tuple[str, ...]:
    """What to look for in said(): a Latin word is whole ("slow" is not in "slowest"); a Hangul one is the start of what its
    ending makes of it ("느려" is in "느려졌어요") and may follow another noun; a space between two Hangul words may be left out."""
    out: list[str] = []
    for item in listed:
        ways = [""]
        for word in said(item).split():
            spaces = ["", " "] if _HANGUL.match(word) else [" "]
            ways = [way + (space if way else "") + word for way in ways
                    for space in (spaces if way and _HANGUL.match(way[-1]) else [" "])]
        out += [(" " if way[0].isascii() else "") + way + (" " if way[-1].isascii() else "") for way in ways]
    return tuple(dict.fromkeys(out))


def _phrase_words(value: Any, where: str, *, two_words: bool = False) -> tuple[str, ...]:
    written = _listed(value, where)
    if len(written) > MAX_PHRASE_WORDS:
        raise ValueError(f"{where} holds more than {MAX_PHRASE_WORDS} entries")
    listed: list[str] = []
    for item in written:
        if item.startswith("@"):
            if item[1:] not in WORD_LISTS:
                raise ValueError(f"{where}: no word list is named {item!r}")
            listed += WORD_LISTS[item[1:]]
        else:
            listed.append(item)
    for item in listed:
        count = len(said(item).split())
        if not count:
            raise ValueError(f"{where}: {item!r} holds no letter or digit")
        if count > MAX_ENTRY_WORDS:
            raise ValueError(f"{where}: an entry is more than {MAX_ENTRY_WORDS} words")
        if two_words and count < 2:
            raise ValueError(f"{where}: {item!r} is one word; a phrase without a state is two or more")
    return _needles(listed)


def _symptoms(raw: Any, where: str) -> tuple[tuple[str, ...], tuple[Phrase, ...]]:
    """The alert names and the phrases of a card's `symptoms`."""
    if raw is None:
        return (), ()
    if not isinstance(raw, Mapping):
        raise ValueError(f"{where} is not an object")
    listed = raw.get("phrases") or []
    if not isinstance(listed, list):
        raise ValueError(f"{where}: phrases is not a list")
    if len(listed) > MAX_PHRASES:
        raise ValueError(f"{where}: more than {MAX_PHRASES} phrases")
    phrases = []
    for n, item in enumerate(listed, 1):
        at = f"{where}: phrase {n}"
        if not isinstance(item, Mapping):
            raise ValueError(f"{at} is not an object")
        state = _phrase_words(item.get("state"), f"{at} state")
        subject = _phrase_words(item.get("subject"), f"{at} subject", two_words=not state)
        if not subject:
            raise ValueError(f"{at} has no subject")
        phrases.append(Phrase(subject, state, _phrase_words(item.get("unless"), f"{at} unless")))
    return _strings(raw.get("alerts"), f"{where}: alerts"), tuple(phrases)


def card_of(raw: Any, symptoms: bool = False) -> Card:
    """One card from the defaults file or the chart (its `symptoms` only with that switch on); ValueError says what is wrong
    with it."""
    if not isinstance(raw, Mapping):
        raise ValueError("a card is not an object")
    kind = str(raw.get("kind") or "").strip()
    if not _KIND.match(kind):
        raise ValueError(f"kind {kind!r} is not lower-case letters, digits, _ and - (at most 40)")
    title = _text(raw.get("title"), MAX_TITLE_CHARS, f"card {kind}: title")
    alerts = _strings(raw.get("alerts"), f"card {kind}: alerts")
    terms = _strings(raw.get("terms"), f"card {kind}: terms")
    phrases: tuple[Phrase, ...] = ()
    if symptoms:
        named, phrases = _symptoms(raw.get("symptoms"), f"card {kind}: symptoms")
        alerts += tuple(a for a in named if a not in alerts)
    if not alerts and not terms and not phrases:
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
    return Card(kind, title, alerts, terms, tuple(checks), phrases)


def defaults(symptoms: bool = False) -> tuple[Card, ...]:
    """The cards of the defaults file; those that only their symptoms pick are among them with that switch on."""
    listed = json.loads(DEFAULTS_FILE.read_text(encoding="utf-8"))
    return tuple(card_of(raw, symptoms) for raw in listed if symptoms or raw.get("alerts") or raw.get("terms"))


@lru_cache(maxsize=4)
def cards_of(added: str = "", removed: str = "", symptoms: bool = False) -> tuple[Card, ...]:
    """The defaults less the kinds in `removed` (comma separated), then the chart's cards (`added`, a JSON list): one of
    a kind already there takes its place. A card the chart got wrong is left out with a log line saying why."""
    by_kind = {card.kind: card for card in defaults(symptoms)}
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
            card = card_of(raw, symptoms)
        except ValueError as e:
            log.warning("ai.ruleCards.cards: %s; that card is left out", e)
            continue
        by_kind[card.kind] = card
    return tuple(by_kind.values())


def load() -> Settings:
    chat, investigations = switch.env_on("AI_RULE_CARDS_CHAT"), switch.env_on("AI_RULE_CARDS_INVESTIGATIONS")
    if not (chat or investigations):
        return Settings()
    symptoms = switch.env_on("AI_RULE_CARDS_SYMPTOMS")
    cards = cards_of(os.getenv("AI_RULE_CARDS", ""), os.getenv("AI_RULE_CARDS_REMOVE", ""), symptoms)
    return Settings(chat, investigations, cards, symptoms)


def _found(text: str, needles: Sequence[str]) -> list[tuple[int, int]]:
    """Where in a text of said() `needles` stand (the first MAX_FOUND), without the spaces that hold one to whole words."""
    out: list[tuple[int, int]] = []
    for needle in needles:
        at = text.find(needle)
        while at >= 0 and len(out) < MAX_FOUND:
            out.append((at + needle.startswith(" "), at + len(needle) - needle.endswith(" ")))
            at = text.find(needle, at + 1)
    return out


def _near(text: str, subject: tuple[int, int], state: tuple[int, int]) -> bool:
    """Both stand in one sentence, the state at most WORDS_AFTER words after the subject or WORDS_BEFORE before it."""
    after = state[0] >= subject[1]
    start, end = (subject[1], state[0]) if after else (state[1], subject[0])
    if not 0 <= end - start <= MAX_BETWEEN:  # one over the other, or too far apart to look at the words
        return False
    between = text[start:end]
    most = WORDS_BEFORE if not after else WORDS_AFTER_KO if _HANGUL.match(text[state[0]]) else WORDS_AFTER
    # a number and a lone syllable (a Korean ending after a Latin word) are no word of their own
    return "\n" not in between and sum(len(word) > 1 and not word.isdigit() for word in between.split()) <= most


def phrase_in(phrase: Phrase, text: str) -> bool:
    """Whether a text, as said() writes it, holds the phrase."""
    places = _found(text, phrase.subject)
    if phrase.state and places:
        states = _found(text, phrase.state)
        places = [(min(a[0], b[0]), max(a[1], b[1])) for a in places for b in states if _near(text, a, b)]
    if not places:
        return False
    others = _found(text, phrase.unless)
    return any(not any(start < last and end >= first - 1 for start, end in others) for first, last in places)


def pick(cards: Sequence[Card], *, alertname: str = "", labels: Optional[Mapping[str, Any]] = None,
         texts: Iterable[str] = (), limit: int = MAX_CARDS) -> list[Card]:
    """At most `limit` cards: those the alert's own name picks first, then those a word or a phrase of its name or label
    values picks, then those a word or a phrase of `texts` picks; in a tie, the card with more matches, then the cards'
    order."""
    name = (alertname or "").strip().lower()
    name_compact = _compact(alertname or "")
    alert_words = words(" ".join([alertname or "", *(str(v) for v in (labels or {}).values())]))
    texts = list(texts)
    other_words = words(" ".join(texts))
    alert_said: list[str] = []
    other_said: list[str] = []
    if any(card.phrases for card in cards):
        # the labels as one text and the other texts as one, so how many there are adds nothing to what is searched
        telling = (str(v) for k, v in (labels or {}).items() if str(k).lower() in TELLING_LABELS)
        alert_said = [name_said(alertname or ""), said("\n".join(telling))]
        other_said = [said("\n".join(texts))]
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
        for phrase in card.phrases:
            if any(phrase_in(phrase, text) for text in alert_said):
                where = ALERT_SYMPTOM
            elif any(phrase_in(phrase, text) for text in other_said):
                where = TEXT_SYMPTOM
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
                        tools: Iterable[Mapping[str, Any]], texts: Iterable[str] = (),
                        annotations: Optional[Mapping[str, Any]] = None) -> tuple[str, list[str]]:
    """What goes into an investigation's first message ("" with the switch off or no card picked). The alert's annotations
    are read with ai.ruleCards.symptoms only."""
    if not settings.investigations:
        return "", []
    source = INVESTIGATION_SOURCE
    if settings.symptoms:
        source = INVESTIGATION_SYMPTOMS_SOURCE
        texts = [*texts, *(str(v) for k, v in (annotations or {}).items() if v and str(k).lower() in TELLING_ANNOTATIONS)]
    picked = pick(settings.cards, alertname=alertname, labels=labels, texts=texts)
    return render(picked, offered_names(tools), source=source)


def chat_cards(message: str, tools: Iterable[Mapping[str, Any]],
               settings: Optional[Settings] = None) -> tuple[Optional[str], Optional[list[str]]]:
    """A system message for this chat turn (None when the question names no failure a card knows) and the kinds in it
    for the turn's ai.chat.complete row; (None, None) with the switch off. Only this turn reads it; the history keeps
    none."""
    settings = settings if settings is not None else load()
    if not settings.chat:
        return None, None
    source = CHAT_SYMPTOMS_SOURCE if settings.symptoms else CHAT_SOURCE
    text, kinds = render(pick(settings.cards, texts=[message or ""]), offered_names(tools), source=source)
    return text or None, kinds
