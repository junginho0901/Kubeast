"""Console links in a read tool's result (AI_TOOL_RESULT_DETAILS, chart ai.toolResultDetails, off by default).

The objects a call named in its arguments, and those its result lists with a kind, a namespace and a name, get the path
of their Kubeast screen: the list page of their kind with the drawer open (``?detail=<Kind>/<namespace>/<name>``,
``components/detailParam.ts``), an alert's window in Alerts, a namespace's Resource Graph. A Pod's drawer holds its
logs and metric charts, a Node's its metrics; the console has no trace screen, so a trace gets no link. Paths are
relative, built from the fixed pages below and names that pass Kubernetes' name rules, so no value a result carries can
point a link at another host. The block goes in front of the result's own keys, which stay byte for byte, so a result
cut at the model's length keeps it. Off, results are as they were."""

from __future__ import annotations

import json
import os
import re
from typing import Any, Iterable, Optional
from urllib.parse import urlencode

ENV = "AI_TOOL_RESULT_DETAILS"
MAX_LINKS = 8
# items read per list of a result, and the longest result read for names (a parse costs CPU only; a longer one is left
# as it came)
MAX_ITEMS = 200
MAX_PARSE_CHARS = 512 * 1024

NOTE = ("Kubeast screens of what this result names, as paths on the console's own address. To point the user at one, "
        "link it as [text](path) with the path exactly as given.")

# The list page of each kind whose drawer the console opens from ?detail= (App.tsx routes, ResourceDetailDrawer kinds).
LIST_PAGES = {
    "Pod": "/workloads/pods",
    "Deployment": "/workloads/deployments",
    "StatefulSet": "/workloads/statefulsets",
    "DaemonSet": "/workloads/daemonsets",
    "ReplicaSet": "/workloads/replicasets",
    "Job": "/workloads/jobs",
    "CronJob": "/workloads/cronjobs",
    "HorizontalPodAutoscaler": "/workloads/hpas",
    "PodDisruptionBudget": "/workloads/pdbs",
    "Service": "/network/services",
    "Ingress": "/network/ingresses",
    "NetworkPolicy": "/network/networkpolicies",
    "ConfigMap": "/configuration/configmaps",
    "PersistentVolumeClaim": "/storage",
    "Node": "/cluster/nodes",
    "Namespace": "/cluster/namespaces",
}
CLUSTER_SCOPED = frozenset({"Node", "Namespace"})
ALERTS_PAGE = "/alerts"
GRAPH_PAGE = "/cluster/resource-graph"

# resource_type as the model writes it (kubectl's names) → kind
_ALIASES = {
    "po": "Pod", "deploy": "Deployment", "sts": "StatefulSet", "ds": "DaemonSet", "rs": "ReplicaSet", "cj": "CronJob",
    "hpa": "HorizontalPodAutoscaler", "pdb": "PodDisruptionBudget", "svc": "Service", "ing": "Ingress",
    "netpol": "NetworkPolicy", "cm": "ConfigMap", "pvc": "PersistentVolumeClaim", "no": "Node", "ns": "Namespace",
    "ingresses": "Ingress", "networkpolicies": "NetworkPolicy",
}
for _kind in LIST_PAGES:
    _ALIASES.setdefault(_kind.lower(), _kind)
    _ALIASES.setdefault(_kind.lower() + "s", _kind)

_LABEL = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
_SUBDOMAIN = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$")
_CLUSTER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
_ALERT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")


def enabled() -> bool:
    return os.getenv(ENV, "false").strip().lower() == "true"


