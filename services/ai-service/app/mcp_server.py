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
import uuid
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
from app.services.ai.permissions import namespace_scope_error
from app.services.ai import features as feature_gate
from app.services.ai.tools import ADMIN_READ_TOOLS, CLUSTER_METRICS_TOOLS, K8S_READONLY_TOOLS, K8S_WRITE_TOOLS
from app.services.k8s_client import K8sServiceClient
from app.services.approval_token import ApprovalTokenUnavailable, sign as sign_approval
from app.services.audit_writer import AuditUnavailable, require_audit_ready, write_audit
from app.services.tool_whitelists import write_approval_required
from app.services.http_shared import ScopedClient
from app.services.tool_server_client import ToolServerClient

logger = logging.getLogger(__name__)

from app.mcp_flags import MCP_PATH, mcp_enabled, mcp_write_tools_enabled  # noqa: F401 — re-exported for callers and tests

MCP_PERMISSION = "ai.mcp.use"
AUDIT_ACTION = "ai.mcp.call"
LIST_CLUSTERS_TOOL = "list_clusters"
API_KEY_PREFIX = "kbk_"
# An exchanged API-key token is reused for this long at most (the token itself
# lives longer); revoking the key refuses the next exchange.
EXCHANGE_CACHE_SECONDS = 60  # a granted access request shows up on the next exchange

AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "http://auth-service:8004").rstrip("/")


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
    for entry in [*CLUSTER_METRICS_TOOLS, *K8S_READONLY_TOOLS, *ADMIN_READ_TOOLS]:
        fn = entry["function"]
        tools[fn["name"]] = Tool(
            name=fn["name"],
            description=" ".join(str(fn.get("description", "")).split()),
            input_schema=_with_cluster(fn.get("parameters")),
            annotations=READ_ONLY,
        )
    return tools


READ_TOOLS: Dict[str, Tool] = _read_tools()

# The chat's write tools (app/services/ai/tools.py K8S_WRITE_TOOLS), offered only
# when MCP_WRITE_TOOLS is on and the token holds ai.tool.<name> somewhere — a key
# with a Read ceiling carries neither that nor ai.mcp.use. No approval step: the
# user's own permissions (or a granted access request) and the Argo CD guard
# apply, and the annotations tell the client which calls change the cluster.
WRITE_NON_DESTRUCTIVE = frozenset({"k8s_annotate_resource", "k8s_remove_annotation", "k8s_label_resource", "k8s_remove_label"})


def _write_tools() -> Dict[str, Tool]:
    tools: Dict[str, Tool] = {}
    for entry in K8S_WRITE_TOOLS:
        fn = entry["function"]
        tools[fn["name"]] = Tool(
            name=fn["name"],
            description=" ".join(str(fn.get("description", "")).split()),
            input_schema=_with_cluster(fn.get("parameters")),
            annotations=ToolAnnotations(
                read_only_hint=False,
                destructive_hint=fn["name"] not in WRITE_NON_DESTRUCTIVE,
                idempotent_hint=False,
                open_world_hint=False,
            ),
        )
    return tools


WRITE_TOOLS: Dict[str, Tool] = _write_tools()

REQUEST_ACCESS_TOOL = "request_access"
REQUEST_ACCESS = Tool(
    name=REQUEST_ACCESS_TOOL,
    description=(
        "Ask a Kubeast admin for a temporary role on a cluster (access request). Use it when a write tool answers "
        "forbidden; once approved, calls within that role work for the granted hours. Needs cluster, role (usually Write), "
        "duration_minutes and a reason."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "cluster": CLUSTER_ARG,
            "role": {"type": "string", "description": "Role to request, e.g. Write."},
            "duration_minutes": {"type": "integer", "minimum": 1, "description": "How long the role is needed (auth-service caps it)."},
            "reason": {"type": "string", "minLength": 3, "description": "Why — shown to the approver."},
        },
        "required": ["cluster", "role", "duration_minutes", "reason"],
        "additionalProperties": False,
    },
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False),
)

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
        "ns": {cid: list(ns) for cid, ns in (payload.namespaces or {}).items()},
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
        namespaces={cid: tuple(v) for cid, v in (claims.get("ns") or {}).items() if v},
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
        is_key = token.startswith(API_KEY_PREFIX)
        jwt_token = token
        payload: Optional[TokenPayload] = None
        for attempt in (0, 1):
            if is_key:
                jwt_token = await self._exchange_api_key(token, fresh=attempt == 1)
                if not jwt_token:
                    return None
            try:
                payload = await anyio.to_thread.run_sync(decode_access_token, jwt_token)
                break
            except HTTPException:
                # A cached exchange goes stale when auth-service revokes the user's
                # tokens (a role change, an approved access request): exchange once
                # more so the new permissions apply now, not after the cache TTL.
                if not is_key or attempt == 1:
                    return None
        if payload is None:
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

    async def _exchange_api_key(self, key: str, fresh: bool = False) -> Optional[str]:
        cache_key = hashlib.sha256(key.encode()).hexdigest()
        cached = self._cache.get(cache_key)
        now = time.monotonic()
        if cached and cached[1] > now and not fresh:
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
    names = [name for name in READ_TOOLS if payload.has_permission_for_cluster(f"ai.tool.{name}", cluster)]
    if mcp_write_tools_enabled():
        names += [name for name in WRITE_TOOLS if payload.has_permission_for_cluster(f"ai.tool.{name}", cluster)]
    return names


