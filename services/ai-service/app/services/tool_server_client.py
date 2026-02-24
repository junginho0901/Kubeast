"""
Tool server HTTP client (kubectl-based tools)
"""
import os
from typing import Optional, Dict, Any
import httpx

TOOL_SERVER_URL = os.getenv("TOOL_SERVER_URL", "http://tool-server:8086").rstrip("/")


class ToolServerClient:
    def __init__(self, authorization: Optional[str] = None):
        headers: Dict[str, str] = {}
        if authorization and authorization.strip():
            headers["Authorization"] = authorization.strip()
        self.client = httpx.AsyncClient(base_url=TOOL_SERVER_URL, timeout=60.0, headers=headers)

    async def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> str:
        payload = {
            "name": name,
            "arguments": arguments or {},
        }
        response = await self.client.post("/tools/call", json=payload)
        response.raise_for_status()
        data = response.json()
        if isinstance(data, dict) and data.get("error"):
            raise Exception(str(data.get("error")))
        if isinstance(data, dict):
            return str(data.get("content") or "")
        return ""