def kind_of(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    v = value.strip()
    if v in LIST_PAGES:
        return v
    return _ALIASES.get(v.lower())


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def object_path(cluster: str, kind: Optional[str], namespace: str, name: str) -> Optional[str]:
    """The drawer of one object on its kind's list page, or None when the kind has no page or a name breaks the rules."""
    if not kind or kind not in LIST_PAGES or not _CLUSTER.match(cluster):
        return None
    if len(name) > 253 or not _SUBDOMAIN.match(name):
        return None
    if kind in CLUSTER_SCOPED:
        if kind == "Namespace" and not _LABEL.match(name):
            return None
        detail = f"{kind}/{name}"
    else:
        if len(namespace) > 63 or not _LABEL.match(namespace):
            return None
        detail = f"{kind}/{namespace}/{name}"
    return f"{LIST_PAGES[kind]}?{urlencode({'cluster': cluster, 'detail': detail}, safe='/')}"


def _object_link(cluster: str, kind: Optional[str], namespace: str, name: str) -> Optional[dict]:
    path = object_path(cluster, kind, namespace, name)
    if path is None:
        return None
    label = f"{kind} {name}" if kind in CLUSTER_SCOPED else f"{kind} {namespace}/{name}"
    return {"for": label, "path": path}


def _from_args(cluster: str, function_name: str, args: dict) -> Iterable[Optional[dict]]:
    ns = _text(args.get("namespace"))
    pod = _text(args.get("pod_name")) or _text(args.get("pod"))
    if pod:
        yield _object_link(cluster, "Pod", ns, pod.split("/")[-1])
    if args.get("workload_name"):
        yield _object_link(cluster, kind_of(args.get("workload_kind")), ns, _text(args.get("workload_name")))
    if args.get("resource_name"):
        yield _object_link(cluster, kind_of(args.get("resource_type")), ns, _text(args.get("resource_name")))
    if args.get("name") and args.get("kind"):
        yield _object_link(cluster, kind_of(args.get("kind")), ns, _text(args.get("name")))
    if args.get("node"):
        yield _object_link(cluster, "Node", "", _text(args.get("node")))
    alert = _text(str(args.get("alert_id"))) if args.get("alert_id") is not None else ""
    if alert and _ALERT_ID.match(alert) and _CLUSTER.match(cluster):
        yield {"for": f"alert {alert}", "path": f"{ALERTS_PAGE}?{urlencode({'cluster': cluster, 'alert': alert})}"}
    if function_name == "resource_graph" and ns and _LABEL.match(ns) and _CLUSTER.match(cluster):
        yield {"for": f"Resource Graph of {ns}", "path": f"{GRAPH_PAGE}?{urlencode({'cluster': cluster, 'namespace': ns})}"}


def _named(item: Any, default_kind: Optional[str], default_ns: str) -> Optional[tuple[Optional[str], str, str]]:
    if not isinstance(item, dict):
        return None
    for key in ("involved_object", "involvedObject"):
        inner = item.get(key)
        if isinstance(inner, dict) and inner.get("name"):
            return kind_of(inner.get("kind")), _text(inner.get("namespace")) or default_ns, _text(inner.get("name"))
    name = item.get("name")
    if not isinstance(name, str) or not name:
        return None
    kind = kind_of(item.get("kind")) if item.get("kind") else default_kind
    return kind, _text(item.get("namespace")) or default_ns, name.strip()


def _from_result(cluster: str, args: dict, data: dict) -> Iterable[Optional[dict]]:
    default_kind = kind_of(args.get("resource_type"))
    default_ns = _text(args.get("namespace"))
    for value in data.values():
        if not isinstance(value, list):
            continue
        for item in value[:MAX_ITEMS]:
            named = _named(item, default_kind, default_ns)
            if named:
                yield _object_link(cluster, *named)


def _parsed(result: str) -> Optional[dict]:
    """The result as an object to add to, or None: not an object, or longer than is read for names (left as it came)."""
    if len(result) > MAX_PARSE_CHARS or not result.lstrip().startswith("{"):
        return None
    try:
        data = json.loads(result)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def links_for(function_name: str, args: Any, data: dict, cluster: str) -> list[dict]:
    """The links of one result: the call's own objects first, then those the result lists, each once, at most MAX_LINKS."""
    if not isinstance(args, dict):
        args = {}
    found: list[dict] = []
    seen: set[str] = set()
    for source in (_from_args(cluster, function_name, args), _from_result(cluster, args, data)):
        for link in source:
            if link and link["path"] not in seen:
                seen.add(link["path"])
                found.append(link)
                if len(found) >= MAX_LINKS:
                    return found
    return found


def with_links(result: str, links: list[dict]) -> str:
    """The result with {"console_links": …} as its first key and its own text after it unchanged."""
    if not links:
        return result
    rest = result.lstrip()[1:].lstrip()
    block = json.dumps({"note": NOTE, "links": links}, ensure_ascii=False)
    return '{"console_links":' + block + ("" if rest.startswith("}") else ",") + rest


def add(function_name: str, args: Any, result: Any, cluster: str) -> Any:
    """What the tool dispatch returns: the result as it was with the switch off, else with its links."""
    if not enabled() or not isinstance(result, str):
        return result
    data = _parsed(result)
    # a status (not_found, unavailable, too_large, …) or an error names nothing that is there to open
    if data is None or isinstance(data.get("status"), str) or data.get("error"):
        return result
    return with_links(result, links_for(function_name, args, data, cluster))
