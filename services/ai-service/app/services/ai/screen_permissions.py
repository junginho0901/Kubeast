"""What a screen asks for the call a tool makes.

A tool reaches the cluster through kubectl, where a screen goes through a route that asks a permission first. This
table says, per tool, what that route asks: a role holding ai.tool.* does not get past it through the AI, however much
its group is bound in the cluster. A read a screen leaves to the cluster's RBAC asks nothing here either. tool-server
keeps the same table (screen_permissions.go) and decides again; its TestToolScreenCasesFixture writes the cases
tests/test_tool_app_permissions.py runs here. A tool that is not in the table is refused to everyone.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Tuple

import yaml

_LEFT_TO_THE_CLUSTER: Tuple[str, ...] = ("left",)


def _always(permission: str) -> Tuple[str, str]:
    return ("always", permission)


def _for_resource_type(verb: str) -> Tuple[str, str]:
    return ("resource_type", verb)


def _for_manifest(verb: str) -> Tuple[str, str]:
    return ("manifest", verb)


TOOL_SCREEN_TABLE: Dict[str, Tuple[str, ...]] = {
    "k8s_get_resources": _LEFT_TO_THE_CLUSTER,
    "k8s_get_resource_yaml": _LEFT_TO_THE_CLUSTER,
    "k8s_describe_resource": _LEFT_TO_THE_CLUSTER,
    "k8s_get_events": _LEFT_TO_THE_CLUSTER,
    "k8s_get_available_api_resources": _LEFT_TO_THE_CLUSTER,
    "k8s_get_cluster_configuration": _LEFT_TO_THE_CLUSTER,
    "get_cluster_overview": _LEFT_TO_THE_CLUSTER,
    "get_node_metrics": _LEFT_TO_THE_CLUSTER,
    "get_pod_metrics": _LEFT_TO_THE_CLUSTER,
    "k8s_check_service_connectivity": _LEFT_TO_THE_CLUSTER,
    "k8s_find_resource": _LEFT_TO_THE_CLUSTER,
    "k8s_explain": _LEFT_TO_THE_CLUSTER,
    "prometheus_query": _LEFT_TO_THE_CLUSTER,
    "prometheus_metrics": _LEFT_TO_THE_CLUSTER,
    "prometheus_labels": _LEFT_TO_THE_CLUSTER,
    "prometheus_rules": _LEFT_TO_THE_CLUSTER,
    "prometheus_targets": _LEFT_TO_THE_CLUSTER,
    "traces_search": _LEFT_TO_THE_CLUSTER,
    "traces_get": _LEFT_TO_THE_CLUSTER,
    "traces_tags": _LEFT_TO_THE_CLUSTER,
    "traces_metrics": _LEFT_TO_THE_CLUSTER,
    "traces_compare": _LEFT_TO_THE_CLUSTER,
    "issues": _LEFT_TO_THE_CLUSTER,
    "gitops_status": _LEFT_TO_THE_CLUSTER,
    "optimization": _LEFT_TO_THE_CLUSTER,
    "can_i": _LEFT_TO_THE_CLUSTER,
    "resource_graph": _LEFT_TO_THE_CLUSTER,
    "k8s_jq_query": _LEFT_TO_THE_CLUSTER,
    "k8s_tabular_query": _LEFT_TO_THE_CLUSTER,
    "k8s_count": _LEFT_TO_THE_CLUSTER,
    "k8s_get_pod_logs": _always("resource.pod.read"),
    "alerts_list": _always("resource.pod.read"),
    "logsearch": _always("resource.pod.read"),
    "loki_query": _always("resource.pod.read"),
    "loki_labels": _always("resource.pod.read"),
    "loki_patterns": _always("resource.pod.read"),
    "policy_reports": _always("resource.policyreport.read"),
    "helm_read": _always("resource.helm.read"),
    "cost": _always("resource.cost.read"),
    "network_policy_check": _always("resource.networkpolicy.read"),
    "network_flows": _always("resource.networkflow.read"),
    "network_drops": _always("resource.networkflow.read"),
    "network_top_flows": _always("resource.networkflow.read"),
    "hygiene": _always("admin.hygiene.read"),
    "audit_search": _always("admin.audit.read"),
    "nodes_stats_summary": _always("admin.nodes.read"),
    "nodes_log": _always("admin.nodes.read"),
    "k8s_delete_resource": _for_resource_type("delete"),
    "k8s_patch_resource": _for_resource_type("edit"),
    "k8s_annotate_resource": _for_resource_type("edit"),
    "k8s_remove_annotation": _for_resource_type("edit"),
    "k8s_label_resource": _for_resource_type("edit"),
    "k8s_remove_label": _for_resource_type("edit"),
    "k8s_scale": _for_resource_type("edit"),
    "k8s_rollout": ("rollout",),
    "k8s_execute_command": _always("resource.pod.exec"),
    "k8s_create_resource": _for_manifest("create"),
    # A screen's apply patches what exists; what kubectl apply would create is tool-server's applyCreateGate.
    "k8s_apply_manifest": _for_manifest("edit"),
    "k8s_diff": _for_manifest("edit"),
}

# Names kubectl expands to several kinds, some of them only known to the cluster: those need every kind.
_KUBECTL_CATEGORIES = frozenset({"all", "api-extensions", "gateway-api"})

# The other names kubectl takes for a kind with a permission name of its own (auth.PermResource in services/pkg).
_SPELLINGS: Dict[str, Tuple[str, ...]] = {
    "pod": ("pods", "po"), "deployment": ("deployments", "deploy"), "statefulset": ("statefulsets", "sts"), "daemonset": ("daemonsets", "ds"),
    "replicaset": ("replicasets", "rs"), "job": ("jobs",), "cronjob": ("cronjobs", "cj"),
    "service": ("services", "svc"), "endpoints": ("ep",), "endpointslice": ("endpointslices",), "ingress": ("ingresses", "ing"),
    "ingressclass": ("ingressclasses",), "networkpolicy": ("networkpolicies", "netpol"),
    "configmap": ("configmaps", "cm"), "secret": ("secrets",), "serviceaccount": ("serviceaccounts", "sa"),
    "role": ("roles",), "rolebinding": ("rolebindings",), "clusterrole": ("clusterroles",), "clusterrolebinding": ("clusterrolebindings",),
    "namespace": ("namespaces", "ns"), "node": ("nodes", "no"), "storageclass": ("storageclasses", "sc"), "volumeattachment": ("volumeattachments",),
    "resourcequota": ("resourcequotas", "quota"), "limitrange": ("limitranges", "limits"), "priorityclass": ("priorityclasses", "pc"),
    "runtimeclass": ("runtimeclasses",), "lease": ("leases",),
    "mutatingwebhookconfiguration": ("mutatingwebhookconfigurations",), "validatingwebhookconfiguration": ("validatingwebhookconfigurations",),
    "validatingadmissionpolicy": ("validatingadmissionpolicies",), "validatingadmissionpolicybinding": ("validatingadmissionpolicybindings",),
    "mutatingadmissionpolicy": ("mutatingadmissionpolicies",), "mutatingadmissionpolicybinding": ("mutatingadmissionpolicybindings",),
    "gateway": ("gateways", "gtw", "gw"), "gatewayclass": ("gatewayclasses", "gc"), "httproute": ("httproutes",), "grpcroute": ("grpcroutes",),
    "referencegrant": ("referencegrants", "refgrant"), "backendtlspolicy": ("backendtlspolicies", "btlspolicy"),
    "deviceclass": ("deviceclasses",), "resourceclaim": ("resourceclaims",), "resourceclaimtemplate": ("resourceclaimtemplates",), "resourceslice": ("resourceslices",),
    "policyreport": ("policyreports", "polr"), "cost": (), "networkflow": (),
    "hpa": ("horizontalpodautoscaler", "horizontalpodautoscalers"), "vpa": ("verticalpodautoscaler", "verticalpodautoscalers"),
    "pdb": ("poddisruptionbudget", "poddisruptionbudgets"), "pv": ("persistentvolume", "persistentvolumes"),
    "pvc": ("persistentvolumeclaim", "persistentvolumeclaims"), "crd": ("crds", "customresourcedefinition", "customresourcedefinitions"),
}

PERMISSION_NAMES: Tuple[str, ...] = (*_SPELLINGS, "customresource")


def spellings() -> Dict[str, str]:
    """Every spelling, a permission name's own too → the permission name."""
    out: Dict[str, str] = {}
    for name, forms in _SPELLINGS.items():
        out[name] = name
        for form in forms:
            out[form] = name
    return out


