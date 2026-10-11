"""The MCP server runs the chat's read tools as the caller, through tool-server,
with an audit row per call. Driven over the real Streamable HTTP transport
(stateless, JSON responses) with the verifier, tool-server and audit store
replaced by fakes."""
from __future__ import annotations

from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi import HTTPException
from starlette.applications import Starlette
from starlette.routing import Route

from app import mcp_server
from app.security import TokenPayload
from app.services.audit_writer import AuditUnavailable

MATRIX_WRITE = {"self": ("ai.tool.*", "ai.mcp.use", "resource.*.read"), "default": ("resource.*.read",)}
TOKENS = {
    "tok-write": TokenPayload(user_id="u-write", role="member", email="w@example.com", matrix=MATRIX_WRITE),
    "tok-read": TokenPayload(user_id="u-read", role="member", email="r@example.com", matrix={"self": ("resource.*.read",)}),
    "tok-pending": TokenPayload(user_id="u-p", role="pending", email="p@example.com", matrix={}),
    "tok-admin": TokenPayload(user_id="u-admin", role="admin", email="a@example.com", permissions=("*",), matrix={"*": ("*",)}),
    "tok-key": TokenPayload(user_id="u-write", role="member", email="w@example.com", matrix=MATRIX_WRITE, api_key_id="k-1"),
}

RPC_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


class FakeToolServer:
    calls: list = []
    content = "pod-a\npod-b"
    fail: str | None = None

    def __init__(self, authorization=None, base_url=None):
        self.authorization = authorization
        self.last_redacted = None

    async def call_tool(self, name, arguments=None, headers=None):
        FakeToolServer.calls.append((self.authorization, name, dict(arguments or {})))
        if FakeToolServer.fail:
            raise Exception(FakeToolServer.fail)
        self.last_redacted = {"count": 1, "kinds": ["key_name"]}
        return FakeToolServer.content


@pytest.fixture
def fakes(monkeypatch):
    audit_rows: list = []
    FakeToolServer.calls = []
    FakeToolServer.fail = None

    def decode(token):
        if token not in TOKENS:
            raise HTTPException(status_code=401, detail="Invalid token")
        return TOKENS[token]

    async def write_audit(**kwargs):
        audit_rows.append(kwargs)
        return True

    state = {"audit_ok": True}

    async def ready():
        if not state["audit_ok"]:
            raise AuditUnavailable("db down")

    monkeypatch.setattr(mcp_server, "decode_access_token", decode)
    monkeypatch.setattr(mcp_server, "ToolServerClient", FakeToolServer)
    monkeypatch.setattr(mcp_server, "write_audit", write_audit)
    monkeypatch.setattr(mcp_server, "require_audit_ready", ready)
    return {"audit": audit_rows, "state": state}


@asynccontextmanager
async def running_app(server: mcp_server.KubeastMCPServer, verifier=None):
    asgi = mcp_server.build_mcp_app(server, verifier)
    app = Starlette(routes=[Route(mcp_server.MCP_PATH, asgi)])
    async with server.session_manager.run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://kubeast") as client:
            yield client


def rpc(method, params=None, rid=1):
    body = {"jsonrpc": "2.0", "id": rid, "method": method}
    if params is not None:
        body["params"] = params
    return body


async def call(client, token, method, params=None):
    headers = dict(RPC_HEADERS)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return await client.post(mcp_server.MCP_PATH, json=rpc(method, params), headers=headers)


def tool_names(res):
    return sorted(t["name"] for t in res.json()["result"]["tools"])


