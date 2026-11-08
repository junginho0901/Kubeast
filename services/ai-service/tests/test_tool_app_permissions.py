"""A tool that does what a screen guards asks for the screen's permission too, in the chat and over MCP, and tool-server
decides the same: the cases come from its TestToolPermissionCasesFixture (UPDATE_TOOL_PERMISSION_CASES=1 rewrites
them). Someone without the permission is not offered the tool and is told what is missing. A write tool's audit row
says what it was asked to do, with credentials masked; a read tool's row stays metadata only."""
import copy
import json
import re
import time
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import mcp_server
from app.database import utcnow
from app.security import TokenPayload
from app.services.ai import features as feature_gate
from app.services.ai import permissions, screen_permissions
from app.services.ai import tools as tools_catalog
from app.services.ai.tools import K8S_WRITE_TOOLS
from app.services.tool_whitelists import READONLY_TOOL_NAMES, WRITE_TOOL_NAMES

CASES = json.loads((Path(__file__).parent / "fixtures" / "tool_app_permission_cases.json").read_text())
CLUSTER = "alpha"
ALL_TOOLS = [{"type": "function", "function": {"name": n}} for n in sorted(WRITE_TOOL_NAMES | READONLY_TOOL_NAMES)]
WRITE_ROLE = ("ai.tool.*", "ai.mcp.use", "resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete", "resource.cronjob.suspend", "resource.cronjob.trigger")
EXEC_ROLE = (*WRITE_ROLE, "resource.pod.exec")
ROLLBACK_ROLE = (*WRITE_ROLE, "resource.workload.rollback")


def _token(perms, cluster=CLUSTER, **extra):
    return TokenPayload(user_id="u1", role="member", email="u1@example.com", matrix={cluster: tuple(perms), "prod": ("resource.pod.exec", "resource.workload.rollback")}, **extra)


def _admin():
    return TokenPayload(user_id="u1", role="admin", email="u1@example.com", permissions=("*",), matrix={"*": ("*",)})


def _service(token, response="ran"):
    async def execute(name, args, ctx):
        service.executed.append((name, args))
        return response

    service = SimpleNamespace(token=token, user_role="read", cluster_name=CLUSTER, tool_server=SimpleNamespace(last_redacted=None),
                              executed=[], _execute_function_with_context=execute)
    return service


class _ApprovalDB:
    def __init__(self):
        self.approvals = []

    async def create_tool_approval(self, **kw):
        self.approvals.append(kw)
        return SimpleNamespace(id="ap1", cluster=kw["cluster"], expires_at=utcnow() + timedelta(minutes=10))


@pytest.fixture
def rows(monkeypatch):
    from app.services import audit_writer

    out = []

    async def write(**kw):
        out.append(kw)
        return True

    async def ready():
        return True, None

    async def require():
        return None

    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setattr(audit_writer, "audit_ready", ready)
    monkeypatch.setattr(audit_writer, "require_audit_ready", require)
    monkeypatch.setenv("AI_WRITE_APPROVAL", "true")
    return out


async def _chat_call(token, name, args, *, offered=None):
    from app.services.ai import streaming

    service = _service(token)
    db = _ApprovalDB()
    tools = permissions.filter_tools_by_role(service, ALL_TOOLS) if offered is None else offered
    events, entry, llm_text = await streaming._call_tool(
        service, db, SimpleNamespace(user_id="u1"), "s1", tools, None, name, copy.deepcopy(args),
        iteration=1, audit_actor={"user_id": "u1", "email": "u1@example.com"}, audit_http=None,
    )
    return SimpleNamespace(events=events, entry=entry, llm_text=llm_text, db=db, service=service, offered=tools)


class _ToolServer:
    calls = []
    fail = None

    def __init__(self, authorization=None, base_url=None):
        self.last_redacted = self.last_access = self.last_requests = None

    async def call_tool(self, name, arguments=None, headers=None):
        _ToolServer.calls.append((name, dict(arguments or {})))
        if _ToolServer.fail:
            raise Exception(_ToolServer.fail)
        return "ok"


@pytest.fixture
def mcp(monkeypatch):
    """Calls the MCP server's call_tool with a token, tool-server and the audit store stood in."""
    audit = []

    async def write_audit(**kw):
        audit.append(kw)
        return True

    async def ready():
        return None

    _ToolServer.calls = []
    _ToolServer.fail = None
    monkeypatch.setenv("MCP_WRITE_TOOLS", "true")
    monkeypatch.setenv("AI_WRITE_APPROVAL", "false")
    monkeypatch.setattr(mcp_server, "ToolServerClient", _ToolServer)
    monkeypatch.setattr(mcp_server, "write_audit", write_audit)
    monkeypatch.setattr(mcp_server, "require_audit_ready", ready)

    async def call(token, name, args):
        access = SimpleNamespace(token="jwt", subject=token.user_id, claims=mcp_server._payload_to_claims(token))
        monkeypatch.setattr(mcp_server, "get_access_token", lambda: access)
        server = mcp_server.KubeastMCPServer(tool_server_url="http://tools")
        return await server.call_tool(name, {"cluster": CLUSTER, **copy.deepcopy(args)}, None)

    return SimpleNamespace(call=call, audit=audit)


# --- The same decision in tool-server, the chat and MCP -------------------------------------------------------------


def test_the_cases_test_both_answers():
    assert len(CASES) >= 50
    assert 10 <= sum(c["allowed"] for c in CASES) <= len(CASES) - 10


@pytest.mark.asyncio
async def test_the_chat_decides_each_case_as_tool_server_does(rows):
    wrong = []
    for c in CASES:
        got = await _chat_call(_token(c["perms"]), c["tool"], c["args"])
        carded = any('"approval_required"' in e for e in got.events)
        if carded != c["allowed"] or bool(got.db.approvals) != c["allowed"]:
            wrong.append(c["name"])
    assert wrong == []


@pytest.mark.asyncio
async def test_mcp_decides_each_case_as_tool_server_does(mcp):
    wrong = []
    for c in CASES:
        _ToolServer.calls = []
        await mcp.call(_token([*c["perms"], "ai.mcp.use"]), c["tool"], c["args"])
        if bool(_ToolServer.calls) != c["allowed"]:
            wrong.append(c["name"])
    assert wrong == []


def test_the_catalog_offers_pod_exec_by_the_same_decision():
    for c in (c for c in CASES if c["tool"] == "k8s_execute_command"):
        service = _service(_token(c["perms"]))
        names = {t["function"]["name"] for t in permissions.filter_tools_by_role(service, ALL_TOOLS)}
        assert ("k8s_execute_command" in names) == c["allowed"], c["name"]


# --- What someone without the permission sees ------------------------------------------------------------------------


def test_a_write_role_is_not_offered_pod_exec_and_keeps_every_other_write_tool():
    offered = {t["function"]["name"] for t in permissions.filter_tools_by_role(_service(_token(WRITE_ROLE)), K8S_WRITE_TOOLS)}
    assert offered == WRITE_TOOL_NAMES - {"k8s_execute_command", "k8s_cordon_node"}


