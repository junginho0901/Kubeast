"""Mask credentials (and optionally personal data) in text bound for the model.

Mirror of services/pkg/redact (Go): same rule families, same placeholders.
tool-server already redacts tool results; this module covers the inputs the
UI sends straight to ai-service (log analysis, resource explanation, the
floating widget's page snapshot). Keep the two rule lists in sync.

Secret objects are handled unconditionally: a document with ``kind: Secret``
loses every value under data/stringData and its last-applied annotation,
whether redaction is enabled or not.

Beyond the Go list, the provider_key rule also masks the model API keys this
process uses (``remember_secret``), whatever their shape.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple


@dataclass
class Options:
    enabled: bool = True
    pii: bool = False
    disabled: set = field(default_factory=set)
    # With pii, every personal-data kind is numbered (<PHONE_1>) and a run's table numbers a value alike across its texts
    # (REDACTION_NUMBERED, chart ai.redaction.numbered, default false). Off: one address keeps one <EMAIL_n> within a
    # text, the other kinds are <REDACTED:kind>, and no table is used.
    numbered: bool = False

    def on(self, rule: str) -> bool:
        return self.enabled and rule not in self.disabled


@dataclass
class Stats:
    count: int = 0
    kinds: Dict[str, int] = field(default_factory=dict)

    def add(self, kind: str, n: int) -> None:
        if n:
            self.kinds[kind] = self.kinds.get(kind, 0) + n
            self.count += n

    def merge(self, other: "Stats") -> None:
        for k, n in other.kinds.items():
            self.add(k, n)

    def as_dict(self) -> Optional[Dict[str, Any]]:
        return {"count": self.count, "kinds": dict(self.kinds)} if self.count else None


# The personal-data rules whose placeholder carries a number (<EMAIL_1>, <PHONE_2>, <RRN_1>, <CARD_1>): the same value gets
# the same number, so the model can tell that two lines name one person without reading who. Go: numberedKinds.
NUMBERED_KINDS = {"email": "EMAIL", "phone": "PHONE", "rrn": "RRN", "card": "CARD"}
_MASK_KEY_CHARS = 16  # 64 bits of the HMAC, enough to tell apart the values of one answer


def mask_key(key: str, kind: str, value: str) -> str:
    """What a number table holds for a value: the HMAC-SHA256 of its normal form under ``key``, in hex, cut to 16
    characters. An address in another case and a number with other separators are the same value. Go: MaskKey."""
    if kind == "email":
        normal = value.lower()
    else:
        normal = "".join(c for c in value if "0" <= c <= "9")
    return hmac.new(key.encode(), normal.encode(), hashlib.sha256).hexdigest()[:_MASK_KEY_CHARS]


_MAX_HELD_NUMBER = 999999  # a number past this in a text is not counted, so ``after`` stays a small number for Go too
_HELD_PLACEHOLDER = re.compile(r"(?:<|\\u003[cC])(EMAIL|PHONE|RRN|CARD)_([0-9]{1,6})(?:>|\\u003[eE])")


def highest_numbers(texts: Any) -> Dict[str, int]:
    """Per kind, the highest numbered placeholder the texts already hold (also as JSON writes < and > for HTML); what is
    not a string is passed over. Go: startAfterHeld."""
    kinds = {name: kind for kind, name in NUMBERED_KINDS.items()}
    found: Dict[str, int] = {}
    for text in texts:
        if not isinstance(text, str) or ("<" not in text and "u003" not in text):
            continue
        for name, digits in _HELD_PLACEHOLDER.findall(text):
            num = int(digits)
            if num <= _MAX_HELD_NUMBER and num > found.get(kinds[name], 0):
                found[kinds[name]] = num
    return found


class Numbers:
    """The personal-data numbers of one chat answer or one alert investigation, in memory for that run only.

    The table is kind → mask_key of a value → number, and holds no value. ai-service sends it with each tool-server call
    (``wire``) and keeps the table that comes back (``take_answer``), so tool-server numbers a value it masks as this run
    numbered it before; ``redact_text(..., numbers=)`` numbers with it here. The key is made for this table only.

    A new number is past every number of its kind in the table, in ``after`` and in the texts given so far: ``after``
    starts past what the conversation already shows the model (``start_after``), so a value is never given a number an
    earlier answer gave another one. The same value in a later answer gets a new number.

    The chat stream turns on ``keep_values`` for the person who asked: tool-server then gives back each placeholder's
    value with the answer (``reveal``), the page masked here adds its own, and ``revealed`` is what the screen shows in
    their place. ``held`` are the placeholders a text already held (an earlier report a tool read), which stand for no
    value of this run and are never given one. Investigations and MCP leave it off. Go: Numbers.Reveal."""

    def __init__(self, key: Optional[str] = None) -> None:
        self.key = secrets.token_hex(16) if key is None else key
        self.table: Dict[str, Dict[str, int]] = {}
        self.after: Dict[str, int] = {}
        self._next: Dict[str, int] = {}  # per kind, one past the highest number, worked out when first needed
        self.values: Optional[Dict[str, str]] = None  # placeholder → value, only once keep_values is on
        self.held: set = set()

    def keep_values(self) -> None:
        """Keep each placeholder's value for this run's answer to the person who asked (the chat stream only)."""
        if self.values is None:
            self.values = {}

    def hold(self, text: str) -> None:
        """Count the numbered placeholders ``text`` already holds: the next new number goes past them and, while values
        are kept, none of them is given a value."""
        self.start_after(highest_numbers([text]))
        if self.values is not None and isinstance(text, str):
            for p in held_placeholders(text):
                self.held.add(p)
                self.values.pop(p, None)

    def keep(self, values: Any, held: Any = None) -> None:
        """Add what tool-server gave back for one answer: placeholder → value, the first one kept, and the placeholders
        its text held. Anything not shaped so is ignored; nothing is kept while values are off."""
        if self.values is None:
            return
        if isinstance(held, list):
            self.held.update(p for p in held if isinstance(p, str) and _NUMBERED_PLACEHOLDER.fullmatch(p))
        if isinstance(values, dict):
            for p, v in values.items():
                if isinstance(p, str) and isinstance(v, str) and _NUMBERED_PLACEHOLDER.fullmatch(p):
                    self.values.setdefault(p, v)
        for p in self.held:
            self.values.pop(p, None)

    def revealed(self, text: str) -> Dict[str, str]:
        """The values of the placeholders ``text`` shows, for the person who asked; none for a held one."""
        if not self.values or not isinstance(text, str):
            return {}
        return {p: v for p, v in self.values.items() if p not in self.held and p in text}

    def start_after(self, found: Dict[str, int]) -> None:
        """Make each kind's next new number past the number ``found`` gives it (highest_numbers)."""
        for kind, num in found.items():
            if num > self.after.get(kind, 0):
                self.after[kind] = num
                if self._next.get(kind, num + 1) <= num:
                    self._next[kind] = num + 1

    def number(self, kind: str, value: str) -> int:
        by_key = self.table.setdefault(kind, {})
        k = mask_key(self.key, kind, value)
        got = by_key.get(k)
        if isinstance(got, int) and got > 0:
            return got
        if kind not in self._next:
            self._next[kind] = max([v for v in by_key.values() if isinstance(v, int)] + [self.after.get(kind, 0)]) + 1
        by_key[k] = self._next[kind]
        self._next[kind] += 1
        return by_key[k]

    def placeholder(self, kind: str, value: str) -> str:
        p = "<%s_%d>" % (NUMBERED_KINDS[kind], self.number(kind, value))
        if self.values is not None and p not in self.held:
            self.values.setdefault(p, value)
        return p

    def wire(self) -> Dict[str, Any]:
        """What a tool-server call sends as ``masks``: the key and a copy of the table as it is when the call leaves, and
        ``reveal`` while values are kept."""
        out = {"key": self.key, "table": {kind: dict(by_key) for kind, by_key in self.table.items()}, "after": dict(self.after)}
        if self.values is not None:
            out["reveal"] = True
        return out

    def take_answer(self, sent: Dict[str, Dict[str, int]], table: Any, text: str, values: Any = None, held: Any = None) -> str:
        """Keep the table a tool-server answer gave back for a call that left with ``sent``, and return ``text`` as the
        run reads it. Two calls of a run at once (Claude Code makes them) both number from the table they left with, so
        each may give the next number to a different value: the later answer's value then takes the run's number for
        it, or the next free one, in its text too. Anything not shaped as a table is ignored. The numbers the text already
        held, an earlier report it read for one, are not given to a new value later in the run. ``values`` and ``held``
        (with ``reveal``) are kept under the numbers the text ends with (``keep``)."""
        self.start_after(highest_numbers([text]))
        if not isinstance(table, dict):
            self.keep(values, held)
            return text
        self._next = {}
        moves: Dict[Tuple[str, int], int] = {}
        for kind, by_key in table.items():
            if kind not in NUMBERED_KINDS or not isinstance(by_key, dict):
                continue
            mine = self.table.setdefault(kind, {})
            left_with = sent.get(kind) or {}
            given = [(n, k) for k, n in by_key.items() if isinstance(k, str) and isinstance(n, int) and not isinstance(n, bool) and n > 0]
            for n, k in sorted(given):
                if k in left_with:
                    continue
                if k in mine:
                    if mine[k] != n:
                        moves[(kind, n)] = mine[k]
                    continue
                if n in mine.values():
                    mine[k] = max(max(mine.values()), self.after.get(kind, 0)) + 1
                    moves[(kind, n)] = mine[k]
                else:
                    mine[k] = n
        if not moves:
            self.keep(values, held)
            return text
        kinds = {name: kind for kind, name in NUMBERED_KINDS.items()}

        def move(m: re.Match) -> str:
            to = moves.get((kinds[m.group(1)], int(m.group(2))))
            return m.group(0) if to is None else "<%s_%d>" % (m.group(1), to)

        if isinstance(values, dict):
            values = {(_NUMBERED_PLACEHOLDER.sub(move, p) if isinstance(p, str) else p): v for p, v in values.items()}
        if isinstance(held, list):
            held = [_NUMBERED_PLACEHOLDER.sub(move, p) if isinstance(p, str) else p for p in held]
        self.keep(values, held)
        return _NUMBERED_PLACEHOLDER.sub(move, text)


