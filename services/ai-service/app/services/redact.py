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

import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple


@dataclass
class Options:
    enabled: bool = True
    pii: bool = False
    disabled: set = field(default_factory=set)

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


def from_env() -> Options:
    """REDACTION_ENABLED (default true) / REDACTION_PII (default false) /
    REDACTION_DISABLE (comma list of rule names)."""
    enabled = os.getenv("REDACTION_ENABLED", "true").strip().lower() not in ("false", "0", "off")
    pii = os.getenv("REDACTION_PII", "false").strip().lower() in ("true", "1", "on")
    disabled = {x.strip().lower() for x in os.getenv("REDACTION_DISABLE", "").split(",") if x.strip()}
    return Options(enabled=enabled, pii=pii, disabled=disabled)


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


def _value_looks_harmless(v: str) -> bool:
    v = v.strip()
    if v in ("", "null", "~", "[]", "{}", "[", "{", "|", ">", "|-", ">-"):
        return True
    if v.startswith("<REDACTED") or v.startswith("<set to the key") or v.startswith("<EMAIL"):
        return True
    if v.lower() in _HARMLESS:
        return True
    return all(c.isdigit() or c in ".-msh" for c in v)


def _is_short_password(key: str) -> bool:
    k = _normalize_key(key.lstrip("-"))
    return bool(_SHORT_PASSWORD_KEY.search(k)) and (key == key.upper() or not _PASS_OF_A_RUN.search(k))


def _key_is_sensitive(key: str) -> bool:
    k = _normalize_key(key)
    return (bool(_SENSITIVE_KEY.search(k)) and not _NOT_SECRET_KEY.search(k)) or _is_short_password(key)


# The key's last word says the value itself is the credential, so a number there is one. Under password_expiry_days,
# token or secret a number may be a setting or a count, and hiding it would change what the reader is told.
_CREDENTIAL_LAST_WORD = re.compile(r"(^|_)[a-z0-9]*(password|passwd|pwd|api_?key|access_?key|secret_?key|private_?key|client_?secret)$|[a-z0-9]_pass$|(^|_)pgpass$")
# The shell's own variables, as the shell spells them: PWD=/app says where a process runs. DB_PWD=/x, and an ODBC
# connection string's Pwd=/x, are a password whatever they look like.
_WORKING_DIRECTORY_KEY = re.compile(r"^(PWD|OLDPWD|pwd|oldpwd)$")
_PATH_SHAPED = re.compile(r"^(~|\.{1,2})?(/[A-Za-z0-9._~\-]*)*$")


def is_working_directory(key: str, value: str) -> bool:
    return bool(_WORKING_DIRECTORY_KEY.match(key) and _PATH_SHAPED.match(value.strip()))


def _left_to_the_word_rule(key: str, line: str) -> bool:
    """KEY=word under a glued name stays with the rule for a line's words, as PGPASSWORD=x psql -h db has to: the command
    after the word is not the value. Whatever that rule cannot read as one word is masked to the end of the line."""
    if _SEPARATED_KEY.search(_normalize_key(key)):
        return False
    m = _INLINE_PAIR.search(line)
    if not m or m.group(2) != key:
        return False
    after = line[m.end():m.end() + 1]
    return after in ("", " ", "\t") or (after == "}" and m.group(4).startswith("${"))


def _value_stays(key: str, value: str) -> bool:
    """Whether a sensitive key's text value is left as it is."""
    if is_working_directory(key, value):
        return True
    if not _value_looks_harmless(value):
        return False
    v = value.strip()
    return not v or not all(c.isdigit() or c in ".-msh" for c in v) or not _CREDENTIAL_LAST_WORD.search(_normalize_key(key))


def _holds_credential(key: str, value: Any) -> bool:
    """Whether a decoded member's value is a credential by its key. true, false and null say nothing."""
    if not _key_is_sensitive(key):
        return False
    if isinstance(value, str):
        return not _value_stays(key, value)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return bool(_CREDENTIAL_LAST_WORD.search(_normalize_key(key)))


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

