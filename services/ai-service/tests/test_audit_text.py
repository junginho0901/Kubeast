"""A row is stored whatever text it holds. The cases are shared with services/pkg/audit (TestSharedAuditTextCases), so
the two make the same text of the same row. PostgreSQL is stood in by a connection that refuses what it refuses;
test_audit_text_postgres.py asks a real one."""
import json
import random
import re
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import DBAPIError

import app.database
from app.services import audit_writer
from app.services.audit_text import INDEXED_MAX, cut_text, refused_for_its_text, storable_json, storable_text

CASES = json.loads((Path(__file__).parent / "fixtures" / "audit_text_cases.json").read_text())
FFFD = chr(0xFFFD)
HALF = chr(0xD800)
NUL = chr(0)


@pytest.mark.parametrize("case", CASES["text"], ids=lambda c: c["name"])
def test_text(case):
    assert storable_text(bytes.fromhex(case["hex"]).decode(errors="surrogateescape")) == case["want"]


@pytest.mark.parametrize("case", CASES["indexed"], ids=lambda c: c["name"])
def test_indexed_text(case):
    assert cut_text(storable_text(case["text"] * case["times"])) == case["text"] * case["chars"]


@pytest.mark.parametrize("case", CASES["json"], ids=lambda c: c["name"])
def test_json(case):
    stored = storable_json(json.loads(case["input"]))
    assert json.loads(stored) == json.loads(case["want"])
    assert jsonb_refusal(stored) is None


def jsonb_refusal(text):
    """The SQLSTATE PostgreSQL refuses a JSON text with, written from its documentation."""
    if text_refusal(text):
        return text_refusal(text)
    try:
        json.loads(text, parse_constant=lambda name: (_ for _ in ()).throw(ValueError(name)))
    except ValueError:
        return "22P02"
    escapes = re.findall(r"\\(?:u([0-9a-fA-F]{4})|.)", text)
    return "22P05" if any(e.lower() == "0000" for e in escapes) else "22P02" if any(e.lower().startswith("d") and e[1] in "89abcdefABCDEF" for e in escapes if e) else None


def text_refusal(text):
    try:
        return "22021" if 0 in text.encode() else None
    except UnicodeEncodeError:
        return "22000"  # asyncpg's own answer


def _random_text(r, n):
    kinds = [(1, 0x1F), (0x20, 0x7E), (0x20, 0x7E), (0x80, 0x7FF), (0x800, 0xD7FF), (0xE000, 0xFFFF), (0x10000, 0x10FFFF)]
    return "".join(chr(r.randint(*r.choice(kinds))) for _ in range(r.randint(0, n)))


def _random_value(r, depth):
    kind = r.randint(0, 7 if depth else 5)
    if kind == 6:
        return [_random_value(r, depth - 1) for _ in range(r.randint(0, 4))]
    if kind == 7:
        return {_random_text(r, 8): _random_value(r, depth - 1) for _ in range(r.randint(0, 4))}
    return [None, True, r.randint(-(10**30), 10**30), r.gauss(0, 1) * 1e30, _random_text(r, 20), _random_text(r, 20)][kind]


def test_what_the_table_took_before_it_holds_byte_for_byte():
    r = random.Random(1)
    for _ in range(5000):
        text = _random_text(r, 60)
        assert text_refusal(text) is None and cut_text(storable_text(text)) == text
        value = _random_value(r, 3)
        before = json.dumps(value, ensure_ascii=False, default=str)
        assert jsonb_refusal(before) is None and storable_json(value) == before
        assert storable_json(value, separators=(",", ":")) == json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))
    assert cut_text("x" * INDEXED_MAX) == "x" * INDEXED_MAX


def test_any_text_is_made_one_the_table_takes():
    r = random.Random(2)
    pieces = [NUL, HALF, chr(0xDFFF), chr(0xDCFF), "\\", "\\u0000", "\\ud800", '"', "a", "파", "{", "}", ":", chr(0x1F600)]
    for _ in range(20000):
        text = "".join(r.choices(pieces, k=r.randint(0, 11)))
        assert text_refusal(storable_text(text)) is None
        stored = storable_json({text: [text, {"v": text}]})
        assert jsonb_refusal(stored) is None, stored


@pytest.mark.parametrize("value,want", [
    (float("inf"), "Infinity"), (float("-inf"), "-Infinity"), (float("nan"), "NaN"), (1e308, 1e308), (10**400, 10**400),
])
def test_a_number_json_does_not_have_is_its_name(value, want):
    stored = storable_json({"replicas": value, "text": NUL})
    assert json.loads(stored) == {"replicas": want, "text": FFFD} and jsonb_refusal(stored) is None


