"""M10/M11/M12: an approval is bound to its user, cluster, tool and arguments,
moves out of pending exactly once, and is only offered for tools the model
was actually given and the user may run."""
import asyncio
import hashlib
from types import SimpleNamespace

import pytest

from app.services import approval_token
from app.services.ai import permissions


# The same vectors as tool-server's approval_token_test.go: both sides must
# hash identical bytes.
VECTORS = [
    ({"resource_type": "deployment", "resource_name": "web", "replicas": 2},
     '{"replicas":2,"resource_name":"web","resource_type":"deployment"}',
     "66f259749f66f4d457a0bb1b9a1e650ce524c6d875fd185484f4bd30e70bd666"),
    ({"b": [1, 2.5, True, None, "x"], "a": {"z": "한글 ✓", "y": "tab\tnl\n\"q\" \\ / <&>", "x": ""}},
     '{"a":{"x":"\\u007f\\u0001","y":"tab\\tnl\\n\\"q\\" \\\\ / <&>","z":"\\ud55c\\uae00 \\u2713"},"b":[1,2.5,true,null,"x"]}',
     "2651207b25ff51dd06da74e632752608090943669cc4e1da7940e7f667e1e692"),
    ({"emoji": "\U0001F600", "nested": {"k": [{"n": 10000000000000000000}, {"f": 1.0e3}]}},
     '{"emoji":"\\ud83d\\ude00","nested":{"k":[{"n":10000000000000000000},{"f":1000.0}]}}',
     "300b1be164fd2c1c3adbc826a9342e8dbe209c617384f61c85bd921c29c6e95b"),
    ({}, "{}", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"),
    ({"cluster": "dropped-by-both-sides", "name": "keep"}, '{"name":"keep"}',
     "5c4b303fb2e264840b3885c0b5ac6c6cbe97bcb910baa14e64513cef2ad7ecbb"),
]


def test_canonical_args_vectors():
    for args, want, sha in VECTORS:
        got = approval_token.canonical_args(args)
        assert got == want
        assert hashlib.sha256(got.encode()).hexdigest() == sha
        assert approval_token.args_digest(args) == sha


def test_sign_and_verify_bind_every_field(monkeypatch):
    monkeypatch.setenv("AI_APPROVAL_SECRET", "s3cret")
    args = {"resource_type": "deployment", "resource_name": "web", "replicas": 2}
    token = approval_token.sign("ap1", "u1", "prod", "k8s_scale", args)
    assert token.count(".") == 1
    assert approval_token.verify(token, "ap1", "u1", "prod", "k8s_scale", args)
    assert not approval_token.verify(token, "ap2", "u1", "prod", "k8s_scale", args)
    assert not approval_token.verify(token, "ap1", "u2", "prod", "k8s_scale", args)
    assert not approval_token.verify(token, "ap1", "u1", "dev", "k8s_scale", args)
    assert not approval_token.verify(token, "ap1", "u1", "prod", "k8s_delete_resource", args)
    assert not approval_token.verify(token, "ap1", "u1", "prod", "k8s_scale", {**args, "replicas": 50})
    monkeypatch.setenv("AI_APPROVAL_SECRET", "other")
    assert not approval_token.verify(token, "ap1", "u1", "prod", "k8s_scale", args)


def test_sign_without_secret_is_refused(monkeypatch):
    monkeypatch.delenv("AI_APPROVAL_SECRET", raising=False)
    with pytest.raises(approval_token.ApprovalTokenUnavailable):
        approval_token.sign("ap1", "u1", "prod", "k8s_scale", {})


@pytest.mark.asyncio
async def test_transition_wins_exactly_once(tmp_path):
    from app.database import DatabaseService, utcnow

    db = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/approvals.db")
    try:
        await db.init_db()
        session = await db.create_session("s1", user_id="u1", title="t")
        approval = await db.create_tool_approval(
            session_id=session.id, user_id="u1", user_email="u1@example.com", cluster="prod",
            tool="k8s_scale", args={"replicas": 2},
        )
        first, second = await asyncio.gather(
            db.transition_tool_approval(approval.id, "pending", status="approved", decided_at=utcnow()),
            db.transition_tool_approval(approval.id, "pending", status="approved", decided_at=utcnow()),
        )
        assert sorted([first is not None, second is not None]) == [False, True]
        assert (await db.get_tool_approval(approval.id)).status == "approved"
        # And the next hop only leaves "approved".
        assert await db.transition_tool_approval(approval.id, "pending", status="rejected") is None
        assert (await db.transition_tool_approval(approval.id, "approved", status="executed", result="ok")).status == "executed"
    finally:
        await db.engine.dispose()


def _svc(role="write", cluster="prod"):
    svc = SimpleNamespace(user_role=role, cluster_name=cluster, token=None)
    return svc


def _tools(*names):
    return [{"type": "function", "function": {"name": n}} for n in names]


def test_may_request_approval_needs_offer_and_permission():
    offered = _tools("k8s_get_resources", "k8s_scale")
    assert permissions.may_request_approval(_svc("write"), offered, "k8s_scale")
    # read-only widget: the write tool was never offered this turn
    assert not permissions.may_request_approval(_svc("write"), _tools("k8s_get_resources"), "k8s_scale")
    # offered but the user may not run it
    assert not permissions.may_request_approval(_svc("read"), offered, "k8s_scale")
    assert not permissions.may_request_approval(_svc("write"), offered, "k8s_execute_command")
    assert permissions.may_request_approval(_svc("admin"), _tools("k8s_execute_command"), "k8s_execute_command")