_NUMBERED_PLACEHOLDER = re.compile(r"<(EMAIL|PHONE|RRN|CARD)_([0-9]+)>")


def held_placeholders(text: str) -> set:
    """The numbered placeholders a text holds, as ``<KIND_n>`` also where JSON wrote < and > for HTML. Go: the held of
    startAfterHeld."""
    return {"<%s_%s>" % (name, digits) for name, digits in _HELD_PLACEHOLDER.findall(text)}


def from_env() -> Options:
    """REDACTION_ENABLED (default true) / REDACTION_PII (default false) /
    REDACTION_DISABLE (comma list of rule names) / REDACTION_NUMBERED (default false)."""
    enabled = os.getenv("REDACTION_ENABLED", "true").strip().lower() not in ("false", "0", "off")
    pii = os.getenv("REDACTION_PII", "false").strip().lower() in ("true", "1", "on")
    disabled = {x.strip().lower() for x in os.getenv("REDACTION_DISABLE", "").split(",") if x.strip()}
    return Options(enabled=enabled, pii=pii, disabled=disabled, numbered=numbered_on())


def numbered_on() -> bool:
    """REDACTION_NUMBERED (chart ai.redaction.numbered, default false): personal data numbered per run (Options.numbered)."""
    return os.getenv("REDACTION_NUMBERED", "false").strip().lower() in ("true", "1", "on")


# --- key-name rule ------------------------------------------------------------

# A credential word at the end of a word of the normalized (snake_case) key: db_password,
# clientSecret → client_secret, apiKey → api_key, names glued together, PGPASSWORD, APIKEY, and the plural, api_keys;
# "tokenizer" or "max_tokens" do not match. "secrets" and "tokens" stay out: they name a kind and what a model used far
# more often than they hold a value.
_SENSITIVE_KEY = re.compile(
    r"(^|_)[a-z0-9]*(passwords?|passwds?|pwds?|secret|token|api_?keys?|access_?keys?|private_?keys?|secretkeys?|credentials?|dsns?|connection_?strings?)(_|$)"
)
# The same words standing apart. A name that matches only the rule above is glued: see _left_to_the_word_rule.
_SEPARATED_KEY = re.compile(
    r"(^|_)(passwords?|passwds?|pwds?|secret|token|api_keys?|access_keys?|private_keys?|credentials?|dsns?|connection_strings?)(_|$)|[a-z0-9]_pass$"
)
# "pass" as a password's short name: the last word after another one (DB_PASS, mysqlPass), or PGPASS. Alone it is a result
# (pass: true), glued it is another word (bypass, compass), and after these words it is a run or a check that passed,
# unless the name is in capitals: an environment variable holds the value itself (E2E_PASS).
_SHORT_PASSWORD_KEY = re.compile(r"[a-z0-9]_pass$|(^|_)pgpass$")
_PASS_OF_A_RUN = re.compile(
    r"(^|_)(first|second|third|fourth|last|final|next|prev|previous|by|single|multi|test|tests|unit|e2e|lint|check|checks|build|gate|scan|summary|result|results|total|all)_pass$"
)
_NOT_SECRET_KEY = re.compile(
    r"(name|ref|url|uri|path|file|dir|ttl|length|count|min|max|timeout|mode|type|enabled|id|version|algorithm|alg|header|claim|issuer|audience|scope|policy)s?$"
)
_CAMEL_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")


def _normalize_key(key: str) -> str:
    return _CAMEL_BOUNDARY.sub(r"\1_\2", key).replace("-", "_").replace(".", "_").lower()
_KEY_VALUE_LINE = re.compile(
    r'^([ \t]*-?[ \t]*(?:export[ \t]+)?"?([A-Za-z0-9_.\-]+)"?[ \t]*[:=][ \t]*)("?)([^"\r\n]*?)("?[ \t]*,?)[ \t]*$', re.M
)
_JSON_PAIR = re.compile(r'(\\?")([A-Za-z0-9_.\-]+)(\\?"[ \t]*:[ \t]*\\?")((?:[^"\\]|\\[^"]|\\\\")*?)(\\?")')
_ENV_LIST_YAML = re.compile(
    r'^([ \t]*-?[ \t]*name:[ \t]*"?([A-Za-z0-9_.\-]+)"?[ \t]*\r?\n[ \t]*value:[ \t]*)("?)([^"\r\n]*?)("?)[ \t]*$', re.M
)
_ENV_LIST_JSON = re.compile(r'("name"[ \t]*:[ \t]*"([A-Za-z0-9_.\-]+)"[ \t]*,[ \t]*"value"[ \t]*:[ \t]*")([^"]*)(")')

_HARMLESS = {"true", "false", "yes", "no", "on", "off", "none", "auto", "default"}


def _only_number_characters(v: str) -> bool:
    """A count or a duration, in ASCII digits as in Go: digits of another width are no number a program prints."""
    return not v.strip("0123456789.-msh")


def _value_looks_harmless(v: str) -> bool:
    v = v.strip()
    if v in ("", "null", "~", "[]", "{}", "[", "{", "|", ">", "|-", ">-"):
        return True
    if v.startswith("<REDACTED") or v.startswith("<set to the key") or v.startswith("<EMAIL"):
        return True
    if v.lower() in _HARMLESS:
        return True
    return _only_number_characters(v)


def _is_short_password(key: str) -> bool:
    k = _normalize_key(key.lstrip("-"))
    return bool(_SHORT_PASSWORD_KEY.search(k)) and (key == key.upper() or not _PASS_OF_A_RUN.search(k))


# A word every sensitive key holds. They look ahead of the key-name rules: nearly all text holds none.
_CREDENTIAL_WORDS = ("pass", "pwd", "secret", "token", "key", "credential", "dsn", "connection")
_ANY_CREDENTIAL_WORD = re.compile("|".join(_CREDENTIAL_WORDS), re.I | re.A)
_PROVIDER_PREFIXES = ("sk-", "AIza", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "xox", "hf_")


def _holds_credential_word(text: str) -> bool:
    lower = text.lower()
    return any(word in lower for word in _CREDENTIAL_WORDS)


def _may_read_fold(text: str, *words: str) -> bool:
    """Whether text may hold one of the words to a case-insensitive rule, which folds ASCII letters only (re.A)."""
    lower = text.lower()
    return any(word in lower for word in words)


def _key_is_sensitive(key: str) -> bool:
    if not _holds_credential_word(key):
        return False
    k = _normalize_key(key)
    return (bool(_SENSITIVE_KEY.search(k)) and not _NOT_SECRET_KEY.search(k)) or _is_short_password(key)