_NAME_OF_SPELLING = spellings()

# Past these a manifest counts as unreadable, which asks for every kind.
_MANIFEST_MAX_BYTES = 256 << 10
_MANIFEST_MAX_DEPTH = 8
_MANIFEST_MAX_OBJECTS = 2000


def _kind_permissions(names: List[str], verb: str) -> List[str]:
    """resource.<name>.<verb> for each name, once each, sorted. "*" is resource.*.<verb>, every kind."""
    return sorted({f"resource.{name}.{verb}" for name in names})


def _arg_string(args: Dict[str, Any], key: str) -> str:
    value = args.get(key)
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


def _resource_type_names(resource_type: str) -> List[str]:
    """The permission name of every kind a kubectl resource argument names: any case, the singular, plural or short
    form, with a version or group behind it, several separated by commas. As on the screens the kind decides, not the
    group. What cannot be read is every kind."""
    names: List[str] = []
    for one in resource_type.split(","):
        name = one.strip().lower().split(".", 1)[0]
        if not name or name in _KUBECTL_CATEGORIES:
            return ["*"]
        names.append(_NAME_OF_SPELLING.get(name, "customresource"))
    return names


def _manifest_text(args: Dict[str, Any]) -> Optional[str]:
    """The manifest in the order tool-server's manifestFromArgs reads the arguments."""
    for key in ("yaml_content", "manifest"):
        value = args.get(key)
        if value is None:
            continue
        if not isinstance(value, str):
            return None
        if value.strip():
            return value.strip()
    value = args.get("resource_manifest")
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return None


