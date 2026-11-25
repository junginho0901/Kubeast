"""The text of an audit row as PostgreSQL takes it. A row is written after its action ran, so no text in it may keep it
out of the table: what the table refuses is made one it takes, and nothing else changes. Go's twin is
services/pkg/audit/storable.go; both run the cases of tests/fixtures/audit_text_cases.json."""
from __future__ import annotations

import json
import re
from typing import Any, Optional

# The most bytes of text an indexed column (service, action, actor_user_id, target_id) takes whatever they are:
# PostgreSQL's index entry is at most 2,704 bytes, 12 of them not the text's.
INDEXED_MAX = 2692

REPLACEMENT = chr(0xFFFD)
_SURROGATE = re.compile("[%s-%s]" % (chr(0xD800), chr(0xDFFF)))
# In the text json.dumps(ensure_ascii=False) writes, a backslash begins a two-character escape or a control character's.
_ESCAPE = re.compile(r"\\u0000|\\.", re.DOTALL)


def storable_text(value: Any) -> str:
    """value as a text column takes it: U+FFFD for each half of a pair of surrogates (what a byte that is not UTF-8
    decodes to with surrogateescape), 0x00 dropped. A value that is not text, as a model's arguments may hold, is
    written as its JSON."""
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, default=str)
    return _SURROGATE.sub(REPLACEMENT, value.replace(chr(0), ""))


def cut_text(value: str, limit: int = INDEXED_MAX) -> str:
    """The characters of value that fit in limit bytes."""
    data = value.encode()
    return value if len(data) <= limit else data[:limit].decode(errors="ignore")


def storable_json(value: Any, separators: Optional[tuple[str, str]] = None) -> str:
    """value as the JSON a JSONB column takes: U+FFFD for 0x00 (dropped, it could make two keys one) and for each half
    of a pair of surrogates, a number JSON does not have (NaN, Infinity) as its name."""
    try:
        text = json.dumps(value, ensure_ascii=False, default=str, separators=separators, allow_nan=False)
    except ValueError:
        named = json.loads(json.dumps(value, ensure_ascii=False, default=str), parse_constant=str)
        text = json.dumps(named, ensure_ascii=False, separators=separators)
    text = _ESCAPE.sub(lambda m: REPLACEMENT if m[0] == "\\u0000" else m[0], text)
    return _SURROGATE.sub(REPLACEMENT, text)


def refused_for_its_text(exc: BaseException) -> bool:
    """Whether PostgreSQL refused a row for what it holds (a data exception, or a value past a limit) rather than for
    the state of the table. 2200H and 22003 are what every row gets once its ids have run out."""
    code = getattr(getattr(exc, "orig", None), "sqlstate", None) or ""
    if code in ("2200H", "22003"):
        return False
    return code.startswith("22") or code in ("54000", "54001")