# The key's last word says the value itself is the credential, so a number there is one. Under password_expiry_days,
# token or secret a number may be a setting or a count, and hiding it would change what the reader is told.
_CREDENTIAL_LAST_WORD = re.compile(r"(^|_)[a-z0-9]*(password|passwd|pwd|api_?key|access_?key|secret_?key|private_?key|client_?secret)$|[a-z0-9]_pass$|(^|_)pgpass$")
# The shell's own variables, as the shell spells them: PWD=/app says where a process runs. DB_PWD=/x, and an ODBC
# connection string's Pwd=/x, are a password whatever they look like.
_WORKING_DIRECTORY_KEY = re.compile(r"^(PWD|OLDPWD|pwd|oldpwd)$")
_PATH_SHAPED = re.compile(r"^(~|\.{1,2})?(/[A-Za-z0-9._~\-]*)*$")
# A directory with a space, past its first part: /fake pass cannot be told from a value, /home/me/My Docs can.
_PATH_WITH_SPACES = re.compile(r"^/[A-Za-z0-9._~\-]+(/[A-Za-z0-9._~\- ]*)+$")
# Two humps in one part of a path read as encoded text.
_ENCODED_PATH_PART = re.compile(r"[a-z0-9][A-Z][^/]*[a-z0-9][A-Z]")


def is_working_directory(key: str, value: str) -> bool:
    """In the shell's own capitals the name says where a process runs. In lower case it may as well be a password's
    abbreviation, so a value that reads as encoded text goes."""
    if not _WORKING_DIRECTORY_KEY.match(key):
        return False
    v = value.strip()
    if key == key.upper():
        return bool(_PATH_SHAPED.match(v) or _PATH_WITH_SPACES.match(v))
    return bool(_PATH_SHAPED.match(v)) and not _ENCODED_PATH_PART.search(v)


# Keys charts use for the name of a Secret that holds the value (existingSecret, tlsSecret).
_NAMES_A_SECRET_OBJECT = re.compile(r"(^|_)(existing|tls|ssl|ca|cert|certificate|pull|image_pull)_?secret$")


def _reads_as_a_name(v: str) -> bool:
    return bool(_NAME_SHAPED.match(v)) and (any(c in v for c in "-./") or not any(c.isdigit() for c in v))


def _names_an_object(key: str, value: str) -> bool:
    """The name is what a reader needs and holds nothing. In capitals the key is an environment variable, which holds the
    value itself."""
    return key != key.upper() and bool(_NAMES_A_SECRET_OBJECT.search(_normalize_key(key))) and _reads_as_a_name(value.strip())


def _counts_what_passed(normalized_key: str, value: str) -> bool:
    """A small number under a short name (foo_pass: 3) is a count; no password is that short."""
    return len(value) < 4 and len(normalized_key) > 5 and normalized_key.endswith("_pass")


# What follows KEY=word reads as more of a command line: another assignment, a path, or a word and its flag. Anything else
# cannot be told from a value with spaces.
_COMMAND_AFTER = re.compile(r"^[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*=|[./~][^ \t]*(?:[ \t]|$)|[A-Za-z0-9_.\-]+[ \t]+-{1,2}[A-Za-z])")


def _left_to_the_word_rule(key: str, line: str) -> bool:
    """KEY=word stays with the rule for a line's words when the command after the word is not the value: always under a
    glued name, as PGPASSWORD=x psql has to, and under a name standing apart when the rest reads as a command. Whatever that
    rule cannot read as one word is masked to the end of the line."""
    m = _INLINE_PAIR.search(line)
    if not m or m.group(2) != key:
        return False
    separated = bool(_SEPARATED_KEY.search(_normalize_key(key)))
    after = line[m.end():m.end() + 1]
    if after in ("", " ", "\t"):
        return not separated or bool(_COMMAND_AFTER.match(line[m.end():]))
    return not separated and after == "}" and m.group(4).startswith("${")


def _value_stays(key: str, value: str) -> bool:
    """Whether a sensitive key's text value is left as it is."""
    if is_working_directory(key, value) or _names_an_object(key, value):
        return True
    if not _value_looks_harmless(value):
        return False
    v = value.strip()
    k = _normalize_key(key)
    return not v or not _only_number_characters(v) or not _CREDENTIAL_LAST_WORD.search(k) or _counts_what_passed(k, v)


def _holds_credential(key: str, value: Any) -> bool:
    """Whether a decoded member's value is a credential by its key. true, false and null say nothing."""
    if not _key_is_sensitive(key):
        return False
    if isinstance(value, str):
        return not _value_stays(key, value)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    k = _normalize_key(key)
    return bool(_CREDENTIAL_LAST_WORD.search(k)) and not _counts_what_passed(k, str(value))


# A value given as a YAML block (token: |, password: >-) is on the lines below the key, which the line rules do not read.
_BLOCK_KEY = re.compile(r"""^([ \t]*(?:-[ \t]+)?)"?([A-Za-z0-9_.\-]+)"?[ \t]*:[ \t]*[|>][0-9+\-]*[ \t]*(?:#.*)?\r?$""")


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" \t"))


def _mask_block_values(text: str, stats: Stats) -> str:
    """Replace a sensitive key's block with one placeholder. The block is what sits deeper than the key, as in YAML; the
    key's next sibling and blank lines after the block stay."""
    if "|" not in text and ">" not in text:
        return text
    lines = text.split("\n")
    out: list = []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        if ":" not in line or ("|" not in line and ">" not in line):
            continue
        m = _BLOCK_KEY.match(line)
        if not m or not _key_is_sensitive(m.group(2)):
            continue
        first, end = None, i
        for j in range(i, len(lines)):
            if not lines[j].strip():
                continue
            if _indent_of(lines[j]) <= len(m.group(1)):
                break
            first = first if first is not None else lines[j]
            end = j + 1
        if first is None:
            continue
        cr = "\r" if first.endswith("\r") else ""
        out.append(first[:_indent_of(first)] + "<REDACTED:" + m.group(2) + ">" + cr)
        stats.add("key_name", 1)
        i = end
    return "\n".join(out)


# A key with nothing after it, whose value may be the list on the lines below, and one item of that list.
_LIST_KEY = re.compile(r"""^([ \t]*(?:-[ \t]+)?)"?([A-Za-z0-9_.\-]+)"?[ \t]*:[ \t]*(?:#.*)?\r?$""")
_LIST_ITEM = re.compile(r"^([ \t]*-[ \t]+)(.*?)([ \t]*\r?)$")

# A key and the bracket of its list, in any quote and any level of escaping, or at the line's start: in a sentence a word
# before a colon is not one.
_JSON_LIST_OPENS = re.compile(r"""["']([A-Za-z0-9_.\-]+)\\*["'][ \t]*:[ \t\r\n]*\[|^[ \t]*(?:-[ \t]+)?([A-Za-z0-9_.\-]+)[ \t]*:[ \t]*\[""", re.M)
# A line that goes on with a list: a string, a bracket, or one word.
_JSON_LIST_LINE_STARTS = re.compile(r"""^[ \t]*(?:\\*["'\[\]{}]|[^ \t\r\n,"'\\\[\]{}:]+[ \t]*(?:[,\]}]|\r?$))""")
_JSON_LIST_WORD = re.compile(r"""[^ \t\r\n,"'\\\[\]{}]+""")
# What a mapping inside a list can change: its depth, or a string that may hold a brace.
_JSON_LIST_MAPPING_STOP = re.compile(r"""[{}"'\\]""")
# What a list can go on with besides a word.
_JSON_LIST_SKIP = re.compile(r"[ \t\r,]+")


def _json_list_openings(text: str) -> list:
    """The sensitive keys' lists in text, in order: (start, end, key, quote). A key at the line's start whose list closes on
    that line is the line rule's."""
    out = []
    for m in _JSON_LIST_OPENS.finditer(text):
        if m.group(1) is None:
            key = m.group(2)
            line_end = len(text)
            for stop in ("\r", "\n"):
                at = text.find(stop, m.end())
                if at != -1:
                    line_end = min(line_end, at)
            if _key_is_sensitive(key) and "]" not in text[m.end():line_end]:
                out.append((m.start(), m.end(), key, '"'))
            continue
        if _key_is_sensitive(m.group(1)):
            start = m.start()
            while start > 0 and text[start - 1] == "\\":
                start -= 1
            out.append((start, m.end(), m.group(1), text[start:m.start() + 1]))
    return out


def _quote_at(text: str, i: int) -> Optional[int]:
    """How many backslashes come before the quote that opens a string at text[i], None if none opens there."""
    j = i
    while j < len(text) and text[j] == "\\":
        j += 1
    return j - i if j < len(text) and text[j] in "\"'" else None


def _line_string_end(text: str, i: int, level: int) -> Tuple[int, bool]:
    """The index after the string that opens at text[i] with level backslashes, which ends with its line at the latest: a
    text cut short has no closing quote. The second value says whether it had one."""
    opening = i + level
    quote = text[opening]
    step = 2 * (level + 1)
    j = opening + 1
    while j < len(text):
        c = text[j]
        if c in "\r\n":
            return j, False
        if c == quote:
            run = 0
            k = j - 1
            while k > opening and text[k] == "\\":
                run += 1
                k -= 1
            if run % step == level:
                return j + 1, True
        j += 1
    return len(text), False