@pytest.mark.asyncio
async def test_list_tools_is_read_only_and_needs_the_permission(fakes):
    server = mcp_server.KubeastMCPServer(tool_server_url="http://tools")
    async with running_app(server) as client:
        res = await call(client, "tok-write", "tools/list")
        assert res.status_code == 200, res.text
        names = tool_names(res)
        assert "list_clusters" in names and "k8s_get_pod_logs" in names and "get_node_metrics" in names
        assert len(names) == len(mcp_server.READ_TOOLS) + 1
        assert not any(n.startswith(("k8s_apply", "k8s_delete", "k8s_scale", "k8s_execute")) for n in names)
        tools = res.json()["result"]["tools"]
        assert all(t["annotations"]["readOnlyHint"] is True for t in tools)
        logs = next(t for t in tools if t["name"] == "k8s_get_pod_logs")
        assert "cluster" in logs["inputSchema"]["required"] and "pod_name" in logs["inputSchema"]["required"]

        # Read on self only: ai.mcp.use is not granted anywhere → nothing to call.
        assert tool_names(await call(client, "tok-read", "tools/list")) == []
        # A global admin sees everything.
        assert len(tool_names(await call(client, "tok-admin", "tools/list"))) == len(mcp_server.READ_TOOLS) + 1


@pytest.mark.asyncio
async def test_missing_or_bad_token_is_401(fakes):
    server = mcp_server.KubeastMCPServer(tool_server_url="http://tools")
    async with running_app(server) as client:
        res = await call(client, None, "tools/list")
        assert res.status_code == 401 and res.headers.get("www-authenticate", "").startswith("Bearer")
        assert (await call(client, "tok-nope", "tools/list")).status_code == 401
        # A pending account holds a session only to see its own state.
        assert (await call(client, "tok-pending", "tools/list")).status_code == 401


@pytest.mark.asyncio
async def test_call_runs_as_the_user_and_is_audited(fakes):
    server = mcp_server.KubeastMCPServer(tool_server_url="http://tools")
    async with running_app(server) as client:
        res = await call(client, "tok-key", "tools/call", {"name": "k8s_get_resources", "arguments": {"cluster": "self", "resource_type": "pods", "namespace": "kubeast"}})
        assert res.status_code == 200, res.text
        result = res.json()["result"]
        assert result.get("isError") in (None, False)
        assert result["content"][0]["text"] == "pod-a\npod-b"
    # tool-server got the user's own token and the cluster the agent named
    assert FakeToolServer.calls == [("Bearer tok-key", "k8s_get_resources", {"cluster": "self", "resource_type": "pods", "namespace": "kubeast"})]
    rows = fakes["audit"]
    assert len(rows) == 1
    row = rows[0]
    assert row["action"] == "ai.mcp.call" and row.get("result", "success") == "success"
    assert row["actor_user_id"] == "u-write" and row["cluster"] == "self" and row["namespace"] == "kubeast"
    assert row["target_type"] == "pods" and row["target_id"] == "k8s_get_resources" and row["path"] == mcp_server.MCP_PATH
    assert row["after"]["credential"] == {"type": "api_key", "akid": "k-1"}
    assert row["after"]["redacted"] == {"count": 1, "kinds": ["key_name"]}


@pytest.mark.asyncio
async def test_call_outside_the_grant_is_refused_and_audited(fakes):
    server = mcp_server.KubeastMCPServer(tool_server_url="http://tools")
    async with running_app(server) as client:
        # Read on default, no ai.mcp.use / ai.tool.* there.
        res = await call(client, "tok-write", "tools/call", {"name": "k8s_get_resources", "arguments": {"cluster": "default", "resource_type": "pods"}})
        result = res.json()["result"]
        assert result["isError"] is True and "forbidden" in result["content"][0]["text"]
        # No cluster: told to call list_clusters, nothing audited.
        res = await call(client, "tok-write", "tools/call", {"name": "k8s_get_resources", "arguments": {"resource_type": "pods"}})
        assert res.json()["result"]["isError"] is True and "list_clusters" in res.json()["result"]["content"][0]["text"]
        # Unknown argument: refused before anything runs.
        res = await call(client, "tok-write", "tools/call", {"name": "k8s_get_events", "arguments": {"cluster": "self", "bogus": 1}})
        assert res.json()["result"]["isError"] is True and "invalid arguments" in res.json()["result"]["content"][0]["text"]
    assert FakeToolServer.calls == []
    assert [(r["result"], r["error"], r["cluster"]) for r in fakes["audit"]] == [("failure", "forbidden", "default")]