@pytest.mark.parametrize("value,want", [(3, "3"), (["a", 1], '["a", 1]'), ({"name": "a"}, '{"name": "a"}'), (True, "true"), ([HALF], '["' + FFFD + '"]')])
def test_a_value_that_is_not_text_is_its_json(value, want):
    assert storable_text(value) == want


class RefusedText(Exception):
    def __init__(self, sqlstate):
        super().__init__(f"refused: {sqlstate}")
        self.sqlstate = sqlstate


def refusal(sqlstate):
    return DBAPIError("INSERT", {}, RefusedText(sqlstate))


class Table:
    """The connection a row is inserted through, refusing the text PostgreSQL refuses."""

    def __init__(self):
        self.rows = []
        self.probes = 0
        self.answer = None  # what every insert is refused with
        self.selects = 0

    async def execute(self, statement, params=None):
        if statement.text == "SELECT 1":
            self.selects += 1
            return
        if self.answer is not None:
            raise self.answer
        if params is None:
            self.probes += 1
            return
        for name, value in params.items():
            if value is None:
                continue
            assert isinstance(value, str), f"{name} is not text: {value!r}"
            code = jsonb_refusal(value) if name == "after" else text_refusal(value)
            if code is None and name in ("service", "action", "actor_user_id", "target_id") and len(value.encode()) > 2704 - 12:
                code = "54000"
            if code:
                raise refusal(code)
        self.rows.append(dict(params))

    async def rollback(self):
        pass

    def begin(self):
        return self

    connect = begin

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def table(monkeypatch):
    table = Table()

    async def db():
        return SimpleNamespace(database_url="postgresql+asyncpg://stand-in", engine=table)

    monkeypatch.setenv("AUDIT_FAIL_CLOSED", "true")
    monkeypatch.setenv("AUDIT_STDOUT", "true")
    monkeypatch.setattr(app.database, "get_db_service", db)
    monkeypatch.setattr(audit_writer, "_write_broken", False)
    monkeypatch.setattr(audit_writer, "_write_doubt", False)
    monkeypatch.setattr(audit_writer, "write_failures", 0)
    monkeypatch.setattr(audit_writer, "_ready_cache", {"at": 0.0, "ok": True, "error": None})
    return table


FIELDS = ("actor_user_id", "actor_email", "target_type", "target_id", "namespace", "request_ip", "user_agent", "request_id", "path", "cluster", "error")
TEXTS = {
    "a byte that is not UTF-8": chr(0xDCFF),
    "0x00": NUL,
    "half a pair": HALF,
    "a long text": "x" * 4000,
    "an empty value": "",
}


@pytest.mark.parametrize("field", FIELDS)
@pytest.mark.parametrize("name", TEXTS)
async def test_a_row_is_stored_whatever_a_caller_sends(table, capsys, field, name):
    assert await audit_writer.write_audit(**{"action": "ai.tool.call", field: "a" + TEXTS[name] + "b"}) is True
    row = table.rows[0]
    assert row["action"] == "ai.tool.call" and row[field].startswith("a")
    line = json.loads(capsys.readouterr().out)
    assert line["audit"][field] == row[field], "the mirror prints what the row holds"


@pytest.mark.parametrize("after", [
    {"input": {"args": [{"v": "a" + NUL}]}}, {"v" + NUL: 1}, {"v": HALF}, {HALF: "x"}, {"v": chr(0xDCFF)}, {"replicas": float("inf")},
    {"replicas": float("nan"), "v": NUL}, {}, None,
])
async def test_a_row_is_stored_whatever_its_payload_holds(table, capsys, after):
    assert await audit_writer.write_audit(action="ai.tool.call", after=after) is True
    stored = json.loads(table.rows[0]["after"])
    line = json.loads(capsys.readouterr().out)["audit"]
    assert line.get("after", {}) == stored


@pytest.mark.parametrize("field", ("target_id", "target_type", "namespace"))
@pytest.mark.parametrize("value", [3, ["web"], {"name": "web"}])
async def test_a_row_is_stored_when_a_models_argument_is_not_text(table, capsys, field, value):
    assert await audit_writer.write_audit(**{"action": "ai.tool.call", field: value}) is True
    assert table.rows[0][field] == json.dumps(value)
    capsys.readouterr()


