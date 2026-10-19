# ai_service.py 의 formatter 함수 모음. self 의존이 formatters 끼리만이라
# 모듈 함수로 추출 (service 인자 X). 호출처에서 `from app.services.ai.formatters
# import ...` 후 직접 호출. 이전 instance method (`self._format_age` 등) 는
# 모두 모듈 함수 (`_format_age`).
#
# Phase 4.5.1 추출.

import json
import re
from datetime import datetime
from typing import Dict, List, Optional, Tuple


LLM_RESULT_CHARS = 6000


def _truncate_tool_result_for_llm(content: Optional[str]) -> str:
    """Tool 결과를 LLM 입력용으로 축약"""
    if not isinstance(content, str):
        content = "" if content is None else str(content)
    max_chars = LLM_RESULT_CHARS
    if len(content) > max_chars:
        return content[:max_chars] + "\n... (truncated for LLM) ..."
    return content

def _format_age(timestamp: Optional[str]) -> str:
    if not timestamp:
        return "-"
    try:
        ts = timestamp.replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts)
    except Exception:
        return "-"
    now = datetime.now(dt.tzinfo)
    delta = now - dt
    seconds = int(delta.total_seconds())
    if seconds < 0:
        seconds = 0
    days = seconds // 86400
    if days > 0:
        return f"{days}d"
    hours = seconds // 3600
    if hours > 0:
        return f"{hours}h"
    minutes = seconds // 60
    if minutes > 0:
        return f"{minutes}m"
    return f"{seconds}s"

