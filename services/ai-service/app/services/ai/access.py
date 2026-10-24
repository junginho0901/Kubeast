"""The identity an AI tool call reached a cluster as (services/pkg/auth.Access), as tool-server or k8s-service
reported it — never worked out here — and its line in the chat's tool block (frontend/src/services/toolAccess.ts
writes the same line while the answer streams)."""
import base64
import html
import json
from typing import Any, Dict, Optional

HEADER = "X-Kubeast-Access"


def from_header(value: Optional[str]) -> Optional[Dict[str, Any]]:
    """k8s-service's X-Kubeast-Access header (base64url JSON); None when absent or unreadable."""
    if not value:
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def reset(service) -> None:
    """Forget what the previous tool reported, so a tool that reaches no cluster shows nothing of another's."""
    for client in (getattr(service, "tool_server", None), getattr(service, "k8s_service", None)):
        if client is not None:
            client.last_access = None
    if getattr(service, "tool_server", None) is not None:
        service.tool_server.last_redacted = None


def with_mode(access: Optional[Dict[str, Any]], function_name: str) -> Optional[Dict[str, Any]]:
    """access with whether the tool writes; None stays None."""
    from app.services.tool_whitelists import WRITE_TOOL_NAMES
    if not isinstance(access, dict):
        return None
    return {**access, "mode": "write" if function_name in WRITE_TOOL_NAMES else "read"}


def of_call(service, function_name: str) -> Optional[Dict[str, Any]]:
    """The identity the tool just run reached its cluster as: tool-server's answer, else k8s-service's."""
    for client in (getattr(service, "tool_server", None), getattr(service, "k8s_service", None)):
        if isinstance(getattr(client, "last_access", None), dict):
            return with_mode(client.last_access, function_name)
    return None


def _code(s: str) -> str:
    return f"<code>{html.escape(s)}</code>"


def line(access: Optional[Dict[str, Any]]) -> str:
    """The 🔐 line under a tool block's name: who the cluster saw, the Kubeast role and scope behind it, read or
    write. Empty without an identity."""
    if not isinstance(access, dict):
        return ""
    kind = access.get("kind")
    parts = []
    if not access.get("impersonation"):
        parts.append("⚠️ Kubeast's own credential, not this user's permissions (impersonation is off)")
    else:
        who = _code(str(access.get("user") or ""))
        if kind == "api_key":
            who += " (API key)"
        parts.append(who)
        groups = [g for g in access.get("groups") or [] if isinstance(g, str)]
        if groups:
            parts.append("groups " + " ".join(_code(g) for g in groups))
    if kind == "investigator":
        parts.append("alert investigator")
    elif kind == "person" or kind == "api_key":
        role = str(access.get("role") or "")
        parts.append("global admin" if role == "*" else f"role {html.escape(role)}" if role else "no role in this cluster")
        namespaces = [n for n in access.get("namespaces") or [] if isinstance(n, str)]
        parts.append("namespaces " + ", ".join(html.escape(n) for n in namespaces) if namespaces else "whole cluster")
    parts.append("write" if access.get("mode") == "write" else "read-only")
    return "<p><strong>🔐 Ran as:</strong> " + " · ".join(parts) + "</p>"
