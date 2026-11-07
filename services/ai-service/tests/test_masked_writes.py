"""What the assistant reads in place of a value is not that value. A write holding it would store those letters, so the
chat stops it before an approval card, whoever asks, and says why; tool-server stops the same calls before kubectl
(fixtures/masked_write_cases.json, read by both)."""
import copy
import json
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.database import utcnow
from app.security import TokenPayload
from app.services.ai import permissions

CASES = json.loads((Path(__file__).parent / "fixtures" / "masked_write_cases.json").read_text())["cases"]
EVERY_WRITE = ("ai.tool.*", "resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete", "resource.pod.exec")
CLUSTER = "alpha"


def _service(*extra):
    async def execute(name, args, ctx):
        service.executed.append((name, args))
        return "ran"

    token = TokenPayload(user_id="u1", role="member", email="u1@example.com", matrix={CLUSTER: (*EVERY_WRITE, *extra)})
    service = SimpleNamespace(token=token, user_role="read", cluster_name=CLUSTER, tool_server=SimpleNamespace(last_redacted=None),
                              executed=[], _execute_function_with_context=execute)
    return service


class _ApprovalDB:
    def __init__(self):
        self.approvals = []

    async def create_tool_approval(self, **kw):
        self.approvals.append(kw)
        return SimpleNamespace(id="ap1", cluster=kw["cluster"], expires_at=utcnow() + timedelta(minutes=10))


async def _chat_call(service, name, args):
    from app.services.ai import streaming

    db = _ApprovalDB()
    offered = [{"type": "function", "function": {"name": name}}]
    events, _entry, llm_text = await streaming._call_tool(
        service, db, SimpleNamespace(user_id="u1"), "s1", offered, None, name, copy.deepcopy(args),
        iteration=1, audit_actor={"user_id": "u1", "email": "u1@example.com"}, audit_http=None,
    )
    return SimpleNamespace(events=events, llm_text=llm_text, db=db)


@pytest.fixture
def rows(monkeypatch):
    from app.services import audit_writer

    out = []

    async def write(**kw):
        out.append(kw)
        return True

    async def ready():
        return True, None

    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setattr(audit_writer, "audit_ready", ready)
    return out


@pytest.mark.parametrize("case", [c for c in CASES if c["refused"]], ids=lambda c: c["name"])
@pytest.mark.parametrize("extra", [(), ("resource.secret.reveal",)], ids=["without reveal", "with reveal"])
async def test_a_write_holding_what_stands_for_a_value_gets_no_card_and_says_why(rows, case, extra):
    got = await _chat_call(_service(*extra), case["tool"], case["args"])
    assert got.db.approvals == [] and not any('"approval_required"' in e for e in got.events)
    answer = json.loads(got.llm_text)
    assert answer["status"] == "not_permitted"
    for word in ("placeholder", "k8s_patch_resource", "Nothing was changed", *case["refused"]):
        assert word in answer["message"]
    assert rows[-1]["action"] == "ai.tool.call" and rows[-1]["result"] == "failure"


@pytest.mark.parametrize("case", [c for c in CASES if not c["refused"]], ids=lambda c: c["name"])
async def test_a_write_with_values_of_its_own_gets_its_card(rows, case):
    got = await _chat_call(_service(), case["tool"], case["args"])
    assert len(got.db.approvals) == 1
    assert permissions.tool_refusal(_service(), case["tool"], case["args"]) is None


def test_a_read_naming_a_placeholder_is_no_write():
    assert permissions.tool_refusal(_service(), "k8s_describe_resource", {"resource_type": "secret", "note": "<REDACTED:secret>"}) is None


def test_arguments_that_are_not_an_object_say_nothing_of_a_placeholder():
    service = _service()
    assert permissions.tool_refusal(service, "k8s_patch_resource", "not an object") is None
