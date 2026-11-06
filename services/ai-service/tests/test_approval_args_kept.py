"""A write tool's arguments are needed until it runs: the card shows them and the run uses them. After that only a
masked copy is kept, in the approval row and the saved answer, with the same fields so the card still says what was asked."""
import copy
import json
from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.database import DatabaseService, utcnow
from app.services import audit_writer
from app.services.ai import permissions

FAKE = "fake-secret-value"

PATCH = {
    "resource_type": "deployment", "resource_name": "web", "namespace": "shop", "replicas": 2,
    "patch": {"spec": {"template": {"spec": {"containers": [{"name": "app", "image": "nginx:1.27", "env": [
        {"name": "DB_PASSWORD", "value": FAKE}, {"name": "LOG_LEVEL", "value": "debug"},
    ]}]}}}},
}
EXEC = {"pod_name": "web-0", "namespace": "shop", "command": ["sh", "-c", f"mysql --password={FAKE} -e 'select 1'"]}
MANIFEST = {"yaml_content": f"kind: ConfigMap\nmetadata:\n  name: web\ndata:\n  token: |\n    {FAKE}\n  color: blue\n"}
SECRET_PATCH = {"resource_type": "secret", "resource_name": "db", "namespace": "shop", "patch": {"data": {"host": FAKE}}}
JSON_PATCH = {"resource_type": "deployment", "resource_name": "web", "patch": [{"op": "add", "path": "/spec/template/spec/env/0/value", "value": FAKE}]}
PATCH_TEXT = {"resource_type": "deployment", "resource_name": "web", "patch": json.dumps({"spec": {"env": [{"name": "API_TOKEN", "value": FAKE}], "replicas": 4}})}

ARG_CASES = [
    ("k8s_patch_resource", PATCH, ["web", "shop", "nginx:1.27", "LOG_LEVEL", "debug", "DB_PASSWORD"]),
    ("k8s_execute_command", EXEC, ["web-0", "shop", "mysql", "select 1"]),
    ("k8s_apply_manifest", MANIFEST, ["ConfigMap", "web", "color: blue"]),
    ("k8s_patch_resource", SECRET_PATCH, ["db", "shop", "secret"]),
    ("k8s_patch_resource", JSON_PATCH, ["web", "/spec/template/spec/env/0/value"]),
    ("k8s_patch_resource", PATCH_TEXT, ["web", "API_TOKEN", "replicas"]),
]


@pytest.fixture(autouse=True)
def _ready(monkeypatch):
    async def ready():
        return None

    async def probe():
        return True, None

    async def write(**_kw):
        return True

    monkeypatch.setattr(audit_writer, "require_audit_ready", ready)
    monkeypatch.setattr(audit_writer, "audit_ready", probe)
    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setenv("AI_WRITE_APPROVAL", "true")
    monkeypatch.setattr("app.services.approval_token.sign", lambda *a, **k: "tok")


@pytest.fixture
async def db(tmp_path, monkeypatch):
    import app.database

    service = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/kept.db")
    await service.init_db()
    await service.create_session("s1", user_id="u1", title="t")

    async def get():
        return service

    monkeypatch.setattr(app.database, "get_db_service", get)
    yield service
    await service.engine.dispose()


def _api(monkeypatch, ran=None, answer="ok"):
    import app.api as api

    class Service:
        tool_server = SimpleNamespace(last_access=None, last_requests=None)

        async def _call_tool_server(self, tool, args, **_kw):
            if ran is not None:
                ran.append((tool, copy.deepcopy(args)))
            if isinstance(answer, Exception):
                raise answer
            return answer

    async def build(_authorization, cluster_name=None):
        return Service()

    monkeypatch.setattr(api, "_caller", lambda _auth: SimpleNamespace(user_id="u1"))
    monkeypatch.setattr(api, "_extract_audit_meta", lambda _request, _auth: ({"user_id": "u1", "email": "u1@example.com"}, {}))
    monkeypatch.setattr(api, "_build_ai_service", build)
    monkeypatch.setattr("app.services.ai.permissions.app_permission_error", lambda *a, **k: None)
    return api


async def _pending(db, tool, args, **fields):
    row = await db.create_tool_approval(session_id="s1", user_id="u1", user_email="u1@example.com", cluster="prod", tool=tool, args=copy.deepcopy(args))
    if fields:
        await db.update_tool_approval(row.id, **fields)
    return row


@pytest.mark.parametrize("tool,args,kept", ARG_CASES, ids=["env patch", "exec", "manifest", "secret patch", "json patch", "patch text"])
async def test_a_rejected_call_keeps_what_was_asked_without_the_credential(db, monkeypatch, tool, args, kept):
    api = _api(monkeypatch)
    row = await _pending(db, tool, args)
    answer = await api.reject_tool_approval(row.id, request=SimpleNamespace(), authorization="Bearer x")
    stored = json.dumps((await db.get_tool_approval(row.id)).args, ensure_ascii=False)
    assert FAKE not in stored and FAKE not in json.dumps(answer["args"], ensure_ascii=False)
    for word in kept:
        assert word in stored, word