def _next_line_goes_on_with_a_list(text: str, i: int) -> bool:
    """The first line after text[i] with anything on it reads as more of a list."""
    while i < len(text):
        end = text.find("\n", i)
        end = len(text) if end == -1 else end
        line = text[i:end]
        if line.strip(" \t\r\n\f\v"):
            return bool(_JSON_LIST_LINE_STARTS.match(line))
        i = end + 1
    return True


def _mask_json_lists(text: str, stats: Stats) -> str:
    """Mask each item of a sensitive key's list in text, which a parser cannot read when it is a log line or was cut short: at
    any depth of lists, past mappings, in any quote. A mapping has its own keys, a count or a state stays as it does on the
    key's own line, and the list ends at its bracket or the first line that does not read as one. One pass over the text,
    however lists nest."""
    if "[" not in text:
        return text
    openings = _json_list_openings(text)
    if not openings:
        return text
    out: list = []
    written = [0]

    def _mask(start: int, end: int, key: str, quote: str, value: str) -> None:
        if _value_stays(key, value):
            return
        out.append(text[written[0]:start])
        out.append(quote + "<REDACTED:" + key + ">" + quote)
        written[0] = end
        stats.add("key_name", 1)

    stack: list = []  # [key, quote, depth, mappings]
    following = 0
    i = 0
    while i < len(text):
        while following < len(openings) and openings[following][0] < i:
            following += 1
        if not stack and following == len(openings):
            break
        if following < len(openings) and (not stack or (stack[-1][3] > 0 and openings[following][0] == i)):
            stack.append([openings[following][2], openings[following][3], 1, 0])
            i = openings[following][1]
            following += 1
            continue
        top = stack[-1]
        if top[3] > 0:
            stop = _JSON_LIST_MAPPING_STOP.search(text, i)
            at = stop.start() if stop else len(text)
            if following < len(openings) and openings[following][0] <= at:
                i = openings[following][0]
                continue
            i = at
            if not stop:
                break
            level = _quote_at(text, i)
            if level is not None:
                i = _line_string_end(text, i, level)[0]
            else:
                c = text[i]
                top[3] += 1 if c == "{" else -1 if c == "}" else 0
                i += 1
            continue
        level = _quote_at(text, i)
        if level is not None:
            end, closed = _line_string_end(text, i, level)
            first = i + level + 1
            _mask(i, end, top[0], text[i:first], text[first:end - level - 1] if closed else text[first:end])
            i = end
            continue
        c = text[i]
        if c == "\n":
            if not _next_line_goes_on_with_a_list(text, i + 1):
                stack.clear()
            i += 1
        elif c == "\\":
            i += 1
        elif c == "[":
            top[2] += 1
            i += 1
        elif c == "]":
            top[2] -= 1
            if top[2] == 0:
                stack.pop()
            i += 1
        elif c == "{":
            top[3] = 1
            i += 1
        elif c == "}":
            stack.pop()
            i += 1
        else:
            skipped = _JSON_LIST_SKIP.match(text, i)
            if skipped:
                i = skipped.end()
                continue
            word = _JSON_LIST_WORD.match(text, i)
            _mask(i, word.end(), top[0], top[1], word.group(0))
            i = word.end()
    if not written[0]:
        return text
    out.append(text[written[0]:])
    return "".join(out)


def _mask_list_values(text: str, stats: Stats) -> str:
    """Replace each item of a sensitive key's list on the lines below it, which the line rules read as words with no key.
    An item that is a mapping has its own keys, and a count or a state stays as it does on the key's own line."""
    if "\n" not in text:
        return text
    lines = text.split("\n")
    for i, line in enumerate(lines):
        # the first colon has nothing after it but space or a comment, without a regex for each line
        colon = line.find(":")
        rest = line[colon + 1:].lstrip(" \t") if colon != -1 else None
        if rest is None or (rest and rest != "\r" and rest[0] != "#"):
            continue
        m = _LIST_KEY.match(line)
        if not m or not _key_is_sensitive(m.group(2)):
            continue
        for j in range(i + 1, len(lines)):
            item = _LIST_ITEM.match(lines[j])
            if not item or _indent_of(lines[j]) < len(m.group(1)):
                break
            value, quote = item.group(2), ""
            if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
                value, quote = value[1:-1], value[0]
            if (not quote and (": " in value or value.endswith(":"))) or _value_stays(m.group(2), value):
                continue
            lines[j] = item.group(1) + quote + "<REDACTED:" + m.group(2) + ">" + quote + item.group(3)
            stats.add("key_name", 1)
    return "\n".join(lines)


# A credential among the words of a line (a log line, a command, a connection string, a URL's query). Prose reads the same
# way ("invalid password: too short"), so only key=value counts there, or a quoted value after = or :, and only a key whose
# last word is the credential: password_policy=strict and token_count=5 are settings.
_INLINE_WORD = r"(?:passwords?|passwds?|pwds?|secret|token|api[_.\-]?keys?|access[_.\-]?keys?|private[_.\-]?keys?|secret[_.\-]?keys?|credentials?|dsns?|connection[_.\-]?strings?|pgpass|[_.\-]pass)"
_INLINE_KEY = r"([A-Za-z0-9_.\-]*?" + _INLINE_WORD + r")"
_INLINE_BEFORE = r"""(--from-file=["']?|^|[^A-Za-z0-9_.\-])"""
# ASCII as in Go, whose \s has no other spaces, so both stop a value at the same place.
_INLINE_PAIR = re.compile(_INLINE_BEFORE + _INLINE_KEY + r"(=)([^\s\"'\\&;,)\]}|={*%<>\[(][^\s\"'\\&;,)\]}|]*)", re.I | re.A)
_INLINE_QUOTED = re.compile(_INLINE_BEFORE + _INLINE_KEY + r"([\"'\\]*[ \t]*[=:][ \t]*)(\"[^\"\r\n]*\"|'[^'\r\n]*'|\\\"[^\"\\\r\n]*\\\")", re.I | re.A)
# What says a state or a place for a value, not the value (token=expired, password=$DB_PASSWORD, password=%s), and the key
# every Ollama client sends for none.
_INLINE_NOT_A_VALUE = _HARMLESS | {"null", "nil", "empty", "set", "unset", "missing", "required", "invalid", "expired", "redacted", "hidden", "masked", "undefined", "unknown", "ollama"}
_INLINE_REFERENCE = re.compile(r"^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[a-z#+]{1,2}|\*+)$")
# These words also name an object: in a Kubernetes log secret=kube-system/my-tls is a Secret, not its value.
_INLINE_NAMES_AN_OBJECT = re.compile(r"(secret|credentials?)$")
_NAME_SHAPED = re.compile(r"^[a-z0-9._/\-]+$")


def _inline_value_stays(key: str, value: str) -> bool:
    v = value.strip("\\\"'").strip()
    if not v or v.startswith("<REDACTED") or v.lower() in _INLINE_NOT_A_VALUE or _INLINE_REFERENCE.match(v):
        return True
    if is_working_directory(key, v):
        return True
    k = _normalize_key(key.lstrip("-"))
    if k.endswith("pass") and not _is_short_password(key):
        return True  # pass=ok, first_pass=done
    credential = bool(_CREDENTIAL_LAST_WORD.search(k))
    if _only_number_characters(v) and (not credential or _counts_what_passed(k, v)):
        return True  # token=5, secret=3, foo_pass=3: a count or a duration
    # In capitals the key is an environment variable, which holds the value itself.
    if credential or key == key.upper() or not _INLINE_NAMES_AN_OBJECT.search(k):
        return False
    return _reads_as_a_name(v)


def _file_after_a_key(before: str, value: str) -> bool:
    """kubectl's --from-file=[key=]source names a file under the key, whatever the key says."""
    return before.lower().startswith("--from-file=") and ("/" in value or "." in value)


def _mask_inline_pair(m: re.Match) -> str:
    key, value = m.group(2), m.group(4)
    if _inline_value_stays(key, value) or _file_after_a_key(m.group(1), value):
        return m.group(0)
    return m.group(1) + key + m.group(3) + "<REDACTED:" + key.lstrip("-") + ">"


def _mask_inline_quoted(m: re.Match) -> str:
    key, value = m.group(2), m.group(4)
    if _inline_value_stays(key, value) or _file_after_a_key(m.group(1), value):
        return m.group(0)
    quote = '\\"' if value.startswith("\\") else value[0]
    return m.group(1) + key + m.group(3) + quote + "<REDACTED:" + key.lstrip("-") + ">" + quote


# --- value-pattern rules --------------------------------------------------------

