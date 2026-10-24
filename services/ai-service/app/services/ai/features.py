"""Feature tools are offered only where the cluster can serve them.

A tool that reads Prometheus or the log store through k8s-service is left out
of the tool list when the cluster has no such feature (k8s-service GET
/features), so the model is not handed a tool that can only answer
"unavailable" and the tool definitions do not cost tokens for nothing. The
chat, the floating widget, alert investigations and the MCP server's
list_clusters all go through here. Features are cached a minute per cluster.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, Iterable, List, Optional

log = logging.getLogger(__name__)

TTL_SECONDS = 60.0


def _prometheus_on(features: Dict[str, Any], cluster: str) -> bool:
    return bool((features.get("prometheus") or {}).get("enabled"))


def _logsearch_on(features: Dict[str, Any], cluster: str) -> bool:
    ls = features.get("logSearch") or {}
    if not ls.get("enabled"):
        return False
    clusters = ls.get("clusters") or []
    return not cluster or cluster in clusters


def _trace_store_on(features: Dict[str, Any], cluster: str) -> bool:
    ts = features.get("traceStore") or {}
    if not ts.get("enabled"):
        return False
    return not cluster or cluster in (ts.get("clusters") or [])


def _alert_store_on(features: Dict[str, Any], cluster: str) -> bool:
    al = features.get("alertStore") or {}
    if not al.get("enabled"):
        return False
    return not cluster or cluster in (al.get("clusters") or [])


def _network_flows_on(features: Dict[str, Any], cluster: str) -> bool:
    nf = features.get("networkFlows") or {}
    if not nf.get("enabled"):
        return False
    return not cluster or cluster in (nf.get("clusters") or [])


def _cost_on(features: Dict[str, Any], cluster: str) -> bool:
    return bool((features.get("cost") or {}).get("enabled"))


def _policy_reports_on(features: Dict[str, Any], cluster: str) -> bool:
    return bool((features.get("policyReports") or {}).get("enabled"))


# tool name → does this cluster serve it. Tools not listed are always offered.
GATES: Dict[str, Callable[[Dict[str, Any], str], bool]] = {
    "prometheus_query": _prometheus_on,
    "prometheus_metrics": _prometheus_on,
    "prometheus_labels": _prometheus_on,
    "prometheus_rules": _prometheus_on,
    "prometheus_targets": _prometheus_on,
    "logsearch": _logsearch_on,
    "loki_query": _logsearch_on,
    "loki_labels": _logsearch_on,
    "loki_patterns": _logsearch_on,
    "traces_search": _trace_store_on,
    "traces_get": _trace_store_on,
    "traces_tags": _trace_store_on,
    "traces_metrics": _trace_store_on,
    "traces_compare": _trace_store_on,
    "alerts_list": _alert_store_on,
    "network_flows": _network_flows_on,
    "network_drops": _prometheus_on,
    "cost": _cost_on,
    "policy_reports": _policy_reports_on,
}

# tool name → (scope, permission) k8s-service asks for when the tool calls it.
# Without it the call could only answer forbidden, so the tool is not offered.
# "global" = the all-cluster entry (admin.*), "cluster" = granted in the active cluster.
REQUIRED_PERMISSIONS: Dict[str, tuple[str, str]] = {
    "hygiene": ("global", "admin.hygiene.read"),
    "policy_reports": ("cluster", "resource.policyreport.read"),
    "cost": ("cluster", "resource.cost.read"),
    "helm_read": ("cluster", "resource.helm.read"),
    "network_flows": ("cluster", "resource.networkflow.read"),
    "network_drops": ("cluster", "resource.networkflow.read"),
    # A server dry run needs the write's RBAC; the Write role's edit permission stands for it.
    "k8s_diff": ("cluster", "resource.*.edit"),
    # Admin-only: the audit log (auth-service asks for it) and node internals through nodes/proxy.
    "audit_search": ("global", "admin.audit.read"),
    "nodes_stats_summary": ("global", "admin.nodes.read"),
    "nodes_log": ("global", "admin.nodes.read"),
}


def permitted(name: str, token, cluster: Optional[str]) -> bool:
    """The token holds what k8s-service will ask for; no token (legacy role mode) keeps the tool."""
    req = REQUIRED_PERMISSIONS.get(name)
    if req is None or token is None:
        return True
    scope, perm = req
    if scope == "global":
        return bool(token.has_permission(perm))
    return bool(token.has_permission_for_cluster(perm, cluster))


def permitted_anywhere(name: str, token) -> bool:
    """For a cluster-agnostic list (MCP tools/list): a global requirement must be
    held; a per-cluster one in at least one cluster of the token's matrix
    (list_clusters then decides per cluster)."""
    req = REQUIRED_PERMISSIONS.get(name)
    if req is None or token is None:
        return True
    scope, perm = req
    if scope == "global":
        return bool(token.has_permission(perm))
    clusters = [c for c in (getattr(token, "matrix", None) or {}) if c != "*"]
    if not clusters:
        return bool(token.has_permission_for_cluster(perm, None))
    return any(token.has_permission_for_cluster(perm, c) for c in clusters)

_cache: Dict[str, tuple[float, Dict[str, Any]]] = {}


def clear_cache() -> None:
    _cache.clear()


async def fetch_features(k8s_client, cluster: Optional[str]) -> Optional[Dict[str, Any]]:
    """The cluster's features, cached; None when k8s-service did not answer."""
    key = cluster or ""
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    try:
        features = await k8s_client.get_features()
    except Exception as e:  # the tool list must still be built
        log.warning("cluster features for %r unavailable: %s", key, e)
        return None
    if not isinstance(features, dict):
        features = {}
    _cache[key] = (now + TTL_SECONDS, features)
    return features


def gated(name: str) -> bool:
    return name in GATES or name in REQUIRED_PERMISSIONS


def gated_names(names: Iterable[str], features: Optional[Dict[str, Any]], cluster: Optional[str], token=None) -> List[str]:
    """names without the feature tools this cluster cannot serve or the token
    may not use. Unknown features (k8s-service unreachable) keep the gated tools out."""
    out: List[str] = []
    for name in names:
        if not permitted(name, token, cluster):
            continue
        check = GATES.get(name)
        if check is None:
            out.append(name)
        elif features is not None and check(features, cluster or ""):
            out.append(name)
    return out


def filter_tools(tools: List[Dict], features: Optional[Dict[str, Any]], cluster: Optional[str], token=None) -> List[Dict]:
    kept: List[Dict] = []
    for tool in tools:
        fn = (tool or {}).get("function", {})
        name = fn.get("name") if isinstance(fn, dict) else None
        if isinstance(name, str) and gated(name) and not gated_names([name], features, cluster, token):
            continue
        kept.append(tool)
    return kept


def _names(tools: List[Dict]) -> List[str]:
    return [str((t or {}).get("function", {}).get("name") or "") for t in tools]


async def gate_tools(tools: List[Dict], service) -> List[Dict]:
    """The chat's tool list for the service's active cluster and token."""
    names = _names(tools)
    if not any(gated(n) for n in names):
        return tools
    cluster = getattr(service, "cluster_name", None) or ""
    token = getattr(service, "token", None)
    features = None
    if any(n in GATES for n in names if permitted(n, token, cluster)):
        k8s = getattr(service, "k8s_service", None)
        features = await fetch_features(k8s, cluster) if k8s is not None else None
    return filter_tools(tools, features, cluster, token)