@pytest.mark.parametrize("token", [_admin(), _token(EXEC_ROLE)], ids=["admin", "custom role with Pod exec"])
def test_who_holds_the_permission_is_offered_pod_exec(token):
    offered = {t["function"]["name"] for t in permissions.filter_tools_by_role(_service(token), K8S_WRITE_TOOLS)}
    assert "k8s_execute_command" in offered


def _rollout(tools):
    return next(t["function"] for t in tools if t["function"]["name"] == "k8s_rollout")


def test_a_role_without_rollback_is_told_undo_is_not_for_it_and_the_shared_catalog_is_untouched():
    before = copy.deepcopy(K8S_WRITE_TOOLS)
    offered = _rollout(permissions.filter_tools_by_role(_service(_token(WRITE_ROLE)), K8S_WRITE_TOOLS))
    assert "resource.workload.rollback" in offered["description"]
    assert "undo" not in offered["parameters"]["properties"]["action"]["description"]
    assert K8S_WRITE_TOOLS == before


@pytest.mark.parametrize("token", [_admin(), _token(ROLLBACK_ROLE)], ids=["admin", "custom role with rollback"])
def test_who_holds_rollback_keeps_the_tool_as_written(token):
    offered = _rollout(permissions.filter_tools_by_role(_service(token), K8S_WRITE_TOOLS))
    assert "resource.workload.rollback" not in offered["description"]
    assert "undo" in offered["parameters"]["properties"]["action"]["description"]


@pytest.mark.asyncio
async def test_the_rollback_permission_of_another_cluster_does_not_count(rows):
    got = await _chat_call(_token(WRITE_ROLE), "k8s_rollout", {"action": "undo", "resource_type": "deployment", "resource_name": "web"})
    assert got.db.approvals == []


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,perm", [
    ("k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["ls"]}, "resource.pod.exec"),
    ("k8s_rollout", {"action": "undo", "resource_type": "deployment", "resource_name": "web"}, "resource.workload.rollback"),
])
async def test_a_refused_call_gets_no_card_and_says_what_is_missing(rows, name, args, perm):
    got = await _chat_call(_token(WRITE_ROLE), name, args)
    assert not any('"approval_required"' in e for e in got.events) and got.db.approvals == []
    answer = json.loads(got.llm_text)
    assert answer["status"] == "not_permitted" and perm in answer["message"] and CLUSTER in answer["message"]
    assert perm in got.events[0], "the chat's tool block shows the reason too"
    row = rows[-1]
    assert row["action"] == "ai.tool.call" and row["result"] == "failure" and row["after"]["status"] == "not_permitted"


@pytest.mark.asyncio
async def test_a_refused_undo_also_stops_with_approval_off(rows, monkeypatch):
    monkeypatch.setenv("AI_WRITE_APPROVAL", "false")
    got = await _chat_call(_token(WRITE_ROLE), "k8s_rollout", {"action": "undo", "resource_type": "deployment", "resource_name": "web"})
    assert got.service.executed == []
    assert json.loads(got.llm_text)["status"] == "not_permitted"


@pytest.mark.asyncio
async def test_a_restart_by_the_same_role_still_gets_its_card(rows):
    got = await _chat_call(_token(WRITE_ROLE), "k8s_rollout", {"action": "restart", "resource_type": "deployment", "resource_name": "web"})
    assert len(got.db.approvals) == 1


@pytest.mark.asyncio
async def test_mcp_lists_pod_exec_only_for_who_holds_the_permission(mcp, monkeypatch):
    payload = _token(WRITE_ROLE)
    assert "k8s_execute_command" not in mcp_server._tools_allowed_in(payload, CLUSTER)
    assert "k8s_rollout" in mcp_server._tools_allowed_in(payload, CLUSTER)
    assert "k8s_execute_command" in mcp_server._tools_allowed_in(_token(EXEC_ROLE), CLUSTER)
    assert "k8s_execute_command" not in mcp_server._write_tools_anywhere(payload)
    assert "k8s_execute_command" in mcp_server._write_tools_anywhere(_token(EXEC_ROLE))
    assert "k8s_execute_command" in mcp_server._write_tools_anywhere(_admin())


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,perm", [
    ("k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["id"]}, "resource.pod.exec"),
    ("k8s_rollout", {"action": "undo", "resource_type": "deployment", "resource_name": "web", "namespace": "shop"}, "resource.workload.rollback"),
])
async def test_an_mcp_refusal_says_what_is_missing_and_is_recorded(mcp, name, args, perm):
    res = await mcp.call(_token(WRITE_ROLE), name, args)
    assert res.is_error is True and "forbidden" in res.content[0].text and perm in res.content[0].text
    assert _ToolServer.calls == []
    row = mcp.audit[-1]
    assert row["action"] == "ai.mcp.call" and row["result"] == "failure" and perm in row["error"] and row["after"]["write"] is True


# --- The sentence no longer decides ----------------------------------------------------------------------------------


def _text_chunk(text):
    delta = SimpleNamespace(content=text, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="stop")], usage=None)


async def _ask(monkeypatch, message, *, user_role, token):
    from app.services.ai import streaming

    models = []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            pass

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content=message)]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

    async def get_db_service():
        return DB()

    async def no_audit(**kw):
        return True

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", no_audit)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)

    async def create(**kwargs):
        models.append(json.loads(json.dumps(kwargs["messages"], default=str)))

        async def gen():
            yield _text_chunk("answer from the model")
        return gen()

    service = SimpleNamespace(
        model="m", provider="anthropic", user_role=user_role, tier="default", cluster_name=CLUSTER, token=token,
        client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
        tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: [],
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _execute_function_with_context=None,
    )
    events = [e async for e in streaming.session_chat_stream(service, "s1", message)]
    return models, "".join(events)


@pytest.mark.asyncio
@pytest.mark.parametrize("message,user_role,perms", [
    # What a word picked out of the sentence used to refuse, each by someone who may ask it.
    ("deployment 몇 개 있어?", "read", ("ai.tool.k8s_get_resources", "resource.*.read")),
    ("실행 중인 파드 보여줘", "read", ("ai.tool.k8s_get_resources", "resource.*.read")),
    ("이 디플로이먼트 스케일해줘", "read", WRITE_ROLE),
    ("이 명령 결과가 왜 이래?", "write", WRITE_ROLE),
    ("exec 로그 어디서 봐?", "write", EXEC_ROLE),
])
async def test_a_word_in_the_sentence_does_not_stop_the_turn(monkeypatch, message, user_role, perms):
    models, stream = await _ask(monkeypatch, message, user_role=user_role, token=_token(perms))
    assert len(models) == 1, "the model is asked"
    assert "answer from the model" in stream
    assert "권한으로는 실행할 수 없습니다" not in stream


