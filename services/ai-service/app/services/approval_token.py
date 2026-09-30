"""Approval tokens bind a write-tool execution to the approval the user gave.

The approve endpoint signs approval_id|user|cluster|tool|sha256(canonical
args)|exp with the secret shared with tool-server (AI_APPROVAL_SECRET) and
sends it as X-Kubeast-Approval-Token next to the approval id. tool-server
runs the call only if every field matches the request in front of it.
"""
import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any, Dict


class ApprovalTokenUnavailable(RuntimeError):
    """AI_APPROVAL_SECRET is not configured: write tools cannot be approved."""


def canonical_args(args: Dict[str, Any]) -> str:
    """The bytes both sides hash: sorted keys, no whitespace, ASCII-escaped,
    without the routing key "cluster" (tool-server strips it before running)."""
    filtered = {k: v for k, v in (args or {}).items() if k != "cluster"}
    return json.dumps(filtered, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def args_digest(args: Dict[str, Any]) -> str:
    return hashlib.sha256(canonical_args(args).encode("utf-8")).hexdigest()


def secret() -> str:
    return os.getenv("AI_APPROVAL_SECRET", "").strip()


def sign(approval_id: str, user_id: str, cluster: str, tool: str, args: Dict[str, Any], ttl_seconds: int = 120) -> str:
    key = secret()
    if not key:
        raise ApprovalTokenUnavailable("AI_APPROVAL_SECRET is not configured")
    exp = int(time.time()) + ttl_seconds
    payload = "|".join([approval_id, user_id, cluster, tool, args_digest(args), str(exp)])
    b64 = base64.urlsafe_b64encode(payload.encode("utf-8")).rstrip(b"=").decode("ascii")
    sig = hmac.new(key.encode("utf-8"), b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{b64}.{sig}"


def verify(token: str, approval_id: str, user_id: str, cluster: str, tool: str, args: Dict[str, Any]) -> bool:
    """Mirror of tool-server's check, kept here so the two sides can be tested
    against each other."""
    key = secret()
    if not key or "." not in token:
        return False
    b64, sig = token.rsplit(".", 1)
    want = hmac.new(key.encode("utf-8"), b64.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, sig):
        return False
    try:
        payload = base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)).decode("utf-8")
    except Exception:
        return False
    fields = payload.split("|")
    if len(fields) != 6 or int(fields[5]) < int(time.time()):
        return False
    return fields[:5] == [approval_id, user_id, cluster, tool, args_digest(args)]
