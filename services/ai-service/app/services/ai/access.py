"""The identity an AI tool call reached a cluster as (services/pkg/auth.Access) and the cluster requests it made,
each with its Audit-ID (services/pkg/accesstrail), as tool-server or k8s-service reported them — never worked out
here — and their section in the chat's tool block (frontend/src/services/toolAccess.ts writes the same while the
answer streams)."""
import base64
import html
import json
from typing import Any, Dict, Optional

HEADER = "X-Kubeast-Access"
RECORD_HEADER = "X-Kubeast-Record"
REQUESTS_HEADER = "X-Kubeast-Requests"
MAX_REQUESTS = 20


def _decode(value: Optional[str]) -> Any:
    if not value:
        return None
    try:
        return json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
    except ValueError:
        return None


def from_header(value: Optional[str]) -> Optional[Dict[str, Any]]:
    """k8s-service's X-Kubeast-Access header (base64url JSON); None when absent or unreadable."""
    data = _decode(value)
    return data if isinstance(data, dict) else None


def trail(value: Any) -> Optional[Dict[str, Any]]:
    """A requests trail ({requests, total}) as a service sent it; None unless it has that shape."""
    if isinstance(value, dict) and isinstance(value.get("requests"), list) and isinstance(value.get("total"), int):
        return {"requests": [r for r in value["requests"] if isinstance(r, dict)][:MAX_REQUESTS], "total": value["total"]}
    return None


def trail_from_header(value: Optional[str]) -> Optional[Dict[str, Any]]:
    """k8s-service's X-Kubeast-Requests header."""
    return trail(_decode(value))


def merge(a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Two trails of one call as one: the first MAX_REQUESTS and the total of both."""
    if not a or not b:
        return a or b
    return {"requests": (a["requests"] + b["requests"])[:MAX_REQUESTS], "total": a["total"] + b["total"]}


def reset(service) -> None:
    """Forget what the previous tool reported, so a tool that reaches no cluster shows nothing of another's."""
    for client in (getattr(service, "tool_server", None), getattr(service, "k8s_service", None)):
        if client is not None:
            client.last_access = None
            client.last_requests = None
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


def requests_of_call(service) -> Optional[Dict[str, Any]]:
    """The cluster requests the tool just run made: tool-server's list, else what k8s-service listed."""
    for client in (getattr(service, "tool_server", None), getattr(service, "k8s_service", None)):
        if trail(getattr(client, "last_requests", None)):
            return client.last_requests
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


def _request_text(r: Dict[str, Any]) -> str:
    if r.get("source") == "cache":
        return f"answered from Kubeast's own store ({html.escape(str(r.get('cache') or ''))}), no cluster request"
    verb = html.escape(str(r.get("verb") or ""))
    if r.get("resource"):
        what = "/".join(str(x) for x in (r.get("group"), r.get("resource"), r.get("subresource")) if x)
        what = html.escape(what) + (f" {html.escape(str(r['name']))}" if r.get("name") else "")
    else:
        what = html.escape(str(r.get("path") or ""))
    where = f" in {html.escape(str(r['namespace']))}" if r.get("namespace") else ""
    status = f" → {int(r['status'])}" if isinstance(r.get("status"), int) and r["status"] else " → no answer"
    audit = ""
    if r.get("audit_id"):
        audit = f" · Audit-ID {_code(str(r['audit_id']))}" + (" ✓" if r.get("echoed") else " (not echoed)")
    return f"{verb} {what}{where}{status}{audit}"


def requests_block(value: Optional[Dict[str, Any]]) -> str:
    """The folded list of a call's cluster requests under its 🔐 line; empty without any."""
    t = trail(value)
    if not t or t["total"] <= 0:
        return ""
    items = [f"<li>{_request_text(r)}</li>" for r in t["requests"]]
    if t["total"] > len(t["requests"]):
        items.append(f"<li>and {t['total'] - len(t['requests'])} more</li>")
    return (f"<details>\n<summary><strong>🧾 Cluster requests ({t['total']})</strong></summary>\n\n<ul>\n"
            + "\n".join(items) + "\n</ul>\n\n</details>")


def section(access: Optional[Dict[str, Any]], requests: Optional[Dict[str, Any]]) -> str:
    """What goes under a tool block's name: the 🔐 line, then the requests."""
    return "\n\n".join(part for part in (line(access), requests_block(requests)) if part)