@pytest.mark.asyncio
@pytest.mark.parametrize("perms,present,absent", [
    (WRITE_ROLE, ["resource.pod.exec", "resource.workload.rollback"], []),
    (EXEC_ROLE, ["resource.workload.rollback"], ["resource.pod.exec"]),
    (ROLLBACK_ROLE, ["resource.pod.exec"], ["resource.workload.rollback"]),
])
async def test_the_model_is_told_what_this_role_lacks_so_its_answer_can_say_why(monkeypatch, perms, present, absent):
    models, _ = await _ask(monkeypatch, "이 파드에서 ls 돌려줘", user_role="read", token=_token(perms))
    told = " ".join(m["content"] for m in models[0] if m["role"] == "system")
    for perm in present:
        assert perm in told
    for perm in absent:
        assert perm not in told


@pytest.mark.asyncio
async def test_the_model_is_told_when_the_role_holds_no_write_tool(monkeypatch):
    models, _ = await _ask(monkeypatch, "이 파드 지워줘", user_role="read", token=_token(("ai.tool.k8s_get_resources",)))
    told = " ".join(m["content"] for m in models[0] if m["role"] == "system")
    assert "write tools" in told and CLUSTER in told


@pytest.mark.asyncio
async def test_an_admin_is_told_nothing(monkeypatch):
    models, _ = await _ask(monkeypatch, "이 파드에서 ls 돌려줘", user_role="admin", token=_admin())
    told = " ".join(m["content"] for m in models[0] if m["role"] == "system")
    assert "resource.pod.exec" not in told and "write tools" not in told


# --- The approved run ------------------------------------------------------------------------------------------------


def _approval(tool, args):
    return SimpleNamespace(id="ap1", user_id="u1", cluster=CLUSTER, tool=tool, args=args, session_id="s1", result="", status="pending",
                           created_at=None, expires_at=None, decided_at=None)


async def _approve(monkeypatch, rows, token, approval):
    from app import api

    messages, ran = [], []

    class DB:
        async def transition_tool_approval(self, *a, **k):
            for key, value in k.items():
                setattr(approval, key, value)
            return approval

        async def add_message(self, *a, **k):
            messages.append((a, k))

    async def load(approval_id, payload):
        return DB(), approval

    class Service:
        tool_server = SimpleNamespace(last_access=None, last_requests=None)

        async def _call_tool_server(self, tool, args, **kw):
            ran.append((tool, args))
            return "ok"

    async def build(authorization, cluster_name=None):
        return Service()

    monkeypatch.setattr(api, "_load_own_pending_approval", load)
    monkeypatch.setattr(api, "_caller", lambda auth: token)
    monkeypatch.setattr(api, "_extract_audit_meta", lambda request, auth: ({"user_id": "u1", "email": "u1@example.com"}, {}))
    monkeypatch.setattr(api, "_build_ai_service", build)
    monkeypatch.setattr("app.services.approval_token.sign", lambda *a, **k: "tok")
    await api.approve_tool_approval("ap1", request=SimpleNamespace(), authorization="Bearer x")
    return SimpleNamespace(messages=messages, ran=ran)


@pytest.mark.asyncio
@pytest.mark.parametrize("tool,args,perm", [
    ("k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["id"]}, "resource.pod.exec"),
    ("k8s_rollout", {"action": "undo", "resource_type": "deployment", "resource_name": "web"}, "resource.workload.rollback"),
])
async def test_a_card_from_before_the_permission_went_stops_at_the_run_and_says_why(monkeypatch, rows, tool, args, perm):
    approval = _approval(tool, args)
    got = await _approve(monkeypatch, rows, _token(WRITE_ROLE), approval)
    assert got.ran == []
    assert approval.status == "failed" and perm in approval.result
    run = next(r for r in rows if r["action"] == "ai.tool.execute")
    assert run["result"] == "failure"
    assert not [r for r in rows if r["action"] == "k8s.pod.exec"], "no exec ran"


@pytest.mark.asyncio
async def test_an_approved_exec_is_in_the_audit_with_its_command(monkeypatch, rows):
    args = {"pod_name": "web", "namespace": "shop", "container": "app", "command": ["sh", "-c", "mysql -u root --password=fake-pass-1 -h db"]}
    got = await _approve(monkeypatch, rows, _token(EXEC_ROLE), _approval("k8s_execute_command", args))
    assert len(got.ran) == 1
    run = next(r for r in rows if r["action"] == "ai.tool.execute")
    assert run["result"] == "success" and run["after"]["container"] == "app"
    assert run["after"]["command"][0:2] == ["sh", "-c"] and "mysql -u root" in run["after"]["command"][2]
    assert "fake-pass-1" not in json.dumps(run)


@pytest.mark.asyncio
async def test_an_approved_exec_also_gets_the_row_the_terminal_writes(monkeypatch, rows):
    args = {"pod_name": "web", "namespace": "shop", "container": "app", "command": ["env", "API_TOKEN=fake-token-2", "ls"]}
    await _approve(monkeypatch, rows, _token(EXEC_ROLE), _approval("k8s_execute_command", args))
    row = next(r for r in rows if r["action"] == "k8s.pod.exec")
    assert (row["target_type"], row["target_id"], row["namespace"], row["cluster"]) == ("pod", "web", "shop", CLUSTER)
    assert row["after"]["container"] == "app" and row["after"]["tool"] == "k8s_execute_command" and row["after"]["approval_id"] == "ap1"
    assert row["after"]["command"][0] == "env" and row["after"]["command"][2] == "ls"
    assert "fake-token-2" not in json.dumps(row)


# --- What a write tool's row says -------------------------------------------------------------------------------------


NO_HASH = re.compile(r"\b[0-9a-f]{32,}\b")


async def _mcp_after(mcp, name, args, token=None):
    await mcp.call(token or _admin(), name, args)
    return mcp.audit[-1]["after"]


@pytest.mark.asyncio
@pytest.mark.parametrize("command,kept", [
    (["mysql", "-u", "root", "--password=fake-pass-1"], ["mysql", "-u", "root"]),
    (["mysql", "--password", "fake-pass-1", "-e", "select 1"], ["mysql", "--password", "-e", "select 1"]),
    (["mysql", "-u", "root", "-pfake-pass-1"], ["mysql", "-u", "root"]),
    (["sh", "-c", "PGPASSWORD=fake-pass-1 psql -h db"], ["sh", "-c"]),
    (["sh", "-c", "mysql --password='fake pass 1' -h db"], ["sh", "-c"]),
    (["sh", "-c", 'mysql --password "fake-pass-1" -h db'], ["sh", "-c"]),
    (["curl", "-H", "Authorization: Bearer fake-token-1234567890", "http://svc"], ["curl", "-H", "http://svc"]),
    (["curl", "-H", "Authorization: token fake-pass-1", "http://svc"], ["curl", "-H", "http://svc"]),
    (["curl", "-H", "Cookie: session=fake-pass-1; other=fake-pass-1", "http://svc"], ["curl", "-H", "http://svc"]),
    (["sh", "-c", "curl -H 'Authorization: Basic fake-pass-1' http://svc | jq ."], ["sh", "-c"]),
    (["curl", "-u", "me:fake-pass-1", "http://svc"], ["curl", "-u", "http://svc"]),
    (["psql", "postgres://me:fake-pass-1@db/app"], ["psql"]),
    (["sshpass", "-p", "fake-pass-1", "ssh", "host"], ["sshpass", "-p", "ssh", "host"]),
    (["redis-cli", "-a", "fake-pass-1", "ping"], ["redis-cli", "-a", "ping"]),
    (["env", "API_TOKEN=fake-pass-1", "ls"], ["env", "ls"]),
])
async def test_an_exec_row_keeps_the_command_and_loses_the_credential(mcp, command, kept):
    after = await _mcp_after(mcp, "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": command})
    written = after.get("command")
    assert isinstance(written, list) and len(written) == len(command)
    for word in kept:
        assert word in written, written
    text = json.dumps(after)
    assert "fake-pass-1" not in text and "fake pass 1" not in text and "fake-token-1234567890" not in text
    assert after["command_len"] == sum(len(a) for a in command)