async def test_the_run_uses_the_real_arguments_and_only_then_the_row_is_masked(db, monkeypatch):
    ran = []
    api = _api(monkeypatch, ran)
    row = await _pending(db, "k8s_patch_resource", PATCH)
    answer = await api.approve_tool_approval(row.id, request=SimpleNamespace(), authorization="Bearer x")
    assert ran == [("k8s_patch_resource", PATCH)], "the tool gets the value it was asked to set"
    assert answer["status"] == "executed"
    stored = await db.get_tool_approval(row.id)
    assert FAKE not in json.dumps(stored.args)
    assert stored.args["replicas"] == 2 and stored.args["resource_name"] == "web"
    messages = await db.get_messages("s1")
    assert all(FAKE not in (m.content or "") and FAKE not in json.dumps(m.tool_calls or []) for m in messages)
    assert messages[-1].tool_calls[0]["args"]["resource_name"] == "web"


async def test_a_failed_run_masks_the_row_too(db, monkeypatch):
    api = _api(monkeypatch, answer=RuntimeError("kubectl failed"))
    row = await _pending(db, "k8s_patch_resource", PATCH)
    answer = await api.approve_tool_approval(row.id, request=SimpleNamespace(), authorization="Bearer x")
    assert answer["status"] == "failed"
    assert FAKE not in json.dumps((await db.get_tool_approval(row.id)).args)


async def test_a_waiting_card_shows_the_real_arguments(db, monkeypatch):
    api = _api(monkeypatch)
    row = await _pending(db, "k8s_patch_resource", PATCH)
    answer = await api.get_tool_approval(row.id, authorization="Bearer x")
    assert answer["status"] == "pending" and answer["args"] == PATCH


async def test_a_card_opened_after_it_expired_says_so_and_holds_no_credential(db, monkeypatch):
    api = _api(monkeypatch)
    row = await _pending(db, "k8s_patch_resource", PATCH, expires_at=utcnow() - timedelta(seconds=1))
    answer = await api.get_tool_approval(row.id, authorization="Bearer x")
    assert answer["status"] == "expired"
    assert FAKE not in json.dumps(answer["args"]) and FAKE not in json.dumps((await db.get_tool_approval(row.id)).args)
    assert answer["args"]["resource_name"] == "web"


async def test_a_new_call_masks_what_expired_unopened(db):
    old = await _pending(db, "k8s_patch_resource", PATCH, expires_at=utcnow() - timedelta(seconds=1))
    waiting = await _pending(db, "k8s_patch_resource", PATCH)
    await _pending(db, "k8s_scale", {"resource_name": "web", "replicas": 2})
    gone = await db.get_tool_approval(old.id)
    assert gone.status == "expired" and FAKE not in json.dumps(gone.args)
    still = await db.get_tool_approval(waiting.id)
    assert still.status == "pending" and still.args == PATCH


async def _chat(monkeypatch, name, args):
    from app.services.ai import streaming

    monkeypatch.setattr(permissions, "tool_refusal", lambda *a, **k: None)
    monkeypatch.setattr(permissions, "may_request_approval", lambda *a, **k: True)
    made = []

    class Approvals:
        async def create_tool_approval(self, **kw):
            made.append(copy.deepcopy(kw))
            return SimpleNamespace(id="ap1", cluster=kw["cluster"], expires_at=utcnow() + timedelta(minutes=10))

    async def execute(_name, _args, _ctx):
        return "ran"

    service = SimpleNamespace(token=None, user_role="write", cluster_name="prod", tool_server=SimpleNamespace(last_redacted=None),
                              _execute_function_with_context=execute)
    events, entry, _text = await streaming._call_tool(
        service, Approvals(), SimpleNamespace(user_id="u1"), "s1", [], None, name, copy.deepcopy(args),
        iteration=1, audit_actor={"user_id": "u1", "email": "u1@example.com"}, audit_http=None,
    )
    return made, events, entry


async def test_the_saved_answer_holds_a_masked_copy_and_the_waiting_card_the_real_one(monkeypatch):
    from app.services.ai import streaming

    made, events, entry = await _chat(monkeypatch, "k8s_patch_resource", PATCH)
    assert made[0]["args"] == PATCH, "the approval is run with these"
    assert any(FAKE in e and "approval_required" in e for e in events), "the card on screen shows what will run"
    assert FAKE not in json.dumps(entry["args"])
    assert entry["args"]["resource_name"] == "web"
    assert FAKE not in streaming.tool_block_markdown(entry)


async def test_a_read_tool_keeps_its_arguments_as_they_came(monkeypatch):
    args = {"resource_type": "pods", "namespace": "shop", "label_selector": "app=web", "secret": "named-in-a-query"}
    _made, _events, entry = await _chat(monkeypatch, "k8s_get_resources", args)
    assert entry["args"] == args


async def test_a_new_call_goes_on_when_masking_what_expired_fails(db, monkeypatch):
    def broken(_args):
        raise RuntimeError("cannot mask")

    monkeypatch.setattr("app.services.audit_target.kept_tool_args", broken)
    await _pending(db, "k8s_patch_resource", PATCH, expires_at=utcnow() - timedelta(seconds=1))
    row = await _pending(db, "k8s_scale", {"resource_name": "web", "replicas": 2})
    assert row.status == "pending"


def test_arguments_that_cannot_be_read_keep_their_fields_and_no_value():
    from app.services.audit_target import MAX_READ_CHARS, kept_tool_args

    big = kept_tool_args({"resource_name": "web", "yaml_content": f"token: {FAKE}\n" + "x: y\n" * MAX_READ_CHARS})
    assert big["resource_name"] == "web" and FAKE not in big["yaml_content"] and "characters" in big["yaml_content"]
    broken = kept_tool_args({"resource_name": "web", "patch": f"{{not yaml: [{FAKE}"})
    assert broken["resource_name"] == "web" and FAKE not in broken["patch"]
    assert kept_tool_args(None) == {}