# re.A, as in Go: a word boundary is one of ASCII word characters, so a value written right after a Korean word, as in 키는ghp_,
# starts where it starts. It leaves \s only the ASCII spaces, so the rules name the others too.
_SPACE_CHARS = r"\s\x1c-\x1f\x85\xa0  -     　"
_SPACE = "[" + _SPACE_CHARS + "]"
_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----")
_URL_CREDENTIALS = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*://[^:/\s@\"']+:)[^@\s\"']+(@)", re.A)
_AUTHORIZATION = re.compile(r"\b(Bearer|Basic)" + _SPACE + r"+([A-Za-z0-9._~+/=\-]{16,})", re.I | re.A)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b", re.A)
_AWS_ACCESS_KEY = re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b", re.A)
_AWS_SECRET_VALUE = re.compile(r"(aws_secret_access_key" + _SPACE + "*[:=]" + _SPACE + r'*"?)([A-Za-z0-9/+=]{40})', re.I | re.A)
# API keys by their published prefixes (the gitleaks rule set), with looser lengths since an error message may cut a
# key short. A bare sk- run counts only with an upper-case letter and a digit, which a Kubernetes name never has.
_PROVIDER_KEY = re.compile(
    r"\b(?:sk-[A-Za-z0-9_\-]{20,}|AIza[A-Za-z0-9_\-]{35}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}"
    r"|xox[abposr]-[A-Za-z0-9\-]{10,}|hf_[A-Za-z0-9]{30,})",
    re.A,
)
_UPPER_AND_DIGIT = re.compile(r"(?=.*[A-Z])(?=.*[0-9])")

# Model API keys this process uses, masked by value (a key with no published shape: Azure, a gateway's own).
_REMEMBERED: set = set()


def remember_secret(value: Optional[str]) -> None:
    """Mask this credential wherever text repeats it. Values under 12 characters are placeholders ("ollama")."""
    if value and len(value) >= 12:
        _REMEMBERED.add(value)


def _provider_key(m: re.Match) -> str:
    k = m.group(0)
    if k.startswith("sk-") and not _UPPER_AND_DIGIT.match(k):
        return k
    return "<REDACTED:api_key>"

_EMAIL = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b", re.A)
_KR_PHONE = re.compile(r"\b01[016789][-." + _SPACE_CHARS + r"]?\d{3,4}[-." + _SPACE_CHARS + r"]?\d{4}\b", re.A)
_KR_RRN = re.compile(r"\b\d{6}[-" + _SPACE_CHARS + r"]?[1-4]\d{6}\b", re.A)
_CARD = re.compile(r"\b\d{4}[-" + _SPACE_CHARS + r"]?\d{4}[-" + _SPACE_CHARS + r"]?\d{4}[-" + _SPACE_CHARS + r"]?\d{4}\b", re.A)


def _sub_count(pattern: re.Pattern, text: str, repl, stats: Stats, kind: str) -> str:
    n = 0

    def _r(m: re.Match) -> str:
        nonlocal n
        out = repl(m)
        if out != m.group(0):
            n += 1
        return out

    text = pattern.sub(_r, text)
    stats.add(kind, n)
    return text


def _sub_on_credential_lines(pattern: re.Pattern, text: str, repl, stats: Stats, kind: str) -> str:
    """_sub_count for a rule that reads one line at a time, on the lines holding a credential word."""
    out: list = []
    written = 0
    at = 0
    while True:
        m = _ANY_CREDENTIAL_WORD.search(text, at)
        if not m:
            break
        start = text.rfind("\n", 0, m.start()) + 1
        end = text.find("\n", m.end())
        end = len(text) if end == -1 else end
        line = text[start:end]
        replaced = _sub_count(pattern, line, repl, stats, kind)
        if replaced != line:
            out.append(text[written:start])
            out.append(replaced)
            written = end
        at = end
    if not written:
        return text
    out.append(text[written:])
    return "".join(out)


# --- Secret documents -----------------------------------------------------------

_SECRET_PLACEHOLDER = "<REDACTED:secret>"
_LAST_APPLIED_NAME = "kubectl.kubernetes.io/last-applied-configuration"
_LAST_APPLIED = _LAST_APPLIED_NAME + ":"
# A Secret's values: its own two fields and the describe answer's data_values.
_SECRET_VALUE_FIELDS = ("data", "stringData", "data_values")

# A chart may quote the kind or put spaces after the colon; kubectl prints `kind: Secret`.
_SECRET_YAML_KIND = re.compile(r"""^[ \t]*(?:-[ \t]+)?["']?kind["']?[ \t]*:[ \t]*["']?Secret["']?[ \t]*\r?$""", re.M)
# `"kind": "Secret"`, or kubectl's own words in a refused patch, whose JSON does not say what it patches.
_SECRET_JSON_KIND = re.compile('"kind"' + _SPACE + "*:" + _SPACE + r'*"Secret"|\bKind=Secret\b', re.A)
# A field of a JSON Secret that holds its values, up to where the value starts.
_JSON_SECRET_FIELD = re.compile(r'"(data|stringData|data_values|kubectl\.kubernetes\.io/last-applied-configuration)"\s*:\s*')
# The same two as JSON in a string, its quotes escaped: a log line holding an object.
_ESCAPED_SECRET_KIND = re.compile(r'"kind(\\+)"\s*:\s*\\+"Secret\\+"')
_ESCAPED_SECRET_FIELD = re.compile(r'"(data|stringData|data_values|kubectl\.kubernetes\.io/last-applied-configuration)(\\+)"\s*:\s*')
# The same two in YAML's flow style, on one line or several: {kind: Secret, data: {key: value}}.
_SECRET_FLOW_KIND = re.compile(r"""[{,][ \t\r\n]*["']?kind["']?[ \t]*:[ \t]*["']?Secret["']?[ \t\r\n]*[,}]""")
_FLOW_SECRET_FIELD = re.compile(r"""[{,][ \t\r\n]*["']?(data|stringData|data_values|kubectl\.kubernetes\.io/last-applied-configuration)["']?[ \t]*:[ \t]*""")
# Past this many backslashes a quote is not read as JSON in a string.
_MAX_ESCAPE_LEVEL = 15


def _names_secret_yaml(text: str) -> bool:
    return "kind: Secret" in text or bool(_SECRET_YAML_KIND.search(text))


def _names_secret(text: str) -> bool:
    """The word comes first, so text that never says it, most of what goes through here, costs one search."""
    return "Secret" in text and bool(
        _names_secret_yaml(text) or _SECRET_JSON_KIND.search(text) or _SECRET_FLOW_KIND.search(text)
        or ('"Secret\\' in text and _ESCAPED_SECRET_KIND.search(text))
    )


def _escaped_secret_levels(text: str) -> list:
    """The levels of escaping at which text says it is a Secret, lowest first."""
    if '"Secret\\' not in text:
        return []
    return sorted({len(m.group(1)) for m in _ESCAPED_SECRET_KIND.finditer(text) if len(m.group(1)) <= _MAX_ESCAPE_LEVEL})


def _strip_secret_yaml(doc: str) -> Tuple[str, int]:
    """Blank every value under data:/stringData: and the last-applied annotation.

    Blocks are found by indentation at any depth — a Secret may sit inside a
    List's items: (``- data:`` or ``  data:``) rather than at the top level —
    and end at the first line that is not deeper than the key. Lines deeper
    than a value's key continue that value (``key: |`` blocks) and are dropped.
    """
    lines = doc.split("\n")
    n = 0
    block = -1  # indent of the data:/stringData: key while inside its block
    value = -1  # indent of the block's key lines; deeper lines continue a value
    anno = -1  # indent of the annotations: key while inside it
    last = -1  # indent of the last-applied key while inside its (block) value
    for i, line in enumerate(lines):
        trim = line.strip()
        if not trim or trim.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        key, key_indent = trim, indent
        if key.startswith("- "):  # "- data:" — the item's keys sit two columns in
            key, key_indent = key[2:].lstrip(), indent + 2
        if block >= 0:
            if indent > block:
                if value < 0:
                    value = indent
                if indent == value and ":" in trim:
                    lines[i] = " " * indent + trim.split(":", 1)[0] + ": " + _SECRET_PLACEHOLDER
                    n += 1
                else:
                    lines[i] = ""
                continue
            block = value = -1
        if anno >= 0:
            if indent > anno:
                if trim.lstrip("\"'").startswith(_LAST_APPLIED_NAME):
                    lines[i] = " " * indent + _LAST_APPLIED + " " + _SECRET_PLACEHOLDER
                    n += 1
                    last = indent
                elif last >= 0 and indent > last:
                    lines[i] = ""
                else:
                    last = -1
                continue
            anno = last = -1
        if ":" not in key:
            continue
        field, rest = key.split(":", 1)
        rest = rest.strip()
        name = field.strip("\"' ")
        on_its_own = rest == "" or rest.startswith("#")
        if name in ("data", "stringData"):
            if on_its_own:
                block, value = key_indent, -1
            elif rest in ("{}", "null", "~"):
                pass
            elif not field.startswith('"'):  # JSON's `"data": {` is _strip_secret_json's
                # a flow mapping or a scalar on the key's line, which may go on below it
                lines[i] = line[:line.index(key)] + field + ": " + _SECRET_PLACEHOLDER
                n += 1
                block, value = key_indent, -1
        elif name == "annotations" and on_its_own:
            anno, last = key_indent, -1
        elif name == "annotations" and _LAST_APPLIED_NAME in rest and not field.startswith('"'):
            lines[i] = line[:line.index(key)] + field + ": " + _SECRET_PLACEHOLDER
            n += 1
    return "\n".join(lines), n