# A JSON string in text, plain or backslash-escaped as an annotation holds it.
_JSON_STRING_IN_TEXT = r'"(?:[^"\\\r\n]|\\[^\r\n])*"|\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"'
# "key": [...] in a line, up to its bracket or, in text cut short, the line's end. A list holding a mapping or a list does
# not match: those have their own keys.
_JSON_LIST_IN_TEXT = re.compile(
    r'(\\?")([A-Za-z0-9_.\-]+)(\\?"[ \t]*:[ \t]*\[)((?:' + _JSON_STRING_IN_TEXT + r'|[^\[\]{}"\\\r\n])*(?:"[^"\r\n]*)?)(\]|\r?$)', re.M
)
_JSON_LIST_ITEM = re.compile(_JSON_STRING_IN_TEXT + r'|"[^"\r\n]*$|[^ \t\r\n,"\\]+')
# A key whose list goes on below this line, quoted or at the line's start: in a sentence a word before a colon is not one.
# Then one item on a line of its own.
_JSON_LIST_OPENS = re.compile(r'(?:^[ \t]*(?:-[ \t]+)?"?|")([A-Za-z0-9_.\-]+)"?[ \t]*:[ \t]*\[[^\]\r\n]*\r?$')
_JSON_LIST_LINE = re.compile(r'^([ \t]*)(' + _JSON_STRING_IN_TEXT + r'|"[^"\r\n]*|[^ \t\r\n,"\\\[\]{}:]+)([ \t,\]}]*\r?)$')


def _mask_list_item(key: str, item: str, quote: str, stats: Stats) -> str:
    """Mask one item of a JSON list under a sensitive key, in the quote it came in, or quote if it had none."""
    value = item
    if item.startswith('\\"'):
        value, quote = item[2:].removesuffix('\\"'), '\\"'
    elif item.startswith('"'):
        value, quote = item[1:].removesuffix('"'), '"'
    if _value_stays(key, value):
        return item
    stats.add("key_name", 1)
    return quote + "<REDACTED:" + key + ">" + quote


def _mask_json_lists(text: str, stats: Stats) -> str:
    """Mask a sensitive key's JSON list held in one line of text, which a parser cannot read when the text is a log line or
    was cut short."""

    def _list(m: re.Match) -> str:
        key = m.group(2)
        if not _key_is_sensitive(key):
            return m.group(0)
        items = _JSON_LIST_ITEM.sub(lambda item: _mask_list_item(key, item.group(0), m.group(1), stats), m.group(4))
        return m.group(1) + key + m.group(3) + items + m.group(5)

    return _JSON_LIST_IN_TEXT.sub(_list, text)


def _mask_list_values(text: str, stats: Stats) -> str:
    """Replace each item of a sensitive key's list on the lines below it, which the line rules read as words with no key.
    An item that is a mapping has its own keys, and a count or a state stays as it does on the key's own line. A JSON list
    is read up to its first line that is not one item, so what follows a mapping in the same list stays."""
    if "\n" not in text:
        return text
    lines = text.split("\n")
    for i, line in enumerate(lines):
        opened = _JSON_LIST_OPENS.search(line)
        if opened and _key_is_sensitive(opened.group(1)):
            for j in range(i + 1, len(lines)):
                item = _JSON_LIST_LINE.match(lines[j])
                if not item:
                    break
                lines[j] = item.group(1) + _mask_list_item(opened.group(1), item.group(2), '"', stats) + item.group(3)
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
_INLINE_BEFORE = r"(^|[^A-Za-z0-9_.\-])"
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
    if not credential and all(c.isdigit() or c in ".-msh" for c in v):
        return True  # token=5, secret=3: a count or a duration
    # In capitals the key is an environment variable, which holds the value itself.
    if credential or key == key.upper() or not _INLINE_NAMES_AN_OBJECT.search(k) or not _NAME_SHAPED.match(v):
        return False
    return any(c in v for c in "-./") or not any(c.isdigit() for c in v)


def _mask_inline_pair(m: re.Match) -> str:
    key, value = m.group(2), m.group(4)
    if _inline_value_stays(key, value):
        return m.group(0)
    return m.group(1) + key + m.group(3) + "<REDACTED:" + key.lstrip("-") + ">"


def _mask_inline_quoted(m: re.Match) -> str:
    key, value = m.group(2), m.group(4)
    if _inline_value_stays(key, value):
        return m.group(0)
    quote = '\\"' if value.startswith("\\") else value[0]
    return m.group(1) + key + m.group(3) + quote + "<REDACTED:" + key.lstrip("-") + ">" + quote


# --- value-pattern rules --------------------------------------------------------