def _format_table(headers: List[str], rows: List[List[str]]) -> str:
    if not rows:
        return "No resources found."
    widths = [len(h) for h in headers]
    for row in rows:
        for idx, cell in enumerate(row):
            widths[idx] = max(widths[idx], len(cell))
    lines = ["  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))]
    for row in rows:
        lines.append("  ".join(row[i].ljust(widths[i]) for i in range(len(headers))))
    return "\n".join(lines)

def _format_k8s_get_resources_display(
        resource_type: str,
    output: str,
    raw_text: str,
    include_namespace: bool = False,
) -> Optional[str]:
    data = None
    try:
        data = json.loads(raw_text)
    except Exception:
        data = None

    if not data:
        return None

    items = []
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        items = data.get("items") or []
    elif isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = [data]

    key = (resource_type or "").strip().lower()
    if key in {"po", "pod", "pods"}:
        headers = ["NAME", "READY", "STATUS", "RESTARTS", "AGE"]
        if include_namespace:
            headers = ["NAMESPACE"] + headers
        rows = []
        for item in items:
            meta = item.get("metadata", {}) if isinstance(item, dict) else {}
            status = item.get("status", {}) if isinstance(item, dict) else {}
            spec = item.get("spec", {}) if isinstance(item, dict) else {}
            containers = (status.get("containerStatuses") or [])
            ready = sum(1 for c in containers if c.get("ready"))
            total = len(containers) or len(spec.get("containers") or [])
            ready_text = f"{ready}/{total}" if total else "0/0"
            restarts = sum(int(c.get("restartCount", 0)) for c in containers)

            phase = status.get("phase", "Unknown")
            reason = None
            for c in containers:
                state = c.get("state") or {}
                if state.get("waiting") and state["waiting"].get("reason"):
                    reason = state["waiting"]["reason"]
                    break
                if state.get("terminated") and state["terminated"].get("reason"):
                    reason = state["terminated"]["reason"]
                    break
            status_text = reason or phase or "Unknown"

            age = _format_age(meta.get("creationTimestamp"))
            row = [
                str(meta.get("name", "")),
                ready_text,
                str(status_text),
                str(restarts),
                age,
            ]
            if include_namespace:
                row = [str(meta.get("namespace", ""))] + row
            rows.append(row)
        return _format_table(headers, rows)

    if key in {"deploy", "deployment", "deployments"}:
        headers = ["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"]
        if include_namespace:
            headers = ["NAMESPACE"] + headers
        rows = []
        for item in items:
            meta = item.get("metadata", {}) if isinstance(item, dict) else {}
            spec = item.get("spec", {}) if isinstance(item, dict) else {}
            status = item.get("status", {}) if isinstance(item, dict) else {}
            desired = int(spec.get("replicas", 0) or 0)
            ready = int(status.get("readyReplicas", 0) or 0)
            updated = int(status.get("updatedReplicas", 0) or 0)
            available = int(status.get("availableReplicas", 0) or 0)
            age = _format_age(meta.get("creationTimestamp"))
            row = [
                str(meta.get("name", "")),
                f"{ready}/{desired}",
                str(updated),
                str(available),
                age,
            ]
            if include_namespace:
                row = [str(meta.get("namespace", ""))] + row
            rows.append(row)
        return _format_table(headers, rows)

    if key in {"svc", "service", "services"}:
        headers = ["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"]
        if include_namespace:
            headers = ["NAMESPACE"] + headers
        rows = []
        for item in items:
            meta = item.get("metadata", {}) if isinstance(item, dict) else {}
            spec = item.get("spec", {}) if isinstance(item, dict) else {}
            status = item.get("status", {}) if isinstance(item, dict) else {}
            svc_type = spec.get("type", "")
            cluster_ip = spec.get("clusterIP", "")
            external_ips = spec.get("externalIPs") or []
            lb_ingress = (status.get("loadBalancer") or {}).get("ingress") or []
            if lb_ingress:
                external_ips = [ing.get("ip") or ing.get("hostname") for ing in lb_ingress if ing]
            external_ip = ",".join([ip for ip in external_ips if ip]) or "<none>"
            ports = []
            for p in spec.get("ports") or []:
                port = p.get("port")
                node_port = p.get("nodePort")
                proto = p.get("protocol") or "TCP"
                if node_port:
                    ports.append(f"{port}:{node_port}/{proto}")
                else:
                    ports.append(f"{port}/{proto}")
            ports_text = ",".join(ports)
            age = _format_age(meta.get("creationTimestamp"))
            row = [
                str(meta.get("name", "")),
                str(svc_type),
                str(cluster_ip),
                external_ip,
                ports_text,
                age,
            ]
            if include_namespace:
                row = [str(meta.get("namespace", ""))] + row
            rows.append(row)
        return _format_table(headers, rows)

    if key in {"ns", "namespace", "namespaces"}:
        headers = ["NAME", "STATUS", "AGE"]
        rows = []
        for item in items:
            meta = item.get("metadata", {}) if isinstance(item, dict) else {}
            status = item.get("status", {}) if isinstance(item, dict) else {}
            phase = status.get("phase", "")
            age = _format_age(meta.get("creationTimestamp"))
            rows.append([str(meta.get("name", "")), str(phase), age])
        return _format_table(headers, rows)

    if key in {"no", "node", "nodes"}:
        headers = ["NAME", "STATUS", "ROLES", "AGE", "VERSION"]
        rows = []
        for item in items:
            meta = item.get("metadata", {}) if isinstance(item, dict) else {}
            status = item.get("status", {}) if isinstance(item, dict) else {}
            conditions = status.get("conditions") or []
            ready = "NotReady"
            for c in conditions:
                if c.get("type") == "Ready":
                    ready = "Ready" if c.get("status") == "True" else "NotReady"
                    break
            labels = meta.get("labels") or {}
            roles = []
            for k in labels.keys():
                if k.startswith("node-role.kubernetes.io/"):
                    role = k.split("/", 1)[1]
                    roles.append(role or "<none>")
            roles_text = ",".join(roles) if roles else "<none>"
            age = _format_age(meta.get("creationTimestamp"))
            version = (status.get("nodeInfo") or {}).get("kubeletVersion", "")
            rows.append([str(meta.get("name", "")), ready, roles_text, age, str(version)])
        return _format_table(headers, rows)

    # Fallback: name/age
    headers = ["NAME", "AGE"]
    if include_namespace:
        headers = ["NAMESPACE"] + headers
    rows = []
    for item in items:
        meta = item.get("metadata", {}) if isinstance(item, dict) else {}
        age = _format_age(meta.get("creationTimestamp"))
        row = [str(meta.get("name", "")), age]
        if include_namespace:
            row = [str(meta.get("namespace", ""))] + row
        rows.append(row)
    return _format_table(headers, rows)

def _format_k8s_get_events_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    include_namespace = any(isinstance(ev, dict) and ev.get("namespace") for ev in data)
    headers = ["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"]
    if include_namespace:
        headers = ["NAMESPACE"] + headers
    rows = []
    for ev in data:
        last_ts = ev.get("last_timestamp") or ev.get("first_timestamp")
        last_seen = _format_age(last_ts) if isinstance(last_ts, str) else "-"
        obj = ev.get("object") or {}
        obj_name = obj.get("name") or ""
        obj_kind = obj.get("kind") or ""
        obj_text = f"{obj_kind}/{obj_name}" if obj_kind or obj_name else ""
        row = [
            last_seen,
            str(ev.get("type", "")),
            str(ev.get("reason", "")),
            obj_text,
            str(ev.get("message", "")),
        ]
        if include_namespace:
            row = [str(ev.get("namespace", ""))] + row
        rows.append(row)
    return _format_table(headers, rows)

def _format_age_value(value) -> str:
    if not value:
        return "-"
    if isinstance(value, str):
        # Already formatted duration (e.g., "110 days, 7:31:18")
        if ("day" in value or "days" in value or "h" in value or "m" in value or "s" in value) and "T" not in value:
            return value
        return _format_age(value)
    try:
        return _format_age(value)
    except Exception:
        return "-"

def _format_namespaces_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    headers = ["NAME", "STATUS", "AGE", "PODS", "SERVICES", "DEPLOYMENTS", "PVCS"]
    rows = []
    for ns in data:
        rc = ns.get("resource_count") or {}
        rows.append([
            str(ns.get("name", "")),
            str(ns.get("status", "")),
            _format_age_value(ns.get("created_at")),
            str(rc.get("pods", 0)),
            str(rc.get("services", 0)),
            str(rc.get("deployments", 0)),
            str(rc.get("pvcs", 0)),
        ])
    return _format_table(headers, rows)

def _format_pods_display(raw_text: str, include_namespace: bool) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    headers = ["NAME", "READY", "STATUS", "RESTARTS", "AGE"]
    if include_namespace:
        headers = ["NAMESPACE"] + headers
    rows = []
    for pod in data:
        row = [
            str(pod.get("name", "")),
            str(pod.get("ready", "")),
            str(pod.get("status", "")),
            str(pod.get("restart_count", 0)),
            _format_age_value(pod.get("created_at")),
        ]
        if include_namespace:
            row = [str(pod.get("namespace", ""))] + row
        rows.append(row)
    return _format_table(headers, rows)

def _format_deployments_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    headers = ["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"]
    rows = []
    for dep in data:
        replicas = int(dep.get("replicas") or 0)
        ready = int(dep.get("ready_replicas") or 0)
        updated = int(dep.get("updated_replicas") or 0)
        available = int(dep.get("available_replicas") or 0)
        rows.append([
            str(dep.get("name", "")),
            f"{ready}/{replicas}",
            str(updated),
            str(available),
            _format_age_value(dep.get("created_at")),
        ])
    return _format_table(headers, rows)

def _format_services_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    headers = ["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"]
    rows = []
    for svc in data:
        ports = svc.get("ports") or []
        port_texts = []
        for p in ports:
            port = p.get("port")
            node_port = p.get("node_port")
            proto = p.get("protocol") or ""
            if node_port:
                port_texts.append(f"{port}:{node_port}/{proto}")
            else:
                port_texts.append(f"{port}/{proto}")
        rows.append([
            str(svc.get("name", "")),
            str(svc.get("type", "")),
            str(svc.get("cluster_ip") or ""),
            str(svc.get("external_ip") or "<none>"),
            ",".join(port_texts) if port_texts else "",
            _format_age_value(svc.get("created_at")),
        ])
    return _format_table(headers, rows)

def _format_service_connectivity_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None

    ports = data.get("ports") or []

    def _fmt_port(p: Dict[str, object]) -> str:
        name = p.get("name")
        port = p.get("port")
        proto = p.get("protocol") or ""
        if name:
            return f"{name}:{port}/{proto}"
        return f"{port}/{proto}"

    port_text = ""
    port_check = data.get("port_check") or {}
    matched = port_check.get("matched")
    requested = port_check.get("requested")
    if matched:
        port_text = _fmt_port(matched)
    elif requested:
        port_text = str(requested)
    else:
        port_text = ",".join(_fmt_port(p) for p in ports) if ports else ""

    endpoints = data.get("endpoints") or {}
    ready = int(endpoints.get("ready") or 0)
    total = endpoints.get("total")
    if total is None:
        total = ready + int(endpoints.get("not_ready") or 0)

    headers = ["NAMESPACE", "SERVICE", "TYPE", "PORT(S)", "ENDPOINTS", "STATUS"]
    rows = [[
        str(data.get("namespace", "")),
        str(data.get("service", "")),
        str(data.get("type", "")),
        port_text,
        f"{ready}/{total}",
        str(data.get("status", "")),
    ]]
    return _format_table(headers, rows)

def _format_nodes_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    headers = ["NAME", "STATUS", "ROLES", "AGE", "VERSION", "INTERNAL-IP", "EXTERNAL-IP"]
    rows = []
    for node in data:
        roles = node.get("roles") or []
        roles_text = ",".join(roles) if roles else "<none>"
        rows.append([
            str(node.get("name", "")),
            str(node.get("status", "")),
            roles_text,
            _format_age_value(node.get("age")),
            str(node.get("version", "")),
            str(node.get("internal_ip") or ""),
            str(node.get("external_ip") or "<none>"),
        ])
    return _format_table(headers, rows)

def _format_pvcs_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    include_namespace = len({str(p.get("namespace", "")) for p in data}) > 1
    headers = ["NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS MODES", "STORAGECLASS", "AGE"]
    if include_namespace:
        headers = ["NAMESPACE"] + headers
    rows = []
    for pvc in data:
        access_modes = pvc.get("access_modes") or []
        row = [
            str(pvc.get("name", "")),
            str(pvc.get("status", "")),
            str(pvc.get("volume_name") or ""),
            str(pvc.get("capacity") or ""),
            ",".join(access_modes) if access_modes else "",
            str(pvc.get("storage_class") or ""),
            _format_age_value(pvc.get("created_at")),
        ]
        if include_namespace:
            row = [str(pvc.get("namespace", ""))] + row
        rows.append(row)
    return _format_table(headers, rows)

def _format_pvs_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    headers = ["NAME", "CAPACITY", "ACCESS MODES", "RECLAIM POLICY", "STATUS", "CLAIM", "STORAGECLASS", "AGE"]
    rows = []
    for pv in data:
        access_modes = pv.get("access_modes") or []
        claim = pv.get("claim_ref") or {}
        claim_text = ""
        if isinstance(claim, dict):
            ns = claim.get("namespace")
            name = claim.get("name")
            if ns or name:
                claim_text = f"{ns}/{name}" if ns and name else str(name or "")
        rows.append([
            str(pv.get("name", "")),
            str(pv.get("capacity", "")),
            ",".join(access_modes) if access_modes else "",
            str(pv.get("reclaim_policy") or ""),
            str(pv.get("status") or ""),
            claim_text or "<none>",
            str(pv.get("storage_class") or ""),
            _format_age_value(pv.get("created_at")),
        ])
    return _format_table(headers, rows)

def _format_api_resources_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    headers = ["NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND"]
    rows = []
    for r in data:
        shortnames = r.get("shortNames") or []
        rows.append([
            str(r.get("name", "")),
            ",".join(shortnames) if shortnames else "",
            str(r.get("apiVersion", "")),
            "true" if r.get("namespaced") else "false",
            str(r.get("kind", "")),
        ])
    return _format_table(headers, rows)

def _format_pod_metrics_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    include_namespace = len({str(p.get("namespace", "")) for p in data}) > 1
    headers = ["NAME", "CPU(cores)", "MEMORY(bytes)"]
    if include_namespace:
        headers = ["NAMESPACE"] + headers
    rows = []
    for m in data:
        row = [
            str(m.get("name", "")),
            str(m.get("cpu", "")),
            str(m.get("memory", "")),
        ]
        if include_namespace:
            row = [str(m.get("namespace", ""))] + row
        rows.append(row)
    return _format_table(headers, rows)

def _format_node_metrics_display(raw_text: str) -> Optional[str]:
    try:
        data = json.loads(raw_text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    headers = ["NAME", "CPU(cores)", "MEMORY(bytes)"]
    rows = []
    for m in data:
        rows.append([
            str(m.get("name", "")),
            str(m.get("cpu", "")),
            str(m.get("memory", "")),
        ])
    return _format_table(headers, rows)

def _build_tool_display(
        function_name: str,
    function_args: Dict,
    formatted_result: str,
    is_json: bool,
    is_yaml: bool,
) -> Optional[str]:
    if function_name == "get_namespaces":
        return _format_namespaces_display(formatted_result)
    if function_name == "get_pods":
        return _format_pods_display(formatted_result, include_namespace=False)
    if function_name == "get_all_pods":
        return _format_pods_display(formatted_result, include_namespace=True)
    if function_name == "find_pods":
        return _format_pods_display(formatted_result, include_namespace=True)
    if function_name == "get_deployments":
        return _format_deployments_display(formatted_result)
    if function_name == "find_deployments":
        return _format_deployments_display(formatted_result)
    if function_name == "get_services":
        return _format_services_display(formatted_result)
    if function_name == "find_services":
        return _format_services_display(formatted_result)
    if function_name == "k8s_check_service_connectivity":
        return _format_service_connectivity_display(formatted_result)
    if function_name == "get_node_list":
        return _format_nodes_display(formatted_result)
    if function_name == "get_pvcs":
        return _format_pvcs_display(formatted_result)
    if function_name == "get_pvs":
        return _format_pvs_display(formatted_result)
    if function_name == "get_pod_metrics":
        return _format_pod_metrics_display(formatted_result)
    if function_name == "get_node_metrics":
        return _format_node_metrics_display(formatted_result)
    if function_name == "k8s_get_available_api_resources":
        return _format_api_resources_display(formatted_result)
    if function_name == "k8s_get_resources":
        output = function_args.get("output", "wide")
        namespace = function_args.get("namespace")
        all_namespaces_raw = function_args.get("all_namespaces", False)
        if isinstance(all_namespaces_raw, str):
            all_namespaces = all_namespaces_raw.strip().lower() == "true"
        else:
            all_namespaces = bool(all_namespaces_raw)
        include_namespace = all_namespaces or not (isinstance(namespace, str) and namespace.strip())
        return _format_k8s_get_resources_display(
            function_args.get("resource_type", ""),
            output if isinstance(output, str) else "wide",
            formatted_result,
            include_namespace=include_namespace,
        )
    if function_name == "k8s_get_events":
        return _format_k8s_get_events_display(formatted_result)
    return None


def _format_tool_result(
        function_name: str,
    function_args: Dict,
    function_response,
) -> (str, bool, bool):
    """Tool 실행 결과를 사용자 친화적으로 포맷 (JSON은 pretty-print)

    Returns:
        (formatted_text, is_json, is_yaml)
    """
    is_yaml = function_name in {"k8s_get_resource_yaml"}
    try:
        # dict/list 는 그대로 pretty-print
        if isinstance(function_response, (dict, list)):
            return json.dumps(function_response, ensure_ascii=False, indent=2), True, False
        
        # 문자열인 경우 JSON 여부를 감지해서 포맷
        if isinstance(function_response, str):
            stripped = function_response.strip()
            if stripped.startswith("{") or stripped.startswith("["):
                try:
                    parsed = json.loads(stripped)
                    return json.dumps(parsed, ensure_ascii=False, indent=2), True, False
                except json.JSONDecodeError:
                    # JSON 이 아니면 원본 그대로 사용
                    return function_response, False, is_yaml
            return function_response, False, is_yaml
        
        # 그 외 타입은 문자열로 변환
        return str(function_response), False, is_yaml
    except Exception as e:
        print(f"[DEBUG] Failed to format tool result: {e}")
        return str(function_response), False, is_yaml