@pytest.mark.asyncio
@pytest.mark.parametrize("command", [
    ["ls", "/var/run/secrets/kubernetes.io/serviceaccount/token"],
    ["sh", "-c", "mysql --password=$DB_PASSWORD -h db -P3306"],
    ["mysql", "--password", "--host=db"],
    ["mysqldump", "--port=3306", "shop"],
    ["cat", "--secret-name=app", "--token-ttl=5m", "--password-file=/etc/app/pw"],
    ["nc", "-p", "8080", "db", "3306"],
    ["grep", "password", "/etc/app.conf"],
    ["kubectl", "get", "secret", "app"],
])
async def test_an_exec_row_keeps_what_only_looks_like_a_credential(mcp, command):
    after = await _mcp_after(mcp, "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": command})
    assert after["command"] == command


@pytest.mark.asyncio
async def test_an_exec_row_keeps_a_plain_command_as_it_is(mcp):
    after = await _mcp_after(mcp, "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "container": "app", "command": ["ls", "-la", "/data"]})
    assert after["command"] == ["ls", "-la", "/data"] and after["container"] == "app" and "command_truncated" not in after


@pytest.mark.asyncio
async def test_a_long_exec_command_is_cut_and_says_so(mcp):
    after = await _mcp_after(mcp, "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["sh", "-c", "x" * 5000]})
    assert after["command_truncated"] is True and after["command_len"] == 5004
    assert sum(len(a) for a in after["command"]) <= 1000
    assert after["command"][0:2] == ["sh", "-c"]


@pytest.mark.asyncio
async def test_a_credential_past_the_cut_is_masked_first_and_gone(mcp):
    after = await _mcp_after(mcp, "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["sh", "-c", "echo " + "y" * 995 + " --password=fake-pass-1"]})
    assert after["command_truncated"] is True and "fake-pass-1" not in json.dumps(after)
    assert sum(len(a) for a in after["command"]) <= 1000


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,field", [
    ("k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["sh", "-c", "mysql " * 200_000]}, "command_truncated"),
    ("k8s_apply_manifest", {"yaml_content": "kind: ConfigMap\ndata:\n  k: " + "mysql " * 40_000 + "\n"}, "manifest_preview"),
])
async def test_a_long_repetitive_input_does_not_hold_the_service_up(mcp, name, args, field):
    started = time.monotonic()
    after = await _mcp_after(mcp, name, args)
    assert field in after and time.monotonic() - started < 20


@pytest.mark.asyncio
async def test_the_row_is_masked_even_with_redaction_turned_off_for_the_model(mcp, monkeypatch):
    monkeypatch.setenv("REDACTION_ENABLED", "false")
    after = await _mcp_after(mcp, "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["mysql", "--password=fake-pass-1"]})
    assert after["command"][0] == "mysql" and "fake-pass-1" not in json.dumps(after)


@pytest.mark.asyncio
@pytest.mark.parametrize("patch", [
    {"spec": {"template": {"spec": {"containers": [{"name": "app", "env": [{"name": "DB_PASSWORD", "value": "fake-pass-1"}], "image": "web:2"}]}}}},
    {"stringData": {"api_token": "fake-pass-1"}, "image": "web:2"},
    {"args": ["--password=fake-pass-1"], "image": "web:2"},
    {"note": "image web:2", "password": "fake-pass-1"},
    '{"password": "fake-pass-1", "image": "web:2"}',
    "password: fake-pass-1\nimage: web:2\n",
    "token: |\n  fake-pass-1\nimage: web:2\n",
    [{"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": "web:2"},
     {"op": "add", "path": "/data/password", "value": "fake-pass-1"},
     {"op": "add", "path": "/spec/template/spec/containers/0/env/0/value", "value": "fake-pass-1"}],
])
async def test_a_patch_row_has_its_length_and_a_masked_start_and_no_hash(rows, monkeypatch, patch):
    monkeypatch.setenv("AI_WRITE_APPROVAL", "false")
    await _chat_call(_admin(), "k8s_patch_resource", {"resource_type": "deployment", "resource_name": "web", "namespace": "shop", "patch": patch, "patch_type": "merge"})
    after = next(r for r in rows if r["action"] == "ai.tool.call")["after"]
    assert after["patch_type"] == "merge"
    assert after["patch_len"] == len(patch if isinstance(patch, str) else json.dumps(patch, ensure_ascii=False))
    assert "web:2" in after["patch_preview"]
    text = json.dumps(after)
    assert "fake-pass-1" not in text
    assert not NO_HASH.search(text) and not any("hash" in k or "sha" in k for k in after)


@pytest.mark.asyncio
async def test_an_mcp_patch_row_says_the_same(mcp):
    patch = {"stringData": {"api_token": "fake-pass-1"}, "image": "web:2"}
    after = await _mcp_after(mcp, "k8s_patch_resource", {"resource_type": "deployment", "resource_name": "web", "namespace": "shop", "patch": patch})
    assert after["patch_len"] == len(json.dumps(patch)) and "web:2" in after["patch_preview"] and "fake-pass-1" not in json.dumps(after)


@pytest.mark.asyncio
@pytest.mark.parametrize("resource_type", ["secret", "secrets", "Secret", "secrets.v1"])
async def test_a_patch_of_a_secret_keeps_only_its_length(mcp, resource_type):
    patch = {"data": {"anything": "ZmFrZS1wYXNzLTE="}}
    after = await _mcp_after(mcp, "k8s_patch_resource", {"resource_type": resource_type, "resource_name": "s", "namespace": "shop", "patch": patch})
    assert after["patch_len"] == len(json.dumps(patch)) and "patch_preview" not in after
    assert "ZmFrZS1wYXNzLTE" not in json.dumps(after)


SECRET_MANIFEST = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  namespace: shop\ndata:\n  anything: ZmFrZS1wYXNzLTE=\nstringData:\n  other: fake-pass-1\n"
CONFIG_MANIFEST = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: shop\ndata:\n  plain: keep-me\n  app.conf: |\n    db.password=fake-pass-1\n    db.host=db\n  token: |\n    fake-pass-1\n"
ENV_MANIFEST = "kind: Deployment\nmetadata:\n  name: web\nspec:\n  template:\n    spec:\n      containers:\n      - name: app\n        image: web:2\n        env:\n        - value: fake-pass-1\n          name: DB_PASSWORD\n        command: [\"sh\", \"-c\", \"mysql --password=fake-pass-1\"]\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["k8s_apply_manifest", "k8s_create_resource"])
@pytest.mark.parametrize("manifest,keep", [(SECRET_MANIFEST, "kind: Secret"), (CONFIG_MANIFEST, "keep-me"), (ENV_MANIFEST, "web:2")])
async def test_a_manifest_row_has_its_length_and_a_masked_start(mcp, tool, manifest, keep):
    after = await _mcp_after(mcp, tool, {"yaml_content": manifest})
    assert after["manifest_len"] == len(manifest) and keep in after["manifest_preview"]
    text = json.dumps(after)
    assert "fake-pass-1" not in text and "ZmFrZS1wYXNzLTE" not in text and not NO_HASH.search(text)


@pytest.mark.asyncio
async def test_a_manifest_object_is_read_the_same(mcp):
    manifest = {"kind": "Secret", "metadata": {"name": "s"}, "stringData": {"anything": "fake-pass-1"}}
    after = await _mcp_after(mcp, "k8s_apply_manifest", {"resource_manifest": manifest})
    assert "kind: Secret" in after["manifest_preview"] and "fake-pass-1" not in json.dumps(after)


@pytest.mark.asyncio
@pytest.mark.parametrize("manifest", [
    "kind: [unclosed\npassword: fake-pass-1\n",
    "a: &a {password: fake-pass-1}\nb: *a\n",
    "kind: ConfigMap\ndata:\n  big: " + "z" * (1 << 19) + "\n",
])
async def test_a_manifest_that_cannot_be_read_safely_keeps_only_its_length(mcp, manifest):
    after = await _mcp_after(mcp, "k8s_apply_manifest", {"yaml_content": manifest})
    assert after["manifest_len"] == len(manifest) and "manifest_preview" not in after
    assert "fake-pass-1" not in json.dumps(after)


@pytest.mark.asyncio
async def test_a_long_manifest_preview_is_cut(mcp):
    manifest = "kind: ConfigMap\ndata:\n" + "".join(f"  k{i}: value-{i}\n" for i in range(300))
    after = await _mcp_after(mcp, "k8s_apply_manifest", {"yaml_content": manifest})
    assert after["manifest_len"] == len(manifest) and 0 < len(after["manifest_preview"]) <= 500


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,want", [
    ("k8s_scale", {"resource_type": "deployment", "resource_name": "web", "namespace": "shop", "replicas": 3}, {"replicas": 3}),
    ("k8s_rollout", {"action": "undo", "resource_type": "deployment", "resource_name": "web", "namespace": "shop", "revision": 4}, {"rollout_action": "undo", "revision": 4}),
    ("k8s_rollout", {"action": "restart", "resource_type": "deployment", "resource_name": "web", "namespace": "shop"}, {"rollout_action": "restart"}),
    ("k8s_delete_resource", {"resource_type": "pod", "resource_name": "web", "namespace": "shop", "force": True, "grace_period": 0}, {"force": True, "grace_period": 0}),
])
async def test_a_write_row_says_what_was_asked(mcp, name, args, want):
    after = await _mcp_after(mcp, name, args)
    for key, value in want.items():
        assert after.get(key) == value, key


@pytest.mark.asyncio
async def test_labels_and_annotations_are_kept_with_credentials_masked(mcp):
    after = await _mcp_after(mcp, "k8s_annotate_resource", {"resource_type": "pod", "resource_name": "web", "namespace": "shop", "annotations": {"team": "shop", "api-token": "fake-pass-1"}})
    assert "team: shop" in after["annotations_preview"] and "fake-pass-1" not in json.dumps(after)
    after = await _mcp_after(mcp, "k8s_label_resource", {"resource_type": "pod", "resource_name": "web", "namespace": "shop", "labels": {"tier": "front"}})
    assert "tier: front" in after["labels_preview"]
    after = await _mcp_after(mcp, "k8s_remove_label", {"resource_type": "pod", "resource_name": "web", "namespace": "shop", "keys": ["tier"]})
    assert "- tier" in after["keys_preview"]


@pytest.mark.asyncio
async def test_a_refused_mcp_call_keeps_what_it_tried(mcp):
    after = await _mcp_after(mcp, "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["cat", "/etc/passwd"]}, token=_token(WRITE_ROLE))
    assert after["command"] == ["cat", "/etc/passwd"]


@pytest.mark.asyncio
async def test_a_failed_mcp_exec_keeps_the_command_and_its_terminal_row_says_failure(mcp):
    _ToolServer.fail = "boom"
    await mcp.call(_admin(), "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["ls"]})
    actions = {r["action"]: r for r in mcp.audit}
    assert actions["ai.mcp.call"]["result"] == "failure" and actions["ai.mcp.call"]["after"]["command"] == ["ls"]
    assert actions["k8s.pod.exec"]["result"] == "failure" and actions["k8s.pod.exec"]["error"] == "boom"


@pytest.mark.asyncio
async def test_an_mcp_exec_also_gets_the_row_the_terminal_writes(mcp):
    await mcp.call(_admin(), "k8s_execute_command", {"pod_name": "web", "container": "app", "command": ["ls"]})
    row = next(r for r in mcp.audit if r["action"] == "k8s.pod.exec")
    # tool-server runs a call without a namespace in default, and the row says where it ran
    assert (row["target_type"], row["target_id"], row["namespace"], row["cluster"], row.get("result", "success")) == ("pod", "web", "default", CLUSTER, "success")
    assert row["after"]["command"] == ["ls"] and row["after"]["container"] == "app"


@pytest.mark.asyncio
async def test_a_refused_mcp_exec_gets_no_terminal_row(mcp):
    await mcp.call(_token(WRITE_ROLE), "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["ls"]})
    assert [r["action"] for r in mcp.audit] == ["ai.mcp.call"]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args", [
    ("k8s_get_pod_logs", {"pod_name": "web", "namespace": "shop", "grep": "password=fake-pass-1"}),
    ("k8s_get_resources", {"resource_type": "pods", "namespace": "shop"}),
    ("prometheus_query", {"promql": "up{password=\"fake-pass-1\"}"}),
])
async def test_a_read_tools_row_stays_metadata_only(mcp, name, args):
    after = await _mcp_after(mcp, name, args)
    assert set(after) <= {"tool", "write", "resource_type", "credential", "client", "objects", "redacted", "access", "requests"}
    assert "fake-pass-1" not in json.dumps(after) and after["write"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("args,want", [
    ({"pod_name": "web", "command": ["ls", "-la"]}, ["ls", "-la"]),
    ({"pod_name": "web", "cmd": ["ls", "-la"]}, ["ls", "-la"]),
    ({"pod_name": "web", "command": "ls -la"}, ["ls", "-la"]),
    ({"pod_name": "web", "command": "ls,-la"}, ["ls", "-la"]),
])
async def test_the_chat_row_reads_the_command_as_tool_server_does(rows, monkeypatch, args, want):
    monkeypatch.setenv("AI_WRITE_APPROVAL", "false")
    await _chat_call(_admin(), "k8s_execute_command", args)
    row = next(r for r in rows if r["action"] == "ai.tool.call")
    assert row["after"]["command"] == want


@pytest.mark.asyncio
async def test_a_chat_exec_without_the_approval_step_gets_the_terminal_row(rows, monkeypatch):
    monkeypatch.setenv("AI_WRITE_APPROVAL", "false")
    await _chat_call(_admin(), "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["ls"]})
    row = next(r for r in rows if r["action"] == "k8s.pod.exec")
    assert row["target_id"] == "web" and row["after"]["command"] == ["ls"] and row["result"] == "success"


@pytest.mark.asyncio
async def test_a_chat_exec_waiting_for_approval_has_no_terminal_row_yet(rows):
    await _chat_call(_admin(), "k8s_execute_command", {"pod_name": "web", "namespace": "shop", "command": ["ls"]})
    assert not [r for r in rows if r["action"] == "k8s.pod.exec"]
    parked = next(r for r in rows if r["action"] == "ai.tool.call")
    assert parked["after"]["command"] == ["ls"]


@pytest.mark.asyncio
async def test_a_chat_read_tools_row_stays_metadata_only(rows):
    await _chat_call(_admin(), "k8s_get_pod_logs", {"pod_name": "web", "namespace": "shop", "grep": "password=fake-pass-1"})
    row = next(r for r in rows if r["action"] == "ai.tool.call")
    assert "fake-pass-1" not in json.dumps(row)
    assert set(row["after"]) <= {"session_id", "tool", "iteration", "resource_type", "status", "redacted", "access", "requests", "objects"}


# --- What a screen asks, for every tool: the table both services keep -------------------------------------------------

SCREEN = json.loads((Path(__file__).parent / "fixtures" / "tool_screen_permission_cases.json").read_text())
TOOLS_ONLY = ("ai.tool.*", "ai.mcp.use")
CATALOG = sorted({t["function"]["name"] for t in tools_catalog.get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))})


def _offered(token, tools=None):
    return {t["function"]["name"] for t in permissions.filter_tools_by_role(_service(token), tools or ALL_TOOLS)}


def test_each_call_asks_what_tool_server_asks():
    wrong = [(c["tool"], c["args"], screen_permissions.app_permissions(c["tool"], c["args"]), c["want"]) for c in SCREEN["cases"]
             if screen_permissions.app_permissions(c["tool"], c["args"]) != (c["want"] or [])]
    assert wrong == []
    assert len(SCREEN["cases"]) > 200


def test_the_table_and_the_spellings_are_tool_servers():
    assert sorted(screen_permissions.TOOL_SCREEN_TABLE) == SCREEN["tools"]
    assert screen_permissions.spellings() == SCREEN["spellings"]
    assert sorted(screen_permissions.PERMISSION_NAMES) == SCREEN["permission_names"]


def test_every_tool_the_model_or_an_agent_can_be_offered_is_in_the_table():
    assert len(CATALOG) > 50
    assert [n for n in CATALOG if n not in screen_permissions.TOOL_SCREEN_TABLE] == []
    assert [n for n in [*mcp_server.READ_TOOLS, *mcp_server.WRITE_TOOLS] if n not in screen_permissions.TOOL_SCREEN_TABLE] == []


def test_each_call_of_the_built_in_roles_goes_as_before():
    admin, write, read = _admin(), _token(SCREEN["write_role"]), _token(SCREEN["read_role"])
    cluster_admin = _token(("*",))
    wrong = []
    for c in SCREEN["cases"]:
        for name, token, want in (("global admin", admin, True), ("Admin", cluster_admin, True), ("Write", write, c["write"]), ("Read", read, c["read"])):
            if permissions.token_may_call(token, CLUSTER, c["tool"], c["args"]) != want:
                wrong.append((name, c["tool"], c["args"]))
    assert wrong == []


def test_the_built_in_roles_are_offered_what_they_were():
    write = _token(SCREEN["write_role"])
    assert _offered(_admin(), [{"type": "function", "function": {"name": n}} for n in CATALOG]) == set(CATALOG)
    assert _offered(write) == (WRITE_TOOL_NAMES | READONLY_TOOL_NAMES) - {"k8s_execute_command", "k8s_cordon_node"}
    assert _offered(_token(SCREEN["read_role"]), [{"type": "function", "function": {"name": n}} for n in sorted(READONLY_TOOL_NAMES)]) == READONLY_TOOL_NAMES


def test_a_role_with_tools_and_no_resource_permission_is_offered_only_what_its_screens_show():
    offered = _offered(_token(TOOLS_ONLY))
    assert "k8s_get_resources" in offered and "k8s_describe_resource" in offered and "issues" in offered
    assert offered & {"k8s_get_pod_logs", "logsearch", "helm_read", "cost", "network_flows"} == set()
    # rollout stays for its status and history; everything else that writes needs a permission no kind here holds.
    assert offered & WRITE_TOOL_NAMES == {"k8s_rollout"}


@pytest.mark.parametrize("perms,present,absent", [
    (("ai.tool.*", "resource.configmap.delete"), {"k8s_delete_resource"}, {"k8s_patch_resource", "k8s_scale", "k8s_create_resource", "k8s_apply_manifest"}),
    (("ai.tool.*", "resource.deployment.edit"), {"k8s_scale", "k8s_patch_resource", "k8s_label_resource", "k8s_apply_manifest"}, {"k8s_delete_resource", "k8s_create_resource"}),
    (("ai.tool.*", "resource.secret.create"), {"k8s_create_resource"}, {"k8s_delete_resource", "k8s_apply_manifest"}),
    (("ai.tool.*", "resource.*.delete"), {"k8s_delete_resource"}, {"k8s_scale"}),
    (("ai.tool.k8s_get_pod_logs", "resource.pod.read"), {"k8s_get_pod_logs"}, {"k8s_get_resources"}),
])
def test_a_tool_is_offered_once_the_role_holds_what_it_asks_for_some_kind(perms, present, absent):
    offered = _offered(_token(perms))
    assert present <= offered and offered & absent == set()


def test_the_grant_of_another_cluster_is_not_what_offers_a_tool():
    token = TokenPayload(user_id="u1", role="member", matrix={CLUSTER: TOOLS_ONLY, "prod": ("resource.*.delete", "resource.pod.read")})
    assert permissions.token_may_call(token, CLUSTER, "k8s_delete_resource") is False
    assert permissions.token_may_call(token, CLUSTER, "k8s_get_pod_logs") is False
    assert permissions.token_may_call(token, CLUSTER, "k8s_delete_resource", {"resource_type": "secret"}) is False


def test_a_tool_not_in_the_table_is_closed(monkeypatch):
    monkeypatch.delitem(screen_permissions.TOOL_SCREEN_TABLE, "k8s_get_resources")
    for token in (_admin(), _token(("*",)), _token(TOOLS_ONLY)):
        assert permissions.token_may_call(token, CLUSTER, "k8s_get_resources") is False
        assert permissions.token_may_call(token, CLUSTER, "k8s_get_resources", {"resource_type": "pods"}) is False
        reason = permissions.app_permission_error(token, CLUSTER, "k8s_get_resources", {"resource_type": "pods"})
        assert reason and "forbidden" in reason and "k8s_get_resources" in reason
        assert "k8s_get_resources" not in _offered(token)


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,perms", [
    ("k8s_get_pod_logs", {"pod_name": "web", "namespace": "shop"}, ["resource.pod.read"]),
    ("logsearch", {"namespace": "shop"}, ["resource.pod.read"]),
    ("helm_read", {"what": "list"}, ["resource.helm.read"]),
    ("nodes_log", {"node": "n1"}, ["admin.nodes.read"]),
    ("access_review", {"review_section": "cluster_roles"}, ["admin.review.read"]),
    ("ai_usage", {}, ["admin.audit.read"]),
    ("access_requests", {}, ["admin.users.update"]),
    ("audit_integrity", {}, ["admin.audit.read"]),
    ("hygiene_history", {}, ["resource.hygiene.scan"]),
    ("investigations", {"investigation_id": "inv-1"}, ["admin.investigations.read"]),
    ("ai_models", {}, ["admin.ai_models.*"]),
    ("session_recordings", {"recording_id": "r1"}, ["admin.sessions.read"]),
    ("k8s_diff", {"yaml_content": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\n"}, ["resource.secret.edit"]),
])
async def test_a_refused_read_in_the_chat_does_not_run_and_says_why(rows, name, args, perms):
    got = await _chat_call(_token(TOOLS_ONLY), name, args, offered=[{"type": "function", "function": {"name": name}}])
    assert got.service.executed == []
    answer = json.loads(got.llm_text)
    assert answer["status"] == "not_permitted" and CLUSTER in answer["message"]
    for perm in perms:
        assert perm in answer["message"]
    assert rows[-1]["action"] == "ai.tool.call" and rows[-1]["result"] == "failure"


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args", [
    ("k8s_get_resources", {"resource_type": "secrets", "namespace": "shop"}),
    ("k8s_describe_resource", {"resource_type": "configmap", "resource_name": "a", "namespace": "shop"}),
    ("k8s_get_events", {"namespace": "shop"}),
    ("prometheus_query", {"promql": "up"}),
])
async def test_a_read_the_screens_leave_to_the_cluster_runs_for_the_same_role(rows, name, args):
    got = await _chat_call(_token(TOOLS_ONLY), name, args, offered=[{"type": "function", "function": {"name": name}}])
    assert [n for n, _ in got.service.executed] == [name]