def _json_value_end(s: str, i: int) -> int:
    """The index after the JSON value that starts at s[i], or -1 if s ends before the value does."""
    if i >= len(s):
        return -1
    c = s[i]
    if c == '"':
        j = i + 1
        while j < len(s):
            if s[j] == "\\":
                j += 2
                continue
            if s[j] == '"':
                return j + 1
            j += 1
        return -1
    if c in "{[":
        depth = 0
        j = i
        while j < len(s):
            ch = s[j]
            if ch == '"':
                end = _json_value_end(s, j)
                if end < 0:
                    return -1
                j = end
                continue
            if ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
                if depth == 0:
                    return j + 1
            j += 1
        return -1
    j = i
    while j < len(s) and s[j] not in ",}]\r\n":
        j += 1
    return j


_JSON_SPACE = " \t\n\r"


def _mask_json_value(out: list, s: str, i: int, counter: list) -> int:
    """Write the placeholder for the value at s[i]; the index after it, -1 if s ends first. An empty value stays."""
    end = _json_value_end(s, i)
    value = s[i:] if end < 0 else s[i:end]
    if end >= 0 and (value in ("{}", "null", '""', "[]") or value.startswith('"<REDACTED')):
        out.append(value)
    else:
        out.append('"' + _SECRET_PLACEHOLDER + '"')
        counter[0] += 1
    return end


def _mask_json_object(out: list, s: str, i: int, counter: list) -> int:
    """Write the object at s[i] with each value masked; the index after it, -1 if s ends first. Anything in it but
    keys, values, punctuation and space (a diff's +/- at a line's start) is left out."""
    out.append("{")
    j = i + 1
    while j < len(s):
        c = s[j]
        if c == "}":
            out.append("}")
            return j + 1
        if c == '"':
            end = _json_value_end(s, j)
            if end < 0:
                return -1
            colon = end
            while colon < len(s) and s[colon] in _JSON_SPACE:
                colon += 1
            if colon >= len(s) or s[colon] != ":":  # no key: a value out of place is still a value
                j = _mask_json_value(out, s, j, counter)
                if j < 0:
                    return -1
                continue
            out.append(s[j:colon + 1])
            j = colon + 1
            while j < len(s) and s[j] in _JSON_SPACE:
                out.append(s[j])
                j += 1
            j = _mask_json_value(out, s, j, counter)
            if j < 0:
                return -1
            continue
        if c in ",+-" or c in _JSON_SPACE:
            out.append(c)
        j += 1
    return -1


def _strip_secret_json(doc: str) -> Tuple[str, int]:
    """Mask a JSON Secret's values where a parser cannot be used: the text may be cut, or hold other text around the
    object. The scan keeps to JSON's strings, so braces and quotes inside a value do not end it, and a value that never
    ends takes the rest of the text with it. Key names stay; what is already a placeholder stays too."""
    out: list = []
    counter = [0]
    pos = 0
    while True:
        m = _JSON_SECRET_FIELD.search(doc, pos)
        if not m:
            out.append(doc[pos:])
            return "".join(out), counter[0]
        out.append(doc[pos:m.end()])
        at = m.end()
        if m.group(1) != _LAST_APPLIED_NAME and at < len(doc) and doc[at] == "{":
            end = _mask_json_object(out, doc, at, counter)
        else:
            end = _mask_json_value(out, doc, at, counter)
        if end < 0:
            return "".join(out), counter[0]
        pos = end


def _escaped_string_end(s: str, i: int, level: int) -> int:
    """The index after the string that opens at s[i] with level backslashes, -1 if s ends first. A quote inside it has more
    backslashes in front of it than the one that closes it, and the count says which."""
    first = i + level + 1
    step = 2 * (level + 1)
    j = s.find('"', first)
    while j != -1:
        run = 0
        k = j - 1
        while k >= first and s[k] == "\\":
            run += 1
            k -= 1
        if run % step == level:
            return j + 1
        j = s.find('"', j + 1)
    return -1


def _escaped_value_end(s: str, i: int, level: int, quote: str) -> int:
    """_json_value_end at a level of escaping."""
    if i >= len(s):
        return -1
    if s.startswith(quote, i):
        return _escaped_string_end(s, i, level)
    if s[i] in "{[":
        depth = 0
        j = i
        while j < len(s):
            if s[j] == "\\" and s.startswith(quote, j):
                end = _escaped_string_end(s, j, level)
                if end < 0:
                    return -1
                j = end
                continue
            if s[j] in "{[":
                depth += 1
            elif s[j] in "}]":
                depth -= 1
                if depth == 0:
                    return j + 1
            j += 1
        return -1
    j = i
    while j < len(s) and s[j] not in ",}]\r\n":
        j += 1
    return j


def _mask_escaped_value(out: list, s: str, i: int, level: int, counter: list) -> int:
    """_mask_json_value at a level of escaping."""
    quote = "\\" * level + '"'
    end = _escaped_value_end(s, i, level, quote)
    value = s[i:] if end < 0 else s[i:end]
    if end >= 0 and (value in ("{}", "null", quote + quote, "[]") or value.startswith(quote + "<REDACTED")):
        out.append(value)
    else:
        out.append(quote + _SECRET_PLACEHOLDER + quote)
        counter[0] += 1
    return end


def _mask_escaped_object(out: list, s: str, i: int, level: int, counter: list) -> int:
    """_mask_json_object at a level of escaping."""
    quote = "\\" * level + '"'
    out.append("{")
    j = i + 1
    while j < len(s):
        c = s[j]
        if c == "}":
            out.append("}")
            return j + 1
        if c == "\\" and s.startswith(quote, j):
            end = _escaped_string_end(s, j, level)
            if end < 0:
                out.append(quote + _SECRET_PLACEHOLDER + quote)
                counter[0] += 1
                return -1
            colon = end
            while colon < len(s) and s[colon] in _JSON_SPACE:
                colon += 1
            if colon >= len(s) or s[colon] != ":":  # no key: a value out of place is still a value
                j = _mask_escaped_value(out, s, j, level, counter)
                if j < 0:
                    return -1
                continue
            out.append(s[j:colon + 1])
            j = colon + 1
            while j < len(s) and s[j] in _JSON_SPACE:
                out.append(s[j])
                j += 1
            j = _mask_escaped_value(out, s, j, level, counter)
            if j < 0:
                return -1
            continue
        if c == "," or c in _JSON_SPACE:
            out.append(c)
        j += 1
    return -1


def _strip_escaped_secret_json(doc: str, level: int) -> Tuple[str, int]:
    """_strip_secret_json for JSON whose quotes each come after level backslashes."""
    out: list = []
    counter = [0]
    pos = 0
    while True:
        m = _ESCAPED_SECRET_FIELD.search(doc, pos)
        if not m:
            out.append(doc[pos:])
            return "".join(out), counter[0]
        out.append(doc[pos:m.end()])
        before = 0
        while m.start() - before - 1 >= pos and doc[m.start() - before - 1] == "\\":
            before += 1
        pos = m.end()
        if before != level or len(m.group(2)) != level:
            continue
        if m.group(1) != _LAST_APPLIED_NAME and pos < len(doc) and doc[pos] == "{":
            end = _mask_escaped_object(out, doc, pos, level, counter)
        else:
            end = _mask_escaped_value(out, doc, pos, level, counter)
        if end < 0:
            return "".join(out), counter[0]
        pos = end


def _flow_string_end(s: str, i: int) -> int:
    """The index after the quoted string at s[i], -1 if s ends first: a backslash escapes in double quotes, a doubled quote in
    single ones."""
    q = s[i]
    j = i + 1
    while j < len(s):
        if q == '"' and s[j] == "\\":
            j += 2
            continue
        if s[j] == q:
            if q == "'" and j + 1 < len(s) and s[j + 1] == q:
                j += 2
                continue
            return j + 1
        j += 1
    return -1


