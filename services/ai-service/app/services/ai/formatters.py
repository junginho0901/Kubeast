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


# A log ends with its newest line, so these keep the end: tool -> the field of its JSON answer holding the log (None: the answer is the log).
_LOG_TOOLS = {"k8s_get_pod_logs": None, "logfiles": "content", "nodes_log": "text"}


def _end_of_log(text: str, max_chars: int) -> str:
    """The last max_chars of a log, from the start of a line unless its last line alone is longer."""
    if max_chars <= 0:
        return ""
    end = text[-max_chars:]
    newline = end.find("\n")
    return end[newline + 1:] if 0 <= newline < len(end) - 1 else end


def _cut_log_answer(content: str, max_chars: int, field: Optional[str]) -> Optional[str]:
    """A log tool's answer cut to the model's length, or None when it holds no log (a list of files)."""
    if field is None:
        return "... (earlier lines truncated for LLM) ...\n" + _end_of_log(content, max_chars)
    try:
        answer = json.loads(content)
    except ValueError:
        return None
    if not isinstance(answer, dict) or not isinstance(answer.get(field), str):
        return None
    log = answer[field]
    shape = {**answer, field: "", "truncated": True, "truncated_for_llm": "earlier lines left out"}
    room = max_chars - len(json.dumps(shape, ensure_ascii=False, indent=2))
    if room <= 0:
        return None
    # a log's quotes and line breaks take more room as JSON than as text
    size = room
    kept = _end_of_log(log, size)
    while size > 0 and len(json.dumps(kept, ensure_ascii=False)) - 2 > room:
        size = size * 4 // 5
        kept = _end_of_log(log, size)
    return json.dumps({**shape, field: kept}, ensure_ascii=False, indent=2)


def _truncate_tool_result_for_llm(content: Optional[str], max_chars: int = LLM_RESULT_CHARS, tool: Optional[str] = None) -> str:
    """Tool 결과를 LLM 입력용으로 축약 (max_chars = 모델의 tool_result_chars, 없으면 6000)"""
    if not isinstance(content, str):
        content = "" if content is None else str(content)
    if len(content) > max_chars:
        if tool in _LOG_TOOLS:
            cut = _cut_log_answer(content, max_chars, _LOG_TOOLS[tool])
            if cut is not None:
                return cut
        return content[:max_chars] + "\n... (truncated for LLM) ..."
    return content


def code_fence(text: str) -> str:
    """The backticks around a tool result in an answer: more than its longest run, so no line of it can close the
    code block (frontend chatStreamManager.codeFence writes the same; keep the two equal)."""
    longest = max(map(len, re.findall(r"`+", text)), default=0)
    return "`" * (max(longest, 2) + 1)


_FENCE_OPEN = re.compile(r" {0,3}(?:(`{3,})[^`]*|(~{3,})[^\n]*)")
_FENCE_CLOSE = re.compile(r" {0,3}(`{3,}|~{3,})[ \t\r]*")


def _line_end(text: str, at: int) -> int:
    end = text.find("\n", at)
    return len(text) if end == -1 else end


def fence_reader(text: str):
    """A reader of text's fenced code blocks, by CommonMark's rules (backticks or tildes, up to three spaces in, closed
    by a line of the same mark at least as long): given the start of a line, moving forward, where the block that opens
    there ends, or -1. A fence nothing closes is no block: an answer saved before results got their longer fence can
    hold an odd line of backticks, and reading the rest as code would lose the answer after it."""
    unclosed: dict = {}  # the shortest fence of each mark with no closing line after it, so open fences stay one pass

    def fence_end(at: int) -> int:
        opening = _FENCE_OPEN.fullmatch(text, at, _line_end(text, at))
        fence = opening and (opening.group(1) or opening.group(2))
        if not fence or len(fence) >= unclosed.get(fence[0], float("inf")):
            return -1
        line = _line_end(text, at) + 1
        while line <= len(text):
            end = _line_end(text, line)
            closing = _FENCE_CLOSE.fullmatch(text, line, end)
            if closing and closing.group(1)[0] == fence[0] and len(closing.group(1)) >= len(fence):
                return min(end + 1, len(text))
            line = end + 1
        unclosed[fence[0]] = len(fence)
        return -1

    return fence_end


def closing_fence(text: str) -> Optional[str]:
    """The line that closes the code block text leaves open, or None. A tool block below an open one reads as code. A
    fence with a less indented line after it was in a list item that line ended, and a closing line there would open a
    new block (frontend chatTextUtils.closingFence does the same, chatAnswer.cases.json holds the two equal)."""
    def indent_of(line: str) -> int:
        return len(line) - len(line.lstrip())

    fence_end = fence_reader(text)
    at = 0
    while at < len(text):
        end = fence_end(at)
        if end != -1:
            at = end
            continue
        next_line = _line_end(text, at)
        opening = _FENCE_OPEN.fullmatch(text, at, next_line)
        if opening:
            indent = indent_of(text[at:next_line])
            ended = any(after.strip() and indent_of(after) < indent for after in text[next_line:].split("\n"))
            if not ended:
                return " " * indent + (opening.group(1) or opening.group(2))
        at = next_line + 1
    return None


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