WRITE_CALLS = [
    ("k8s_delete_resource", {"resource_type": "Secret", "resource_name": "x", "namespace": "shop"}, ["resource.secret.delete"]),
    ("k8s_delete_resource", {"resource_type": "configmaps,secrets.v1", "resource_name": "x", "namespace": "shop"}, ["resource.configmap.delete", "resource.secret.delete"]),
    ("k8s_delete_resource", {"resource_type": "all", "all": True, "namespace": "shop"}, ["resource.*.delete"]),
    ("k8s_patch_resource", {"resource_type": "deployment.apps", "resource_name": "x", "namespace": "shop", "patch": {"a": 1}}, ["resource.deployment.edit"]),
    ("k8s_annotate_resource", {"resource_type": "svc", "resource_name": "x", "namespace": "shop", "annotations": {"a": "b"}}, ["resource.service.edit"]),
    ("k8s_label_resource", {"resource_type": "nodes", "resource_name": "x", "labels": {"a": "b"}}, ["resource.node.edit"]),
    ("k8s_scale", {"resource_type": "statefulsets", "resource_name": "x", "namespace": "shop", "replicas": 2}, ["resource.statefulset.edit"]),
    ("k8s_rollout", {"action": "restart", "resource_type": "deploy", "resource_name": "x", "namespace": "shop"}, ["resource.deployment.edit"]),
    ("k8s_apply_manifest", {"yaml_content": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: b\n"}, ["resource.configmap.edit", "resource.secret.edit"]),
    ("k8s_create_resource", {"yaml_content": "apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Secret\n  metadata:\n    name: b\n"}, ["resource.secret.create"]),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,perms", WRITE_CALLS)
async def test_a_refused_write_in_the_chat_gets_no_card_and_a_failure_row(rows, name, args, perms):
    got = await _chat_call(_token(TOOLS_ONLY), name, args, offered=[{"type": "function", "function": {"name": name}}])
    assert not any('"approval_required"' in e for e in got.events) and got.db.approvals == []
    answer = json.loads(got.llm_text)
    assert answer["status"] == "not_permitted"
    for perm in perms:
        assert perm in answer["message"]
    assert rows[-1]["action"] == "ai.tool.call" and rows[-1]["result"] == "failure" and rows[-1]["after"]["status"] == "not_permitted"


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,perms", WRITE_CALLS)
async def test_the_same_write_in_the_chat_gets_its_card_with_the_permission(rows, name, args, perms):
    got = await _chat_call(_token(("ai.tool.*", *perms)), name, args)
    assert len(got.db.approvals) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,perms", [
    *WRITE_CALLS,
    ("k8s_get_pod_logs", {"pod_name": "web", "namespace": "shop"}, ["resource.pod.read"]),
    ("access_review", {"review_section": "users"}, ["admin.review.read"]),
    ("ai_usage", {}, ["admin.audit.read"]),
    ("access_requests", {}, ["admin.users.update"]),
    ("audit_integrity", {}, ["admin.audit.read"]),
    ("hygiene_history", {}, ["resource.hygiene.scan"]),
    ("investigations", {}, ["admin.investigations.read"]),
    ("ai_models", {}, ["admin.ai_models.*"]),
    ("session_recordings", {}, ["admin.sessions.read"]),
])
async def test_a_refusal_over_mcp_says_what_is_missing_and_is_recorded(mcp, name, args, perms):
    res = await mcp.call(_token(TOOLS_ONLY), name, args)
    assert res.is_error is True and _ToolServer.calls == []
    row = mcp.audit[-1]
    assert row["action"] == "ai.mcp.call" and row["result"] == "failure" and row["after"]["write"] is (name in WRITE_TOOL_NAMES)
    for perm in perms:
        assert perm in res.content[0].text and perm in row["error"]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,perms", WRITE_CALLS)
async def test_the_same_call_over_mcp_goes_through_with_the_permission(mcp, name, args, perms):
    res = await mcp.call(_token(("ai.tool.*", "ai.mcp.use", *perms)), name, args)
    assert res.is_error is not True and [n for n, _ in _ToolServer.calls] == [name]


ADMIN_READS = [
    ("access_review", {"review_section": "cluster_roles"}, "admin.review.read"),
    ("ai_usage", {"usage_group": "model"}, "admin.audit.read"),
    ("access_requests", {}, "admin.users.update"),
    ("audit_integrity", {}, "admin.audit.read"),
    ("hygiene_history", {}, "resource.hygiene.scan"),
    ("investigations", {}, "admin.investigations.read"),
    ("ai_models", {}, "admin.ai_models.*"),
    ("session_recordings", {}, "admin.sessions.read"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,perm", ADMIN_READS)
async def test_an_admin_read_over_mcp_runs_with_the_screens_permission_and_is_recorded(mcp, name, args, perm):
    res = await mcp.call(_token(("ai.tool.*", "ai.mcp.use", perm)), name, args)
    assert res.is_error is not True and [n for n, _ in _ToolServer.calls] == [name]
    row = mcp.audit[-1]
    assert row["action"] == "ai.mcp.call" and row.get("result", "success") == "success" and row["target_id"] == name and row["after"]["write"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("name,args,perm", ADMIN_READS)
async def test_an_admin_read_in_the_chat_runs_with_the_screens_permission_and_is_recorded(rows, name, args, perm):
    got = await _chat_call(_token(("ai.tool.*", perm)), name, args, offered=[{"type": "function", "function": {"name": name}}])
    assert [n for n, _ in got.service.executed] == [name]
    assert rows[-1]["action"] == "ai.tool.call" and rows[-1].get("result", "success") == "success" and rows[-1]["after"]["tool"] == name


def test_only_what_is_missing_is_named():
    reason = permissions.app_permission_error(_token(("ai.tool.*", "resource.configmap.delete")), CLUSTER, "k8s_delete_resource", {"resource_type": "configmap,secret,pods"})
    assert reason and "resource.secret.delete" in reason and "resource.pod.delete" in reason and "resource.configmap.delete" not in reason


def test_mcp_offers_each_cluster_what_may_be_called_there(mcp):
    token = TokenPayload(user_id="u1", role="member", matrix={CLUSTER: TOOLS_ONLY, "prod": ("ai.mcp.use", "ai.tool.*", "resource.pod.read", "resource.*.delete")})
    alpha, prod = mcp_server._tools_allowed_in(token, CLUSTER), mcp_server._tools_allowed_in(token, "prod")
    assert "k8s_get_resources" in alpha and "k8s_get_resources" in prod
    assert "k8s_get_pod_logs" not in alpha and "k8s_get_pod_logs" in prod
    assert "k8s_delete_resource" not in alpha and "k8s_delete_resource" in prod


def test_a_feature_tool_is_not_listed_where_its_screen_permission_is_held_nowhere():
    for name in ("k8s_get_pod_logs", "logsearch", "loki_query", "alerts_list", "network_policy_check", "helm_read", "cost"):
        assert feature_gate.permitted_anywhere(name, _token(TOOLS_ONLY)) is False, name
        assert feature_gate.permitted_anywhere(name, _token(SCREEN["read_role"])) is True, name
        assert feature_gate.permitted_anywhere(name, _admin()) is True, name


def test_the_list_gate_reads_the_same_table():
    for tool, rule in screen_permissions.TOOL_SCREEN_TABLE.items():
        if rule[0] == "always" and tool not in WRITE_TOOL_NAMES:
            assert feature_gate.REQUIRED_PERMISSIONS[tool][1] == rule[1], tool


@pytest.mark.asyncio
async def test_a_card_for_a_kind_the_role_no_longer_holds_stops_at_the_run_and_says_why(monkeypatch, rows):
    args = {"resource_type": "secret", "resource_name": "x", "namespace": "shop"}
    approval = _approval("k8s_delete_resource", args)
    got = await _approve(monkeypatch, rows, _token(TOOLS_ONLY), approval)
    assert got.ran == []
    assert approval.status == "failed" and "resource.secret.delete" in approval.result
    assert next(r for r in rows if r["action"] == "ai.tool.execute")["result"] == "failure"


def test_arguments_that_are_not_an_object_count_as_every_kind():
    service = _service(_token(("ai.tool.*", "resource.configmap.delete")))
    assert "resource.*.delete" in (permissions.tool_refusal(service, "k8s_delete_resource", "not an object") or "")
    assert permissions.tool_refusal(_service(_token(SCREEN["write_role"])), "k8s_delete_resource", "not an object") is None
    assert permissions.tool_refusal(_service(_admin()), "k8s_delete_resource", "not an object") is None


def test_the_legacy_role_mode_keeps_its_rules():
    def legacy(role):
        return SimpleNamespace(token=None, user_role=role, cluster_name=CLUSTER)

    assert permissions.tool_refusal(legacy("write"), "k8s_delete_resource", {"resource_type": "secret"}) is None
    assert permissions.tool_refusal(legacy("read"), "k8s_get_pod_logs", {"pod_name": "web"}) is None
    assert "resource.pod.exec" in permissions.tool_refusal(legacy("write"), "k8s_execute_command", {"pod_name": "web"})
    assert permissions.tool_refusal(legacy("admin"), "k8s_execute_command", {"pod_name": "web"}) is None


@pytest.mark.asyncio
async def test_the_model_is_told_which_writes_a_role_with_tools_only_cannot_do(monkeypatch):
    models, _ = await _ask(monkeypatch, "이 파드 지워줘", user_role="read", token=_token(TOOLS_ONLY))
    told = " ".join(m["content"] for m in models[0] if m["role"] == "system")
    for verb in ("create", "edit", "delete"):
        assert f"resource.<kind>.{verb}" in told


@pytest.mark.asyncio
async def test_the_write_role_is_not_told_about_the_writes_it_holds(monkeypatch):
    models, _ = await _ask(monkeypatch, "이 파드 지워줘", user_role="read", token=_token(WRITE_ROLE))
    told = " ".join(m["content"] for m in models[0] if m["role"] == "system")
    assert "resource.<kind>" not in told


def test_a_manifest_too_long_to_read_counts_as_every_kind():
    long = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\ndata:\n  a: " + "x" * (257 << 10) + "\n"
    assert screen_permissions.app_permissions("k8s_apply_manifest", {"yaml_content": long}) == ["resource.*.edit"]


def test_a_manifest_that_refers_to_itself_counts_as_every_kind():
    nested = "kind: List\nitems: &a\n- kind: List\n  items: *a\n"
    assert screen_permissions.app_permissions("k8s_create_resource", {"yaml_content": nested}) == ["resource.*.create"]