def _flow_value_end(s: str, i: int) -> int:
    """The index after the value at s[i], -1 if s ends inside quotes or brackets."""
    if i >= len(s):
        return -1
    if s[i] in "\"'":
        return _flow_string_end(s, i)
    if s[i] in "{[":
        depth = 0
        j = i
        while j < len(s):
            c = s[j]
            if c in "\"'":
                end = _flow_string_end(s, j)
                if end < 0:
                    return -1
                j = end
                continue
            if c in "{[":
                depth += 1
            elif c in "}]":
                depth -= 1
                if depth == 0:
                    return j + 1
            j += 1
        return -1
    j = i
    while j < len(s) and s[j] not in ",}]\r\n":
        j += 1
    return j


def _flow_key_end(s: str, i: int) -> Optional[int]:
    """Where the value of the key at s[i] starts, None if what is there is a value out of place and not a key."""
    j = i
    if s[i] in "\"'":
        j = _flow_string_end(s, i)
        if j < 0:
            return None
    else:
        while j < len(s) and s[j] not in ",}\r\n":
            if s[j] == ":" and (j + 1 == len(s) or s[j + 1] in " \t\r\n,}"):
                break
            j += 1
    while j < len(s) and s[j] in " \t":
        j += 1
    if j >= len(s) or s[j] != ":":
        return None
    j += 1
    while j < len(s) and s[j] in " \t":
        j += 1
    return j


def _mask_flow_value(out: list, s: str, i: int, counter: list) -> int:
    """Write the placeholder for the value at s[i]; the index after it, -1 if s ends first. An empty value stays."""
    if i >= len(s):
        return -1
    end = _flow_value_end(s, i)
    value = s[i:] if end < 0 else s[i:end]
    quote = value[:1] if value[:1] in ('"', "'") else ""
    bare = value.strip(" \t\r\n")
    if end >= 0 and (bare in ("", "{}", "[]", "null", "~", '""', "''") or bare.lstrip("\"'").startswith("<REDACTED")):
        out.append(value)
        return end
    out.append(quote + _SECRET_PLACEHOLDER + quote)
    counter[0] += 1
    return end


def _mask_flow_object(out: list, s: str, i: int, counter: list) -> int:
    """Write the mapping at s[i] with each value masked; the index after it, -1 if s ends first."""
    out.append("{")
    j = i + 1
    while j < len(s):
        c = s[j]
        if c == "}":
            out.append("}")
            return j + 1
        if c == "," or c in _JSON_SPACE:
            out.append(c)
            j += 1
            continue
        value = _flow_key_end(s, j)
        if value is not None:
            out.append(s[j:value])
            j = value
        j = _mask_flow_value(out, s, j, counter)
        if j < 0:
            return -1
    return -1


def _strip_secret_flow(doc: str) -> Tuple[str, int]:
    """Mask the values of a Secret written in YAML's flow style. Like _strip_secret_json it scans, since the text may be cut
    or hold other text around the object. Key names stay; a value keeps its quote; what is already a placeholder stays too."""
    out: list = []
    counter = [0]
    pos = 0
    while True:
        m = _FLOW_SECRET_FIELD.search(doc, pos)
        if not m:
            out.append(doc[pos:])
            return "".join(out), counter[0]
        out.append(doc[pos:m.end()])
        at = m.end()
        if m.group(1) != _LAST_APPLIED_NAME and at < len(doc) and doc[at] == "{":
            end = _mask_flow_object(out, doc, at, counter)
        else:
            end = _mask_flow_value(out, doc, at, counter)
        if end < 0:
            return "".join(out), counter[0]
        pos = end


def strip_secret_text(text: str) -> Tuple[str, int]:
    """Strip text known to hold a Secret, also when nothing in it says so: a text cut short may end before its kind."""
    docs = text.split("\n---")
    total = 0
    for i, doc in enumerate(docs):
        out, n = _strip_secret_yaml(doc)
        out, m = _strip_secret_json(out)
        docs[i], total = out, total + n + m
    return "\n---".join(docs), total


def _strip_secret_documents(text: str) -> Tuple[str, int]:
    docs = text.split("\n---")
    total = 0
    for i, doc in enumerate(docs):
        if "Secret" not in doc:
            continue
        if _names_secret_yaml(doc):
            docs[i], n = _strip_secret_yaml(doc)
            total += n
        if _SECRET_JSON_KIND.search(docs[i]):
            docs[i], n = _strip_secret_json(docs[i])
            total += n
        if _SECRET_FLOW_KIND.search(docs[i]):
            docs[i], n = _strip_secret_flow(docs[i])
            total += n
        for level in _escaped_secret_levels(docs[i]):
            docs[i], n = _strip_escaped_secret_json(docs[i], level)
            total += n
    return "\n---".join(docs), total


# --- public API -------------------------------------------------------------------

def redact_text(text: Optional[str], opts: Optional[Options] = None, numbers: Optional[Numbers] = None) -> Tuple[str, Stats]:
    """Redact free text (logs, YAML, JSON, describe output). With Options.numbered, personal data is numbered with
    ``numbers`` (one run's table), without it from 1 for this text; with numbered off ``numbers`` is not read."""
    stats = Stats()
    if not text:
        return text or "", stats
    o = opts or from_env()
    if _names_secret(text):
        text, n = _strip_secret_documents(text)
        stats.add("secret", n)
    if not o.enabled:
        return text, stats
    # Each rule first looks for what it cannot match without: most text goes through none of them.
    if o.on("private_key") and "PRIVATE KEY" in text:
        text = _sub_count(_PRIVATE_KEY, text, lambda m: "<REDACTED:private_key>", stats, "private_key")
    if o.on("url_credentials") and "://" in text and "@" in text:
        text = _sub_count(_URL_CREDENTIALS, text, lambda m: m.group(1) + "<REDACTED:password>" + m.group(2), stats, "url_credentials")
    if o.on("authorization") and _may_read_fold(text, "bearer", "basic"):
        text = _sub_count(_AUTHORIZATION, text, lambda m: m.group(1) + " <REDACTED:token>", stats, "authorization")
    if o.on("jwt") and "eyJ" in text:
        text = _sub_count(_JWT, text, lambda m: "<REDACTED:jwt>", stats, "jwt")
    if o.on("aws_key"):
        if "AKIA" in text or "ASIA" in text:
            text = _sub_count(_AWS_ACCESS_KEY, text, lambda m: "<REDACTED:aws_access_key>", stats, "aws_key")
        if _may_read_fold(text, "aws_secret_access_key"):
            text = _sub_count(_AWS_SECRET_VALUE, text, lambda m: m.group(1) + "<REDACTED:aws_secret_key>", stats, "aws_key")
    if o.on("provider_key"):
        if any(prefix in text for prefix in _PROVIDER_PREFIXES):
            text = _sub_count(_PROVIDER_KEY, text, _provider_key, stats, "provider_key")
        for value in sorted(_REMEMBERED, key=len, reverse=True):
            if value in text:
                stats.add("provider_key", text.count(value))
                text = text.replace(value, "<REDACTED:api_key>")
    if o.on("key_name") and _holds_credential_word(text):
        def _pair(m: re.Match) -> str:
            key, value = m.group(2), m.group(4)
            if not _key_is_sensitive(key) or _value_stays(key, value):
                return m.group(0)
            return m.group(1) + key + m.group(3) + "<REDACTED:" + key + ">" + m.group(5)

        def _env_json(m: re.Match) -> str:
            if not _key_is_sensitive(m.group(2)) or _value_stays(m.group(2), m.group(3)):
                return m.group(0)
            return m.group(1) + "<REDACTED:" + m.group(2) + ">" + m.group(4)

        def _line(m: re.Match) -> str:
            key, value = m.group(2), m.group(4)
            if not _key_is_sensitive(key) or _value_stays(key, value) or _left_to_the_word_rule(key, m.group(0)):
                return m.group(0)
            return m.group(1) + m.group(3) + "<REDACTED:" + key + ">" + m.group(5)

        def _env_yaml(m: re.Match) -> str:
            if not _key_is_sensitive(m.group(2)) or _value_stays(m.group(2), m.group(4)):
                return m.group(0)
            return m.group(1) + m.group(3) + "<REDACTED:" + m.group(2) + ">" + m.group(5)

        text = _mask_block_values(text, stats)
        text = _mask_list_values(text, stats)
        text = _mask_json_lists(text, stats)
        text = _sub_count(_JSON_PAIR, text, _pair, stats, "key_name")
        if '"name"' in text:
            text = _sub_count(_ENV_LIST_JSON, text, _env_json, stats, "key_name")
        text = _sub_on_credential_lines(_KEY_VALUE_LINE, text, _line, stats, "key_name")
        if "name:" in text and "value:" in text:
            text = _sub_count(_ENV_LIST_YAML, text, _env_yaml, stats, "key_name")
        text = _sub_on_credential_lines(_INLINE_QUOTED, text, _mask_inline_quoted, stats, "key_name")
        text = _sub_on_credential_lines(_INLINE_PAIR, text, _mask_inline_pair, stats, "key_name")
    if o.pii and not o.numbered:
        if o.on("email"):
            seen: Dict[str, int] = {}

            def _email(m: re.Match) -> str:
                seen.setdefault(m.group(0), len(seen) + 1)
                return "<EMAIL_%d>" % seen[m.group(0)]

            text = _sub_count(_EMAIL, text, _email, stats, "email")
        if o.on("rrn"):
            text = _sub_count(_KR_RRN, text, lambda m: "<REDACTED:rrn>", stats, "rrn")
        if o.on("card"):
            text = _sub_count(_CARD, text, lambda m: "<REDACTED:card>", stats, "card")
        if o.on("phone"):
            text = _sub_count(_KR_PHONE, text, lambda m: "<REDACTED:phone>", stats, "phone")
    elif o.pii:
        n = numbers if numbers is not None else Numbers(key="")
        n.hold(text)
        for kind, pattern in (("email", _EMAIL), ("rrn", _KR_RRN), ("card", _CARD), ("phone", _KR_PHONE)):
            if o.on(kind):
                text = _sub_count(pattern, text, lambda m, kind=kind: n.placeholder(kind, m.group(0)), stats, kind)
    return text, stats