def _pod_list_view(pod: Dict) -> Tuple[str, str, int]:
    """STATUS, READY and RESTARTS as kubectl's printPod (v1.37) prints them and k8s-service's podrow.ListView writes them
    for the Pods list; tests/test_kubectl_table_cases.py holds the two equal."""
    spec = pod.get("spec") or {}
    status = pod.get("status") or {}
    phase = status.get("phase") or ""
    conditions = status.get("conditions") or []
    reason = status.get("reason") or phase
    if any(c.get("type") == "PodScheduled" and c.get("reason") == "SchedulingGated" for c in conditions):
        reason = "SchedulingGated"

    init_specs = spec.get("initContainers") or []
    sidecars = {c.get("name") for c in init_specs if c.get("restartPolicy") == "Always"}
    total = len(spec.get("containers") or []) + len(sidecars)
    ready = restarts = sidecar_restarts = 0
    initializing = False
    for i, cs in enumerate(status.get("initContainerStatuses") or []):
        restarts += cs.get("restartCount") or 0
        sidecar = cs.get("name") in sidecars
        if sidecar:
            sidecar_restarts += cs.get("restartCount") or 0
        state = cs.get("state") or {}
        ended, waiting = state.get("terminated"), state.get("waiting") or {}
        if ended is not None and not ended.get("exitCode"):
            continue
        if sidecar and cs.get("started"):
            ready += 1 if cs.get("ready") else 0
            continue
        if ended is not None:
            reason = "Init:" + _ended_reason(ended)
        elif waiting.get("reason") and waiting["reason"] != "PodInitializing":
            reason = "Init:" + waiting["reason"]
        else:
            reason = f"Init:{i}/{len(init_specs)}"
        initializing = True
        break

    if not initializing or _condition_true(conditions, "Initialized", first_only=True):
        restarts = sidecar_restarts
        has_running = False
        error_reason = ""
        for cs in reversed(status.get("containerStatuses") or []):
            restarts += cs.get("restartCount") or 0
            state = cs.get("state") or {}
            ended, waiting = state.get("terminated"), state.get("waiting") or {}
            if waiting.get("reason"):
                reason = waiting["reason"]
            elif ended is not None:
                reason = _ended_reason(ended)
                if ended.get("exitCode"):
                    error_reason = reason
            elif cs.get("ready") and state.get("running") is not None:
                has_running = True
                ready += 1
        if reason == "Completed":
            if has_running and _condition_true(conditions, "Ready"):
                reason = "Running"
            elif error_reason:
                reason = error_reason
            elif has_running:
                reason = "NotReady"

    if (pod.get("metadata") or {}).get("deletionTimestamp"):
        if status.get("reason") == "NodeLost":
            reason = "Unknown"
        elif phase not in ("Succeeded", "Failed"):
            reason = "Terminating"
    return reason or "Unknown", f"{ready}/{total}", restarts


def _ended_reason(ended: Dict) -> str:
    if ended.get("reason"):
        return ended["reason"]
    if ended.get("signal"):
        return f"Signal:{ended['signal']}"
    return f"ExitCode:{ended.get('exitCode') or 0}"


def _condition_true(conditions: List[Dict], kind: str, first_only: bool = False) -> bool:
    matching = [c for c in conditions if c.get("type") == kind]
    if first_only:
        matching = matching[:1]
    return any(c.get("status") == "True" for c in matching)


def _service_external_ip(svc: Dict) -> str:
    """EXTERNAL-IP as kubectl's getServiceExternalIP (v1.37) prints it and k8s-service's service.Info writes it for the
    Services list, not always an address; tests/test_kubectl_table_cases.py holds the two equal."""
    spec = svc.get("spec") or {}
    external_ips = spec.get("externalIPs") or []
    kind = spec.get("type")
    if kind in ("ClusterIP", "NodePort"):
        return ",".join(external_ips) or "<none>"
    if kind == "LoadBalancer":
        ingress = ((svc.get("status") or {}).get("loadBalancer") or {}).get("ingress") or []
        addresses = sorted({address for address in (ing.get("ip") or ing.get("hostname") for ing in ingress) if address})
        return ",".join(addresses + external_ips) or "<pending>"
    if kind == "ExternalName":
        return spec.get("externalName") or ""
    return "<unknown>"


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
            status_text, ready_text, restarts = _pod_list_view(item if isinstance(item, dict) else {})
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
            svc_type = spec.get("type", "")
            cluster_ip = spec.get("clusterIP", "")
            external_ip = _service_external_ip(item if isinstance(item, dict) else {})
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
    note = ""
    if isinstance(data, dict) and isinstance(data.get("events"), list):
        # more events matched than were listed: the newest, with the total
        note = str(data.get("note") or "")
        data = data["events"]
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
    table = _format_table(headers, rows)
    return f"{table}\n{note}" if note else table

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
    if function_name == "k8s_check_service_connectivity":
        return _format_service_connectivity_display(formatted_result)
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
