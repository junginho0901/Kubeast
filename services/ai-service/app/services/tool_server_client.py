"""
Tool server HTTP client (kubectl-based tools)
"""
import os
from typing import Optional, Dict, Any

from app.services.ai.access import trail as tool_trail
from app.services.http_shared import ScopedClient

DEFAULT_TOOL_SERVER_URL = os.getenv("TOOL_SERVER_URL", "http://tool-server:8086").rstrip("/")


class ToolServerClient:
    def __init__(self, authorization: Optional[str] = None, base_url: Optional[str] = None):
        headers: Dict[str, str] = {}
        if authorization and authorization.strip():
            headers["Authorization"] = authorization.strip()
        resolved = (base_url or DEFAULT_TOOL_SERVER_URL).rstrip("/")
        # Shared connection pool per tool-server URL; this instance only carries
        # the user's Authorization header.
        self.client = ScopedClient(resolved, timeout=60.0, headers=headers)
        # What tool-server masked in the last result ({count, kinds}) — copied
        # into the ai.tool.call audit row. Calls on one stream are sequential.
        self.last_redacted: Optional[Dict[str, Any]] = None
        # The identity the last call reached the cluster as (services/pkg/auth.Access), also on a failed call,
        # and the cluster requests it made ({requests, total}, services/pkg/accesstrail).
        self.last_access: Optional[Dict[str, Any]] = None
        self.last_requests: Optional[Dict[str, Any]] = None

    async def call_tool(
        self,
        name: str,
        arguments: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> str:
        payload = {
            "name": name,
            "arguments": arguments or {},
        }
        self.last_redacted = None
        self.last_access = None
        self.last_requests = None
        response = await self.client.post("/tools/call", json=payload, headers=headers or None)
        if response.is_error:
            # tool-server answers {"error": "..."} with the reason (a refused
            # write, a cluster 403); keep it instead of httpx's status line.
            try:
                body = response.json()
                reason = body.get("error")
                self.last_access = body.get("access") if isinstance(body.get("access"), dict) else None
                self.last_requests = tool_trail(body.get("requests"))
            except Exception:
                reason = None
            if reason:
                raise Exception(str(reason))
            response.raise_for_status()
        data = response.json()
        if isinstance(data, dict) and isinstance(data.get("access"), dict):
            self.last_access = data["access"]
        if isinstance(data, dict):
            self.last_requests = tool_trail(data.get("requests"))
        if isinstance(data, dict) and data.get("error"):
            raise Exception(str(data.get("error")))
        if isinstance(data, dict):
            redacted = data.get("redacted")
            self.last_redacted = redacted if isinstance(redacted, dict) else None
            return str(data.get("content") or "")
        return ""