def _json_stream(text: str) -> Optional[List[Any]]:
    decoder = json.JSONDecoder()
    docs: List[Any] = []
    index, end = 0, len(text)
    while True:
        while index < end and text[index].isspace():
            index += 1
        if index >= end:
            return docs
        try:
            doc, index = decoder.raw_decode(text, index)
        except ValueError:
            return None
        docs.append(doc)


def _yaml_chunks(text: str) -> Optional[List[str]]:
    """Documents as kubectl's YAML reader splits them: at a line that starts with ---, with nothing but a comment after."""
    chunks: List[str] = []
    current: List[str] = []
    for line in text.split("\n"):
        if line.startswith("---"):
            rest = line[3:].strip()
            if rest and not rest.startswith("#"):
                return None
            if any(part.strip() for part in current):
                chunks.append("\n".join(current))
                current = []
        current.append(line)
    chunks.append("\n".join(current))
    return chunks


def _documents(text: str) -> Optional[List[Any]]:
    if text.lstrip().startswith("{"):
        docs = _json_stream(text)
        if docs is not None:
            return docs
    chunks = _yaml_chunks(text)
    if chunks is None:
        return None
    docs = []
    try:
        for chunk in chunks:
            docs.extend(yaml.safe_load_all(chunk))
    except yaml.YAMLError:
        return None
    return docs


def _append_kinds(kinds: List[str], doc: Dict[Any, Any], depth: int) -> bool:
    """Flattens a document as kubectl does: anything with items is a list (kubectl's detector reads the key in any
    case), and an item without a kind takes its list's. False when it cannot be read."""
    if depth > _MANIFEST_MAX_DEPTH or len(kinds) > _MANIFEST_MAX_OBJECTS:
        return False
    kind = doc.get("kind") if isinstance(doc.get("kind"), str) else ""
    is_list = False
    for key, value in doc.items():
        if not isinstance(key, str) or key.casefold() != "items" or value is None:
            continue
        if not isinstance(value, list):
            return False
        is_list = True
        for item in value:
            if not isinstance(item, dict):
                return False
            item_kind = item.get("kind")
            if not (isinstance(item_kind, str) and item_kind):
                item = {**item, "kind": kind[:-4] if kind.endswith("List") else kind}
            if not _append_kinds(kinds, item, depth + 1):
                return False
    if is_list and kind.endswith("List"):
        return True
    if not kind:
        return False
    kinds.append(kind)
    return True


def _manifest_kinds(text: Optional[str]) -> Optional[List[str]]:
    """The kind of every object of a manifest; None when any of it cannot be read, or nothing is there."""
    if not text or len(text.encode("utf-8", "surrogatepass")) > _MANIFEST_MAX_BYTES:
        return None
    docs = _documents(text)
    if docs is None:
        return None
    kinds: List[str] = []
    for doc in docs:
        if doc is None:
            continue
        if not isinstance(doc, dict) or not _append_kinds(kinds, doc, 0):
            return None
    return kinds or None


def app_permissions(tool: str, args: Any = None) -> Optional[List[str]]:
    """What a screen asks for this call; None for a tool nobody decided. Arguments that are not an object read as none."""
    rule = TOOL_SCREEN_TABLE.get(tool)
    if rule is None:
        return None
    args = args if isinstance(args, dict) else {}
    how = rule[0]
    if how == "left":
        return []
    if how == "always":
        return [rule[1]]
    if how == "rollout":
        action = _arg_string(args, "action").strip().lower()
        if action == "undo":
            return ["resource.workload.rollback"]
        if action in ("status", "history"):
            return []
        how, rule = "resource_type", _for_resource_type("edit")
    verb = rule[1]
    if how == "resource_type":
        return _kind_permissions(_resource_type_names(_arg_string(args, "resource_type")), verb)
    kinds = _manifest_kinds(_manifest_text(args))
    if kinds is None:
        return _kind_permissions(["*"], verb)
    return _kind_permissions([_NAME_OF_SPELLING.get(kind.lower(), "customresource") for kind in kinds], verb)


def may_be_called(holds: Callable[[str], bool], tool: str) -> bool:
    """For a list, where the arguments are not known yet: could some call of this tool pass for a holder of these
    permissions. A tool that names a kind passes with its verb on any kind; rollout has status and history."""
    rule = TOOL_SCREEN_TABLE.get(tool)
    if rule is None:
        return False
    if rule[0] in ("left", "rollout"):
        return True
    if rule[0] == "always":
        return holds(rule[1])
    return holds_verb_on_some_kind(holds, rule[1])


def holds_verb_on_some_kind(holds: Callable[[str], bool], verb: str) -> bool:
    return any(holds(f"resource.{name}.{verb}") for name in PERMISSION_NAMES)


def fixed_permissions() -> Dict[str, str]:
    """The tools that ask one permission whatever the call: tool → permission."""
    return {tool: rule[1] for tool, rule in TOOL_SCREEN_TABLE.items() if rule[0] == "always"}
