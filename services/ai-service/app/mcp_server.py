"""MCP server: an external AI agent's way into the clusters, through Kubeast.

Claude Code, Cursor and the like connect to /api/v1/ai/mcp (Streamable HTTP)
with a Kubeast API key or access token instead of a kubeconfig. Every tool
call then runs as that user: the user's cluster role (tool-server impersonates
them), the read tools the chat offers, the same masking of what leaves for a
model, and an audit row (ai.mcp.call) per call — refused while the row cannot
be stored. Read tools only; nothing here changes a cluster.

Stateless with JSON responses: there is no session to hijack, any replica
answers, and the bearer token is checked on every request (MCP spec,
Security Best Practices). MCP_ENABLED (chart `mcp.enabled`) mounts it.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

import anyio
import jsonschema
from fastapi import HTTPException
from mcp.server.auth.middleware.auth_context import AuthContextMiddleware, get_access_token
from mcp.server.auth.middleware.bearer_auth import BearerAuthBackend, RequireAuthMiddleware
from mcp.server.auth.provider import AccessToken
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent, Tool, ToolAnnotations
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.types import ASGIApp

from app.security import TokenPayload, decode_access_token
from app.services.ai.tools import CLUSTER_METRICS_TOOLS, K8S_READONLY_TOOLS
from app.services.audit_writer import AuditUnavailable, require_audit_ready, write_audit
from app.services.http_shared import ScopedClient
from app.services.tool_server_client import ToolServerClient

logger = logging.getLogger(__name__)

MCP_PATH = "/api/v1/ai/mcp"
MCP_PERMISSION = "ai.mcp.use"
AUDIT_ACTION = "ai.mcp.call"
LIST_CLUSTERS_TOOL = "list_clusters"
API_KEY_PREFIX = "kbk_"
# An exchanged API-key token is reused for this long at most (the token itself
# lives longer); revoking the key refuses the next exchange.
EXCHANGE_CACHE_SECONDS = 300

AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "http://auth-service:8004").rstrip("/")


def mcp_enabled() -> bool:
    return os.getenv("MCP_ENABLED", "false").strip().lower() == "true"


# ---------------------------------------------------------------------------
# Tools: the chat's read tools, each with a required `cluster` argument.

READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)

CLUSTER_ARG = {"type": "string", "description": "Cluster id, from list_clusters."}


def _with_cluster(parameters: Dict[str, Any]) -> Dict[str, Any]:
    schema = copy.deepcopy(parameters or {"type": "object", "properties": {}})
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})["cluster"] = CLUSTER_ARG
    schema["required"] = [*[r for r in schema.get("required", []) if r != "cluster"], "cluster"]
    schema["additionalProperties"] = False
    return schema


def _read_tools() -> Dict[str, Tool]:
    tools: Dict[str, Tool] = {}
    for entry in [*CLUSTER_METRICS_TOOLS, *K8S_READONLY_TOOLS]:
        fn = entry["function"]
        tools[fn["name"]] = Tool(
            name=fn["name"],
            description=" ".join(str(fn.get("description", "")).split()),
            input_schema=_with_cluster(fn.get("parameters")),
            annotations=READ_ONLY,
        )
    return tools


READ_TOOLS: Dict[str, Tool] = _read_tools()

LIST_CLUSTERS = Tool(
    name=LIST_CLUSTERS_TOOL,
    description="Clusters you can reach through Kubeast, with the tools you may call in each. Call this first; every other tool needs a cluster id.",
    input_schema={"type": "object", "properties": {}, "additionalProperties": False},
    annotations=READ_ONLY,
)


# ---------------------------------------------------------------------------
# Who is calling: a Kubeast access token, or an API key exchanged for one.

def _payload_to_claims(payload: TokenPayload) -> Dict[str, Any]:
    return {
        "email": payload.email,
        "role": payload.role,
        "matrix": {cid: list(perms) for cid, perms in payload.matrix.items()},
        "akid": payload.api_key_id,
    }


def payload_of(token: AccessToken) -> TokenPayload:
    claims = token.claims or {}
    matrix = {cid: tuple(perms) for cid, perms in (claims.get("matrix") or {}).items()}
    return TokenPayload(
        user_id=token.subject or "",
        role=str(claims.get("role") or "read"),
        email=str(claims.get("email") or ""),
        permissions=matrix.get("*", ()),
        matrix=matrix,
        api_key_id=str(claims.get("akid") or ""),
    )


class KubeastTokenVerifier:
    """TokenVerifier for the SDK's bearer middleware.

    A `kbk_` API key is exchanged at auth-service for the short access token
    every service validates (the exchange is audited there); the token is then
    verified like any other — signature, audience, expiry, token version.
    """

    def __init__(self, auth_service_url: str = AUTH_SERVICE_URL):
        self._exchange = ScopedClient(auth_service_url, timeout=10.0)
        self._cache: Dict[str, tuple[str, float]] = {}

    async def verify_token(self, token: str) -> AccessToken | None:
        token = token.strip()
        if not token:
            return None
        jwt_token = token
        if token.startswith(API_KEY_PREFIX):
            jwt_token = await self._exchange_api_key(token)
            if not jwt_token:
                return None
        try:
            payload = await anyio.to_thread.run_sync(decode_access_token, jwt_token)
        except HTTPException:
            return None
        if (payload.role or "").lower() == "pending":
            return None
        return AccessToken(
            token=jwt_token,
            client_id=f"api_key:{payload.api_key_id}" if payload.api_key_id else "session",
            scopes=[],
            subject=payload.user_id,
            claims=_payload_to_claims(payload),
        )

    async def _exchange_api_key(self, key: str) -> Optional[str]:
        cache_key = hashlib.sha256(key.encode()).hexdigest()
        cached = self._cache.get(cache_key)
        now = time.monotonic()
        if cached and cached[1] > now:
            return cached[0]
        try:
            res = await self._exchange.post("/api/v1/auth/token", headers={"Authorization": f"Bearer {key}"})
        except Exception as e:  # network: the key cannot be checked, so it is refused
            logger.warning("mcp: api key exchange failed: %s", e)
            return None
        if res.status_code != 200:
            self._cache.pop(cache_key, None)
            return None
        data = res.json() if res.content else {}
        jwt_token = str(data.get("access_token") or "")
        if not jwt_token:
            return None
        ttl = min(EXCHANGE_CACHE_SECONDS, int(data.get("expires_in") or EXCHANGE_CACHE_SECONDS))
        self._cache[cache_key] = (jwt_token, now + max(ttl - 5, 1))
        return jwt_token


# ---------------------------------------------------------------------------
# The server.

def _text(text: str, *, error: bool = False) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=error)


def _may_use_mcp(payload: TokenPayload, cluster: Optional[str] = None) -> bool:
    if cluster is not None:
        return payload.has_permission_for_cluster(MCP_PERMISSION, cluster)
    if payload.has_permission(MCP_PERMISSION):
        return True
    return any(payload.has_permission_for_cluster(MCP_PERMISSION, cid) for cid in payload.matrix if cid != "*")


def _tools_allowed_in(payload: TokenPayload, cluster: str) -> List[str]:
    if not _may_use_mcp(payload, cluster):
        return []
    return [name for name in READ_TOOLS if payload.has_permission_for_cluster(f"ai.tool.{name}", cluster)]


def _http_meta(context: Optional[Context]) -> Dict[str, str]:
    headers = (context.headers if context is not None else None) or {}
    request = getattr(getattr(context, "request_context", None), "request", None)
    client = getattr(request, "client", None)
    ip = str(headers.get("x-real-ip", "")).strip() or (getattr(client, "host", "") or "")
    return {
        "ip": ip,
        "user_agent": str(headers.get("user-agent", "")),
        "request_id": str(headers.get("x-request-id", "")),
    }


class KubeastMCPServer(MCPServer):
    """Lists and runs the chat's read tools for the authenticated user.

    The tool catalogue is the chat's (app/services/ai/tools.py), so the two
    never drift; a tool runs through tool-server with the user's own token,
    which impersonates the user in the cluster and masks the result.
    """

    def __init__(self, tool_server_url: Optional[str] = None, auth_service_url: str = AUTH_SERVICE_URL):
        super().__init__(
            name="Kubeast",
            instructions=(
                "Kubernetes clusters through Kubeast, as the signed-in user. Call list_clusters first and pass "
                "its cluster id to every other tool. Tools are read-only; Secret values are masked."
            ),
        )
        self._tool_server_url = tool_server_url
        self._clusters = ScopedClient(auth_service_url, timeout=10.0)

    async def list_tools(self) -> list[Tool]:
        token = get_access_token()
        if token is None:
            return []
        payload = payload_of(token)
        if not _may_use_mcp(payload):
            return []
        return [LIST_CLUSTERS, *READ_TOOLS.values()]

    async def call_tool(self, name: str, arguments: dict[str, Any], context: Context | None = None) -> CallToolResult:  # type: ignore[override]
        token = get_access_token()
        if token is None:
            return _text("authentication required", error=True)
        payload = payload_of(token)
        if name == LIST_CLUSTERS_TOOL:
            return await self._list_clusters(token, payload)
        tool = READ_TOOLS.get(name)
        if tool is None:
            return _text(f"unknown tool: {name}", error=True)

        args = dict(arguments or {})
        cluster = args.get("cluster")
        if not isinstance(cluster, str) or not cluster.strip():
            return _text("cluster is required: call list_clusters and pass a cluster id", error=True)
        cluster = cluster.strip()
        args["cluster"] = cluster
        try:
            jsonschema.validate(instance=args, schema=tool.input_schema)
        except jsonschema.ValidationError as e:
            return _text(f"invalid arguments: {e.message}", error=True)

        meta = _http_meta(context)
        audit: Dict[str, Any] = {
            "action": AUDIT_ACTION,
            "actor_user_id": payload.user_id,
            "actor_email": payload.email,
            "target_type": args.get("resource_type") or "tool",
            "target_id": args.get("resource_name") or args.get("name") or args.get("pod_name") or name,
            "namespace": args.get("namespace"),
            "cluster": cluster,
            "request_ip": meta["ip"],
            "user_agent": meta["user_agent"],
            "request_id": meta["request_id"],
            "path": MCP_PATH,
        }
        after: Dict[str, Any] = {
            "tool": name,
            "resource_type": args.get("resource_type"),
            "credential": {"type": "api_key" if payload.api_key_id else "session", "akid": payload.api_key_id or None},
            "client": meta["user_agent"],
        }

        if not (_may_use_mcp(payload, cluster) and payload.has_permission_for_cluster(f"ai.tool.{name}", cluster)):
            reason = f"forbidden: {name} is not granted to you in cluster {cluster}"
            await write_audit(**audit, after=after, result="failure", error="forbidden")
            return _text(reason, error=True)

        # The row is a precondition for a sensitive read (pod logs, describe):
        # no store, no call.
        try:
            await require_audit_ready()
        except AuditUnavailable as e:
            return _text(f"audit unavailable: {e}", error=True)

        client = ToolServerClient(authorization=f"Bearer {token.token}", base_url=self._tool_server_url)
        try:
            content = await client.call_tool(name, args)
        except Exception as e:
            error = str(e) or e.__class__.__name__
            after["redacted"] = client.last_redacted
            await write_audit(**audit, after=after, result="failure", error=error[:500])
            return _text(error, error=True)
        after["redacted"] = client.last_redacted
        await write_audit(**audit, after=after)
        return _text(content)

    async def _list_clusters(self, token: AccessToken, payload: TokenPayload) -> CallToolResult:
        try:
            # accessibleOnly: the clusters the caller holds a grant on (the admin-only
            # listing without it answers 403 for everyone else).
            res = await self._clusters.get(
                "/api/v1/clusters", params={"accessibleOnly": "true"}, headers={"Authorization": f"Bearer {token.token}"}
            )
            res.raise_for_status()
            items = (res.json() or {}).get("items") or []
        except Exception as e:
            return _text(f"could not list clusters: {e}", error=True)
        out = []
        for item in items:
            cid = str(item.get("id") or "")
            if not cid:
                continue
            tools = _tools_allowed_in(payload, cid)
            out.append(
                {
                    "id": cid,
                    "display_name": item.get("display_name") or cid,
                    "mode": item.get("mode"),
                    "mcp": bool(tools),
                    "tools": tools,
                }
            )
        return _text(json.dumps({"clusters": out}, ensure_ascii=False))


def build_mcp_app(server: KubeastMCPServer, verifier: Optional[KubeastTokenVerifier] = None) -> ASGIApp:
    """The ASGI app for MCP_PATH: bearer auth around the SDK's Streamable HTTP app.

    The SDK's own auth setup also advertises an OAuth authorization server
    (RFC 9728 metadata); Kubeast has none, so the same middleware is stacked
    here without it — a missing or invalid token gets a plain 401.
    """
    inner = server.streamable_http_app(
        streamable_http_path=MCP_PATH,
        json_response=True,
        stateless_http=True,
        # Host/Origin checks guard local servers that trust the caller; this one
        # sits behind the gateway and trusts nothing but the bearer token.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    verifier = verifier or KubeastTokenVerifier()
    return AuthenticationMiddleware(
        AuthContextMiddleware(RequireAuthMiddleware(inner, required_scopes=[])),
        backend=BearerAuthBackend(verifier),
    )
