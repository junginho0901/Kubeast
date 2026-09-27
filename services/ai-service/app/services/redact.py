"""Mask credentials (and optionally personal data) in text bound for the model.

Mirror of services/pkg/redact (Go): same rule families, same placeholders.
tool-server already redacts tool results; this module covers the inputs the
UI sends straight to ai-service (log analysis, resource explanation, the
floating widget's page snapshot). Keep the two rule lists in sync.

Secret objects are handled unconditionally: a document with ``kind: Secret``
loses every value under data/stringData and its last-applied annotation,
whether redaction is enabled or not.
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

# A credential word as a whole segment of the normalized (snake_case) key:
# db_password, clientSecret → client_secret, apiKey → api_key match;
# "tokenizer" or "max_tokens" do not.
_SENSITIVE_KEY = re.compile(
    r"(^|_)(password|passwd|pwd|secret|token|api_key|access_key|private_key|credentials?|client_secret|dsn|connection_string)(_|$)"
)
_NOT_SECRET_KEY = re.compile(
    r"(name|ref|url|uri|path|file|dir|ttl|length|count|min|max|timeout|mode|type|enabled|id|version|algorithm|alg|header|claim|issuer|audience|scope)s?$"
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
    if v in ("", "null", "~", "[]", "{}", "|", ">", "|-", ">-"):
        return True
    if v.startswith("<REDACTED") or v.startswith("<set to the key") or v.startswith("<EMAIL"):
        return True
    if v.lower() in _HARMLESS:
        return True
    return all(c.isdigit() or c in ".-msh" for c in v)


def _key_is_sensitive(key: str) -> bool:
    k = _normalize_key(key)
    return bool(_SENSITIVE_KEY.search(k)) and not _NOT_SECRET_KEY.search(k)


# --- value-pattern rules --------------------------------------------------------

_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----")
_URL_CREDENTIALS = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*://[^:/\s@\"']+:)[^@\s\"']+(@)")
_AUTHORIZATION = re.compile(r"\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=\-]{16,})", re.I)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b")
_AWS_ACCESS_KEY = re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")
_AWS_SECRET_VALUE = re.compile(r'(aws_secret_access_key\s*[:=]\s*"?)([A-Za-z0-9/+=]{40})', re.I)

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

_JSON_SECRET_DATA = re.compile(r'"(data|stringData)"\s*:\s*\{[^{}]*\}')
_JSON_LAST_APPLIED = re.compile(r'"kubectl\.kubernetes\.io/last-applied-configuration"\s*:\s*"(?:[^"\\]|\\.)*"')


def _strip_secret_yaml(doc: str) -> Tuple[str, int]:
    lines = doc.split("\n")
    n = 0
    in_block = in_anno = False
    for i, line in enumerate(lines):
        trim = line.strip()
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0 and trim:
            in_block = trim in ("data:", "stringData:")
            in_anno = False
            continue
        if in_block and indent > 0 and ":" in trim:
            lines[i] = " " * indent + trim.split(":", 1)[0] + ": <REDACTED:secret>"
            n += 1
            continue
        if in_block and indent > 0:
            lines[i] = ""
            continue
        if trim.startswith("annotations:"):
            in_anno = True
            continue
        if in_anno and trim.startswith("kubectl.kubernetes.io/last-applied-configuration:"):
            lines[i] = " " * indent + "kubectl.kubernetes.io/last-applied-configuration: <REDACTED:secret>"
            n += 1
            continue
        if in_anno and indent <= 2 and not trim.startswith("kubectl.kubernetes.io/"):
            in_anno = False
    return "\n".join(lines), n


def _strip_secret_json(doc: str) -> Tuple[str, int]:
    n = 0

    def _data(m: re.Match) -> str:
        nonlocal n
        n += 1
        return '"%s": {"<REDACTED>": "secret"}' % m.group(1)

    def _anno(_m: re.Match) -> str:
        nonlocal n
        n += 1
        return '"kubectl.kubernetes.io/last-applied-configuration": "<REDACTED:secret>"'

    doc = _JSON_SECRET_DATA.sub(_data, doc)
    doc = _JSON_LAST_APPLIED.sub(_anno, doc)
    return doc, n


def _strip_secret_documents(text: str) -> Tuple[str, int]:
    docs = text.split("\n---")
    total = 0
    for i, doc in enumerate(docs):
        if "kind: Secret" in doc:
            docs[i], n = _strip_secret_yaml(doc)
            total += n
        if '"kind": "Secret"' in docs[i] or '"kind":"Secret"' in docs[i]:
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
    if "kind: Secret" in text or '"kind": "Secret"' in text or '"kind":"Secret"' in text:
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
    if o.on("key_name"):
        def _pair(m: re.Match) -> str:
            key, value = m.group(2), m.group(4)
            if not _key_is_sensitive(key) or _value_looks_harmless(value):
                return m.group(0)
            return m.group(1) + key + m.group(3) + "<REDACTED:" + key + ">" + m.group(5)

        def _env_json(m: re.Match) -> str:
            if not _key_is_sensitive(m.group(2)) or _value_looks_harmless(m.group(3)):
                return m.group(0)
            return m.group(1) + "<REDACTED:" + m.group(2) + ">" + m.group(4)

        def _line(m: re.Match) -> str:
            key, value = m.group(2), m.group(4)
            if not _key_is_sensitive(key) or _value_looks_harmless(value):
                return m.group(0)
            return m.group(1) + m.group(3) + "<REDACTED:" + key + ">" + m.group(5)

        def _env_yaml(m: re.Match) -> str:
            if not _key_is_sensitive(m.group(2)) or _value_looks_harmless(m.group(4)):
                return m.group(0)
            return m.group(1) + m.group(3) + "<REDACTED:" + m.group(2) + ">" + m.group(5)

        text = _sub_count(_JSON_PAIR, text, _pair, stats, "key_name")
        text = _sub_count(_ENV_LIST_JSON, text, _env_json, stats, "key_name")
        text = _sub_count(_KEY_VALUE_LINE, text, _line, stats, "key_name")
        text = _sub_count(_ENV_LIST_YAML, text, _env_yaml, stats, "key_name")
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


def redact_object(value: Any, opts: Optional[Options] = None, _secret: bool = False, _stats: Optional[Stats] = None) -> Tuple[Any, Stats]:
    """Redact a decoded JSON/YAML value in place: credential-looking keys lose
    their string values, every string goes through redact_text, and a mapping
    with kind: Secret loses data/stringData entirely."""
    stats = _stats if _stats is not None else Stats()
    o = opts or from_env()
    if isinstance(value, dict):
        secret = _secret or value.get("kind") == "Secret"
        skip = {"data", "stringData"} if secret else set()
        if value.get("kind") == "Secret":
            for f in ("data", "stringData"):
                inner = value.get(f)
                if isinstance(inner, dict):
                    for k in list(inner.keys()):
                        inner[k] = "<REDACTED:secret>"
                        stats.add("secret", 1)
            anno = (value.get("metadata") or {}).get("annotations") if isinstance(value.get("metadata"), dict) else None
            if isinstance(anno, dict) and "kubectl.kubernetes.io/last-applied-configuration" in anno:
                anno["kubectl.kubernetes.io/last-applied-configuration"] = "<REDACTED:secret>"
                stats.add("secret", 1)
            # a page snapshot may carry the YAML text next to the object
            if isinstance(value.get("yaml"), str):
                value["yaml"], n = _strip_secret_documents(value["yaml"])
                stats.add("secret", n)
                skip.add("yaml")
        for k, v in list(value.items()):
            if k in skip:
                continue
            if isinstance(v, str) and o.on("key_name") and _key_is_sensitive(k) and not _value_looks_harmless(v):
                value[k] = "<REDACTED:" + k + ">"
                stats.add("key_name", 1)
                continue
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