def _write_tools_anywhere(payload: TokenPayload) -> List[str]:
    """Write tools the token may call in at least one cluster of its matrix."""
    if not mcp_write_tools_enabled():
        return []
    clusters = [c for c in payload.matrix if c != "*"] or ["*"]
    return [name for name in WRITE_TOOLS if any(payload.has_permission_for_cluster(f"ai.tool.{name}", c) for c in clusters)]


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
            # Nothing to call yet; with write tools on the agent may still ask for a role.
            return [REQUEST_ACCESS] if mcp_write_tools_enabled() else []
        # The Admin-only read tool is listed only for a token that holds its global permission.
        tools = [LIST_CLUSTERS, *(t for n, t in READ_TOOLS.items() if feature_gate.permitted_anywhere(n, payload)), *(WRITE_TOOLS[n] for n in _write_tools_anywhere(payload))]
        if mcp_write_tools_enabled():
            tools.append(REQUEST_ACCESS)
        return tools

    async def call_tool(self, name: str, arguments: dict[str, Any], context: Context | None = None) -> CallToolResult:  # type: ignore[override]
        token = get_access_token()
        if token is None:
            return _text("authentication required", error=True)
        payload = payload_of(token)
        if name == LIST_CLUSTERS_TOOL:
            return await self._list_clusters(token, payload)
        if name == REQUEST_ACCESS_TOOL and mcp_write_tools_enabled():
            return await self._request_access(token, payload, dict(arguments or {}), context)
        tool = READ_TOOLS.get(name) or (WRITE_TOOLS.get(name) if mcp_write_tools_enabled() else None)
        if tool is None:
            return _text(f"unknown tool: {name}", error=True)
        is_write = name in WRITE_TOOLS

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
            "write": is_write,
            "resource_type": args.get("resource_type"),
            "credential": {"type": "api_key" if payload.api_key_id else "session", "akid": payload.api_key_id or None},
            "client": meta["user_agent"],
        }

        if not (_may_use_mcp(payload, cluster) and payload.has_permission_for_cluster(f"ai.tool.{name}", cluster)):
            reason = f"forbidden: {name} is not granted to you in cluster {cluster}"
            await write_audit(**audit, after=after, result="failure", error="forbidden")
            return _text(reason, error=True)
        if reason := namespace_scope_error(payload, cluster, name, args):
            await write_audit(**audit, after=after, result="failure", error="forbidden: namespace scope")
            return _text(reason, error=True)

        # The row is a precondition for a sensitive read (pod logs, describe):
        # no store, no call.
        try:
            await require_audit_ready()
        except AuditUnavailable as e:
            return _text(f"audit unavailable: {e}", error=True)

        # tool-server's approval gate (AI_WRITE_APPROVAL) exists for the chat, where
        # the model picks the call and the user approves it in a card. Here the
        # agent calls under the user's own key and the MCP client confirms
        # destructive calls, so the server signs the approval per call.
        headers: Optional[Dict[str, str]] = None
        if is_write and write_approval_required():
            approval_id = f"mcp-{uuid.uuid4().hex}"
            try:
                headers = {"X-Kubeast-Approval-Id": approval_id, "X-Kubeast-Approval-Token": sign_approval(approval_id, payload.user_id, cluster, name, args)}
            except ApprovalTokenUnavailable as e:
                await write_audit(**audit, after=after, result="failure", error=str(e))
                return _text(f"write tools are not available: {e}", error=True)
            after["approval_id"] = approval_id

        client = ToolServerClient(authorization=f"Bearer {token.token}", base_url=self._tool_server_url)
        try:
            content = await client.call_tool(name, args, headers=headers)
        except Exception as e:
            error = str(e) or e.__class__.__name__
            after["redacted"] = client.last_redacted
            await write_audit(**audit, after=after, result="failure", error=error[:500])
            return _text(error, error=True)
        after["redacted"] = client.last_redacted
        await write_audit(**audit, after=after)
        return _text(content)

    async def _request_access(self, token: AccessToken, payload: TokenPayload, args: Dict[str, Any], context: Optional[Context]) -> CallToolResult:
        """File an access request as the user. auth-service decides (feature on,
        escalation only, ceiling role, duration cap, one pending per cluster); no
        ai.mcp.use check here, since the requester usually lacks it in that very
        cluster. The agent retries after an admin approves — the granted role
        reaches the key on its next exchange (EXCHANGE_CACHE_SECONDS). Audited
        here and, by auth-service, as user.access.request."""
        try:
            jsonschema.validate(instance=args, schema=REQUEST_ACCESS.input_schema)
        except jsonschema.ValidationError as e:
            return _text(f"invalid arguments: {e.message}", error=True)
        cluster = str(args["cluster"]).strip()
        meta = _http_meta(context)
        audit: Dict[str, Any] = {
            "action": AUDIT_ACTION,
            "actor_user_id": payload.user_id,
            "actor_email": payload.email,
            "target_type": "access_request",
            "target_id": cluster,
            "cluster": cluster,
            "request_ip": meta["ip"],
            "user_agent": meta["user_agent"],
            "request_id": meta["request_id"],
            "path": MCP_PATH,
        }
        after: Dict[str, Any] = {
            "tool": REQUEST_ACCESS_TOOL,
            "write": False,
            "role": args["role"],
            "duration_minutes": args["duration_minutes"],
            "credential": {"type": "api_key" if payload.api_key_id else "session", "akid": payload.api_key_id or None},
            "client": meta["user_agent"],
        }
        try:
            await require_audit_ready()
        except AuditUnavailable as e:
            return _text(f"audit unavailable: {e}", error=True)
        try:
            res = await self._clusters.post(
                "/api/v1/auth/access-requests",
                json={"cluster_id": cluster, "role": args["role"], "duration_minutes": int(args["duration_minutes"]), "reason": str(args["reason"])},
                headers={"Authorization": f"Bearer {token.token}", "X-Requested-With": "XMLHttpRequest"},
            )
            body = res.json() if res.content else {}
            if res.status_code >= 400:
                detail = str((body or {}).get("detail") or (body or {}).get("error") or res.text)[:300]
                await write_audit(**audit, after=after, result="failure", error=f"{res.status_code}: {detail}")
                return _text(f"access request refused ({res.status_code}): {detail}", error=True)
        except Exception as e:
            await write_audit(**audit, after=after, result="failure", error=str(e)[:500])
            return _text(f"access request failed: {e}", error=True)
        after["request_id"] = (body or {}).get("id")
        await write_audit(**audit, after=after)
        return _text(json.dumps({"status": "pending", "request": body, "note": "an admin approves it in Kubeast → Access Requests; retry the call afterwards (takes effect within a minute)"}, ensure_ascii=False))

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
            if any(feature_gate.gated(name) for name in tools):
                # Feature tools only where that cluster serves them (k8s-service /features, as the caller)
                # and where the caller holds what k8s-service will ask for.
                features = None
                if any(name in feature_gate.GATES and feature_gate.permitted(name, payload, cid) for name in tools):
                    features = await feature_gate.fetch_features(K8sServiceClient(authorization=f"Bearer {token.token}", cluster_name=cid), cid)
                tools = feature_gate.gated_names(tools, features, cid, payload)
            out.append(
                {
                    "id": cid,
                    "display_name": item.get("display_name") or cid,
                    "mode": item.get("mode"),
                    "mcp": bool(tools),
                    "tools": tools,
                    "namespaces": list(payload.namespaces.get(cid, ())) or None,
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