async def test_an_ordinary_row_and_its_line_are_what_they_were(table, capsys):
    fields = {f: f"{f} 파드 é" for f in FIELDS}
    after = {"session_id": "s-1", "n": 1, "f": 0.5, "list": ["a", None, True], "nested": {"k": "v"}, "when": time.gmtime(0)}
    assert await audit_writer.write_audit(action="ai.chat.send", after=after, result="failure", **fields) is True
    assert table.rows == [{"service": "ai", "action": "ai.chat.send", "result": "failure", **fields,
                           "after": json.dumps(after, ensure_ascii=False, default=str)}]
    line = capsys.readouterr().out
    head, _, audit = line.rstrip("\n").partition('"audit":{')
    assert head.endswith('"level":"INFO","msg":"audit","event":"audit",')
    want = {"service": "ai", "action": "ai.chat.send", "result": "failure", "error": fields["error"], "actor_user_id": fields["actor_user_id"],
            "actor_email": fields["actor_email"], "target_type": fields["target_type"], "target_id": fields["target_id"],
            "cluster": fields["cluster"], "namespace": fields["namespace"], "path": fields["path"], "request_ip": fields["request_ip"],
            "user_agent": fields["user_agent"], "request_id": fields["request_id"], "after": after}
    assert "{" + audit[:-1] == json.dumps(want, ensure_ascii=False, default=str, separators=(",", ":"))


async def test_a_row_in_the_callers_transaction_is_stored_too(table, capsys):
    record = {"action": "ai.tool.interrupt", "target_id": NUL + "t" * 3000, "after": {"v": HALF}}
    assert await audit_writer.write_audit(**record, conn=table) is True
    assert capsys.readouterr().out == ""
    table.commit = table.rollback
    await audit_writer.commit_row(table, **record)
    line = json.loads(capsys.readouterr().out)["audit"]
    assert line["target_id"] == table.rows[0]["target_id"] == "t" * INDEXED_MAX and line["after"] == {"v": FFFD}


@pytest.mark.parametrize("sqlstate", ["22021", "22P02", "22P05", "22001", "22000", "54000", "54001"])
async def test_a_row_refused_for_its_text_refuses_nobody(table, capsys, caplog, sqlstate):
    assert await audit_writer.audit_ready() == (True, None)
    table.answer = refusal(sqlstate)
    for _ in range(3):
        assert await audit_writer.write_audit(action="ai.tool.call") is False
        assert await audit_writer.audit_ready() == (True, None)
    assert table.selects == 1 and table.probes == 0 and audit_writer._write_broken is False
    assert audit_writer.write_failures == 3
    assert caplog.text.count("audit row refused for its text (action=ai.tool.call") == 3

    table.answer = None
    audit_writer._ready_cache["at"] = 0.0  # the next check is due
    assert await audit_writer.audit_ready() == (True, None)
    audit_writer._ready_cache["at"] = 0.0
    assert await audit_writer.audit_ready() == (True, None)
    assert table.probes == 1, "the check after a refused row probes a write, the next one does not"

    table.answer = refusal(sqlstate)
    assert await audit_writer.write_audit(action="ai.tool.call") is False
    for _ in range(2):
        audit_writer._ready_cache["at"] = 0.0
        ok, error = await audit_writer.audit_ready()
        assert ok is False and sqlstate in error, "every row is refused, and an action may run"
    table.answer = None
    audit_writer._ready_cache["at"] = 0.0
    assert await audit_writer.audit_ready() == (True, None)
    capsys.readouterr()


async def test_a_landed_row_ends_the_doubt_of_a_refused_one(table, capsys):
    table.answer = refusal("22021")
    assert await audit_writer.write_audit(action="ai.tool.call") is False
    table.answer = None
    assert await audit_writer.write_audit(action="ai.tool.call") is True
    audit_writer._ready_cache["at"] = 0.0
    assert await audit_writer.audit_ready() == (True, None) and table.probes == 0
    capsys.readouterr()


@pytest.mark.parametrize("failure", [
    OSError("connection refused"), refusal("2200H"), refusal("22003"), refusal("53100"), refusal("55P03"), refusal("23514"),
    refusal("P0001"), refusal("57014"), refusal("42P01"), DBAPIError("INSERT", {}, OSError("22021")), RuntimeError("22021"),
], ids=str)
async def test_a_row_missing_for_any_other_reason_refuses_the_next_action(table, capsys, failure):
    assert await audit_writer.audit_ready() == (True, None)
    table.answer = failure
    assert await audit_writer.write_audit(action="ai.tool.call") is False
    with pytest.raises(audit_writer.AuditUnavailable):
        await audit_writer.require_audit_ready()
    table.answer = refusal("22021")
    assert await audit_writer.write_audit(action="ai.tool.call") is False
    assert (await audit_writer.audit_ready())[0] is False, "a row refused for its text let the next action run"
    table.answer = None
    audit_writer._ready_cache["at"] = 0.0
    assert await audit_writer.audit_ready() == (True, None) and table.probes == 1
    capsys.readouterr()


def test_the_codes_that_name_the_text():
    for code, text in {"22021": True, "22P05": True, "54000": True, "2200H": False, "22003": False, "23505": False, "": False, None: False}.items():
        assert refused_for_its_text(refusal(code)) is text, code
    assert refused_for_its_text(ValueError("22021")) is False