def _mask_secret_fields(value: dict, stats: Stats) -> None:
    """Mask what one mapping under a Secret holds of its values."""
    for f in _SECRET_VALUE_FIELDS:
        inner = value.get(f)
        if isinstance(inner, dict):
            for k in list(inner.keys()):
                inner[k] = _SECRET_PLACEHOLDER
                stats.add("secret", 1)
        elif inner is not None:
            value[f] = _SECRET_PLACEHOLDER
            stats.add("secret", 1)
    # metadata.annotations of an object, or annotations at the top of a describe answer
    anno = value.get("annotations")
    if isinstance(anno, dict) and _LAST_APPLIED_NAME in anno:
        anno[_LAST_APPLIED_NAME] = _SECRET_PLACEHOLDER
        stats.add("secret", 1)


def redact_object(value: Any, opts: Optional[Options] = None, _secret: bool = False, _stats: Optional[Stats] = None,
                  numbers: Optional[Numbers] = None) -> Tuple[Any, Stats]:
    """Redact a decoded JSON/YAML value in place: credential-looking keys lose
    their values, a container env entry's value follows its name, every string
    goes through redact_text, and a mapping with kind: Secret (or an item
    without a kind in a SecretList) loses data/stringData wherever they sit
    under it, with the last-applied annotation of any annotations under it. ``numbers`` is passed to redact_text."""
    stats = _stats if _stats is not None else Stats()
    o = opts or from_env()
    if isinstance(value, dict):
        secret = _secret or value.get("kind") == "Secret"
        secret_list = value.get("kind") == "SecretList"
        skip = set()
        if secret:
            _mask_secret_fields(value, stats)
            skip.update(_SECRET_VALUE_FIELDS)
            # a page snapshot may carry the YAML text next to the object
            if isinstance(value.get("yaml"), str):
                value["yaml"], n = strip_secret_text(value["yaml"])
                stats.add("secret", n)
                skip.add("yaml")
        env_name = value.get("name")  # the key is "value", so the name decides
        for k, v in list(value.items()):
            if k in skip:
                continue
            if o.on("key_name") and _holds_credential(k, v):
                value[k] = "<REDACTED:" + k + ">"
                stats.add("key_name", 1)
                continue
            if k == "value" and isinstance(env_name, str) and o.on("key_name") and _holds_credential(env_name, v):
                value[k] = "<REDACTED:" + env_name + ">"
                stats.add("key_name", 1)
                continue
            if isinstance(v, list) and o.on("key_name") and _key_is_sensitive(k):
                for i, item in enumerate(v):
                    if _holds_credential(k, item):
                        v[i] = "<REDACTED:" + k + ">"
                        stats.add("key_name", 1)
            if secret_list and k == "items" and isinstance(v, list):
                # A typed list's items carry no kind of their own; kubectl reads them as the list's (apimachinery decodeToList).
                for i, item in enumerate(v):
                    own_kind = isinstance(item, dict) and isinstance(item.get("kind"), str) and item["kind"] != ""
                    v[i], _ = redact_object(item, o, secret or (isinstance(item, dict) and not own_kind), stats, numbers)
                continue
            value[k], _ = redact_object(v, o, secret, stats, numbers)
        return value, stats
    if isinstance(value, list):
        for i, v in enumerate(value):
            value[i], _ = redact_object(v, o, _secret, stats, numbers)
        return value, stats
    if isinstance(value, str):
        out, s = redact_text(value, o, numbers)
        stats.merge(s)
        return out, stats
    return value, stats


# --- command lines --------------------------------------------------------------

# Go's twin is services/pkg/redact/command.go, for a terminal's row; both run the "commands" of redact_shape_cases.json. The
# key-name rule above reads whole lines, so it misses a credential among the words of a command (sh -c "mysql --password=x",
# env TOKEN=x app). ASCII as in Go, with the arguments' separator named, since ASCII \s leaves it out.

_ARG_SEP = "\x1f"  # joins a command's arguments for the rules below, which read it as a space
_WORD = r"""("[^"\x1f]*"|'[^'\x1f]*'|[^\s"',;|&)\]\x1f]+)"""
_CREDENTIAL_WORD = r"(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|dsn|connection[_-]?string|pgpass|[_.\-]pass)"
_WORD_ASSIGN = re.compile(r"""(--from-file=["']?|^|[^\w.\-])(-{0,2}[\w.\-]*""" + _CREDENTIAL_WORD + r"[\w.\-]*)([ \t]*[=:][ \t]*)" + _WORD, re.I | re.A)
_WORD_FLAG = re.compile(r"(^|[^\w.\-])(--?[\w.\-]*" + _CREDENTIAL_WORD + r"[\w.\-]*)([\s\x1f]+)" + _WORD, re.I | re.A)
# What holds a credential by its place, not its name: -p is a port or a path outside these programs, and a header's whole
# value is the credential, a scheme word included.
_PLACED_CREDENTIALS = [
    re.compile(r"(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^|;&\n]{0,500}?[\s\x1f]-p)" + _WORD, re.A),
    re.compile(r"(\bsshpass\b[^|;&\n]{0,500}?[\s\x1f]-p[\s\x1f]*)" + _WORD, re.A),
    re.compile(r"(\bredis-cli\b[^|;&\n]{0,500}?[\s\x1f]-a[\s\x1f]+)" + _WORD, re.A),
    re.compile(r"([\s\x1f](?:-u|--user)[\s=\x1f]+[^\s:\x1f]+:)" + _WORD, re.A),
    re.compile(r"(\b(?:proxy-authorization|authorization|set-cookie|cookie)[ \t]*:[ \t]*)([^\x1f\n\"']+)", re.I | re.A),
]
_SHELL_REFERENCE = re.compile(r"""^["']?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?["']?$""")
_NOT_A_VALUE = _HARMLESS | {"null", "~", "[]", "{}", "|", ">", "|-", ">-"}


def word_key_is_sensitive(key: str) -> bool:
    """A flag or variable named like a credential: PGPASSWORD or --db-token, but not --password-file or --token-ttl."""
    k = key.lstrip("-")
    return _key_is_sensitive(k) or _normalize_key(k).endswith(("password", "passwd", "secret", "token"))


def redact_words(text: str) -> str:
    """Mask the credentials among the words of a command line. A value that names a shell variable is not one."""

    def _value(m: re.Match) -> str:
        before, key, value = m.group(1), m.group(2), m.group(4)
        if not word_key_is_sensitive(key) or _SHELL_REFERENCE.match(value) or value.startswith(("<REDACTED", "-")) or value.lower() in _NOT_A_VALUE:
            return m.group(0)
        if is_working_directory(key, value.strip("\"'")) or _file_after_a_key(before, value):
            return m.group(0)
        return before + key + m.group(3) + "<REDACTED:" + key.lstrip("-") + ">"

    text = _WORD_ASSIGN.sub(_value, text)
    text = _WORD_FLAG.sub(_value, text)
    for rule in _PLACED_CREDENTIALS:
        text = rule.sub(lambda m: m.group(1) + "<REDACTED:password>", text)
    return text


def redact_command(argv: list, opts: Optional[Options] = None) -> list:
    """Mask a command's arguments one for one: each through the text rules, then the words of all of them together, so
    a flag's value may be the next argument."""
    masked = [redact_text(a, opts)[0].replace(_ARG_SEP, " ") for a in argv]
    return redact_words(_ARG_SEP.join(masked)).split(_ARG_SEP)