@pytest.mark.asyncio
async def test_no_audit_store_no_call(fakes):
    fakes["state"]["audit_ok"] = False
    server = mcp_server.KubeastMCPServer(tool_server_url="http://tools")
    async with running_app(server) as client:
        res = await call(client, "tok-write", "tools/call", {"name": "k8s_get_pod_logs", "arguments": {"cluster": "self", "pod_name": "p"}})
        result = res.json()["result"]
        assert result["isError"] is True and "audit unavailable" in result["content"][0]["text"]
    assert FakeToolServer.calls == [] and fakes["audit"] == []


@pytest.mark.asyncio
async def test_tool_failure_is_an_error_result_with_a_failure_row(fakes):
    FakeToolServer.fail = "cluster kubeconfig: not found"
    server = mcp_server.KubeastMCPServer(tool_server_url="http://tools")
    async with running_app(server) as client:
        res = await call(client, "tok-write", "tools/call", {"name": "get_node_metrics", "arguments": {"cluster": "self"}})
        assert res.json()["result"]["isError"] is True
    assert fakes["audit"][0]["result"] == "failure" and "kubeconfig" in fakes["audit"][0]["error"]


@pytest.mark.asyncio
async def test_list_clusters_names_the_tools_allowed_in_each(fakes, monkeypatch):
    server = mcp_server.KubeastMCPServer(tool_server_url="http://tools")

    class Res:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"items": [{"id": "self", "display_name": "self", "mode": "self"}, {"id": "default", "display_name": "kind-b", "mode": "external"}]}

    async def get(url, **kwargs):
        assert url == "/api/v1/clusters" and kwargs["headers"]["Authorization"] == "Bearer tok-write"
        assert kwargs["params"] == {"accessibleOnly": "true"}
        return Res()

    monkeypatch.setattr(server._clusters, "get", get)
    async with running_app(server) as client:
        res = await call(client, "tok-write", "tools/call", {"name": "list_clusters", "arguments": {}})
        import json

        data = json.loads(res.json()["result"]["content"][0]["text"])
    by_id = {c["id"]: c for c in data["clusters"]}
    assert by_id["self"]["mcp"] is True and set(by_id["self"]["tools"]) == set(mcp_server.READ_TOOLS)
    assert by_id["default"]["mcp"] is False and by_id["default"]["tools"] == []
    assert fakes["audit"] == []


@pytest.mark.asyncio
async def test_api_key_is_exchanged_once_and_cached(fakes, monkeypatch):
    verifier = mcp_server.KubeastTokenVerifier(auth_service_url="http://auth")
    exchanges = []

    class Res:
        def __init__(self, status, body):
            self.status_code = status
            self._body = body
            self.content = b"x"

        def json(self):
            return self._body

    async def post(url, **kwargs):
        exchanges.append(kwargs["headers"]["Authorization"])
        key = kwargs["headers"]["Authorization"].split(" ", 1)[1]
        if key == "kbk_good":
            return Res(200, {"access_token": "tok-key", "expires_in": 3600, "token_type": "Bearer"})
        return Res(401, {"detail": "unknown or revoked key"})

    monkeypatch.setattr(verifier._exchange, "post", post)
    server = mcp_server.KubeastMCPServer(tool_server_url="http://tools")
    async with running_app(server, verifier) as client:
        assert (await call(client, "kbk_good", "tools/list")).status_code == 200
        assert (await call(client, "kbk_good", "tools/list")).status_code == 200
        assert (await call(client, "kbk_revoked", "tools/list")).status_code == 401
    assert exchanges == ["Bearer kbk_good", "Bearer kbk_revoked"]


def test_disabled_by_default_and_config_route():
    import os

    from fastapi.testclient import TestClient

    from main import app
    from app.security import require_auth

    assert os.getenv("MCP_ENABLED", "false") != "true"
    with TestClient(app) as client:
        # Not mounted: the path answers like any unknown one.
        assert client.post(mcp_server.MCP_PATH, json=rpc("tools/list"), headers=RPC_HEADERS).status_code == 404
        app.dependency_overrides[require_auth] = lambda: TOKENS["tok-write"]
        try:
            res = client.get("/api/v1/ai/mcp/config")
        finally:
            app.dependency_overrides.pop(require_auth, None)
    assert res.status_code == 200 and res.json() == {"enabled": False, "path": mcp_server.MCP_PATH}