_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----")
_URL_CREDENTIALS = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*://[^:/\s@\"']+:)[^@\s\"']+(@)")
_AUTHORIZATION = re.compile(r"\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=\-]{16,})", re.I)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b")
_AWS_ACCESS_KEY = re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")
_AWS_SECRET_VALUE = re.compile(r'(aws_secret_access_key\s*[:=]\s*"?)([A-Za-z0-9/+=]{40})', re.I)
# API keys by their published prefixes (the gitleaks rule set), with looser lengths since an error message may cut a
# key short. A bare sk- run counts only with an upper-case letter and a digit, which a Kubernetes name never has.
_PROVIDER_KEY = re.compile(
    r"\b(?:sk-[A-Za-z0-9_\-]{20,}|AIza[A-Za-z0-9_\-]{35}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}"
    r"|xox[abposr]-[A-Za-z0-9\-]{10,}|hf_[A-Za-z0-9]{30,})"
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

_EMAIL = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
_KR_PHONE = re.compile(r"\b01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b")
_KR_RRN = re.compile(r"\b\d{6}[-\s]?[1-4]\d{6}\b")
_CARD = re.compile(r"\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b")


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


# --- Secret documents -----------------------------------------------------------

_SECRET_PLACEHOLDER = "<REDACTED:secret>"
_LAST_APPLIED_NAME = "kubectl.kubernetes.io/last-applied-configuration"
_LAST_APPLIED = _LAST_APPLIED_NAME + ":"
# A Secret's values: its own two fields and the describe answer's data_values.
_SECRET_VALUE_FIELDS = ("data", "stringData", "data_values")

# A chart may quote the kind or put spaces after the colon; kubectl prints `kind: Secret`.
_SECRET_YAML_KIND = re.compile(r"""^[ \t]*(?:-[ \t]+)?["']?kind["']?[ \t]*:[ \t]*["']?Secret["']?[ \t]*\r?$""", re.M)
# `"kind": "Secret"`, or kubectl's own words in a refused patch, whose JSON does not say what it patches.
_SECRET_JSON_KIND = re.compile(r'"kind"\s*:\s*"Secret"|\bKind=Secret\b')
# A field of a JSON Secret that holds its values, up to where the value starts.
_JSON_SECRET_FIELD = re.compile(r'"(data|stringData|data_values|kubectl\.kubernetes\.io/last-applied-configuration)"\s*:\s*')


def _names_secret_yaml(text: str) -> bool:
    return "kind: Secret" in text or bool(_SECRET_YAML_KIND.search(text))


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
    while True:
        m = _JSON_SECRET_FIELD.search(doc)
        if not m:
            out.append(doc)
            return "".join(out), counter[0]
        out.append(doc[:m.end()])
        at = m.end()
        if m.group(1) != _LAST_APPLIED_NAME and at < len(doc) and doc[at] == "{":
            end = _mask_json_object(out, doc, at, counter)
        else:
            end = _mask_json_value(out, doc, at, counter)
        if end < 0:
            return "".join(out), counter[0]
        doc = doc[end:]


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
        if _names_secret_yaml(doc):
            docs[i], n = _strip_secret_yaml(doc)
            total += n
        if _SECRET_JSON_KIND.search(docs[i]):
            docs[i], n = _strip_secret_json(docs[i])
            total += n
    return "\n---".join(docs), total


# --- public API -------------------------------------------------------------------

def redact_text(text: Optional[str], opts: Optional[Options] = None) -> Tuple[str, Stats]:
    """Redact free text (logs, YAML, JSON, describe output)."""
    stats = Stats()
    if not text:
        return text or "", stats
    o = opts or from_env()
    if _names_secret_yaml(text) or _SECRET_JSON_KIND.search(text):
        text, n = _strip_secret_documents(text)
        stats.add("secret", n)
    if not o.enabled:
        return text, stats
    if o.on("private_key"):
        text = _sub_count(_PRIVATE_KEY, text, lambda m: "<REDACTED:private_key>", stats, "private_key")
    if o.on("url_credentials"):
        text = _sub_count(_URL_CREDENTIALS, text, lambda m: m.group(1) + "<REDACTED:password>" + m.group(2), stats, "url_credentials")
    if o.on("authorization"):
        text = _sub_count(_AUTHORIZATION, text, lambda m: m.group(1) + " <REDACTED:token>", stats, "authorization")
    if o.on("jwt"):
        text = _sub_count(_JWT, text, lambda m: "<REDACTED:jwt>", stats, "jwt")
    if o.on("aws_key"):
        text = _sub_count(_AWS_ACCESS_KEY, text, lambda m: "<REDACTED:aws_access_key>", stats, "aws_key")
        text = _sub_count(_AWS_SECRET_VALUE, text, lambda m: m.group(1) + "<REDACTED:aws_secret_key>", stats, "aws_key")
    if o.on("provider_key"):
        text = _sub_count(_PROVIDER_KEY, text, _provider_key, stats, "provider_key")
        for value in sorted(_REMEMBERED, key=len, reverse=True):
            if value in text:
                stats.add("provider_key", text.count(value))
                text = text.replace(value, "<REDACTED:api_key>")
    if o.on("key_name"):
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
        text = _sub_count(_ENV_LIST_JSON, text, _env_json, stats, "key_name")
        text = _sub_count(_KEY_VALUE_LINE, text, _line, stats, "key_name")
        text = _sub_count(_ENV_LIST_YAML, text, _env_yaml, stats, "key_name")
        text = _sub_count(_INLINE_QUOTED, text, _mask_inline_quoted, stats, "key_name")
        text = _sub_count(_INLINE_PAIR, text, _mask_inline_pair, stats, "key_name")
    if o.pii:
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


def redact_object(value: Any, opts: Optional[Options] = None, _secret: bool = False, _stats: Optional[Stats] = None) -> Tuple[Any, Stats]:
    """Redact a decoded JSON/YAML value in place: credential-looking keys lose
    their values, a container env entry's value follows its name, every string
    goes through redact_text, and a mapping with kind: Secret loses
    data/stringData wherever they sit under it, with the last-applied annotation
    of any annotations under it."""
    stats = _stats if _stats is not None else Stats()
    o = opts or from_env()
    if isinstance(value, dict):
        secret = _secret or value.get("kind") == "Secret"
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
            value[k], _ = redact_object(v, o, secret, stats)
        return value, stats
    if isinstance(value, list):
        for i, v in enumerate(value):
            value[i], _ = redact_object(v, o, _secret, stats)
        return value, stats
    if isinstance(value, str):
        out, s = redact_text(value, o)
        stats.merge(s)
        return out, stats
    return value, stats


# --- command lines --------------------------------------------------------------

# No Go twin: only ai-service writes a command into an audit row. The key-name rule above reads whole lines, so it misses
# a credential among the words of a command (sh -c "mysql --password=x", env TOKEN=x app).

_ARG_SEP = "\x1f"  # joins a command's arguments for the rules below, which read it as a space
_WORD = r"""("[^"\x1f]*"|'[^'\x1f]*'|[^\s"',;|&)\]]+)"""
_CREDENTIAL_WORD = r"(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|dsn|connection[_-]?string|pgpass|[_.\-]pass)"
_WORD_ASSIGN = re.compile(r"(?<![\w.\-])(-{0,2}[\w.\-]*" + _CREDENTIAL_WORD + r"[\w.\-]*)([ \t]*[=:][ \t]*)" + _WORD, re.I)
_WORD_FLAG = re.compile(r"(?<![\w.\-])(--?[\w.\-]*" + _CREDENTIAL_WORD + r"[\w.\-]*)(\s+)" + _WORD, re.I)
# What holds a credential by its place, not its name: -p is a port or a path outside these programs, and a header's whole
# value is the credential, a scheme word included.
_PLACED_CREDENTIALS = [
    re.compile(r"(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^|;&\n]{0,500}?\s-p)" + _WORD),
    re.compile(r"(\bsshpass\b[^|;&\n]{0,500}?\s-p\s*)" + _WORD),
    re.compile(r"(\bredis-cli\b[^|;&\n]{0,500}?\s-a\s+)" + _WORD),
    re.compile(r"(\s(?:-u|--user)[\s=]+[^\s:]+:)" + _WORD),
    re.compile(r"(\b(?:proxy-authorization|authorization|set-cookie|cookie)[ \t]*:[ \t]*)([^\x1f\n\"']+)", re.I),
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
        key, value = m.group(1), m.group(3)
        if not word_key_is_sensitive(key) or _SHELL_REFERENCE.match(value) or value.startswith(("<REDACTED", "-")) or value.lower() in _NOT_A_VALUE:
            return m.group(0)
        if is_working_directory(key, value.strip("\"'")):
            return m.group(0)
        return m.group(1) + m.group(2) + "<REDACTED:" + key.lstrip("-") + ">"

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
