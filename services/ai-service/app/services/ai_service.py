"""
AI 트러블슈팅 서비스
"""
from openai import AsyncOpenAI
from typing import List, Dict, Optional
import httpx
import re
import json
import os
import sys
from app.config import settings
from datetime import datetime
from app.security import decode_access_token
from app.models.ai import (
    LogAnalysisRequest,
    LogAnalysisResponse,
    TroubleshootRequest,
    TroubleshootResponse,
    ChatRequest,
    ChatResponse,
    ErrorPattern,
    SeverityLevel
)
from app.services.k8s_client import K8sServiceClient
from app.services.tool_server_client import ToolServerClient


class ToolContext:
    """Tool 실행 컨텍스트"""
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.state = {}  # 실행 상태
        self.cache = {}  # 결과 캐시


class AIService:
    """AI 트러블슈팅 서비스"""
    
    def __init__(
        self,
        authorization: Optional[str] = None,
        model: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        tls_verify: Optional[bool] = True,
    ):
        """OpenAI 클라이언트 초기화"""
        resolved_base_url = (base_url if base_url is not None else settings.OPENAI_BASE_URL)
        resolved_base_url = (resolved_base_url or "").strip() or None
        resolved_api_key = api_key if api_key is not None else settings.OPENAI_API_KEY
        resolved_model = model or settings.OPENAI_MODEL
        headers = extra_headers or {}

        http_client = httpx.AsyncClient(verify=tls_verify if tls_verify is not None else True)
        self.client = AsyncOpenAI(
            api_key=resolved_api_key,
            base_url=resolved_base_url,
            default_headers=headers if headers else None,
            http_client=http_client,
        )
        self.model = resolved_model
        self.user_role = self._resolve_user_role(authorization)
        self.k8s_service = K8sServiceClient(authorization=authorization)
        tool_server_url = self._resolve_tool_server_url(self.user_role)
        self.tool_server = ToolServerClient(authorization=authorization, base_url=tool_server_url)
        self.tool_contexts: Dict[str, ToolContext] = {}  # {session_id: ToolContext}
        print(f"[AI Service] 초기화 완료 - 사용 모델: {self.model}, role: {self.user_role}", flush=True)

    def _resolve_user_role(self, authorization: Optional[str]) -> str:
        if not authorization:
            return "read"
        try:
            parts = authorization.split(" ", 1)
            token = parts[1].strip() if len(parts) == 2 else authorization.strip()
            payload = decode_access_token(token)
            role = (payload.role or "").strip().lower()
            if role in {"admin", "read", "write"}:
                return role
        except Exception:
            pass
        return "read"

    def _resolve_tool_server_url(self, role: str) -> Optional[str]:
        role_key = (role or "").strip().lower()
        if role_key == "admin":
            return os.getenv("TOOL_SERVER_URL_ADMIN")
        if role_key == "write":
            return os.getenv("TOOL_SERVER_URL_WRITE")
        return os.getenv("TOOL_SERVER_URL_READ")

    async def _call_tool_server(self, function_name: str, function_args: Dict) -> str:
        return await self.tool_server.call_tool(function_name, function_args)

    def _role_allows_write(self) -> bool:
        return self.user_role in {"write", "admin"}

    def _role_allows_admin(self) -> bool:
        return self.user_role == "admin"

    def _is_tool_allowed(self, function_name: str) -> bool:
        write_tools = {
            "k8s_apply_manifest",
            "k8s_create_resource",
            "k8s_create_resource_from_url",
            "k8s_delete_resource",
            "k8s_patch_resource",
            "k8s_annotate_resource",
            "k8s_remove_annotation",
            "k8s_label_resource",
            "k8s_remove_label",
            "k8s_scale",
            "k8s_rollout",
        }
        admin_only_tools = {
            "k8s_execute_command",
        }

        if function_name in admin_only_tools:
            return self._role_allows_admin()
        if function_name in write_tools:
            return self._role_allows_write()
        return True

    def _filter_tools_by_role(self, tools: List[Dict]) -> List[Dict]:
        filtered: List[Dict] = []
        for tool in tools:
            fn = (tool or {}).get("function", {})
            name = fn.get("name") if isinstance(fn, dict) else None
            if not isinstance(name, str) or not name:
                filtered.append(tool)
                continue
            if self._is_tool_allowed(name):
                filtered.append(tool)
        return filtered

    def _sanitize_history_content(self, role: str, content: Optional[str]) -> str:
        """LLM 히스토리에 넣기 전에 tool 결과 블록을 제거/축약"""
        if not isinstance(content, str):
            return ""
        if role != "assistant":
            return content

        # Remove tool result blocks (KAgent-style <details> with 🔧 summary)
        sanitized = re.sub(
            r"<details>\s*<summary>🔧.*?</details>\s*",
            "",
            content,
            flags=re.DOTALL,
        ).strip()

        # Hard cap to avoid context blow-up even after stripping
        max_chars = 8000
        if len(sanitized) > max_chars:
            sanitized = sanitized[:max_chars] + "\n... (truncated) ..."
        return sanitized

    def _truncate_tool_result_for_llm(self, content: Optional[str]) -> str:
        """Tool 결과를 LLM 입력용으로 축약"""
        if not isinstance(content, str):
            content = "" if content is None else str(content)
        max_chars = 6000
        if len(content) > max_chars:
            return content[:max_chars] + "\n... (truncated for LLM) ..."
        return content

    def _format_age(self, timestamp: Optional[str]) -> str:
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

    def _format_table(self, headers: List[str], rows: List[List[str]]) -> str:
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
        self,
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

                age = self._format_age(meta.get("creationTimestamp"))
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
            return self._format_table(headers, rows)

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
                age = self._format_age(meta.get("creationTimestamp"))
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
            return self._format_table(headers, rows)

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
                age = self._format_age(meta.get("creationTimestamp"))
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
            return self._format_table(headers, rows)

        if key in {"ns", "namespace", "namespaces"}:
            headers = ["NAME", "STATUS", "AGE"]
            rows = []
            for item in items:
                meta = item.get("metadata", {}) if isinstance(item, dict) else {}
                status = item.get("status", {}) if isinstance(item, dict) else {}
                phase = status.get("phase", "")
                age = self._format_age(meta.get("creationTimestamp"))
                rows.append([str(meta.get("name", "")), str(phase), age])
            return self._format_table(headers, rows)

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
                age = self._format_age(meta.get("creationTimestamp"))
                version = (status.get("nodeInfo") or {}).get("kubeletVersion", "")
                rows.append([str(meta.get("name", "")), ready, roles_text, age, str(version)])
            return self._format_table(headers, rows)

        # Fallback: name/age
        headers = ["NAME", "AGE"]
        if include_namespace:
            headers = ["NAMESPACE"] + headers
        rows = []
        for item in items:
            meta = item.get("metadata", {}) if isinstance(item, dict) else {}
            age = self._format_age(meta.get("creationTimestamp"))
            row = [str(meta.get("name", "")), age]
            if include_namespace:
                row = [str(meta.get("namespace", ""))] + row
            rows.append(row)
        return self._format_table(headers, rows)

    def _format_k8s_get_events_display(self, raw_text: str) -> Optional[str]:
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
            last_seen = self._format_age(last_ts) if isinstance(last_ts, str) else "-"
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
        return self._format_table(headers, rows)

    def _format_age_value(self, value) -> str:
        if not value:
            return "-"
        if isinstance(value, str):
            # Already formatted duration (e.g., "110 days, 7:31:18")
            if ("day" in value or "days" in value or "h" in value or "m" in value or "s" in value) and "T" not in value:
                return value
            return self._format_age(value)
        try:
            return self._format_age(value)
        except Exception:
            return "-"

    def _format_namespaces_display(self, raw_text: str) -> Optional[str]:
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
                self._format_age_value(ns.get("created_at")),
                str(rc.get("pods", 0)),
                str(rc.get("services", 0)),
                str(rc.get("deployments", 0)),
                str(rc.get("pvcs", 0)),
            ])
        return self._format_table(headers, rows)

    def _format_pods_display(self, raw_text: str, include_namespace: bool) -> Optional[str]:
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
                self._format_age_value(pod.get("created_at")),
            ]
            if include_namespace:
                row = [str(pod.get("namespace", ""))] + row
            rows.append(row)
        return self._format_table(headers, rows)

    def _format_deployments_display(self, raw_text: str) -> Optional[str]:
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
                self._format_age_value(dep.get("created_at")),
            ])
        return self._format_table(headers, rows)

    def _format_services_display(self, raw_text: str) -> Optional[str]:
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
                self._format_age_value(svc.get("created_at")),
            ])
        return self._format_table(headers, rows)

    def _format_service_connectivity_display(self, raw_text: str) -> Optional[str]:
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
        return self._format_table(headers, rows)

    def _format_nodes_display(self, raw_text: str) -> Optional[str]:
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
                self._format_age_value(node.get("age")),
                str(node.get("version", "")),
                str(node.get("internal_ip") or ""),
                str(node.get("external_ip") or "<none>"),
            ])
        return self._format_table(headers, rows)

    def _format_pvcs_display(self, raw_text: str) -> Optional[str]:
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
                self._format_age_value(pvc.get("created_at")),
            ]
            if include_namespace:
                row = [str(pvc.get("namespace", ""))] + row
            rows.append(row)
        return self._format_table(headers, rows)

    def _format_pvs_display(self, raw_text: str) -> Optional[str]:
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
                self._format_age_value(pv.get("created_at")),
            ])
        return self._format_table(headers, rows)

    def _format_api_resources_display(self, raw_text: str) -> Optional[str]:
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
        return self._format_table(headers, rows)

    def _format_pod_metrics_display(self, raw_text: str) -> Optional[str]:
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
        return self._format_table(headers, rows)

    def _format_node_metrics_display(self, raw_text: str) -> Optional[str]:
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
        return self._format_table(headers, rows)

    def _build_tool_display(
        self,
        function_name: str,
        function_args: Dict,
        formatted_result: str,
        is_json: bool,
        is_yaml: bool,
    ) -> Optional[str]:
        if function_name == "get_namespaces":
            return self._format_namespaces_display(formatted_result)
        if function_name == "get_pods":
            return self._format_pods_display(formatted_result, include_namespace=False)
        if function_name == "get_all_pods":
            return self._format_pods_display(formatted_result, include_namespace=True)
        if function_name == "find_pods":
            return self._format_pods_display(formatted_result, include_namespace=True)
        if function_name == "get_deployments":
            return self._format_deployments_display(formatted_result)
        if function_name == "find_deployments":
            return self._format_deployments_display(formatted_result)
        if function_name == "get_services":
            return self._format_services_display(formatted_result)
        if function_name == "find_services":
            return self._format_services_display(formatted_result)
        if function_name == "k8s_check_service_connectivity":
            return self._format_service_connectivity_display(formatted_result)
        if function_name == "get_node_list":
            return self._format_nodes_display(formatted_result)
        if function_name == "get_pvcs":
            return self._format_pvcs_display(formatted_result)
        if function_name == "get_pvs":
            return self._format_pvs_display(formatted_result)
        if function_name == "get_pod_metrics":
            return self._format_pod_metrics_display(formatted_result)
        if function_name == "get_node_metrics":
            return self._format_node_metrics_display(formatted_result)
        if function_name == "k8s_get_available_api_resources":
            return self._format_api_resources_display(formatted_result)
        if function_name == "k8s_get_resources":
            output = function_args.get("output", "wide")
            namespace = function_args.get("namespace")
            all_namespaces_raw = function_args.get("all_namespaces", False)
            if isinstance(all_namespaces_raw, str):
                all_namespaces = all_namespaces_raw.strip().lower() == "true"
            else:
                all_namespaces = bool(all_namespaces_raw)
            include_namespace = all_namespaces or not (isinstance(namespace, str) and namespace.strip())
            return self._format_k8s_get_resources_display(
                function_args.get("resource_type", ""),
                output if isinstance(output, str) else "wide",
                formatted_result,
                include_namespace=include_namespace,
            )
        if function_name == "k8s_get_events":
            return self._format_k8s_get_events_display(formatted_result)
        return None
    
    async def analyze_logs(self, request: LogAnalysisRequest) -> LogAnalysisResponse:
        """로그 분석"""
        
        # 에러 패턴 추출
        error_patterns = self._extract_error_patterns(request.logs)
        
        # GPT를 사용한 상세 분석
        prompt = f"""
다음은 Kubernetes Pod의 로그입니다:

Namespace: {request.namespace}
Pod: {request.pod_name}
Container: {request.container or 'N/A'}

로그:
```
{request.logs[:4000]}  # 토큰 제한을 위해 일부만
```

다음을 분석해주세요:
1. 로그 요약
2. 발견된 에러의 근본 원인
3. 해결 방안 (구체적이고 실행 가능한 단계)
4. 관련된 일반적인 이슈들

JSON 형식으로 응답해주세요:
{{
  "summary": "로그 요약",
  "root_cause": "근본 원인",
  "recommendations": ["해결방안1", "해결방안2"],
  "related_issues": ["관련이슈1", "관련이슈2"]
}}
"""
        
        try:
            print(f"[AI Service] Analyze Logs API 호출 - 요청 모델: {self.model}", flush=True)
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "당신은 Kubernetes 전문가이자 DevOps 엔지니어입니다. 로그를 분석하고 문제를 해결하는 데 도움을 줍니다."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3,
                response_format={"type": "json_object"}
            )
            print(f"[AI Service] Analyze Logs API 응답 - 실제 사용 모델: {response.model}", flush=True)
            
            # OpenAI 응답 전체 로그 출력
            import json
            response_dict = {
                "id": response.id,
                "model": response.model,
                "created": response.created,
                "choices": [
                    {
                        "index": choice.index,
                        "message": {
                            "role": choice.message.role,
                            "content": choice.message.content,
                            "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                        },
                        "finish_reason": choice.finish_reason
                    } for choice in response.choices
                ],
                "usage": {
                    "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                    "completion_tokens": response.usage.completion_tokens if response.usage else None,
                    "total_tokens": response.usage.total_tokens if response.usage else None
                } if response.usage else None
            }
            print(f"[OPENAI RESPONSE][analyze_logs] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
            
            result = json.loads(response.choices[0].message.content)
            
            return LogAnalysisResponse(
                summary=result.get("summary", ""),
                errors=error_patterns,
                root_cause=result.get("root_cause"),
                recommendations=result.get("recommendations", []),
                related_issues=result.get("related_issues", [])
            )
        except Exception as e:
            # Fallback: GPT 없이도 기본 분석 제공
            return LogAnalysisResponse(
                summary="로그에서 에러 패턴을 감지했습니다.",
                errors=error_patterns,
                root_cause="상세 분석을 위해 AI 서비스가 필요합니다.",
                recommendations=["로그를 확인하고 에러 메시지를 검색하세요."],
                related_issues=[]
            )
    
    async def troubleshoot(self, request: TroubleshootRequest) -> TroubleshootResponse:
        """종합 트러블슈팅"""
        
        # 리소스 정보 수집
        context = await self._gather_resource_context(request)
        
        prompt = f"""
다음 Kubernetes 리소스에 문제가 발생했습니다:

Namespace: {request.namespace}
Resource Type: {request.resource_type}
Resource Name: {request.resource_name}

컨텍스트:
{context}

다음을 분석해주세요:
1. 진단 (무엇이 문제인가?)
2. 심각도 (critical/high/medium/low/info)
3. 근본 원인들
4. 해결 방안들 (단계별로 구체적으로)
5. 예방 조치

JSON 형식으로 응답해주세요:
{{
  "diagnosis": "진단 내용",
  "severity": "심각도",
  "root_causes": ["원인1", "원인2"],
  "solutions": [
    {{"step": 1, "action": "조치1", "command": "kubectl 명령어"}},
    {{"step": 2, "action": "조치2", "command": "kubectl 명령어"}}
  ],
  "preventive_measures": ["예방조치1", "예방조치2"],
  "estimated_fix_time": "예상 해결 시간"
}}
"""
        
        try:
            print(f"[AI Service] Troubleshoot API 호출 - 요청 모델: {self.model}", flush=True)
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "당신은 Kubernetes 트러블슈팅 전문가입니다."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3,
                response_format={"type": "json_object"}
            )
            print(f"[AI Service] Troubleshoot API 응답 - 실제 사용 모델: {response.model}", flush=True)
            
            # OpenAI 응답 전체 로그 출력
            import json
            response_dict = {
                "id": response.id,
                "model": response.model,
                "created": response.created,
                "choices": [
                    {
                        "index": choice.index,
                        "message": {
                            "role": choice.message.role,
                            "content": choice.message.content,
                            "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                        },
                        "finish_reason": choice.finish_reason
                    } for choice in response.choices
                ],
                "usage": {
                    "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                    "completion_tokens": response.usage.completion_tokens if response.usage else None,
                    "total_tokens": response.usage.total_tokens if response.usage else None
                } if response.usage else None
            }
            print(f"[OPENAI RESPONSE][troubleshoot] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
            
            result = json.loads(response.choices[0].message.content)
            
            return TroubleshootResponse(
                diagnosis=result.get("diagnosis", ""),
                severity=SeverityLevel(result.get("severity", "medium")),
                root_causes=result.get("root_causes", []),
                solutions=result.get("solutions", []),
                preventive_measures=result.get("preventive_measures", []),
                estimated_fix_time=result.get("estimated_fix_time")
            )
        except Exception as e:
            raise Exception(f"Troubleshooting failed: {e}")
    
    async def chat(self, request: ChatRequest) -> ChatResponse:
        """AI 챗봇 with Function Calling"""
        
        # 시스템 메시지
        system_message = """
    당신은 Kubernetes 클러스터를 관리하는 AI Agent입니다.
    사용자의 질문에 답하기 위해 필요한 경우 Kubernetes API를 직접 호출할 수 있습니다.
    실시간 클러스터 정보를 조회하여 정확한 답변을 제공하세요.

    중요: 사용자가 네임스페이스를 명시하지 않은 요청에서 `default`를 임의로 가정하지 마세요.
    사용자가 리소스 이름을 "대충" 던지는 경우(정확한 전체 이름이 아닌 식별자/부분 문자열)에는,
    먼저 `k8s_get_resources`를 `all_namespaces=true`로 호출해 모든 네임스페이스에서 후보를 찾고
    그 결과의 `namespace`/`name`을 사용해 후속 도구(로그/describe 등)를 호출하세요.
    YAML 요청은 `k8s_get_resource_yaml`에서만 지원합니다. 그 외에는 JSON으로 조회하고 화면에는 kubectl 테이블로 표시합니다.
    """
        
        # 메시지 변환
        messages = [{"role": "system", "content": system_message}]
        for msg in request.messages:
            messages.append({
                "role": msg.role,
                "content": self._sanitize_history_content(msg.role, msg.content),
            })
        
        # 컨텍스트 추가
        if request.context:
            context_str = f"\n\n현재 컨텍스트:\n{request.context}"
            messages[-1]["content"] += context_str
        
        # Function definitions
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_cluster_overview",
                    "description": "클러스터 전체 개요 (네임스페이스, Pod, Service 등의 총 개수)를 조회합니다",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pod_metrics",
                    "description": "Pod 리소스 사용량(CPU/Memory) 조회 (kubectl top pods)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"}
                        }
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_node_metrics",
                    "description": "Node 리소스 사용량(CPU/Memory) 조회 (kubectl top nodes)",
                    "parameters": {"type": "object", "properties": {}}
                }
            }
        ]
        tools.extend(self._get_k8s_readonly_tool_definitions())
        # YAML/WIDE 요청 시 legacy JSON-only 도구는 제외
        latest_user_message = next((m.content for m in reversed(request.messages) if m.role == "user"), None)
        tools = self._filter_tools_for_output_preference(tools, latest_user_message)
        
        try:
            # 첫 번째 GPT 호출 (function calling 포함)
            print(f"[AI Service] Chat API 호출 - 요청 모델: {self.model}", flush=True)
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                temperature=0.7
            )
            print(f"[AI Service] Chat API 응답 - 실제 사용 모델: {response.model}", flush=True)
            
            # OpenAI 응답 전체 로그 출력
            import json
            response_dict = {
                "id": response.id,
                "model": response.model,
                "created": response.created,
                "choices": [
                    {
                        "index": choice.index,
                        "message": {
                            "role": choice.message.role,
                            "content": choice.message.content,
                            "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                        },
                        "finish_reason": choice.finish_reason
                    } for choice in response.choices
                ],
                "usage": {
                    "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                    "completion_tokens": response.usage.completion_tokens if response.usage else None,
                    "total_tokens": response.usage.total_tokens if response.usage else None
                } if response.usage else None
            }
            print(f"[OPENAI RESPONSE][chat first] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
            
            response_message = response.choices[0].message
            tool_calls = response_message.tool_calls
            
            # Function calling이 있으면 실행
            if tool_calls:
                messages.append(response_message)
                
                for tool_call in tool_calls:
                    function_name = tool_call.function.name
                    function_args = eval(tool_call.function.arguments)
                    
                    # 함수 실행
                    function_response = await self._execute_function(function_name, function_args)
                    formatted_result, _, _ = self._format_tool_result(
                        function_name,
                        function_args,
                        function_response,
                    )
                    tool_message_content = self._truncate_tool_result_for_llm(formatted_result)
                    
                    messages.append({
                        "tool_call_id": tool_call.id,
                        "role": "tool",
                        "name": function_name,
                        "content": tool_message_content
                    })
                
                # 함수 결과를 바탕으로 최종 답변 생성
                print(f"[AI Service] Chat API 두 번째 호출 - 요청 모델: {self.model}", flush=True)
                second_response = await self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    temperature=0.7
                )
                print(f"[AI Service] Chat API 두 번째 응답 - 실제 사용 모델: {second_response.model}", flush=True)
                
                # OpenAI 응답 전체 로그 출력
                import json
                response_dict = {
                    "id": second_response.id,
                    "model": second_response.model,
                    "created": second_response.created,
                    "choices": [
                        {
                            "index": choice.index,
                            "message": {
                                "role": choice.message.role,
                                "content": choice.message.content,
                                "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                            },
                            "finish_reason": choice.finish_reason
                        } for choice in second_response.choices
                    ],
                    "usage": {
                        "prompt_tokens": second_response.usage.prompt_tokens if second_response.usage else None,
                        "completion_tokens": second_response.usage.completion_tokens if second_response.usage else None,
                        "total_tokens": second_response.usage.total_tokens if second_response.usage else None
                    } if second_response.usage else None
                }
                print(f"[OPENAI RESPONSE][chat second] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
                
                message = second_response.choices[0].message.content
            else:
                message = response_message.content
            
            suggestions = self._extract_suggestions(message)
            
            return ChatResponse(
                message=message,
                suggestions=suggestions,
                actions=[]
            )
        except Exception as e:
            raise Exception(f"Chat failed: {e}")
    
    async def explain_resource(self, resource_type: str, resource_yaml: str) -> str:
        """리소스 YAML 설명"""
        
        prompt = f"""
다음 Kubernetes {resource_type} 리소스를 분석해주세요:

```yaml
{resource_yaml}
```

다음을 설명해주세요:
1. 이 리소스가 하는 일
2. 주요 설정 설명
3. 잠재적 문제점이나 개선 사항
4. 베스트 프랙티스 권장사항
"""
        
        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "당신은 Kubernetes 리소스 설정 전문가입니다."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.5
            )
            
            # OpenAI 응답 전체 로그 출력
            import json
            response_dict = {
                "id": response.id,
                "model": response.model,
                "created": response.created,
                "choices": [
                    {
                        "index": choice.index,
                        "message": {
                            "role": choice.message.role,
                            "content": choice.message.content,
                            "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                        },
                        "finish_reason": choice.finish_reason
                    } for choice in response.choices
                ],
                "usage": {
                    "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                    "completion_tokens": response.usage.completion_tokens if response.usage else None,
                    "total_tokens": response.usage.total_tokens if response.usage else None
                } if response.usage else None
            }
            print(f"[OPENAI RESPONSE][explain_resource] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
            
            return response.choices[0].message.content
        except Exception as e:
            raise Exception(f"Resource explanation failed: {e}")
    
    async def suggest_optimization(self, namespace: str) -> List[str]:
        """리소스 최적화 제안"""

        observations = await self._build_optimization_observations(namespace)

        prompt = f"""
아래는 Kubernetes 네임스페이스의 **관측 데이터(스펙/상태/메트릭/이벤트)** 요약입니다.
이 데이터에 근거해서 리소스 최적화 제안을 작성하세요.

중요:
- 추측/일반론만 쓰지 말고, 반드시 숫자/리소스명 등 관측값을 인용하세요.
- 관측 데이터에 없는 내용은 "추가 확인 필요"로 남기세요.

관측 요약:
{observations['observations_md']}

요구사항:
1) 우선순위(High/Med/Low)와 기대효과(비용/성능/안정성)를 같이 표기
2) 각 항목마다 "근거(관측)"를 1줄 이상 포함
3) 가능하면 kubectl 패치 예시(짧게) 포함

출력은 마크다운으로, 리스트 형태로 작성하세요.
"""

        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "당신은 Kubernetes 리소스 최적화 전문가입니다. 반드시 관측 데이터에 근거해 답하세요."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.5
            )
            
            # OpenAI 응답 전체 로그 출력
            import json
            response_dict = {
                "id": response.id,
                "model": response.model,
                "created": response.created,
                "choices": [
                    {
                        "index": choice.index,
                        "message": {
                            "role": choice.message.role,
                            "content": choice.message.content,
                            "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                        },
                        "finish_reason": choice.finish_reason
                    } for choice in response.choices
                ],
                "usage": {
                    "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                    "completion_tokens": response.usage.completion_tokens if response.usage else None,
                    "total_tokens": response.usage.total_tokens if response.usage else None
                } if response.usage else None
            }
            print(f"[OPENAI RESPONSE][suggest_optimization] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)
            
            content = response.choices[0].message.content
            # 제안을 리스트로 파싱
            suggestions = [line.strip() for line in content.split('\n') if line.strip() and (line.strip().startswith('-') or line.strip().startswith('•'))]
            
            return suggestions if suggestions else [content]
        except Exception as e:
            raise Exception(f"Optimization suggestion failed: {e}")

    async def suggest_optimization_stream(self, namespace: str):
        """리소스 최적화 제안 (SSE 스트리밍)"""
        import asyncio
        import json

        try:
            observations = await self._build_optimization_observations(namespace)
            observed_md = observations["observations_md"].rstrip() + "\n\n---\n\n## 최적화 제안 (AI)\n\n"

            # 1) 표(관측 데이터) 먼저 출력
            yield "data: " + json.dumps({"kind": "observed", "content": observed_md}, ensure_ascii=False) + "\n\n"
            await asyncio.sleep(0)

            # 2) 표/관측값 기반 draft(룰 기반)도 모델 입력에 포함해 일관성 강화 (UI에는 직접 출력 X)
            draft_plan = observations.get("action_plan_md", "").strip()

            prompt = f"""
    아래는 Kubernetes 네임스페이스의 관측 데이터(표)입니다. 이 표를 근거로 최적화 제안을 작성하세요.

    필수:
    - 제안에 반드시 표의 리소스명/수치(util, request/limit, avg usage 등)를 인용해서 근거를 달아주세요.
    - 표의 `usage`는 metrics-server 스냅샷(현재값)이며, 표의 `usage` 값은 파드별 스냅샷을 deployment 단위로 평균 낸 값입니다. `req/lim`은 컨테이너별 합(누락 시 과소추정)일 수 있습니다. 누락/불일치가 보이면 숫자 추천을 단정하지 말고 "먼저 YAML 확인/누락 보완"을 제안하세요.
    - 표에 없는 내용은 "추가 확인 필요"로 처리하고 추측하지 마세요.
    - 아래 'Draft (rules-based)'에 있는 수치/추천값이 있다면 **수치를 변경하지 말고** 문장/구조만 다듬어 주세요.

Observed data (markdown):
{observations["observations_md"]}

Draft (rules-based, keep numbers unchanged):
{draft_plan if draft_plan else "(none)"}

출력:
- 마크다운
- High/Medium/Low 우선순위
- 각 항목에 (효과: 비용/성능/안정성) + 근거 + 적용 예시(kubectl 짧게)

금지:
- 응답 전체를 ```markdown ... ``` 같은 코드 펜스로 감싸지 마세요. (그렇게 하면 UI에서 마크다운 렌더가 코드블록으로 깨집니다)
- 최상단을 ```로 시작하지 마세요.
"""

            max_tokens = int(getattr(settings, "OPENAI_OPTIMIZATION_MAX_TOKENS", 900) or 900)

            try:
                stream = await self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {
                            "role": "system",
                            "content": "당신은 Kubernetes 리소스 최적화 전문가입니다. 반드시 관측 데이터에 근거해 답하세요.",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.2,
                    max_tokens=max_tokens,
                    stream=True,
                    stream_options={"include_usage": True},
                )
            except TypeError:
                stream = await self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {
                            "role": "system",
                            "content": "당신은 Kubernetes 리소스 최적화 전문가입니다. 반드시 관측 데이터에 근거해 답하세요.",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.2,
                    max_tokens=max_tokens,
                    stream=True,
                )

            stream_usage = None
            finish_reason = None
            async for chunk in stream:
                if getattr(chunk, "usage", None) is not None:
                    stream_usage = chunk.usage
                if chunk.choices and getattr(chunk.choices[0], "finish_reason", None) is not None:
                    finish_reason = chunk.choices[0].finish_reason

                delta = chunk.choices[0].delta
                if delta and getattr(delta, "content", None):
                    yield "data: " + json.dumps({"kind": "answer", "content": delta.content}, ensure_ascii=False) + "\n\n"

            yield (
                "data: "
                + json.dumps(
                    {
                        "kind": "meta",
                        "usage_phase": "suggest_optimization_stream",
                        "finish_reason": finish_reason,
                        "max_tokens": max_tokens,
                    },
                    ensure_ascii=False,
                )
                + "\n\n"
            )

            if stream_usage is not None:
                yield (
                    "data: "
                    + json.dumps(
                        {
                            "kind": "usage",
                            "usage_phase": "suggest_optimization_stream",
                            "usage": {
                                "prompt_tokens": stream_usage.prompt_tokens,
                                "completion_tokens": stream_usage.completion_tokens,
                                "total_tokens": stream_usage.total_tokens,
                            },
                        },
                        ensure_ascii=False,
                    )
                    + "\n\n"
                )

            yield "data: [DONE]\n\n"
        except Exception as e:
            yield "data: " + json.dumps({"kind": "error", "error": str(e)}, ensure_ascii=False) + "\n\n"
            yield "data: [DONE]\n\n"

    def _parse_cpu_quantity_to_m(self, value: Optional[str]) -> Optional[int]:
        if value is None:
            return None
        s = str(value).strip()
        if not s:
            return None
        try:
            if s.endswith("m"):
                return int(float(s[:-1]))
            if s.endswith("n"):
                # nano cores -> millicores
                return int(float(s[:-1]) / 1_000_000)
            # assume cores
            return int(float(s) * 1000)
        except Exception:
            return None

    def _parse_memory_quantity_to_mi(self, value: Optional[str]) -> Optional[int]:
        if value is None:
            return None
        s = str(value).strip()
        if not s:
            return None
        try:
            if s.endswith("Ki"):
                return int(float(s[:-2]) / 1024)
            if s.endswith("Mi"):
                return int(float(s[:-2]))
            if s.endswith("Gi"):
                return int(float(s[:-2]) * 1024)
            if s.endswith("Ti"):
                return int(float(s[:-2]) * 1024 * 1024)
            # bytes
            return int(float(s) / (1024 * 1024))
        except Exception:
            return None

    def _median_int(self, values: List[int]) -> Optional[int]:
        if not values:
            return None
        values_sorted = sorted(values)
        return values_sorted[len(values_sorted) // 2]

    def _round_up_int(self, value: int, step: int) -> int:
        if step <= 0:
            return value
        return int(((value + step - 1) // step) * step)

    def _labels_match_selector(self, labels: Dict, selector: Dict) -> bool:
        if not selector:
            return False
        if not labels:
            return False
        for k, v in selector.items():
            if labels.get(k) != v:
                return False
        return True

    def _extract_image_tag_flag(self, image: str) -> str:
        if not image:
            return "unknown"
        # image without ':' after last '/' is often untagged -> defaults to latest
        last_segment = image.split("/")[-1]
        if ":" not in last_segment:
            return "untagged"
        if image.endswith(":latest"):
            return "latest"
        return "pinned"

    async def _build_optimization_observations(self, namespace: str) -> Dict[str, str]:
        """최적화 제안용 관측 데이터 요약 생성 (LLM 입력 + UI 표시용)"""
        overview = None
        try:
            overview = await self.k8s_service.get_cluster_overview()
        except Exception as e:
            overview = {"error": str(e)}

        deployments = await self.k8s_service.get_deployments(namespace)
        pods = await self.k8s_service.get_pods(namespace)

        pod_metrics: Optional[List[Dict]] = None
        pod_metrics_error: Optional[str] = None
        try:
            pod_metrics = await self.k8s_service.get_pod_metrics(namespace)
        except Exception as e:
            pod_metrics = None
            pod_metrics_error = str(e)

        events: List[Dict] = []
        events_error: Optional[str] = None
        try:
            events = await self.k8s_service.get_events(namespace)
        except Exception as e:
            events_error = str(e)

        deployments_sorted = sorted(
            deployments,
            key=lambda d: len((d.get("selector") or {})),
            reverse=True,
        )

        # Map pod -> deployment by selector (most specific selector wins)
        pod_to_deployment: Dict[str, str] = {}
        deployment_to_pods: Dict[str, List[Dict]] = {d.get("name"): [] for d in deployments_sorted if d.get("name")}
        unmatched_pods: List[Dict] = []
        for pod in pods:
            labels = pod.get("labels") or {}
            matched_name: Optional[str] = None
            for dep in deployments_sorted:
                dep_name = dep.get("name")
                selector = dep.get("selector") or {}
                if not dep_name:
                    continue
                if self._labels_match_selector(labels, selector):
                    matched_name = dep_name
                    break
            if matched_name:
                pod_to_deployment[pod.get("name", "")] = matched_name
                deployment_to_pods.setdefault(matched_name, []).append(pod)
            else:
                unmatched_pods.append(pod)

        metrics_by_pod: Dict[str, Dict] = {}
        if pod_metrics:
            for item in pod_metrics:
                key = f"{item.get('namespace')}/{item.get('name')}"
                metrics_by_pod[key] = item

        metrics_window_sample: Optional[str] = None
        metrics_timestamp_max: Optional[str] = None
        if pod_metrics:
            windows = [str(m.get("window")) for m in pod_metrics if m.get("window")]
            if windows:
                # "30s" 같은 값이 대부분이므로 샘플 1개만 표기(가장 흔한 값 우선)
                counts: Dict[str, int] = {}
                for w in windows:
                    counts[w] = counts.get(w, 0) + 1
                metrics_window_sample = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[0][0]

            timestamps = [str(m.get("timestamp")) for m in pod_metrics if m.get("timestamp")]
            if timestamps:
                # ISO8601이면 max timestamp를 표기(파싱 실패 시 문자열 max로 fallback)
                try:
                    from datetime import datetime

                    parsed = []
                    for ts in timestamps:
                        parsed.append(datetime.fromisoformat(ts.replace("Z", "+00:00")))
                    metrics_timestamp_max = max(parsed).isoformat()
                except Exception:
                    metrics_timestamp_max = max(timestamps)

        def pod_resource_totals(pod: Dict):
            cpu_req_m_vals: List[int] = []
            cpu_lim_m_vals: List[int] = []
            mem_req_mi_vals: List[int] = []
            mem_lim_mi_vals: List[int] = []
            missing_req_any = 0
            missing_lim_any = 0
            missing_cpu_req = 0
            missing_mem_req = 0
            missing_cpu_lim = 0
            missing_mem_lim = 0

            for c in (pod.get("containers") or []):
                req = c.get("requests") or {}
                lim = c.get("limits") or {}
                cpu_req_m = self._parse_cpu_quantity_to_m(req.get("cpu"))
                mem_req_mi = self._parse_memory_quantity_to_mi(req.get("memory"))
                cpu_lim_m = self._parse_cpu_quantity_to_m(lim.get("cpu"))
                mem_lim_mi = self._parse_memory_quantity_to_mi(lim.get("memory"))

                if cpu_req_m is None:
                    missing_cpu_req += 1
                if mem_req_mi is None:
                    missing_mem_req += 1
                if cpu_lim_m is None:
                    missing_cpu_lim += 1
                if mem_lim_mi is None:
                    missing_mem_lim += 1

                if cpu_req_m is None or mem_req_mi is None:
                    missing_req_any += 1
                if cpu_lim_m is None or mem_lim_mi is None:
                    missing_lim_any += 1

                if cpu_req_m is not None:
                    cpu_req_m_vals.append(cpu_req_m)
                if cpu_lim_m is not None:
                    cpu_lim_m_vals.append(cpu_lim_m)
                if mem_req_mi is not None:
                    mem_req_mi_vals.append(mem_req_mi)
                if mem_lim_mi is not None:
                    mem_lim_mi_vals.append(mem_lim_mi)

            return {
                "cpu_request_m": sum(cpu_req_m_vals) if cpu_req_m_vals else None,
                "cpu_limit_m": sum(cpu_lim_m_vals) if cpu_lim_m_vals else None,
                "mem_request_mi": sum(mem_req_mi_vals) if mem_req_mi_vals else None,
                "mem_limit_mi": sum(mem_lim_mi_vals) if mem_lim_mi_vals else None,
                "containers_total": len(pod.get("containers") or []),
                "containers_missing_requests": missing_req_any,
                "containers_missing_limits": missing_lim_any,
                "containers_missing_cpu_requests": missing_cpu_req,
                "containers_missing_mem_requests": missing_mem_req,
                "containers_missing_cpu_limits": missing_cpu_lim,
                "containers_missing_mem_limits": missing_mem_lim,
            }

        def pod_usage(pod: Dict):
            key = f"{pod.get('namespace')}/{pod.get('name')}"
            m = metrics_by_pod.get(key)
            if not m:
                return {"cpu_m": None, "mem_mi": None}
            return {
                "cpu_m": self._parse_cpu_quantity_to_m(m.get("cpu")),
                "mem_mi": self._parse_memory_quantity_to_mi(m.get("memory")),
                "timestamp": m.get("timestamp"),
                "window": m.get("window"),
            }

        deployment_rows = []
        findings: List[str] = []

        node_count = None
        if isinstance(overview, dict):
            node_count = overview.get("node_count")
        node_count = int(node_count) if isinstance(node_count, (int, float)) else None

        for dep in deployments_sorted[:25]:
            dep_name = dep.get("name")
            if not dep_name:
                continue
            dep_pods = deployment_to_pods.get(dep_name, [])

            restarts = [int(p.get("restart_count") or 0) for p in dep_pods]
            total_restarts = sum(restarts)
            max_restarts = max(restarts) if restarts else 0
            not_ready = 0
            for p in dep_pods:
                ready_str = str(p.get("ready") or "")
                try:
                    ready_ok = ready_str and ready_str.split("/")[0] == ready_str.split("/")[1]
                except Exception:
                    ready_ok = False
                if not ready_ok:
                    not_ready += 1

            per_pod_cpu_req = []
            per_pod_cpu_lim = []
            per_pod_mem_req = []
            per_pod_mem_lim = []
            missing_req_containers = 0
            missing_lim_containers = 0
            missing_cpu_req_containers = 0
            missing_mem_req_containers = 0
            missing_cpu_lim_containers = 0
            missing_mem_lim_containers = 0
            containers_total = 0

            cpu_usage_vals = []
            mem_usage_vals = []

            image_flags = []
            reason_counts: Dict[str, int] = {}
            for p in dep_pods:
                totals = pod_resource_totals(p)
                containers_total += totals["containers_total"]
                missing_req_containers += totals["containers_missing_requests"]
                missing_lim_containers += totals["containers_missing_limits"]
                missing_cpu_req_containers += totals.get("containers_missing_cpu_requests", 0) or 0
                missing_mem_req_containers += totals.get("containers_missing_mem_requests", 0) or 0
                missing_cpu_lim_containers += totals.get("containers_missing_cpu_limits", 0) or 0
                missing_mem_lim_containers += totals.get("containers_missing_mem_limits", 0) or 0
                if totals["cpu_request_m"] is not None:
                    per_pod_cpu_req.append(totals["cpu_request_m"])
                if totals["cpu_limit_m"] is not None:
                    per_pod_cpu_lim.append(totals["cpu_limit_m"])
                if totals["mem_request_mi"] is not None:
                    per_pod_mem_req.append(totals["mem_request_mi"])
                if totals["mem_limit_mi"] is not None:
                    per_pod_mem_lim.append(totals["mem_limit_mi"])

                u = pod_usage(p)
                if u.get("cpu_m") is not None:
                    cpu_usage_vals.append(int(u["cpu_m"]))
                if u.get("mem_mi") is not None:
                    mem_usage_vals.append(int(u["mem_mi"]))

                for c in (p.get("containers") or []):
                    img = str(c.get("image") or "")
                    if img:
                        image_flags.append(self._extract_image_tag_flag(img))

                    # container state / last_state reasons
                    for state_key in ("state", "last_state"):
                        st = c.get(state_key) or {}
                        if not isinstance(st, dict):
                            continue
                        waiting = st.get("waiting") if isinstance(st.get("waiting"), dict) else None
                        if waiting and waiting.get("reason"):
                            reason = str(waiting.get("reason"))
                            reason_counts[reason] = reason_counts.get(reason, 0) + 1
                        terminated = st.get("terminated") if isinstance(st.get("terminated"), dict) else None
                        if terminated and terminated.get("reason"):
                            reason = str(terminated.get("reason"))
                            reason_counts[reason] = reason_counts.get(reason, 0) + 1

            cpu_req_med = self._median_int(per_pod_cpu_req)
            mem_req_med = self._median_int(per_pod_mem_req)
            cpu_lim_med = self._median_int(per_pod_cpu_lim)
            mem_lim_med = self._median_int(per_pod_mem_lim)

            cpu_usage_avg = int(sum(cpu_usage_vals) / len(cpu_usage_vals)) if cpu_usage_vals else None
            mem_usage_avg = int(sum(mem_usage_vals) / len(mem_usage_vals)) if mem_usage_vals else None

            cpu_util = None
            if missing_cpu_req_containers == 0 and cpu_req_med and cpu_usage_avg is not None and cpu_req_med > 0:
                cpu_util = round(cpu_usage_avg / cpu_req_med * 100, 1)
            mem_util = None
            if missing_mem_req_containers == 0 and mem_req_med and mem_usage_avg is not None and mem_req_med > 0:
                mem_util = round(mem_usage_avg / mem_req_med * 100, 1)

            image_flag = "unknown"
            if image_flags:
                # If any latest/untagged exists, highlight
                if "latest" in image_flags:
                    image_flag = "latest"
                elif "untagged" in image_flags:
                    image_flag = "untagged"
                else:
                    image_flag = "pinned"

            deployment_rows.append(
                {
                    "name": dep_name,
                    "replicas": dep.get("replicas"),
                    "ready": dep.get("ready_replicas"),
                    "pods": len(dep_pods),
                    "not_ready": not_ready,
                    "restarts_total": total_restarts,
                    "restarts_max": max_restarts,
                    "cpu_req_m": cpu_req_med,
                    "cpu_lim_m": cpu_lim_med,
                    "mem_req_mi": mem_req_med,
                    "mem_lim_mi": mem_lim_med,
                    "cpu_usage_m_avg": cpu_usage_avg,
                    "mem_usage_mi_avg": mem_usage_avg,
                    "cpu_util_pct": cpu_util,
                    "mem_util_pct": mem_util,
                    "containers_total": containers_total,
                    "missing_req_containers": missing_req_containers,
                    "missing_lim_containers": missing_lim_containers,
                    "missing_cpu_req_containers": missing_cpu_req_containers,
                    "missing_mem_req_containers": missing_mem_req_containers,
                    "missing_cpu_lim_containers": missing_cpu_lim_containers,
                    "missing_mem_lim_containers": missing_mem_lim_containers,
                    "image_flag": image_flag,
                    "selector": dep.get("selector") or {},
                    "reason_counts": reason_counts,
                }
            )

        # Aggregate findings (less spammy than per-deployment repetition)
        def sample(names: List[str], limit: int = 6) -> str:
            if not names:
                return ""
            head = names[:limit]
            suffix = "…" if len(names) > limit else ""
            return ", ".join(f"`{n}`" for n in head) + suffix

        if node_count and node_count >= 2:
            single_replica = [r["name"] for r in deployment_rows if r.get("replicas") == 1]
            if single_replica:
                findings.append(
                    f"- replicas=1 deployments: {len(single_replica)}/{len(deployment_rows)} (node_count={node_count}) 예: {sample(single_replica)}"
                )

        missing_resources = [
            r["name"]
            for r in deployment_rows
            if (r.get("missing_req_containers", 0) > 0 or r.get("missing_lim_containers", 0) > 0) and r.get("pods", 0) > 0
        ]
        if missing_resources:
            findings.append(f"- requests/limits 누락 컨테이너가 있는 deployment: {len(missing_resources)} 예: {sample(missing_resources)}")

        missing_cpu_req = [r["name"] for r in deployment_rows if (r.get("missing_cpu_req_containers") or 0) > 0]
        if missing_cpu_req:
            findings.append(f"- cpu requests 누락 컨테이너(부분 누락 포함): {len(missing_cpu_req)} 예: {sample(missing_cpu_req)}")

        missing_mem_req = [r["name"] for r in deployment_rows if (r.get("missing_mem_req_containers") or 0) > 0]
        if missing_mem_req:
            findings.append(f"- memory requests 누락 컨테이너(부분 누락 포함): {len(missing_mem_req)} 예: {sample(missing_mem_req)}")

        missing_cpu_lim = [r["name"] for r in deployment_rows if (r.get("missing_cpu_lim_containers") or 0) > 0]
        if missing_cpu_lim:
            findings.append(f"- cpu limits 누락 컨테이너(부분 누락 포함): {len(missing_cpu_lim)} 예: {sample(missing_cpu_lim)}")

        missing_mem_lim = [r["name"] for r in deployment_rows if (r.get("missing_mem_lim_containers") or 0) > 0]
        if missing_mem_lim:
            findings.append(f"- memory limits 누락 컨테이너(부분 누락 포함): {len(missing_mem_lim)} 예: {sample(missing_mem_lim)}")

        image_issues = [r["name"] for r in deployment_rows if r.get("image_flag") in ("latest", "untagged")]
        if image_issues:
            findings.append(f"- latest/미태깅 이미지 가능성: {len(image_issues)} 예: {sample(image_issues)}")

        # Common runtime issues
        def count_reason(deployment: Dict, reason: str) -> int:
            rc = deployment.get("reason_counts") or {}
            if not isinstance(rc, dict):
                return 0
            return int(rc.get(reason) or 0)

        crashloops = [r["name"] for r in deployment_rows if count_reason(r, "CrashLoopBackOff") > 0]
        if crashloops:
            findings.append(f"- CrashLoopBackOff 감지: {len(crashloops)} 예: {sample(crashloops)}")

        oomkilled = [r["name"] for r in deployment_rows if count_reason(r, "OOMKilled") > 0]
        if oomkilled:
            findings.append(f"- OOMKilled 감지: {len(oomkilled)} 예: {sample(oomkilled)}")

        imagepull = [
            r["name"]
            for r in deployment_rows
            if count_reason(r, "ImagePullBackOff") > 0 or count_reason(r, "ErrImagePull") > 0
        ]
        if imagepull:
            findings.append(f"- ImagePullBackOff/ErrImagePull 감지: {len(imagepull)} 예: {sample(imagepull)}")

        not_ready_deps = [r["name"] for r in deployment_rows if (r.get("not_ready") or 0) > 0]
        if not_ready_deps:
            findings.append(f"- Ready 아닌 pod가 있는 deployment: {len(not_ready_deps)} 예: {sample(not_ready_deps)}")

        high_restarts = [r["name"] for r in deployment_rows if (r.get("restarts_total") or 0) >= 3]
        if high_restarts:
            findings.append(f"- 재시작(>=3) 발생 deployment: {len(high_restarts)} 예: {sample(high_restarts)}")

        cpu_over = [
            r["name"]
            for r in deployment_rows
            if r.get("cpu_util_pct") is not None and (r.get("cpu_req_m") or 0) >= 200 and float(r["cpu_util_pct"]) < 20
        ]
        if cpu_over:
            findings.append(f"- CPU request 과대 가능성(util<20% & req>=200m): {len(cpu_over)} 예: {sample(cpu_over)}")

        mem_over = [
            r["name"]
            for r in deployment_rows
            if r.get("mem_util_pct") is not None and (r.get("mem_req_mi") or 0) >= 256 and float(r["mem_util_pct"]) < 20
        ]
        if mem_over:
            findings.append(f"- Memory request 과대 가능성(util<20% & req>=256Mi): {len(mem_over)} 예: {sample(mem_over)}")

        mem_hot = [r["name"] for r in deployment_rows if r.get("mem_util_pct") is not None and float(r["mem_util_pct"]) >= 90]
        if mem_hot:
            findings.append(f"- Memory request 대비 사용량 높음(util>=90%): {len(mem_hot)} 예: {sample(mem_hot)}")

        cpu_hot = [r["name"] for r in deployment_rows if r.get("cpu_util_pct") is not None and float(r["cpu_util_pct"]) >= 90]
        if cpu_hot:
            findings.append(f"- CPU request 대비 사용량 높음(util>=90%): {len(cpu_hot)} 예: {sample(cpu_hot)}")

        # Events: keep Warning-ish events only, and trim
        event_lines: List[str] = []
        if events:
            warnings = []
            for ev in events:
                if not isinstance(ev, dict):
                    continue
                t = str(ev.get("type") or "")
                reason = str(ev.get("reason") or "")
                msg = str(ev.get("message") or "")
                if t.lower() in ("warning",) or reason in ("FailedScheduling", "FailedMount", "Failed", "BackOff", "ErrImagePull", "ImagePullBackOff"):
                    warnings.append((t, reason, msg))
            for t, reason, msg in warnings[:12]:
                trimmed = (msg[:180] + "…") if len(msg) > 180 else msg
                event_lines.append(f"- [{t or 'Event'}] {reason}: {trimmed}")

        # Build markdown
        header_lines = [
            f"## Observed data (`{namespace}`)",
        ]
        if isinstance(overview, dict) and overview.get("error"):
            header_lines.append(f"- Cluster overview: error={overview.get('error')}")
        else:
            if isinstance(overview, dict):
                header_lines.append(f"- Nodes: {overview.get('node_count', 'N/A')}, Cluster version: {overview.get('cluster_version', 'N/A')}")
        header_lines.append(f"- Deployments: {len(deployments)}, Pods: {len(pods)}")
        if pod_metrics_error:
            header_lines.append(f"- Pod metrics: error={pod_metrics_error}")
        else:
            header_lines.append(f"- Pod metrics: {'available' if pod_metrics is not None else 'unavailable'}")
        header_lines.append(
            "- Note: `usage`는 metrics-server **스냅샷(현재값)** 이며, 표의 `usage` 값은 **파드별 스냅샷을 deployment 단위로 평균** 낸 값입니다. `req/lim`은 컨테이너별 합(누락 컨테이너가 있으면 과소추정)입니다."
        )
        if metrics_window_sample or metrics_timestamp_max:
            header_lines.append(
                f"- Pod metrics snapshot info: window={metrics_window_sample or 'N/A'}, timestamp(max)={metrics_timestamp_max or 'N/A'}"
            )
        if events_error:
            header_lines.append(f"- Events: error={events_error}")
        elif event_lines:
            header_lines.append(f"- Warning events (sample): {len(event_lines)}")

        table_lines = [
            "",
            "### Deployments summary",
            "| deployment | replicas(ready) | pods(notReady) | restarts(total/max) | cpu req/lim (m, per-pod) | cpu usage (m, pods avg snapshot) | mem req/lim (Mi, per-pod) | mem usage (Mi, pods avg snapshot) | util cpu/mem (vs req) | image |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
        ]
        for row in deployment_rows:
            replicas = row.get("replicas")
            ready = row.get("ready")
            pods_count = row.get("pods")
            not_ready = row.get("not_ready")
            restarts_total = row.get("restarts_total")
            restarts_max = row.get("restarts_max")
            cpu_req = row.get("cpu_req_m")
            cpu_lim = row.get("cpu_lim_m")
            mem_req = row.get("mem_req_mi")
            mem_lim = row.get("mem_lim_mi")
            cpu_u = row.get("cpu_usage_m_avg")
            mem_u = row.get("mem_usage_mi_avg")
            cpu_util = row.get("cpu_util_pct")
            mem_util = row.get("mem_util_pct")
            util_text = ""
            if cpu_util is not None or mem_util is not None:
                util_text = f"{cpu_util if cpu_util is not None else 'N/A'}%/{mem_util if mem_util is not None else 'N/A'}%"
            image_flag = row.get("image_flag")

            cpu_req_text = cpu_req if cpu_req is not None else "N/A"
            cpu_lim_text = cpu_lim if cpu_lim is not None else "N/A"
            mem_req_text = mem_req if mem_req is not None else "N/A"
            mem_lim_text = mem_lim if mem_lim is not None else "N/A"
            cpu_u_text = cpu_u if cpu_u is not None else "N/A"
            mem_u_text = mem_u if mem_u is not None else "N/A"
            table_lines.append(
                f"| `{row.get('name')}` | {replicas}({ready}) | {pods_count}({not_ready}) | {restarts_total}/{restarts_max} | {cpu_req_text}/{cpu_lim_text} | {cpu_u_text} | {mem_req_text}/{mem_lim_text} | {mem_u_text} | {util_text or 'N/A'} | {image_flag} |"
            )

        md = "\n".join(header_lines + table_lines)
        if event_lines:
            md += "\n\n### Warning events (sample)\n" + "\n".join(event_lines)
        if findings:
            md += "\n\n### Auto findings (based on observed data)\n" + "\n".join(findings[:30])

        # Build deterministic action plan (so "표"와 "제안"이 연결되게)
        def is_probably_control_plane(name: str) -> bool:
            lowered = name.lower()
            keywords = ("operator", "controller", "admission", "webhook", "converter", "crd")
            return any(k in lowered for k in keywords)

        def is_probably_user_facing(name: str) -> bool:
            lowered = name.lower()
            keywords = ("gateway", "ingress", "web", "api", "console", "dashboard")
            return any(k in lowered for k in keywords)

        def fmt_m(value: Optional[int]) -> str:
            return f"{value}m" if isinstance(value, int) else "N/A"

        def fmt_mi(value: Optional[int]) -> str:
            return f"{value}Mi" if isinstance(value, int) else "N/A"

        def rec_cpu_request_m(row: Dict) -> Optional[int]:
            usage = row.get("cpu_usage_m_avg")
            if not isinstance(usage, int) or usage <= 0:
                return None
            # p95가 없으니 보수적으로 avg*2를 권장(최소 50m)
            return self._round_up_int(max(int(usage * 2), 50), 10)

        def rec_mem_request_mi(row: Dict) -> Optional[int]:
            usage = row.get("mem_usage_mi_avg")
            if not isinstance(usage, int) or usage <= 0:
                return None
            # avg 기반으로 1.5x(최소 128Mi)
            return self._round_up_int(max(int(usage * 1.5), 128), 64)

        def rec_limit_from_request(request: Optional[int], factor: float, step: int) -> Optional[int]:
            if not isinstance(request, int) or request <= 0:
                return None
            return self._round_up_int(max(int(request * factor), request), step)

        # Hot/overprovision lists
        hot_mem = sorted(
            [r for r in deployment_rows if isinstance(r.get("mem_util_pct"), (int, float)) and float(r["mem_util_pct"]) >= 90],
            key=lambda r: float(r.get("mem_util_pct") or 0),
            reverse=True,
        )
        hot_cpu = sorted(
            [r for r in deployment_rows if isinstance(r.get("cpu_util_pct"), (int, float)) and float(r["cpu_util_pct"]) >= 90],
            key=lambda r: float(r.get("cpu_util_pct") or 0),
            reverse=True,
        )
        over_cpu = sorted(
            [r for r in deployment_rows if isinstance(r.get("cpu_util_pct"), (int, float)) and float(r["cpu_util_pct"]) < 20 and (r.get("cpu_req_m") or 0) >= 200],
            key=lambda r: float(r.get("cpu_util_pct") or 0),
        )

        missing_resources_rows = [
            r
            for r in deployment_rows
            if (r.get("missing_req_containers", 0) > 0 or r.get("missing_lim_containers", 0) > 0 or r.get("cpu_req_m") is None or r.get("mem_req_mi") is None)
        ]

        latest_images_rows = [r for r in deployment_rows if r.get("image_flag") in ("latest", "untagged")]

        oom_rows = [r for r in deployment_rows if isinstance(r.get("reason_counts"), dict) and (r["reason_counts"].get("OOMKilled") or 0) > 0]

        failed_scheduling = any("FailedScheduling" in line for line in event_lines)
        readiness_failed = any("Readiness probe failed" in line or "ReadinessProbe" in line for line in event_lines)

        action_lines: List[str] = []
        action_lines.append("### High")

        # HA recommendation (nuanced)
        if node_count and node_count >= 2:
            user_facing_single = [r["name"] for r in deployment_rows if r.get("replicas") == 1 and is_probably_user_facing(r.get("name", ""))]
            controllers_single = [r["name"] for r in deployment_rows if r.get("replicas") == 1 and is_probably_control_plane(r.get("name", ""))]
            if user_facing_single:
                sample_names = ", ".join(f"`{n}`" for n in user_facing_single[:6]) + ("…" if len(user_facing_single) > 6 else "")
                action_lines.append(
                    f"- **[High] 사용자 트래픽/게이트웨이 계열 HA 보강 (효과: 안정성)**  \n"
                    f"  - 근거: node_count={node_count}인데 replicas=1. 사용자 facing으로 보이는 deployment {len(user_facing_single)}개 예: {sample_names}  \n"
                    f"  - 권장: 우선 사용자 요청 경로(gateway/web/api/dashboard)부터 replicas=2+로 올리고, readiness/liveness를 확인  \n"
                    f"  - 적용 예시: `spec.replicas: 2`"
                )
            if controllers_single:
                action_lines.append(
                    f"- **[High] operator/controller는 replicas=1 유지 여부 검토 (효과: 안정성)**  \n"
                    f"  - 근거: operator/controller로 보이는 deployment도 replicas=1 다수(예: `{controllers_single[0]}` 등)  \n"
                    f"  - 권장: leader election 지원 여부 확인 후 2로 확장(지원 시) 또는 1 유지(의도된 싱글톤인 경우)"
                )

        # Missing resources
        if missing_resources_rows:
            examples = ", ".join(f"`{r['name']}`" for r in missing_resources_rows[:6]) + ("…" if len(missing_resources_rows) > 6 else "")
            action_lines.append(
                f"- **[High] requests/limits 누락 정리 (효과: 안정성/비용)**  \n"
                f"  - 근거: requests/limits 누락 의심 deployment {len(missing_resources_rows)}개 예: {examples}  \n"
                f"  - 권장: 최소한 `cpu/memory requests`를 먼저 채우고, 안정화 후 `limits` 적용"
            )

        # Hot memory targets with numbers + recommended values
        if hot_mem:
            action_lines.append("- **[High] Memory request 상향(스케줄링/eviction 리스크 감소) (효과: 안정성)**")
            for r in hot_mem[:6]:
                name = r["name"]
                req = r.get("mem_req_mi")
                lim = r.get("mem_lim_mi")
                usage = r.get("mem_usage_mi_avg")
                util = r.get("mem_util_pct")
                missing_req = int(r.get("missing_mem_req_containers") or 0)
                missing_lim = int(r.get("missing_mem_lim_containers") or 0)
                action_lines.append(
                    f"  - 근거: `{name}` mem usage(pods avg snapshot)={fmt_mi(usage)} vs request={fmt_mi(req)} (util≈{util}%), limit={fmt_mi(lim)}"
                )
                if missing_req > 0:
                    action_lines.append(
                        f"  - 주의: memory requests 누락 컨테이너가 있어(util 계산이 부정확할 수 있음) 먼저 컨테이너별 requests를 채운 뒤 재평가하세요. (missing={missing_req})"
                    )
                    continue
                if missing_lim > 0:
                    action_lines.append(
                        f"  - 주의: memory limits 누락 컨테이너가 있어(limit 합계가 과소추정일 수 있음) 먼저 컨테이너별 limits를 확인/정리하세요. (missing={missing_lim})"
                    )
                    continue
                suspicious = (
                    isinstance(lim, int)
                    and isinstance(usage, int)
                    and lim > 0
                    and usage > int(lim * 1.1)
                )
                if suspicious:
                    action_lines.append(
                        "  - 주의: **표상 usage(pods avg snapshot)가 limit보다 큼** → (1) 컨테이너별 limits 일부 누락 (2) 여러 컨테이너 합산/파싱 차이 가능. Pod 스펙으로 컨테이너별 resources를 먼저 확인하세요."
                    )
                    continue

                rec_req = rec_mem_request_mi(r)
                rec_lim = rec_limit_from_request(rec_req, 2.0, 128)
                if rec_req and rec_lim:
                    action_lines.append(
                        f"  - 권장(초안): requests.memory≈`{fmt_mi(rec_req)}` (pods avg snapshot*1.5, round) / limits.memory≈`{fmt_mi(rec_lim)}` (request*2)  \n"
                        f"    - 적용 예시:\n"
                        f"      ```json\n"
                        f"      {{\n"
                        f"        \"resources\": {{\n"
                        f"          \"requests\": {{\"memory\": \"{rec_req}Mi\"}},\n"
                        f"          \"limits\": {{\"memory\": \"{rec_lim}Mi\"}}\n"
                        f"        }}\n"
                        f"      }}\n"
                        f"      ```"
                    )

        # Hot CPU targets
        if hot_cpu:
            action_lines.append("- **[High] CPU request 상향 또는 HPA 검토 (효과: 안정성/성능)**")
            for r in hot_cpu[:4]:
                name = r["name"]
                req = r.get("cpu_req_m")
                lim = r.get("cpu_lim_m")
                usage = r.get("cpu_usage_m_avg")
                util = r.get("cpu_util_pct")
                missing_req = int(r.get("missing_cpu_req_containers") or 0)
                missing_lim = int(r.get("missing_cpu_lim_containers") or 0)
                action_lines.append(
                    f"  - 근거: `{name}` cpu usage(pods avg snapshot)={fmt_m(usage)} vs request={fmt_m(req)} (util≈{util}%), limit={fmt_m(lim)}"
                )
                if missing_req > 0:
                    action_lines.append(
                        f"  - 주의: cpu requests 누락 컨테이너가 있어(util 계산이 부정확할 수 있음) 먼저 컨테이너별 requests를 채운 뒤 재평가하세요. (missing={missing_req})"
                    )
                    continue
                if missing_lim > 0:
                    action_lines.append(
                        f"  - 주의: cpu limits 누락 컨테이너가 있어(limit 합계가 과소추정일 수 있음) 먼저 컨테이너별 limits를 확인/정리하세요. (missing={missing_lim})"
                    )
                    continue
                suspicious = (
                    isinstance(lim, int)
                    and isinstance(usage, int)
                    and lim > 0
                    and usage > int(lim * 1.1)
                )
                if suspicious:
                    action_lines.append(
                        "  - 주의: **표상 usage(pods avg snapshot)가 limit보다 큼** → (1) 컨테이너별 limits 일부 누락 (2) 여러 컨테이너 합산/파싱 차이 가능. Pod 스펙으로 컨테이너별 resources를 먼저 확인하세요."
                    )
                    continue

                rec_req = rec_cpu_request_m(r)
                rec_lim = rec_limit_from_request(rec_req, 2.0, 100)
                if rec_req and rec_lim:
                    action_lines.append(
                        f"  - 권장(초안): requests.cpu≈`{fmt_m(rec_req)}` (pods avg snapshot*2, round) / limits.cpu≈`{fmt_m(rec_lim)}`  \n"
                        f"    - 적용 예시:\n"
                        f"      ```json\n"
                        f"      {{\n"
                        f"        \"resources\": {{\n"
                        f"          \"requests\": {{\"cpu\": \"{rec_req}m\"}},\n"
                        f"          \"limits\": {{\"cpu\": \"{rec_lim}m\"}}\n"
                        f"        }}\n"
                        f"      }}\n"
                        f"      ```"
                    )

        # Scheduling / readiness event hints
        if failed_scheduling:
            action_lines.append(
                "- **[High] FailedScheduling(affinity/nodeSelector) 원인 확인 (효과: 안정성)**  \n"
                "  - 근거: Warning events에 `FailedScheduling` 존재 (node affinity/selector 불일치)  \n"
                "  - 권장: 해당 Pod의 `nodeSelector/affinity/tolerations`와 노드 label/taint를 비교해서 스케줄 가능하도록 조정"
            )
        if readiness_failed:
            action_lines.append(
                "- **[High] Readiness probe 실패 원인 점검 (효과: 안정성/가용성)**  \n"
                "  - 근거: Warning events에 `Readiness probe failed` 존재  \n"
                "  - 권장: probe endpoint/timeout/initialDelaySeconds 확인 + 앱 로그/헬스체크 응답 시간 측정"
            )

        action_lines.append("")
        action_lines.append("### Medium")

        if latest_images_rows:
            examples = ", ".join(f"`{r['name']}`" for r in latest_images_rows[:6]) + ("…" if len(latest_images_rows) > 6 else "")
            action_lines.append(
                f"- **[Medium] 이미지 태그 pinning (효과: 안정성/재현성)**  \n"
                f"  - 근거: latest/미태깅 이미지 가능성 {len(latest_images_rows)}개 예: {examples}  \n"
                f"  - 권장: `:latest` 대신 버전 태그 또는 digest 사용"
            )

        if oom_rows:
            examples = ", ".join(f"`{r['name']}`" for r in oom_rows[:6]) + ("…" if len(oom_rows) > 6 else "")
            action_lines.append(
                f"- **[Medium] OOMKilled 원인 분석 및 memory limit/request 재조정 (효과: 안정성)**  \n"
                f"  - 근거: OOMKilled 감지 deployment {len(oom_rows)}개 예: {examples}  \n"
                f"  - 권장: (1) OOMKilled 시점 로그/메트릭 확인 (2) memory limit이 실제 피크를 수용하는지 확인 (3) 누수/캐시 설정 점검"
            )

        if over_cpu:
            action_lines.append("- **[Medium] CPU request 과대(낭비) 의심 - 하향 검토 (효과: 비용)**")
            for r in over_cpu[:4]:
                name = r["name"]
                req = r.get("cpu_req_m")
                usage = r.get("cpu_usage_m_avg")
                util = r.get("cpu_util_pct")
                if not isinstance(req, int):
                    continue
                suggested = self._round_up_int(max(int((usage or 0) * 2), 50), 10) if isinstance(usage, int) else max(int(req * 0.5), 50)
                action_lines.append(
                    f"  - 근거: `{name}` cpu usage(pods avg snapshot)={fmt_m(usage)} vs request={fmt_m(req)} (util≈{util}%)  \n"
                    f"  - 권장(초안): requests.cpu≈`{fmt_m(suggested)}`로 낮추고 모니터링(p95 기반으로 재조정)"
                )

        action_plan_md = "\n".join(action_lines).strip()

        # Text-only version (for LLM; keep same content but without heavy markdown table constraints)
        text = {
            "namespace": namespace,
            "overview": overview,
            "deployments_count": len(deployments),
            "pods_count": len(pods),
            "deployment_rows": deployment_rows,
            "warning_events_sample": event_lines,
            "auto_findings": findings[:40],
            "pod_metrics_available": pod_metrics is not None,
            "action_plan_md": action_plan_md,
        }

        return {
            "observations_md": md,
            "observations_text": json.dumps(text, ensure_ascii=False),
            "action_plan_md": action_plan_md,
        }
    
    def _extract_error_patterns(self, logs: str) -> List[ErrorPattern]:
        """로그에서 에러 패턴 추출"""
        patterns = []
        
        # 일반적인 에러 패턴
        error_keywords = [
            (r'ERROR|Error|error', SeverityLevel.HIGH),
            (r'FATAL|Fatal|fatal', SeverityLevel.CRITICAL),
            (r'WARN|Warning|warning', SeverityLevel.MEDIUM),
            (r'Exception|exception', SeverityLevel.HIGH),
            (r'Failed|failed|failure', SeverityLevel.HIGH),
            (r'OOMKilled', SeverityLevel.CRITICAL),
            (r'CrashLoopBackOff', SeverityLevel.CRITICAL),
        ]
        
        for pattern, severity in error_keywords:
            matches = re.findall(pattern, logs)
            if matches:
                patterns.append(ErrorPattern(
                    pattern=pattern,
                    severity=severity,
                    occurrences=len(matches),
                    first_seen=None,
                    last_seen=None
                ))
        
        return patterns
    
    async def _gather_resource_context(self, request: TroubleshootRequest) -> str:
        """리소스 컨텍스트 수집"""
        context = ""
        
        try:
            if request.resource_type.lower() == "pod":
                pods = await self.k8s_service.get_pods(request.namespace)
                pod = next((p for p in pods if p["name"] == request.resource_name), None)
                if pod:
                    context += f"Pod Status: {pod.get('status', 'N/A')}\n"
                    context += f"Phase: {pod.get('phase', 'N/A')}\n"
                    context += f"Restart Count: {pod.get('restart_count', 0)}\n"
                    context += f"Node: {pod.get('node_name', 'N/A')}\n"
                
                if request.include_logs:
                    logs = await self.k8s_service.get_pod_logs(
                        request.namespace,
                        request.resource_name,
                        tail_lines=50
                    )
                    context += f"\nRecent Logs:\n{logs}\n"
            
            if request.include_events:
                events = await self.k8s_service.get_events(request.namespace)
                if events:
                    context += "\nRecent Events:\n"
                    for event in events[:5]:
                        context += f"- [{event['type']}] {event['reason']}: {event['message']}\n"
        
        except Exception as e:
            context += f"\nError gathering context: {e}\n"
        
        return context
    
    async def chat_stream(self, request: ChatRequest):
        """AI 챗봇 스트리밍 with Function Calling"""
        import json
        
        # 시스템 메시지 (KAgent 스타일)
        system_message = """# Kubernetes AI Agent System Prompt

당신은 **KubeAssist**입니다. Kubernetes 트러블슈팅 및 운영에 특화된 고급 AI 에이전트입니다. Kubernetes 아키텍처, 컨테이너 오케스트레이션, 네트워킹, 스토리지 시스템, 리소스 관리에 대한 깊은 전문 지식을 보유하고 있습니다.

## 핵심 역량

- **전문 Kubernetes 지식**: Kubernetes 컴포넌트, 아키텍처, 오케스트레이션 원리, 리소스 관리
- **체계적 트러블슈팅**: 로그, 메트릭, 클러스터 상태를 분석하는 방법론적 접근
- **보안 우선 사고방식**: RBAC, Pod Security Policies, 보안 관행 우선
- **명확한 커뮤니케이션**: 명확하고 간결한 기술 정보 제공
- **안전 지향**: 최소 권한 원칙을 따르고 확인 없이 파괴적 작업 회피

## 운영 가이드라인

### 조사 프로토콜

1. **비침습적 시작**: 더 침습적인 작업 전에 읽기 전용 작업(get, describe)으로 시작
2. **점진적 확대**: 필요한 경우에만 더 상세한 조사로 확대
3. **모든 것을 문서화**: 모든 조사 단계와 작업의 명확한 기록 유지
4. **실행 전 확인**: 변경 사항을 실행하기 전에 잠재적 영향 고려
5. **롤백 계획**: 필요한 경우 변경 사항을 되돌릴 계획 항상 준비

### 문제 해결 프레임워크

1. **초기 평가**: 기본 클러스터 정보 수집, Kubernetes 버전 확인, 노드 상태 확인, 최근 변경 사항 검토
2. **문제 분류**: 애플리케이션 문제, 인프라 문제, 성능 문제, 보안 사고, 구성 오류
3. **리소스 분석**: Pod 상태 및 이벤트, 컨테이너 로그, 리소스 메트릭, 네트워크 연결, 스토리지 상태
4. **솔루션 구현**: 여러 솔루션 제안, 위험 평가, 구현 계획 제시, 테스트 전략, 롤백 절차

## 사용 가능한 도구

### 정보 수집 도구
- `k8s_get_resources`: kubectl get (json/wide) 형식 지원. 출력 형식 요청 시 우선 사용
- `k8s_get_resource_yaml`: 단일 리소스 YAML 조회 (kubectl get -o yaml)
- `k8s_describe_resource`: 리소스 상세 조회 (kubectl describe)
- `k8s_get_pod_logs`: Pod 로그 조회 (kubectl logs)
- `k8s_get_events`: 네임스페이스 이벤트 조회 (kubectl get events)
- `k8s_get_available_api_resources`: api-resources 조회
- `k8s_get_cluster_configuration`: 클러스터 구성 정보 조회
- `k8s_check_service_connectivity`: Service/Endpoint 연결성 확인
- `get_cluster_overview`: 클러스터 전체 요약(확장 기능)
- `get_pod_metrics`: Pod 리소스 사용량 조회(확장 기능, kubectl top pods)
- `get_node_metrics`: Node 리소스 사용량 조회(확장 기능, kubectl top nodes)

## 도구 사용 원칙

**매우 중요**: 사용자가 질문을 하면, **반드시 먼저 도구를 사용하여 실제 클러스터 상태를 확인**하세요. 절대 추측하지 마세요.

## 네임스페이스/리소스 식별 규칙 (중요)

- 사용자가 네임스페이스를 명시하지 않은 요청에서 `default`를 임의로 가정하지 마세요.
- 사용자가 리소스 이름을 "대충" 던지는 경우(정확한 전체 이름이 아닌 식별자/부분 문자열)에는,
  먼저 `k8s_get_resources`를 `all_namespaces=true`로 호출해 **모든 네임스페이스에서 후보를 찾은 뒤**
  해당 후보의 `namespace`와 `name`을 사용해 후속 도구(로그/describe 등)를 호출하세요.
- 후보가 여러 개면 (다른 네임스페이스/여러 replica 등) 후보를 나열하고 사용자에게 선택을 요청하거나, 일반적으로 Healthy/Running+Ready인 리소스를 우선하세요.

## 출력 포맷/툴 선택 규칙 (중요)

- 사용자가 WIDE/`kubectl get` 스타일을 요청하면 `k8s_get_resources`를 사용하고 `output`에 형식을 지정하세요.
- YAML 요청은 `k8s_get_resource_yaml`에서만 지원합니다. 그 외에는 JSON으로 조회하고 화면에는 kubectl 테이블로 표시하세요.

1. **항상 도구를 적극적으로 사용**: 
   - 사용자가 클러스터에 대해 질문하면, 관련 도구를 즉시 호출하세요
   - 일반적인 설명보다 실제 데이터를 우선시하세요

2. **구체적인 정보 수집 예시**: 
   - "네임스페이스가 뭐가 있어?" → `k8s_get_resources`(resource_type=namespaces) 호출
   - "Pod 상태 확인해줘" → `k8s_get_resources`(resource_type=pods, namespace=...) 호출
   - "Failed Pod 있어?" → `k8s_get_resources`(resource_type=pods, all_namespaces=true) 후 상태 분석, 발견 시 `k8s_describe_resource` 및 `k8s_get_pod_logs`, `k8s_get_events` 추가 호출
   - "리소스 많이 쓰는 Pod는?" → `get_pod_metrics` 호출
   - "죽어 있는 Pod들 알려줘" → `k8s_get_resources`(resource_type=pods, all_namespaces=true) 후 NotReady/Error/CrashLoopBackOff 필터링

3. **문제 발견 시 추가 조사**:
   - Pod 문제 발견 → `k8s_describe_resource`, `k8s_get_pod_logs`, `k8s_get_events` 순차 호출
   - 노드 문제 발견 → `k8s_get_resources`(resource_type=nodes) 후 필요 시 `k8s_describe_resource`
   - 재시작이 많은 Pod → `k8s_get_pod_logs`로 크래시 원인 파악

4. **컨텍스트 기억**: 이전 대화에서 수집한 정보를 기억하고 활용하세요

## 안전 프로토콜

1. **쓰기 전에 읽기**: 항상 정보 도구를 먼저 사용
2. **작업 설명**: 수정 도구를 사용하기 전에 수행할 작업과 이유 설명
3. **제한된 범위**: 문제 해결에 필요한 최소 범위로 변경 적용
4. **변경 확인**: 수정 후 적절한 정보 도구로 결과 확인
5. **위험한 명령 회피**: 명시적 확인 없이 잠재적으로 파괴적인 명령 실행 금지

## 응답 형식

**매우 중요**: 사용자 쿼리에 응답할 때 다음 형식을 **반드시** 따르세요:

1. **초기 평가 (Initial Assessment)**: 
   - 문제를 간략히 인정하고 상황에 대한 이해 확립
   - 예: "네, 클러스터의 죽어 있는 Pod들을 확인해드리겠습니다."

2. **정보 수집 (Information Gathering)**: 
   - 필요한 도구를 명시하고 호출
   - 예: "먼저 모든 네임스페이스의 Pod 상태를 확인하겠습니다."
   - **이 단계에서 tool call을 실행합니다**

3. **분석 (Analysis)**: 
   - **Tool call 결과를 받은 후**, 명확한 기술 용어로 상황 분석
   - 예: "현재 클러스터 전체 네임스페이스에서 죽어 있거나 비정상인 파드는 다음과 같습니다..."
   - **절대로 이 단계를 생략하지 마세요**

4. **권장 사항 (Recommendations)**: 
   - 구체적인 권장 사항과 추가로 사용할 도구 제시
   - 예: "죽어 있거나 문제 있는 파드들의 구체적인 이유를 분석하려면..."

5. **실행 계획 (Action Plan)**: 
   - 해결을 위한 단계별 계획 제시
   - 예: "1. 원인 추가 점검 필요 2. 필요 시 특정 파드들의 상세 진단 진행"

6. **검증 (Verification)**: 
   - 솔루션이 올바르게 작동했는지 확인하는 방법 설명
   - 예: "필요하시다면 어떤 파드를 우선 점검할지 알려주세요."

7. **지식 공유 (Knowledge Sharing)**: 
   - 관련 Kubernetes 개념에 대한 간략한 설명 포함
   - 예: "참고로, Pod 상태가 NotReady인 경우..."

**응답 완성도 규칙**:
- Tool을 호출한 후에는 **반드시 3단계(분석)부터 7단계(지식 공유)까지 완료**해야 합니다
- Tool call만 하고 끝내는 것은 **절대 금지**입니다
- 항상 완전한 문장으로 응답을 마무리하세요
- **절대로 문장 중간에 멈추지 마세요**, 특히 tool call 후에는 더욱 그렇습니다
- 최소한 분석 → 권장사항 → 실행 계획 순서로 완전한 응답을 제공해야 합니다

## 언어

**중요**: 모든 응답은 **반드시 한국어로** 작성해야 합니다.
- 기술 용어는 영어 원문을 병기할 수 있습니다 (예: "파드(Pod)")
- 명령어와 코드는 그대로 유지
- 분석, 설명, 권장사항은 모두 한국어로 작성
- 친근하면서도 전문적인 톤 유지

항상 최소 침습적 접근으로 시작하고, 필요한 경우에만 진단을 확대하세요. 의심스러운 경우 변경을 권장하기 전에 더 많은 정보를 수집하세요.
"""
        
        # 메시지 변환
        messages = [{"role": "system", "content": system_message}]
        for msg in request.messages:
            messages.append({"role": msg.role, "content": msg.content})
        
        # 디버그: 메시지 개수 출력
        print(f"[DEBUG] Total messages: {len(messages)}, User messages: {len([m for m in messages if m['role'] == 'user'])}")
        
        # Function definitions
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_cluster_overview",
                    "description": "클러스터 전체 개요를 조회합니다",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pod_metrics",
                    "description": "Pod 리소스 사용량(CPU/Memory) 조회 (kubectl top pods)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 이름 (선택)"}
                        }
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_node_metrics",
                    "description": "Node 리소스 사용량(CPU/Memory) 조회 (kubectl top nodes)",
                    "parameters": {"type": "object", "properties": {}}
                }
            }
        ]
        tools.extend(self._get_k8s_readonly_tool_definitions())
        
        try:
            # 첫 번째 호출 (function calling 체크)
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                temperature=0.7
            )

            # OpenAI 응답 전체 로그 출력
            import json
            response_dict = {
                "id": response.id,
                "model": response.model,
                "created": response.created,
                "choices": [
                    {
                        "index": choice.index,
                        "message": {
                            "role": choice.message.role,
                            "content": choice.message.content,
                            "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                        },
                        "finish_reason": choice.finish_reason
                    } for choice in response.choices
                ],
                "usage": {
                    "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                    "completion_tokens": response.usage.completion_tokens if response.usage else None,
                    "total_tokens": response.usage.total_tokens if response.usage else None
                } if response.usage else None
            }
            print(f"[OPENAI RESPONSE][chat_stream first] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)

            # 토큰 사용량 로그 (첫 번째 호출)
            usage = getattr(response, "usage", None)
            if usage is not None:
                print(
                    f"[TOKENS][chat_stream first] prompt={usage.prompt_tokens}, "
                    f"completion={usage.completion_tokens}, total={usage.total_tokens}",
                    flush=True,
                )
            
            response_message = response.choices[0].message
            
            # Function calling이 있으면 실행
            if response_message.tool_calls:
                print(f"[DEBUG] Tool calls detected: {len(response_message.tool_calls)}")
                messages.append(response_message)
                
                for tool_call in response_message.tool_calls:
                    function_name = tool_call.function.name
                    function_args = json.loads(tool_call.function.arguments)
                    
                    print(f"[DEBUG] Calling function: {function_name} with args: {function_args}")
                    
                    # 함수 실행 중임을 알림
                    yield f"data: {json.dumps({'function': function_name, 'args': function_args}, ensure_ascii=False)}\n\n"
                    
                    # 함수 실행
                    function_response = await self._execute_function(function_name, function_args)
                    
                    print(f"[DEBUG] Function response length: {len(str(function_response))}")

                    formatted_result, _, _ = self._format_tool_result(
                        function_name,
                        function_args,
                        function_response,
                    )
                    tool_message_content = self._truncate_tool_result_for_llm(formatted_result)
                    
                    messages.append({
                        "tool_call_id": tool_call.id,
                        "role": "tool",
                        "name": function_name,
                        "content": tool_message_content
                    })
                
                print(f"[DEBUG] Starting second GPT call for analysis with {len(messages)} messages")
                
                # 함수 결과를 바탕으로 스트리밍 응답
                try:
                    stream = await self.client.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        tools=tools,  # tools를 계속 제공
                        temperature=0.8,
                        max_tokens=2000,
                        stream=True,
                        stream_options={"include_usage": True},
                    )
                except TypeError:
                    # openai 라이브러리 버전에 따라 stream_options 미지원일 수 있음
                    stream = await self.client.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        tools=tools,  # tools를 계속 제공
                        temperature=0.8,
                        max_tokens=2000,
                        stream=True,
                    )
                
                print(f"[DEBUG] Second GPT call started, streaming...")
                
                # 스트리밍 청크 전체 수집 및 로그
                full_stream_content = ""
                stream_chunks = []
                stream_usage = None
                async for chunk in stream:
                    if getattr(chunk, "usage", None) is not None:
                        # include_usage=true 일 때 보통 마지막 chunk에 usage가 포함됨
                        stream_usage = chunk.usage
                    chunk_dict = {
                        "id": chunk.id if hasattr(chunk, 'id') else None,
                        "model": chunk.model if hasattr(chunk, 'model') else None,
                        "created": chunk.created if hasattr(chunk, 'created') else None,
                        "choices": [
                            {
                                "index": choice.index if hasattr(choice, 'index') else None,
                                "delta": {
                                    "role": choice.delta.role if hasattr(choice.delta, 'role') else None,
                                    "content": choice.delta.content if hasattr(choice.delta, 'content') else None,
                                    "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.delta.tool_calls or [])]
                                } if hasattr(choice, 'delta') else None,
                                "finish_reason": choice.finish_reason if hasattr(choice, 'finish_reason') else None
                            } for choice in chunk.choices
                        ]
                    }
                    stream_chunks.append(chunk_dict)
                    
                    if chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        full_stream_content += content
                        yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"

                if stream_usage is not None:
                    print(
                        f"[TOKENS][chat_stream second stream] prompt={stream_usage.prompt_tokens}, "
                        f"completion={stream_usage.completion_tokens}, total={stream_usage.total_tokens}",
                        flush=True,
                    )
                    yield (
                        "data: "
                        + json.dumps(
                            {
                                "usage_phase": "chat_stream_second_stream",
                                "usage": {
                                    "prompt_tokens": stream_usage.prompt_tokens,
                                    "completion_tokens": stream_usage.completion_tokens,
                                    "total_tokens": stream_usage.total_tokens,
                                },
                            },
                            ensure_ascii=False,
                        )
                        + "\n\n"
                    )
                
                # 스트리밍 완료 후 전체 로그 출력
                print(f"[OPENAI RESPONSE][chat_stream second - streaming] total_chunks={len(stream_chunks)}, full_content_length={len(full_stream_content)}", flush=True)
                print(f"[OPENAI RESPONSE][chat_stream second - full_content] {json.dumps({'content': full_stream_content}, ensure_ascii=False)}", flush=True)
                print(f"[OPENAI RESPONSE][chat_stream second - chunks] {json.dumps(stream_chunks, ensure_ascii=False, indent=2)}", flush=True)
                
                print(f"[DEBUG] Streaming completed")
            else:
                # Function calling 없이 바로 스트리밍
                try:
                    stream = await self.client.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        temperature=0.8,
                        max_tokens=2000,
                        stream=True,
                        stream_options={"include_usage": True},
                    )
                except TypeError:
                    stream = await self.client.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        temperature=0.8,
                        max_tokens=2000,
                        stream=True,
                    )
                
                # 스트리밍 청크 전체 수집 및 로그
                full_stream_content = ""
                stream_chunks = []
                stream_usage = None
                async for chunk in stream:
                    if getattr(chunk, "usage", None) is not None:
                        stream_usage = chunk.usage
                    chunk_dict = {
                        "id": chunk.id if hasattr(chunk, 'id') else None,
                        "model": chunk.model if hasattr(chunk, 'model') else None,
                        "created": chunk.created if hasattr(chunk, 'created') else None,
                        "choices": [
                            {
                                "index": choice.index if hasattr(choice, 'index') else None,
                                "delta": {
                                    "role": choice.delta.role if hasattr(choice.delta, 'role') else None,
                                    "content": choice.delta.content if hasattr(choice.delta, 'content') else None,
                                    "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.delta.tool_calls or [])]
                                } if hasattr(choice, 'delta') else None,
                                "finish_reason": choice.finish_reason if hasattr(choice, 'finish_reason') else None
                            } for choice in chunk.choices
                        ]
                    }
                    stream_chunks.append(chunk_dict)
                    
                    if chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        full_stream_content += content
                        yield f"data: {json.dumps({'content': content}, ensure_ascii=False)}\n\n"

                if stream_usage is not None:
                    print(
                        f"[TOKENS][chat_stream stream] prompt={stream_usage.prompt_tokens}, "
                        f"completion={stream_usage.completion_tokens}, total={stream_usage.total_tokens}",
                        flush=True,
                    )
                    yield (
                        "data: "
                        + json.dumps(
                            {
                                "usage_phase": "chat_stream_stream",
                                "usage": {
                                    "prompt_tokens": stream_usage.prompt_tokens,
                                    "completion_tokens": stream_usage.completion_tokens,
                                    "total_tokens": stream_usage.total_tokens,
                                },
                            },
                            ensure_ascii=False,
                        )
                        + "\n\n"
                    )
                
                # 스트리밍 완료 후 전체 로그 출력
                print(f"[OPENAI RESPONSE][chat_stream no_tool_calls - streaming] total_chunks={len(stream_chunks)}, full_content_length={len(full_stream_content)}", flush=True)
                print(f"[OPENAI RESPONSE][chat_stream no_tool_calls - full_content] {json.dumps({'content': full_stream_content}, ensure_ascii=False)}", flush=True)
                print(f"[OPENAI RESPONSE][chat_stream no_tool_calls - chunks] {json.dumps(stream_chunks, ensure_ascii=False, indent=2)}", flush=True)
            
            yield "data: [DONE]\n\n"
        
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
    
    async def _pick_log_container(
        self,
        namespace: str,
        pod_name: str,
        explicit_container: Optional[str] = None,
    ) -> (Optional[str], Optional[List[str]]):
        """로그 조회용 컨테이너 자동 선택

        Returns:
            (chosen_container_name, all_container_names_if_ambiguous)
        """
        # 사용자가 명시적으로 container를 지정한 경우 그대로 사용
        if explicit_container:
            return explicit_container, None

        try:
            # get_pods API를 사용해 대상 파드를 찾고 컨테이너 목록을 가져옴
            pods = await self.k8s_service.get_pods(namespace)
            target_pod = next(
                (p for p in pods if p.get("name") == pod_name),
                None,
            )
            if not target_pod:
                print(
                    f"[DEBUG] _pick_log_container: pod {namespace}/{pod_name} not found in get_pods() result"
                )
                return None, None

            containers = target_pod.get("containers") or []
            names = [c.get("name") for c in containers if c.get("name")]

            if not names:
                return None, None

            # 컨테이너가 하나뿐이면 그대로 사용
            if len(names) == 1:
                return names[0], None

            # 사이드카로 자주 쓰이는 컨테이너 이름/패턴은 우선 제외
            sidecar_exact = {"istio-proxy", "istio-init", "linkerd-proxy"}
            sidecar_prefixes = ("istio-", "linkerd-", "vault-", "kube-rbac-proxy")

            candidates = [
                n
                for n in names
                if n not in sidecar_exact
                and not any(n.startswith(pfx) for pfx in sidecar_prefixes)
            ]

            if len(candidates) == 1:
                return candidates[0], None

            # 여전히 여러 개면 모호하므로 호출자에게 전체 목록을 넘겨줌
            return None, names
        except Exception as e:
            print(
                f"[DEBUG] Failed to auto-select log container for {namespace}/{pod_name}: {e}"
            )
            return None, None

    def _coerce_limit(self, value: object, default: int = 20, max_value: int = 200) -> int:
        try:
            v = int(value)  # type: ignore[arg-type]
        except Exception:
            v = default
        if v <= 0:
            v = default
        if v > max_value:
            v = max_value
        return v

    def _normalize_for_search(self, text: str) -> str:
        # Treat non-alphanumerics as separators (e.g., "alarm broker" matches "service-alarm-broker").
        return re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip()

    def _query_tokens(self, query: str) -> List[str]:
        normalized = self._normalize_for_search(query)
        return [t for t in normalized.split() if t]

    def _all_tokens_in_text(self, query: str, text: str) -> bool:
        tokens = self._query_tokens(query)
        if not tokens:
            return False
        hay = self._normalize_for_search(text)
        return all(t in hay for t in tokens)

    def _extract_items_from_payload(self, payload: object) -> List[Dict]:
        if isinstance(payload, dict):
            data = payload.get("data") if "data" in payload else payload
            if isinstance(data, dict) and isinstance(data.get("items"), list):
                return list(data.get("items") or [])
        return []

    async def _find_resource_matches(
        self,
        resource_type: str,
        query: str,
        namespace: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict]:
        payload = await self.k8s_service.get_resources(
            resource_type=resource_type,
            namespace=namespace if isinstance(namespace, str) else None,
            all_namespaces=namespace is None,
            output="json",
        )
        items = self._extract_items_from_payload(payload)

        matches: List[Dict] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            meta = item.get("metadata", {}) if isinstance(item, dict) else {}
            name = str(meta.get("name", ""))
            if not name:
                continue
            if not self._all_tokens_in_text(query, name):
                continue
            matches.append(
                {
                    "name": name,
                    "namespace": str(meta.get("namespace", "")),
                    "kind": str(item.get("kind", "")),
                    "resource_type": resource_type,
                }
            )
            if len(matches) >= limit:
                break
        return matches

    async def _locate_resource_for_yaml(
        self,
        resource_name: str,
        namespace: Optional[str],
        preferred_type: Optional[str],
    ) -> Dict:
        search_types = [
            "deployments",
            "statefulsets",
            "daemonsets",
            "pods",
            "services",
            "ingresses",
            "jobs",
            "cronjobs",
        ]
        if preferred_type:
            preferred = str(preferred_type).strip()
            if preferred:
                search_types = [preferred] + [t for t in search_types if t != preferred]

        # 1) If namespace is provided, try that namespace first (for preferred type)
        if namespace and preferred_type:
            matches = await self._find_resource_matches(preferred_type, resource_name, namespace=namespace, limit=20)
            if matches:
                chosen = await self._resolve_single(preferred_type, resource_name, matches)
                return {
                    "resource_type": preferred_type,
                    "resource_name": chosen.get("name", resource_name),
                    "namespace": chosen.get("namespace") or namespace,
                }

        # 2) Search across namespaces by type
        for rtype in search_types:
            try:
                matches = await self._find_resource_matches(rtype, resource_name, namespace=None, limit=20)
            except Exception:
                continue
            if not matches:
                continue
            chosen = await self._resolve_single(rtype, resource_name, matches)
            return {
                "resource_type": rtype,
                "resource_name": chosen.get("name", resource_name),
                "namespace": chosen.get("namespace"),
            }

        raise Exception(f"No resource matched '{resource_name}'. Provide namespace and resource type.")

    def _query_in_mapping(self, query: str, mapping: object) -> bool:
        if not isinstance(mapping, dict):
            return False
        for k, v in mapping.items():
            if self._all_tokens_in_text(query, f"{k} {v}"):
                return True
        return False

    async def _find_pods(self, query_raw: str, namespace: Optional[str] = None, limit: int = 20) -> List[Dict]:
        query = query_raw.strip()
        if not query:
            return []

        if namespace and namespace.strip():
            pods = await self.k8s_service.get_pods(namespace.strip())
        else:
            pods = await self.k8s_service.get_all_pods()

        def _matches(p: Dict) -> bool:
            name = str(p.get("name", ""))
            if self._all_tokens_in_text(query, name):
                return True
            return self._query_in_mapping(query, p.get("labels") or {})

        matches = [p for p in pods if isinstance(p, dict) and _matches(p)]

        def _ready_score(p: Dict) -> int:
            status = str(p.get("status", "")).lower()
            ready = str(p.get("ready", "")).strip()
            is_running = 1 if status == "running" else 0
            is_ready = 1 if "/" in ready and ready.split("/", 1)[0] == ready.split("/", 1)[1] else 0
            return is_running * 10 + is_ready

        def _restart_count(p: Dict) -> int:
            try:
                return int(p.get("restart_count", 0))
            except Exception:
                return 0

        matches.sort(
            key=lambda p: (
                -_ready_score(p),
                _restart_count(p),
                str(p.get("namespace", "")),
                str(p.get("name", "")),
            )
        )

        return matches[:limit]

    async def _find_services(self, query_raw: str, namespace: Optional[str] = None, limit: int = 20) -> List[Dict]:
        query = query_raw.strip()
        if not query:
            return []

        if namespace and namespace.strip():
            services = await self.k8s_service.get_services(namespace.strip())
            svc_dicts = [s if isinstance(s, dict) else getattr(s, "model_dump", lambda: s)() for s in services]  # type: ignore[misc]
        else:
            namespaces = await self.k8s_service.get_namespaces()
            svc_dicts = []
            for ns in namespaces:
                ns_name = ns.get("name") if isinstance(ns, dict) else getattr(ns, "name", None)
                if not ns_name:
                    continue
                svcs = await self.k8s_service.get_services(str(ns_name))
                for s in svcs:
                    if isinstance(s, dict):
                        svc_dicts.append(s)
                    else:
                        try:
                            svc_dicts.append(s.model_dump())  # type: ignore[attr-defined]
                        except Exception:
                            svc_dicts.append(dict(s))  # type: ignore[arg-type]
                if len(svc_dicts) >= limit * 5:
                    # safety guard to avoid very large collections in huge clusters
                    break

        def _matches(s: Dict) -> bool:
            if self._all_tokens_in_text(query, str(s.get("name", ""))):
                return True
            return self._query_in_mapping(query, s.get("selector") or {})

        matches = [s for s in svc_dicts if isinstance(s, dict) and _matches(s)]
        matches.sort(key=lambda s: (str(s.get("namespace", "")), str(s.get("name", ""))))
        return matches[:limit]

    async def _find_deployments(self, query_raw: str, namespace: Optional[str] = None, limit: int = 20) -> List[Dict]:
        query = query_raw.strip()
        if not query:
            return []

        if namespace and namespace.strip():
            deployments = await self.k8s_service.get_deployments(namespace.strip())
            dep_dicts = [d if isinstance(d, dict) else getattr(d, "model_dump", lambda: d)() for d in deployments]  # type: ignore[misc]
        else:
            namespaces = await self.k8s_service.get_namespaces()
            dep_dicts = []
            for ns in namespaces:
                ns_name = ns.get("name") if isinstance(ns, dict) else getattr(ns, "name", None)
                if not ns_name:
                    continue
                deps = await self.k8s_service.get_deployments(str(ns_name))
                for d in deps:
                    if isinstance(d, dict):
                        dep_dicts.append(d)
                    else:
                        try:
                            dep_dicts.append(d.model_dump())  # type: ignore[attr-defined]
                        except Exception:
                            dep_dicts.append(dict(d))  # type: ignore[arg-type]
                if len(dep_dicts) >= limit * 5:
                    break

        def _matches(d: Dict) -> bool:
            if self._all_tokens_in_text(query, str(d.get("name", ""))):
                return True
            if self._query_in_mapping(query, d.get("labels") or {}):
                return True
            if self._query_in_mapping(query, d.get("selector") or {}):
                return True
            return False

        matches = [d for d in dep_dicts if isinstance(d, dict) and _matches(d)]

        def _status_score(d: Dict) -> int:
            status = str(d.get("status", "")).lower()
            return 2 if status == "healthy" else (1 if status == "degraded" else 0)

        def _ready_ratio(d: Dict) -> float:
            try:
                replicas = int(d.get("replicas", 0))
                ready = int(d.get("ready_replicas", 0))
            except Exception:
                return 0.0
            if replicas <= 0:
                return 0.0
            return ready / replicas

        matches.sort(
            key=lambda d: (
                -_status_score(d),
                -_ready_ratio(d),
                str(d.get("namespace", "")),
                str(d.get("name", "")),
            )
        )
        return matches[:limit]

    async def _resolve_single(self, kind: str, query: str, matches: List[Dict]) -> Dict:
        if len(matches) == 1:
            return matches[0]
        if not matches:
            raise Exception(f"No {kind} matched query '{query}'. Try a more specific name.")

        preview = []
        for m in matches[:10]:
            ns = m.get("namespace", "")
            name = m.get("name", "")
            status = m.get("status", m.get("type", ""))
            ready = m.get("ready", "")
            extra = f" status={status}" if status else ""
            if ready:
                extra += f" ready={ready}"
            preview.append(f"{ns}/{name}{extra}".strip())

        raise Exception(
            f"Multiple {kind} matched query '{query}'. Please specify namespace or choose one: "
            + "; ".join(preview)
        )

    async def _execute_function(self, function_name: str, function_args: dict):
        """Function calling 실행"""
        import json
        
        try:
            print(f"[DEBUG] Executing function: {function_name} with args: {function_args}")
            if not self._is_tool_allowed(function_name):
                return json.dumps(
                    {"error": f"권한 없음: '{function_name}'는 {self.user_role} 역할에서 사용할 수 없습니다."},
                    ensure_ascii=False,
                )
            
            if function_name == "get_namespaces":
                namespaces = await self.k8s_service.get_namespaces()
                result = json.dumps(namespaces, ensure_ascii=False)
                print(f"[DEBUG] get_namespaces result: {result[:200]}")
                return result

            elif function_name == "find_pods":
                query_raw = str(function_args.get("query", "")).strip()
                if not query_raw:
                    raise Exception("find_pods requires non-empty 'query'")
                limit_int = self._coerce_limit(function_args.get("limit", 20))
                namespace = function_args.get("namespace")
                matches = await self._find_pods(query_raw, namespace=namespace if isinstance(namespace, str) else None, limit=limit_int)
                return json.dumps(matches, ensure_ascii=False)

            elif function_name == "find_services":
                query_raw = str(function_args.get("query", "")).strip()
                if not query_raw:
                    raise Exception("find_services requires non-empty 'query'")
                limit_int = self._coerce_limit(function_args.get("limit", 20))
                namespace = function_args.get("namespace")
                matches = await self._find_services(query_raw, namespace=namespace if isinstance(namespace, str) else None, limit=limit_int)
                return json.dumps(matches, ensure_ascii=False)

            elif function_name == "find_deployments":
                query_raw = str(function_args.get("query", "")).strip()
                if not query_raw:
                    raise Exception("find_deployments requires non-empty 'query'")
                limit_int = self._coerce_limit(function_args.get("limit", 20))
                namespace = function_args.get("namespace")
                matches = await self._find_deployments(query_raw, namespace=namespace if isinstance(namespace, str) else None, limit=limit_int)
                return json.dumps(matches, ensure_ascii=False)
            
            elif function_name == "get_pods":
                pods = await self.k8s_service.get_pods(function_args["namespace"])
                result = json.dumps(pods, ensure_ascii=False)
                print(f"[DEBUG] get_pods result: {result[:200]}")
                return result
            
            elif function_name == "get_deployments":
                deployments = await self.k8s_service.get_deployments(function_args["namespace"])
                return json.dumps(deployments, ensure_ascii=False)
            
            elif function_name == "get_services":
                services = await self.k8s_service.get_services(function_args["namespace"])
                return json.dumps(services, ensure_ascii=False)
            
            elif function_name == "get_pod_logs":
                namespace = function_args.get("namespace")
                pod_name = function_args["pod_name"]
                tail_lines = function_args.get("tail_lines", 50)
                requested_container = function_args.get("container")

                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_pods(str(pod_name), namespace=None, limit=20)
                    chosen = await self._resolve_single("pods", str(pod_name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    pod_name = str(chosen.get("name", pod_name))

                chosen_container, all_containers = await self._pick_log_container(
                    namespace,
                    pod_name,
                    explicit_container=requested_container,
                )

                # 여러 컨테이너가 있는데 어떤 것을 쓸지 결정하지 못한 경우
                if chosen_container is None and all_containers:
                    raise Exception(
                        f"Pod '{pod_name}' in namespace '{namespace}' has multiple containers "
                        f"({', '.join(all_containers)}). 'container' 인자를 사용해 로그를 볼 컨테이너를 명시해주세요."
                    )

                logs = await self.k8s_service.get_pod_logs(
                    namespace,
                    pod_name,
                    tail_lines=tail_lines,
                    container=chosen_container,
                )
                return logs
            
            elif function_name == "get_cluster_overview":
                return await self._call_tool_server(function_name, function_args)
            
            elif function_name == "describe_pod":
                namespace = function_args.get("namespace")
                name = function_args["name"]
                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_pods(str(name), namespace=None, limit=20)
                    chosen = await self._resolve_single("pods", str(name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    name = str(chosen.get("name", name))
                result = await self.k8s_service.describe_pod(namespace, name)
                return json.dumps(result, ensure_ascii=False)
            
            elif function_name == "describe_deployment":
                namespace = function_args.get("namespace")
                name = function_args["name"]
                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_deployments(str(name), namespace=None, limit=20)
                    chosen = await self._resolve_single("deployments", str(name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    name = str(chosen.get("name", name))
                result = await self.k8s_service.describe_deployment(namespace, name)
                return json.dumps(result, ensure_ascii=False)
            
            elif function_name == "describe_service":
                namespace = function_args.get("namespace")
                name = function_args["name"]
                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_services(str(name), namespace=None, limit=20)
                    chosen = await self._resolve_single("services", str(name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    name = str(chosen.get("name", name))
                result = await self.k8s_service.describe_service(namespace, name)
                return json.dumps(result, ensure_ascii=False)
            
            elif function_name == "get_events":
                events = await self.k8s_service.get_events(function_args["namespace"])
                return json.dumps(events, ensure_ascii=False)

            elif function_name == "k8s_get_resources":
                resource_type = function_args.get("resource_type", "")
                resource_name = function_args.get("resource_name")
                namespace = function_args.get("namespace")
                all_namespaces_raw = function_args.get("all_namespaces", False)
                output = function_args.get("output", "wide")

                if isinstance(all_namespaces_raw, str):
                    all_namespaces = all_namespaces_raw.strip().lower() == "true"
                else:
                    all_namespaces = bool(all_namespaces_raw)
                if not isinstance(namespace, str) or not namespace.strip():
                    all_namespaces = True
                if isinstance(output, str) and output.strip().lower() == "yaml":
                    output = "json"

                tool_args = {
                    "resource_type": resource_type,
                    "resource_name": resource_name,
                    "namespace": namespace if isinstance(namespace, str) else None,
                    "all_namespaces": all_namespaces,
                    "output": output if isinstance(output, str) else "wide",
                }
                return await self._call_tool_server(function_name, tool_args)

            elif function_name == "k8s_get_resource_yaml":
                namespace = function_args.get("namespace")
                resource_type = function_args.get("resource_type", "")
                resource_name = function_args.get("resource_name", "")

                # Support "pods/foo" style resource_name if resource_type is missing.
                if isinstance(resource_name, str) and "/" in resource_name:
                    prefix, name = resource_name.split("/", 1)
                    if prefix and name and not (isinstance(resource_type, str) and resource_type.strip()):
                        resource_type = prefix
                        resource_name = name

                resource_type = str(resource_type or "").strip()
                resource_name = str(resource_name or "").strip()
                ns = namespace if isinstance(namespace, str) and namespace.strip() else None

                if not resource_name:
                    raise Exception("resource_name is required for k8s_get_resource_yaml")

                resolved = None
                if not resource_type or ns is None:
                    resolved = await self._locate_resource_for_yaml(
                        resource_name=resource_name,
                        namespace=ns,
                        preferred_type=resource_type or None,
                    )
                    resource_type = str(resolved.get("resource_type") or resource_type)
                    resource_name = str(resolved.get("resource_name") or resource_name)
                    ns = resolved.get("namespace") or ns

                try:
                    return await self._call_tool_server(
                        function_name,
                        {
                            "resource_type": resource_type,
                            "resource_name": resource_name,
                            "namespace": ns,
                        },
                    )
                except Exception:
                    if resolved is None:
                        resolved = await self._locate_resource_for_yaml(
                            resource_name=resource_name,
                            namespace=ns,
                            preferred_type=resource_type or None,
                        )
                        resource_type = str(resolved.get("resource_type") or resource_type)
                        resource_name = str(resolved.get("resource_name") or resource_name)
                        ns = resolved.get("namespace") or ns
                        return await self._call_tool_server(
                            function_name,
                            {
                                "resource_type": resource_type,
                                "resource_name": resource_name,
                                "namespace": ns,
                            },
                        )
                    raise

            elif function_name == "k8s_describe_resource":
                namespace = function_args.get("namespace")
                return await self._call_tool_server(
                    function_name,
                    {
                        "resource_type": function_args.get("resource_type", ""),
                        "resource_name": function_args.get("resource_name", ""),
                        "namespace": namespace if isinstance(namespace, str) else None,
                    },
                )

            elif function_name == "k8s_get_pod_logs":
                namespace = function_args.get("namespace")
                pod_name = function_args.get("pod_name", "")
                if isinstance(pod_name, str) and "/" in pod_name:
                    pod_name = pod_name.split("/")[-1]
                tail_lines = self._coerce_limit(function_args.get("tail_lines", 50), default=50, max_value=2000)
                requested_container = function_args.get("container")

                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_pods(str(pod_name), namespace=None, limit=20)
                    chosen = await self._resolve_single("pods", str(pod_name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    pod_name = str(chosen.get("name", pod_name))

                chosen_container, all_containers = await self._pick_log_container(
                    namespace,
                    pod_name,
                    explicit_container=requested_container,
                )

                if chosen_container is None and all_containers:
                    raise Exception(
                        f"Pod '{pod_name}' in namespace '{namespace}' has multiple containers "
                        f"({', '.join(all_containers)}). 'container' 인자를 사용해 로그를 볼 컨테이너를 명시해주세요."
                    )

                return await self._call_tool_server(
                    function_name,
                    {
                        "namespace": namespace,
                        "pod_name": pod_name,
                        "tail_lines": tail_lines,
                        "container": chosen_container,
                    },
                )

            elif function_name == "k8s_get_events":
                namespace = function_args.get("namespace")
                ns = namespace if isinstance(namespace, str) and namespace.strip() else None
                return await self._call_tool_server(function_name, {"namespace": ns})

            elif function_name == "k8s_get_available_api_resources":
                return await self._call_tool_server(function_name, {})

            elif function_name == "k8s_get_cluster_configuration":
                return await self._call_tool_server(function_name, {})

            elif function_name == "k8s_generate_resource":
                return json.dumps(
                    {"error": "YAML 생성은 비활성화되었습니다."},
                    ensure_ascii=False,
                )
            
            elif function_name == "get_node_list":
                nodes = await self.k8s_service.get_node_list()
                return json.dumps(nodes, ensure_ascii=False)
            
            elif function_name == "describe_node":
                result = await self.k8s_service.describe_node(function_args["name"])
                return json.dumps(result, ensure_ascii=False)
            
            elif function_name == "get_pvcs":
                namespace = function_args.get("namespace")
                pvcs = await self.k8s_service.get_pvcs(namespace) if namespace else await self.k8s_service.get_pvcs()
                return json.dumps(pvcs, ensure_ascii=False)
            
            elif function_name == "get_pvs":
                pvs = await self.k8s_service.get_pvs()
                return json.dumps(pvs, ensure_ascii=False)
            
            else:
                return json.dumps({"error": f"Unknown function: {function_name}"})
        
        except Exception as e:
            error_msg = f"Error in {function_name}: {str(e)}"
            print(f"[DEBUG] {error_msg}")
            return json.dumps({"error": error_msg}, ensure_ascii=False)
    
    def _format_tool_result(
        self,
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

    def _detect_output_preference(self, text: Optional[str]) -> Optional[str]:
        if not isinstance(text, str):
            return None
        lowered = text.lower()
        if "yaml" in lowered or "yml" in lowered:
            return "yaml"
        if "wide" in lowered:
            return "wide"
        if "json" in lowered:
            return "json"
        return None

    def _mentions_events(self, text: Optional[str]) -> bool:
        if not isinstance(text, str):
            return False
        lowered = text.lower()
        return "event" in lowered or "이벤트" in lowered

    def _mentions_logs(self, text: Optional[str]) -> bool:
        if not isinstance(text, str):
            return False
        lowered = text.lower()
        return "log" in lowered or "로그" in lowered

    def _mentions_describe(self, text: Optional[str]) -> bool:
        if not isinstance(text, str):
            return False
        lowered = text.lower()
        return "describe" in lowered or "상세" in lowered or "디스크라이브" in lowered

    def _filter_tools_for_output_preference(self, tools: List[Dict], user_text: Optional[str]) -> List[Dict]:
        pref = self._detect_output_preference(user_text)
        if pref not in {"json", "wide", "yaml"}:
            return tools

        want_events = self._mentions_events(user_text)
        want_logs = self._mentions_logs(user_text)
        want_describe = self._mentions_describe(user_text)

        # Strongly prefer format-specific tools when output format is requested.
        if pref == "yaml":
            allow = {"k8s_get_resource_yaml"}
        else:
            allow = {"k8s_get_resources"}
        if want_events:
            allow.add("k8s_get_events")
        if want_logs:
            allow.add("k8s_get_pod_logs")
        if want_describe:
            allow.add("k8s_describe_resource")

        filtered = []
        for tool in tools:
            fn = tool.get("function", {}).get("name")
            if fn in allow:
                filtered.append(tool)

        # If for some reason nothing matched, fall back to original tools
        return filtered or tools

    def _render_k8s_resource_payload(self, payload) -> str:
        """k8s_get_resources 결과 포맷을 문자열로 변환"""
        try:
            if isinstance(payload, dict) and "format" in payload:
                return json.dumps(payload.get("data"), ensure_ascii=False)
            return json.dumps(payload, ensure_ascii=False)
        except Exception:
            return str(payload)
    
    def _extract_suggestions(self, message: str) -> List[str]:
        """메시지에서 제안 추출"""
        suggestions = []
        
        # "다음을 시도해보세요:", "권장사항:" 등의 패턴 찾기
        lines = message.split('\n')
        in_suggestion_block = False
        
        for line in lines:
            if any(keyword in line.lower() for keyword in ['시도', '권장', '제안', 'try', 'recommend', 'suggest']):
                in_suggestion_block = True
                continue
            
            if in_suggestion_block and line.strip().startswith(('-', '•', '*', '1.', '2.', '3.')):
                suggestions.append(line.strip().lstrip('-•*123456789. '))
        
        return suggestions[:5]  # 최대 5개
    
    async def session_chat_stream(self, session_id: str, message: str):
        """세션 기반 AI 챗봇 (스트리밍 + 세션 관리 + Tool Context)"""
        from app.database import get_db_service
        
        try:
            db = await get_db_service()
            
            # 세션 확인
            session = await db.get_session(session_id)
            if not session:
                yield f"data: {json.dumps({'type': 'error', 'content': 'Session not found'})}\n\n"
                return
            
            # 사용자 메시지 저장
            await db.add_message(session_id, "user", message)
            
            # 대화 히스토리 가져오기
            messages_history = await db.get_messages(session_id)

            # GPT 메시지 형식으로 변환
            # 👉 토큰 과사용을 막기 위해 user/assistant 히스토리를 최근 N개만 사용
            MAX_HISTORY_MESSAGES = 10  # user/assistant 메시지 기준 (약 5턴)
            history_for_model = [
                msg for msg in messages_history
                if msg.role in ["user", "assistant"]
            ]
            recent_history = history_for_model[-MAX_HISTORY_MESSAGES:]

            messages = [{"role": "system", "content": self._get_system_message()}]
            for msg in recent_history:
                messages.append({
                    "role": msg.role,
                    "content": self._sanitize_history_content(msg.role, msg.content),
                })
            
            # Tool Context 가져오기 또는 생성
            if session_id not in self.tool_contexts:
                self.tool_contexts[session_id] = ToolContext(session_id)
                # DB에서 컨텍스트 복원
                context_data = await db.get_context(session_id)
                if context_data:
                    self.tool_contexts[session_id].state = context_data.state or {}
                    self.tool_contexts[session_id].cache = context_data.cache or {}
            
            tool_context = self.tool_contexts[session_id]
            
            print(f"[DEBUG] Session {session_id}: {len(messages)} messages, context state keys: {list(tool_context.state.keys())}")
            
            # Function definitions
            tools = self._get_tools_definition()
            # YAML/WIDE 요청 시 legacy JSON-only 도구는 제외
            tools = self._filter_tools_for_output_preference(tools, message)
            
            # ===== Multi-turn Tool Calling Loop =====
            max_iterations = 5  # 최대 5번까지 tool call 반복 허용
            iteration = 0
            assistant_content = ""
            tool_calls_log = []  # Tool call 정보 저장
            
            while iteration < max_iterations:
                iteration += 1
                print(f"[DEBUG] Iteration {iteration}/{max_iterations}")
                
                # GPT 호출 (Function Calling)
                print(f"[AI Service] Session Chat API 호출 (Iteration {iteration}) - 요청 모델: {self.model}", flush=True)
                print(f"[DEBUG] Messages count: {len(messages)}, Tools count: {len(tools)}", flush=True)
                
                try:
                    response = await self.client.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        tools=tools,
                        tool_choice="auto",
                        temperature=0.7,
                        max_tokens=1600,  # 답변이 길어질 수 있어 여유를 둠
                        timeout=60.0  # tool 결과가 큰 경우를 고려해 타임아웃 상향
                    )
                    print(f"[AI Service] Session Chat API 응답 (Iteration {iteration}) - 실제 사용 모델: {response.model}", flush=True)

                    # OpenAI 응답 전체 로그 출력
                    response_dict = {
                        "id": response.id,
                        "model": response.model,
                        "created": response.created,
                        "choices": [
                            {
                                "index": choice.index,
                                "message": {
                                    "role": choice.message.role,
                                    "content": choice.message.content,
                                    "tool_calls": [{"id": tc.id, "type": tc.type, "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in (choice.message.tool_calls or [])]
                                },
                                "finish_reason": choice.finish_reason
                            } for choice in response.choices
                        ],
                        "usage": {
                            "prompt_tokens": response.usage.prompt_tokens if response.usage else None,
                            "completion_tokens": response.usage.completion_tokens if response.usage else None,
                            "total_tokens": response.usage.total_tokens if response.usage else None
                        } if response.usage else None
                    }
                    print(f"[OPENAI RESPONSE][session_chat_stream iteration {iteration}] {json.dumps(response_dict, ensure_ascii=False, indent=2)}", flush=True)

                    # 토큰 사용량 로그 (Function Calling 단계)
                    usage = getattr(response, "usage", None)
                    if usage is not None:
                        print(
                            f"[TOKENS][session_chat iteration {iteration} fc] prompt={usage.prompt_tokens}, "
                            f"completion={usage.completion_tokens}, total={usage.total_tokens}",
                            flush=True,
                        )
                        yield (
                            "data: "
                            + json.dumps(
                                {
                                    "usage_phase": f"session_chat_iteration_{iteration}_fc",
                                    "usage": {
                                        "prompt_tokens": usage.prompt_tokens,
                                        "completion_tokens": usage.completion_tokens,
                                        "total_tokens": usage.total_tokens,
                                    },
                                },
                                ensure_ascii=False,
                            )
                            + "\n\n"
                        )
                except Exception as api_error:
                    print(f"[ERROR] OpenAI API call failed: {api_error}", flush=True)
                    yield f"data: {json.dumps({'error': f'OpenAI API 호출 실패: {str(api_error)}'}, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                
                response_message = response.choices[0].message
                
                # Function calling이 있으면 실행
                if response_message.tool_calls:
                    print(f"[DEBUG] Tool calls detected: {len(response_message.tool_calls)}")
                    messages.append(response_message)
                    
                    for tool_call in response_message.tool_calls:
                        function_name = tool_call.function.name
                        function_args = json.loads(tool_call.function.arguments)
                        
                        print(f"[DEBUG] Calling function: {function_name} with args: {function_args}")
                        
                        # 함수 실행 중임을 알림
                        yield f"data: {json.dumps({'function': function_name, 'args': function_args}, ensure_ascii=False)}\n\n"
                        
                        # 함수 실행 (Tool Context 전달)
                        function_response = await self._execute_function_with_context(
                            function_name,
                            function_args,
                            tool_context
                        )
                        
                        print(f"[DEBUG] Function response length: {len(str(function_response))}")
                        
                        # 결과를 사용자 친화적으로 포맷 (JSON이면 pretty-print)
                        formatted_result, is_json, is_yaml = self._format_tool_result(
                            function_name,
                            function_args,
                            function_response,
                        )

                        display_result = self._build_tool_display(
                            function_name,
                            function_args,
                            formatted_result,
                            is_json,
                            is_yaml,
                        )
                        
                        # 결과 미리보기 (너무 길면 잘라서 전송하되, 표시를 남김)
                        max_preview_len = 2500
                        if len(formatted_result) > max_preview_len:
                            result_preview = formatted_result[:max_preview_len] + "\n... (truncated) ..."
                        else:
                            result_preview = formatted_result

                        display_preview = None
                        if display_result is not None:
                            if len(display_result) > max_preview_len:
                                display_preview = display_result[:max_preview_len] + "\n... (truncated) ..."
                            else:
                                display_preview = display_result
                        
                        # Function 결과를 프론트엔드로 전송 (스트리밍) - 실행 후
                        # 👉 프론트에는 미리보기만 전달 (약 2500자)
                        payload = {
                            "function_result": function_name,
                            "result": result_preview,
                            "is_json": is_json,
                            "is_yaml": is_yaml,
                        }
                        if display_preview is not None:
                            payload["display"] = display_preview
                            payload["display_format"] = "kubectl"
                        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                        
                        # Tool call 정보 + 실행 결과 전체 저장 (DB에는 전체 결과 보관)
                        tool_calls_log.append({
                            'function': function_name, 
                            'args': function_args,
                            'result': formatted_result,
                            'is_json': is_json,
                            'is_yaml': is_yaml,
                            'display': display_result,
                            'display_format': "kubectl" if display_result is not None else None,
                        })
                        
                        tool_message_content = self._truncate_tool_result_for_llm(formatted_result)
                        messages.append({
                            "tool_call_id": tool_call.id,
                            "role": "tool",
                            "name": function_name,
                            "content": tool_message_content
                        })
                    
                    # 다음 iteration으로 계속
                    continue
                
                # Tool call이 없으면 최종 텍스트 응답 (스트리밍)
                else:
                    print("[DEBUG] No tool calls. Streaming final answer directly from OpenAI.")

                    # 1) 최초 응답을 스트리밍으로 전송
                    try:
                        stream = await self.client.chat.completions.create(
                            model=self.model,
                            messages=messages,
                            temperature=0.7,
                            max_tokens=1200,
                            stream=True,
                            stream_options={"include_usage": True},
                        )
                    except TypeError:
                        stream = await self.client.chat.completions.create(
                            model=self.model,
                            messages=messages,
                            temperature=0.7,
                            max_tokens=1200,
                            stream=True,
                        )

                    last_finish_reason = None
                    stream_usage = None
                    async for chunk in stream:
                        if getattr(chunk, "usage", None) is not None:
                            stream_usage = chunk.usage
                        if chunk.choices and getattr(chunk.choices[0], "delta", None):
                            delta = chunk.choices[0].delta
                            if delta.content:
                                assistant_content += delta.content
                                yield f"data: {json.dumps({'content': delta.content}, ensure_ascii=False)}\n\n"
                        if chunk.choices and getattr(chunk.choices[0], "finish_reason", None):
                            last_finish_reason = chunk.choices[0].finish_reason

                    if stream_usage is not None:
                        print(
                            f"[TOKENS][session_chat final stream] prompt={stream_usage.prompt_tokens}, "
                            f"completion={stream_usage.completion_tokens}, total={stream_usage.total_tokens}",
                            flush=True,
                        )
                        yield (
                            "data: "
                            + json.dumps(
                                {
                                    "usage_phase": "session_chat_final_stream",
                                    "usage": {
                                        "prompt_tokens": stream_usage.prompt_tokens,
                                        "completion_tokens": stream_usage.completion_tokens,
                                        "total_tokens": stream_usage.total_tokens,
                                    },
                                },
                                ensure_ascii=False,
                            )
                            + "\n\n"
                        )

                    # 모델 컨텍스트에 누적된 전체 답변을 넣어 둠
                    if assistant_content:
                        messages.append({"role": "assistant", "content": assistant_content})

                    print(
                        f"[DEBUG] Primary streaming completed. finish_reason={last_finish_reason}, length={len(assistant_content)}"
                    )

                    # 2) 길이 제한으로 잘렸다면 이어서 최대 3회까지 추가 스트리밍
                    if last_finish_reason == "length":
                        max_continuations = 3
                        for continuation_index in range(1, max_continuations + 1):
                            print(
                                f"[DEBUG] Continuation {continuation_index}/{max_continuations} (length truncated)"
                            )
                            messages.append(
                                {
                                    "role": "user",
                                    "content": (
                                        "방금 답변이 길이 제한으로 중간에 끊겼습니다. "
                                        "바로 이전 출력의 마지막 문장/항목 다음부터 자연스럽게 이어서 작성하세요. "
                                        "이미 출력한 내용은 반복하지 마세요."
                                    ),
                                }
                            )

                            try:
                                cont_stream = await self.client.chat.completions.create(
                                    model=self.model,
                                    messages=messages,
                                    temperature=0.7,
                                    max_tokens=1200,
                                    stream=True,
                                    stream_options={"include_usage": True},
                                )
                            except TypeError:
                                cont_stream = await self.client.chat.completions.create(
                                    model=self.model,
                                    messages=messages,
                                    temperature=0.7,
                                    max_tokens=1200,
                                    stream=True,
                                )
                            cont_usage = None

                            continuation_text = ""
                            cont_finish_reason = None
                            async for chunk in cont_stream:
                                if getattr(chunk, "usage", None) is not None:
                                    cont_usage = chunk.usage
                                if chunk.choices and getattr(chunk.choices[0], "delta", None):
                                    delta = chunk.choices[0].delta
                                    if delta.content:
                                        continuation_text += delta.content
                                        assistant_content += delta.content
                                        yield f"data: {json.dumps({'content': delta.content}, ensure_ascii=False)}\n\n"
                                if chunk.choices and getattr(chunk.choices[0], "finish_reason", None):
                                    cont_finish_reason = chunk.choices[0].finish_reason

                            if cont_usage is not None:
                                print(
                                    f"[TOKENS][session_chat continuation {continuation_index}] prompt={cont_usage.prompt_tokens}, "
                                    f"completion={cont_usage.completion_tokens}, total={cont_usage.total_tokens}",
                                    flush=True,
                                )
                                yield (
                                    "data: "
                                    + json.dumps(
                                        {
                                            "usage_phase": f"session_chat_continuation_{continuation_index}",
                                            "usage": {
                                                "prompt_tokens": cont_usage.prompt_tokens,
                                                "completion_tokens": cont_usage.completion_tokens,
                                                "total_tokens": cont_usage.total_tokens,
                                            },
                                        },
                                        ensure_ascii=False,
                                    )
                                    + "\n\n"
                                )

                            if continuation_text:
                                messages.append({"role": "assistant", "content": continuation_text})

                            print(
                                f"[DEBUG] Continuation done. finish_reason={cont_finish_reason}, len={len(continuation_text)}"
                            )

                            if cont_finish_reason != "length":
                                break

                    # 최종 응답 완료, 루프 종료
                    break
            
            # Max iterations 도달
            if iteration >= max_iterations and not assistant_content:
                print(f"[WARNING] Max iterations ({max_iterations}) reached without final response")
                assistant_content = "죄송합니다. 정보 수집 중 최대 반복 횟수에 도달했습니다. 더 구체적인 질문으로 다시 시도해주세요."
                yield f"data: {json.dumps({'content': assistant_content}, ensure_ascii=False)}\n\n"
            
            print(f"[DEBUG] Preparing to save message. assistant_content length: {len(assistant_content)}, tool_calls: {len(tool_calls_log)}")
            
            # Tool call 정보를 포함한 전체 메시지 생성 (KAgent 스타일)
            full_message = ""
            if tool_calls_log:
                for tc in tool_calls_log:
                    # Arguments 섹션
                    if tc['args']:
                        args_json = json.dumps(tc['args'], indent=2, ensure_ascii=False)
                        args_section = f"""<details>
<summary><strong>📋 Arguments</strong></summary>

```json
{args_json}
```

</details>"""
                    else:
                        args_section = '<p><strong>📋 Arguments:</strong> No arguments</p>'
                    
                    # Results 섹션 - 실제 tool 실행 결과
                    result_preview = tc.get('display') or tc.get('result', 'No result')
                    is_json = tc.get('is_json', False)
                    is_yaml = tc.get('is_yaml', False)
                    if tc.get('display'):
                        code_fence = "```"
                    elif is_yaml:
                        code_fence = "```yaml"
                    else:
                        code_fence = "```json" if is_json else "```"
                    
                    results_section = f"""<details>
<summary><strong>📊 Results</strong></summary>

{code_fence}
{result_preview}
```

</details>"""
                    
                    full_message += f"""<details>
<summary>🔧 <strong>{tc['function']}</strong></summary>

{args_section}

{results_section}

</details>

"""
            full_message += assistant_content
            
            print(f"[DEBUG] Full message length: {len(full_message)}")
            print(f"[DEBUG] Full message preview: {full_message[:200]}...")
            
            # Assistant 메시지 저장 (tool call 정보 포함 - 전체 결과)
            await db.add_message(session_id, "assistant", full_message, tool_calls=tool_calls_log or None)
            print(f"[DEBUG] Message saved to DB")
            
            # Tool Context를 DB에 저장
            await db.update_context(
                session_id,
                state=tool_context.state,
                cache=tool_context.cache
            )
            
            # 세션 제목 자동 생성 (첫 메시지인 경우)
            if len(messages_history) <= 1:  # 시스템 메시지 + 첫 사용자 메시지
                title = message[:50] + "..." if len(message) > 50 else message
                await db.update_session_title(session_id, title)
            
            yield "data: [DONE]\n\n"
        
        except Exception as e:
            print(f"[ERROR] Session chat error: {e}")
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
    
    def _get_system_message(self) -> str:
        """시스템 메시지 반환 (KAgent 스타일)"""
        return """# Kubernetes AI Agent System Prompt

당신은 **KubeAssist**입니다. Kubernetes 트러블슈팅 및 운영에 특화된 고급 AI 에이전트입니다.

## 핵심 역량

- **전문 Kubernetes 지식**: Kubernetes 컴포넌트, 아키텍처, 오케스트레이션 원리, 리소스 관리
- **체계적 트러블슈팅**: 로그, 메트릭, 클러스터 상태를 분석하는 방법론적 접근
- **보안 우선 사고방식**: RBAC, Pod Security Policies, 보안 관행 우선
- **명확한 커뮤니케이션**: 명확하고 간결한 기술 정보 제공
- **안전 지향**: 최소 권한 원칙을 따르고 확인 없이 파괴적 작업 회피

## 운영 가이드라인

### 조사 프로토콜
1. **비침습적 시작**: 더 침습적인 작업 전에 읽기 전용 작업으로 시작
2. **점진적 확대**: 필요한 경우에만 더 상세한 조사로 확대
3. **모든 것을 문서화**: 모든 조사 단계와 작업의 명확한 기록 유지
4. **실행 전 확인**: 변경 사항을 실행하기 전에 잠재적 영향 고려
5. **롤백 계획**: 필요한 경우 변경 사항을 되돌릴 계획 항상 준비

### 문제 해결 프레임워크
1. **초기 평가**: 기본 클러스터 정보 수집, Kubernetes 버전 확인, 노드 상태 확인
2. **문제 분류**: 애플리케이션 문제, 인프라 문제, 성능 문제, 보안 사고, 구성 오류
3. **리소스 분석**: Pod 상태 및 이벤트, 컨테이너 로그, 리소스 메트릭, 네트워크 연결
4. **솔루션 구현**: 여러 솔루션 제안, 위험 평가, 구현 계획, 테스트 전략, 롤백 절차

## 사용 가능한 도구

### 정보 수집 도구
- `k8s_get_resources`: kubectl get (json/wide) 형식 지원. 출력 형식 요청 시 우선 사용
- `k8s_get_resource_yaml`: 단일 리소스 YAML 조회 (kubectl get -o yaml)
- `k8s_describe_resource`: 리소스 상세 조회 (kubectl describe)
- `k8s_get_pod_logs`: Pod 로그 조회 (kubectl logs)
- `k8s_get_events`: 네임스페이스 이벤트 조회 (kubectl get events)
- `k8s_get_available_api_resources`: api-resources 조회
- `k8s_get_cluster_configuration`: 클러스터 구성 정보 조회
- `get_cluster_overview`: 클러스터 전체 요약(확장 기능)
- `get_pod_metrics`: Pod 리소스 사용량 조회(확장 기능, kubectl top pods)
- `get_node_metrics`: Node 리소스 사용량 조회(확장 기능, kubectl top nodes)

## 도구 사용 원칙

**매우 중요**: 사용자가 질문을 하면, **반드시 먼저 도구를 사용하여 실제 클러스터 상태를 확인**하세요. 절대 추측하지 마세요.

### 네임스페이스/리소스 식별 규칙 (중요)

- 사용자가 네임스페이스를 명시하지 않은 요청에서 `default`를 임의로 가정하지 마세요.
- 사용자가 리소스 이름을 "대충" 던지는 경우(정확한 전체 이름이 아닌 식별자/부분 문자열)에는,
  먼저 `k8s_get_resources`를 `all_namespaces=true`로 호출해 **모든 네임스페이스에서 후보를 찾은 뒤**
  해당 후보의 `namespace`와 `name`을 사용해 후속 도구(로그/describe 등)를 호출하세요.
- 후보가 여러 개면 (다른 네임스페이스/여러 replica 등) 후보를 나열하고 사용자에게 선택을 요청하거나, 일반적으로 Healthy/Running+Ready인 리소스를 우선하세요.

### 출력 포맷/툴 선택 규칙 (중요)

- 사용자가 WIDE/`kubectl get` 스타일을 요청하면 `k8s_get_resources`를 사용하고 `output`에 형식을 지정하세요.
- YAML 요청은 `k8s_get_resource_yaml`에서만 지원합니다. 그 외에는 JSON으로 조회하고 화면에는 kubectl 테이블로 표시하세요.

1. **항상 도구를 적극적으로 사용**: 
   - 사용자가 클러스터에 대해 질문하면, 관련 도구를 즉시 호출하세요
   - 일반적인 설명보다 실제 데이터를 우선시하세요

2. **구체적인 정보 수집 예시**: 
   - "네임스페이스가 뭐가 있어?" → `k8s_get_resources`(resource_type=namespaces) 호출
   - "Pod 상태 확인해줘" → `k8s_get_resources`(resource_type=pods, namespace=...) 호출
   - "Failed Pod 있어?" → `k8s_get_resources`(resource_type=pods, all_namespaces=true) 후 상태 분석, 발견 시 `k8s_describe_resource` 및 `k8s_get_pod_logs`, `k8s_get_events` 추가 호출
   - "리소스 많이 쓰는 Pod는?" → `get_pod_metrics` 호출
   - "죽어 있는 Pod들 알려줘" → `k8s_get_resources`(resource_type=pods, all_namespaces=true) 후 NotReady/Error/CrashLoopBackOff 필터링

3. **문제 발견 시 추가 조사**:
   - Pod 문제 발견 → `k8s_describe_resource`, `k8s_get_pod_logs`, `k8s_get_events` 순차 호출
   - 노드 문제 발견 → `k8s_get_resources`(resource_type=nodes) 후 필요 시 `k8s_describe_resource`
   - 재시작이 많은 Pod → `k8s_get_pod_logs`로 크래시 원인 파악

4. **컨텍스트 기억**: 이전 대화에서 수집한 정보를 기억하고 활용하세요

## 응답 형식

**간결하고 명확하게 답변하세요**:

1. **Tool 결과 분석**: Tool을 호출한 경우, 결과를 간단히 요약하고 핵심 내용만 전달
2. **문제가 있다면**: 문제점과 원인을 명확히 설명
3. **해결 방법**: 필요한 경우 간단한 해결 방법이나 다음 단계 제시

**응답 원칙**:
- ✅ 핵심만 간결하게 전달
- ✅ 불필요한 섹션 구조(## 제목) 사용하지 않기
- ✅ Tool 결과를 자연스럽게 설명
- ✅ 사용자가 물어본 것에만 집중
- ❌ 긴 설명이나 배경 지식은 필요할 때만
- ❌ 형식적인 인사나 불필요한 전문 용어 남발 금지

## 언어

**중요**: 모든 응답은 **반드시 한국어로** 작성해야 합니다.
- 기술 용어는 영어 원문을 병기할 수 있습니다 (예: "파드(Pod)")
- 명령어와 코드는 그대로 유지
- 분석, 설명, 권장사항은 모두 한국어로 작성
- 친근하면서도 전문적인 톤 유지

항상 최소 침습적 접근으로 시작하고, 필요한 경우에만 진단을 확대하세요.

## 구조화된 출력 형식

Tool 결과를 분석한 후 다음 형식으로 응답하세요:

```
## 🔍 분석 요약
[발견한 내용의 간단한 개요]

## ⚠️ 발견된 문제
1. **[문제 유형]**: [구체적인 문제]
   - 심각도: [Critical/High/Medium/Low]
   - 영향받는 리소스: [리소스 이름]
   - 영향: [무엇이 문제인지]

## 🔎 Root Cause
[왜 이런 문제가 발생했는지 상세 설명]

## ✅ Recommended Actions
1. **Immediate Fix**: [명령어 또는 작업]
   ```bash
   kubectl [구체적인 명령어]
   ```
   
2. **Verification**: [How to confirm it's fixed]
   
3. **Prevention**: [How to avoid this in future]

## 📚 Additional Context
[Relevant K8s concepts, best practices, or documentation links]
```

**위 형식은 사용하지 마세요!** 대신 간결하고 자연스럽게 답변하세요.

# Critical Rules

**⚠️ EXTREMELY IMPORTANT - READ CAREFULLY:**

1. **NEVER guess** - Always call functions to get real-time data
2. **Be thorough** - Don't stop at surface-level symptoms
3. **Be concise** - 간결하게 핵심만 전달하세요. 불필요한 구조화된 섹션(## 제목)은 사용하지 마세요
3. **Think ahead** - Anticipate related issues
4. **Explain clearly** - Use analogies for complex concepts
5. **Provide commands** - Give exact kubectl commands to run
6. **Consider impact** - Warn about potential side effects
7. **Remember context** - Reference previous conversation

**🚨 COMPLETION REQUIREMENT:**
- You MUST provide COMPLETE answers with ALL sections filled
- NEVER end your response prematurely
- When you call a tool, you MUST analyze the results thoroughly
- Minimum response length: 3-4 paragraphs with specific details
- Include specific resource names, namespaces, and status information from tool results

# Available Tools (kubectl equivalent)

**Cluster Overview:**
- `get_cluster_overview()` - Overall health snapshot
- `k8s_get_resources(resource_type=namespaces)` - Namespace list
- `k8s_get_resources(resource_type=nodes)` - Node status
- `k8s_describe_resource(resource_type=nodes, resource_name)` - Node details

**Workload Analysis:**
- `k8s_get_resources(resource_type=pods)` - Pod list with status
- `k8s_describe_resource(resource_type=pods, resource_name)` - Pod details, events, conditions
- `k8s_get_pod_logs(namespace, pod_name, tail_lines)` - Container logs
- `k8s_get_resources(resource_type=deployments)` - Deployment status
- `k8s_describe_resource(resource_type=deployments, resource_name)` - Deployment details
- `k8s_get_resources(resource_type=services)` - Service endpoints
- `k8s_describe_resource(resource_type=services, resource_name)` - Service configuration

**Storage & Config:**
- `k8s_get_resources(resource_type=pvcs)` - PVC status
- `k8s_get_resources(resource_type=pvs)` - PV availability
- `k8s_get_events(namespace)` - Recent events (critical for debugging!)

**Metrics (extension):**
- `get_pod_metrics(namespace)` - Top pods (CPU/Memory)
- `get_node_metrics()` - Top nodes (CPU/Memory)

# Example Workflow

User: "My pod is not starting"

Your thought process:
1. Which namespace? If not specified, ask or list pods across namespaces (do NOT assume 'default')
2. `k8s_get_resources` → Find the problematic pod
3. `k8s_describe_resource` → Check conditions, events
4. `k8s_get_pod_logs` → Look for startup errors
5. `k8s_get_events` → Find scheduling/pulling issues
6. Analyze → Determine root cause
7. Provide solution with commands

# Tone
- Professional but approachable
- Confident but not arrogant
- Patient with beginners
- Detailed with experts
- Always constructive

Remember: You're not just answering questions - you're **solving production problems** and **teaching best practices**.
"""
    
    def _get_tools_definition(self) -> List[Dict]:
        """Tools 정의 반환 (상세한 설명 포함)"""
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_cluster_overview",
                    "description": """Get a comprehensive overview of the entire Kubernetes cluster health.
                    
                    Returns:
                    - Total counts: namespaces, pods, services, deployments, PVCs, PVs
                    - Pod status breakdown (Running, Pending, Failed, etc.)
                    - Node count and cluster version
                    
                    Use this FIRST when user asks about cluster health or wants a general status check.""",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_pod_metrics",
                    "description": """Get pod resource usage (CPU and memory) - equivalent to 'kubectl top pods'.
                    
                    Use this to:
                    - Check which pods are consuming the most resources
                    - Identify resource-heavy workloads
                    - Diagnose performance issues
                    - Monitor resource utilization""",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "Optional namespace filter. If not provided, shows all pods across all namespaces."}
                        }
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_node_metrics",
                    "description": """Get node resource usage (CPU and memory) - equivalent to 'kubectl top nodes'.
                    
                    Use this to:
                    - Check node resource utilization
                    - Identify nodes under heavy load
                    - Monitor cluster capacity
                    - Diagnose node-level performance issues""",
                    "parameters": {"type": "object", "properties": {}}
                }
            }
        ]

        tools.extend(self._get_k8s_readonly_tool_definitions())
        tools.extend(self._get_k8s_write_tool_definitions())
        return self._filter_tools_by_role(tools)

    def _get_k8s_readonly_tool_definitions(self) -> List[Dict]:
        """kagent 스타일의 read-only k8s tool 정의"""
        return [
            {
                "type": "function",
                "function": {
                    "name": "k8s_get_resources",
                    "description": "Kubernetes 리소스를 조회합니다 (kubectl get). 출력 형식(wide/json) 요청 시 우선 사용.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "resource_type": {
                                "type": "string",
                                "description": "리소스 타입 (pods, deployments, services 등)",
                            },
                            "resource_name": {
                                "type": "string",
                                "description": "리소스 이름 (선택)",
                            },
                            "namespace": {
                                "type": "string",
                                "description": "네임스페이스 (선택)",
                            },
                            "all_namespaces": {
                                "type": "string",
                                "description": "모든 네임스페이스 조회 (true/false)",
                            },
                            "output": {
                                "type": "string",
                                "description": "출력 포맷 (json, wide)",
                                "default": "wide",
                            },
                        },
                        "required": ["resource_type"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_get_resource_yaml",
                    "description": "단일 리소스의 YAML을 조회합니다 (kubectl get -o yaml).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "resource_type": {"type": "string", "description": "리소스 타입"},
                            "resource_name": {"type": "string", "description": "리소스 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                        },
                        "required": ["resource_type", "resource_name"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_get_pod_logs",
                    "description": "Pod 로그를 조회합니다 (kubectl logs).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "pod_name": {"type": "string", "description": "Pod 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (기본: default)"},
                            "container": {"type": "string", "description": "컨테이너 이름 (선택)"},
                            "tail_lines": {"type": "integer", "description": "마지막 N줄 (기본: 50)"},
                        },
                        "required": ["pod_name"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_get_events",
                    "description": "네임스페이스 이벤트 조회 (kubectl get events).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "namespace": {"type": "string", "description": "네임스페이스 (기본: default)"},
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_get_available_api_resources",
                    "description": "사용 가능한 API 리소스 목록 조회 (kubectl api-resources).",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_get_cluster_configuration",
                    "description": "클러스터 구성 정보 조회 (kubectl config view -o json 유사).",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_check_service_connectivity",
                    "description": "Service/Endpoint 연결성 확인 (서비스에 Ready 엔드포인트가 있는지 점검).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "service_name": {"type": "string", "description": "서비스 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                            "port": {"type": "string", "description": "서비스 포트(이름 또는 번호, 선택)"},
                        },
                        "required": ["service_name"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_describe_resource",
                    "description": "리소스 상세 조회 (kubectl describe).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "resource_type": {"type": "string", "description": "리소스 타입"},
                            "resource_name": {"type": "string", "description": "리소스 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                        },
                        "required": ["resource_type", "resource_name"],
                    },
                },
            },
        ]

    def _get_k8s_write_tool_definitions(self) -> List[Dict]:
        """kagent 스타일의 write k8s tool 정의"""
        return [
            {
                "type": "function",
                "function": {
                    "name": "k8s_apply_manifest",
                    "description": "매니페스트 적용 (kubectl apply -f -).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "yaml_content": {"type": "string", "description": "YAML 매니페스트 문자열"},
                            "resource_manifest": {
                                "type": "object",
                                "description": "매니페스트 JSON 객체 (선택)",
                            },
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_create_resource",
                    "description": "리소스 생성 (kubectl create -f -).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "yaml_content": {"type": "string", "description": "YAML 매니페스트 문자열"},
                            "resource_manifest": {
                                "type": "object",
                                "description": "매니페스트 JSON 객체 (선택)",
                            },
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_create_resource_from_url",
                    "description": "URL 매니페스트로 리소스 생성 (kubectl create -f URL).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "url": {"type": "string", "description": "매니페스트 URL"},
                        },
                        "required": ["url"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_delete_resource",
                    "description": "리소스 삭제 (kubectl delete).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "resource_type": {"type": "string", "description": "리소스 타입"},
                            "resource_name": {"type": "string", "description": "리소스 이름 (all=true일 때 생략 가능)"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                            "all": {"type": "boolean", "description": "모두 삭제"},
                            "force": {"type": "boolean", "description": "강제 삭제"},
                            "grace_period": {"type": "integer", "description": "grace period(초)"},
                            "wait": {"type": "boolean", "description": "삭제 완료 대기"},
                            "ignore_not_found": {"type": "boolean", "description": "없으면 무시"},
                        },
                        "required": ["resource_type"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_patch_resource",
                    "description": "리소스 패치 (kubectl patch).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "resource_type": {"type": "string", "description": "리소스 타입"},
                            "resource_name": {"type": "string", "description": "리소스 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                            "patch": {"type": "object", "description": "패치 JSON 객체 또는 문자열"},
                            "patch_type": {
                                "type": "string",
                                "description": "패치 타입 (strategic, merge, json)",
                            },
                        },
                        "required": ["resource_type", "resource_name", "patch"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_annotate_resource",
                    "description": "리소스 어노테이션 추가/수정 (kubectl annotate).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "resource_type": {"type": "string", "description": "리소스 타입"},
                            "resource_name": {"type": "string", "description": "리소스 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                            "annotations": {"type": "object", "description": "추가할 annotations"},
                            "overwrite": {"type": "boolean", "description": "기존 값 덮어쓰기"},
                        },
                        "required": ["resource_type", "resource_name", "annotations"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_remove_annotation",
                    "description": "리소스 어노테이션 제거 (kubectl annotate key-).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "resource_type": {"type": "string", "description": "리소스 타입"},
                            "resource_name": {"type": "string", "description": "리소스 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                            "keys": {"type": "array", "items": {"type": "string"}, "description": "제거할 키 목록"},
                            "overwrite": {"type": "boolean", "description": "기존 값 덮어쓰기"},
                        },
                        "required": ["resource_type", "resource_name", "keys"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_label_resource",
                    "description": "리소스 라벨 추가/수정 (kubectl label).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "resource_type": {"type": "string", "description": "리소스 타입"},
                            "resource_name": {"type": "string", "description": "리소스 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                            "labels": {"type": "object", "description": "추가할 labels"},
                            "overwrite": {"type": "boolean", "description": "기존 값 덮어쓰기"},
                        },
                        "required": ["resource_type", "resource_name", "labels"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_remove_label",
                    "description": "리소스 라벨 제거 (kubectl label key-).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "resource_type": {"type": "string", "description": "리소스 타입"},
                            "resource_name": {"type": "string", "description": "리소스 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                            "keys": {"type": "array", "items": {"type": "string"}, "description": "제거할 키 목록"},
                            "overwrite": {"type": "boolean", "description": "기존 값 덮어쓰기"},
                        },
                        "required": ["resource_type", "resource_name", "keys"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_scale",
                    "description": "리소스 스케일 조정 (kubectl scale).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "resource_type": {"type": "string", "description": "리소스 타입"},
                            "resource_name": {"type": "string", "description": "리소스 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                            "replicas": {"type": "integer", "description": "replica 수"},
                        },
                        "required": ["resource_type", "resource_name", "replicas"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_rollout",
                    "description": "롤아웃 작업 (restart/undo/pause/resume/status).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": {"type": "string", "description": "restart/undo/pause/resume/status"},
                            "resource_type": {"type": "string", "description": "리소스 타입"},
                            "resource_name": {"type": "string", "description": "리소스 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (선택)"},
                            "revision": {"type": "integer", "description": "undo revision"},
                            "timeout": {"type": "string", "description": "timeout (예: 60s)"},
                        },
                        "required": ["action", "resource_type", "resource_name"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "k8s_execute_command",
                    "description": "Pod 내 명령 실행 (kubectl exec).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "pod_name": {"type": "string", "description": "Pod 이름"},
                            "namespace": {"type": "string", "description": "네임스페이스 (기본: default)"},
                            "container": {"type": "string", "description": "컨테이너 이름 (선택)"},
                            "command": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "실행할 명령 배열 (예: [\"ls\", \"/\"])",
                            },
                        },
                        "required": ["pod_name", "command"],
                    },
                },
            },
        ]
    
    async def _execute_function_with_context(
        self,
        function_name: str,
        function_args: Dict,
        tool_context: ToolContext
    ) -> str:
        """Function 실행 (Tool Context 포함)"""
        import json
        
        try:
            print(f"[DEBUG] Executing {function_name} with context, state keys: {list(tool_context.state.keys())}")
            if not self._is_tool_allowed(function_name):
                return json.dumps(
                    {"error": f"권한 없음: '{function_name}'는 {self.user_role} 역할에서 사용할 수 없습니다."},
                    ensure_ascii=False,
                )
            
            # 캐시 확인
            cache_key = f"{function_name}_{json.dumps(function_args, sort_keys=True)}"
            if cache_key in tool_context.cache:
                print(f"[DEBUG] Cache hit for {cache_key}")
                return tool_context.cache[cache_key]

            write_tools = {
                "k8s_apply_manifest",
                "k8s_create_resource",
                "k8s_create_resource_from_url",
                "k8s_delete_resource",
                "k8s_patch_resource",
                "k8s_annotate_resource",
                "k8s_remove_annotation",
                "k8s_label_resource",
                "k8s_remove_label",
                "k8s_scale",
                "k8s_rollout",
                "k8s_execute_command",
            }
            if function_name in write_tools:
                return await self._call_tool_server(function_name, function_args)

            # 함수 실행
            if function_name == "get_cluster_overview":
                result = await self._call_tool_server(function_name, function_args)
            
            elif function_name == "get_namespaces":
                namespaces = await self.k8s_service.get_namespaces()
                result = json.dumps(namespaces, ensure_ascii=False)
                tool_context.state["last_namespaces"] = [ns["name"] for ns in namespaces]
            
            elif function_name == "get_all_pods":
                pods = await self.k8s_service.get_all_pods()
                result = json.dumps(pods, ensure_ascii=False)
                tool_context.state["last_all_pods_count"] = len(pods)

            elif function_name == "find_pods":
                query_raw = str(function_args.get("query", "")).strip()
                if not query_raw:
                    raise Exception("find_pods requires non-empty 'query'")
                namespace = function_args.get("namespace")
                limit_int = self._coerce_limit(function_args.get("limit", 20))
                matches = await self._find_pods(
                    query_raw,
                    namespace=namespace if isinstance(namespace, str) else None,
                    limit=limit_int,
                )
                result = json.dumps(matches, ensure_ascii=False)
                tool_context.state["last_pod_search_query"] = query_raw
                tool_context.state["last_pod_search_count"] = len(matches)

            elif function_name == "find_services":
                query_raw = str(function_args.get("query", "")).strip()
                if not query_raw:
                    raise Exception("find_services requires non-empty 'query'")
                namespace = function_args.get("namespace")
                limit_int = self._coerce_limit(function_args.get("limit", 20))
                matches = await self._find_services(
                    query_raw,
                    namespace=namespace if isinstance(namespace, str) else None,
                    limit=limit_int,
                )
                result = json.dumps(matches, ensure_ascii=False)

            elif function_name == "find_deployments":
                query_raw = str(function_args.get("query", "")).strip()
                if not query_raw:
                    raise Exception("find_deployments requires non-empty 'query'")
                namespace = function_args.get("namespace")
                limit_int = self._coerce_limit(function_args.get("limit", 20))
                matches = await self._find_deployments(
                    query_raw,
                    namespace=namespace if isinstance(namespace, str) else None,
                    limit=limit_int,
                )
                result = json.dumps(matches, ensure_ascii=False)
            
            elif function_name == "get_pods":
                pods = await self.k8s_service.get_pods(function_args["namespace"])
                result = json.dumps(pods, ensure_ascii=False)
                tool_context.state["last_namespace"] = function_args["namespace"]
                tool_context.state["last_pods"] = [{"name": pod["name"], "status": pod["status"]} for pod in pods]
            
            elif function_name == "describe_pod":
                namespace = function_args.get("namespace")
                name = function_args["name"]
                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_pods(str(name), namespace=None, limit=20)
                    chosen = await self._resolve_single("pods", str(name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    name = str(chosen.get("name", name))

                result_data = await self.k8s_service.describe_pod(namespace, name)
                result = json.dumps(result_data, ensure_ascii=False)
                tool_context.state["last_described_pod"] = function_args["name"]
            
            elif function_name == "get_pod_logs":
                namespace = function_args.get("namespace")
                pod_name = function_args["pod_name"]
                tail_lines = function_args.get("tail_lines", 100)
                requested_container = function_args.get("container")

                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_pods(str(pod_name), namespace=None, limit=20)
                    chosen = await self._resolve_single("pods", str(pod_name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    pod_name = str(chosen.get("name", pod_name))

                chosen_container, all_containers = await self._pick_log_container(
                    namespace,
                    pod_name,
                    explicit_container=requested_container,
                )

                # 여러 컨테이너가 있는데 어떤 것을 쓸지 결정하지 못한 경우
                if chosen_container is None and all_containers:
                    return json.dumps(
                        {
                            "error": (
                                f"Pod '{pod_name}' in namespace '{namespace}' has multiple containers "
                                f"({', '.join(all_containers)}). "
                                "로그를 조회할 컨테이너를 'container' 인자로 명시해주세요."
                            )
                        },
                        ensure_ascii=False,
                    )

                logs = await self.k8s_service.get_pod_logs(
                    namespace,
                    pod_name,
                    tail_lines=tail_lines,
                    container=chosen_container,
                )
                result = logs
                tool_context.state["last_log_pod"] = pod_name
            
            elif function_name == "get_deployments":
                deployments = await self.k8s_service.get_deployments(function_args["namespace"])
                result = json.dumps(deployments, ensure_ascii=False)
            
            elif function_name == "describe_deployment":
                namespace = function_args.get("namespace")
                name = function_args["name"]
                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_deployments(str(name), namespace=None, limit=20)
                    chosen = await self._resolve_single("deployments", str(name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    name = str(chosen.get("name", name))

                result_data = await self.k8s_service.describe_deployment(namespace, name)
                result = json.dumps(result_data, ensure_ascii=False)
            
            elif function_name == "get_services":
                services = await self.k8s_service.get_services(function_args["namespace"])
                result = json.dumps(services, ensure_ascii=False)
            
            elif function_name == "describe_service":
                namespace = function_args.get("namespace")
                name = function_args["name"]
                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_services(str(name), namespace=None, limit=20)
                    chosen = await self._resolve_single("services", str(name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    name = str(chosen.get("name", name))

                result_data = await self.k8s_service.describe_service(namespace, name)
                result = json.dumps(result_data, ensure_ascii=False)
            
            elif function_name == "get_events":
                events = await self.k8s_service.get_events(function_args["namespace"])
                result = json.dumps([{
                    "type": event["type"],
                    "reason": event["reason"],
                    "message": event["message"],
                    "count": event["count"]
                } for event in events], ensure_ascii=False)

            elif function_name == "k8s_get_resources":
                resource_type = function_args.get("resource_type", "")
                resource_name = function_args.get("resource_name")
                namespace = function_args.get("namespace")
                all_namespaces_raw = function_args.get("all_namespaces", False)
                output = function_args.get("output", "wide")

                if isinstance(all_namespaces_raw, str):
                    all_namespaces = all_namespaces_raw.strip().lower() == "true"
                else:
                    all_namespaces = bool(all_namespaces_raw)
                if not isinstance(namespace, str) or not namespace.strip():
                    all_namespaces = True
                if isinstance(output, str) and output.strip().lower() == "yaml":
                    output = "json"

                tool_args = {
                    "resource_type": resource_type,
                    "resource_name": resource_name,
                    "namespace": namespace if isinstance(namespace, str) else None,
                    "all_namespaces": all_namespaces,
                    "output": output if isinstance(output, str) else "wide",
                }
                result = await self._call_tool_server(function_name, tool_args)

            elif function_name == "k8s_get_resource_yaml":
                namespace = function_args.get("namespace")
                resource_type = function_args.get("resource_type", "")
                resource_name = function_args.get("resource_name", "")

                # Support "pods/foo" style resource_name if resource_type is missing.
                if isinstance(resource_name, str) and "/" in resource_name:
                    prefix, name = resource_name.split("/", 1)
                    if prefix and name and not (isinstance(resource_type, str) and resource_type.strip()):
                        resource_type = prefix
                        resource_name = name

                resource_type = str(resource_type or "").strip()
                resource_name = str(resource_name or "").strip()
                ns = namespace if isinstance(namespace, str) and namespace.strip() else None

                if not resource_name:
                    raise Exception("resource_name is required for k8s_get_resource_yaml")

                resolved = None
                if not resource_type or ns is None:
                    resolved = await self._locate_resource_for_yaml(
                        resource_name=resource_name,
                        namespace=ns,
                        preferred_type=resource_type or None,
                    )
                    resource_type = str(resolved.get("resource_type") or resource_type)
                    resource_name = str(resolved.get("resource_name") or resource_name)
                    ns = resolved.get("namespace") or ns

                try:
                    result = await self._call_tool_server(
                        function_name,
                        {
                            "resource_type": resource_type,
                            "resource_name": resource_name,
                            "namespace": ns,
                        },
                    )
                except Exception:
                    if resolved is None:
                        resolved = await self._locate_resource_for_yaml(
                            resource_name=resource_name,
                            namespace=ns,
                            preferred_type=resource_type or None,
                        )
                        resource_type = str(resolved.get("resource_type") or resource_type)
                        resource_name = str(resolved.get("resource_name") or resource_name)
                        ns = resolved.get("namespace") or ns
                        result = await self._call_tool_server(
                            function_name,
                            {
                                "resource_type": resource_type,
                                "resource_name": resource_name,
                                "namespace": ns,
                            },
                        )
                    else:
                        raise

            elif function_name == "k8s_describe_resource":
                namespace = function_args.get("namespace")
                result = await self._call_tool_server(
                    function_name,
                    {
                        "resource_type": function_args.get("resource_type", ""),
                        "resource_name": function_args.get("resource_name", ""),
                        "namespace": namespace if isinstance(namespace, str) else None,
                    },
                )

            elif function_name == "k8s_get_pod_logs":
                namespace = function_args.get("namespace")
                pod_name = function_args.get("pod_name", "")
                if isinstance(pod_name, str) and "/" in pod_name:
                    pod_name = pod_name.split("/")[-1]
                tail_lines = self._coerce_limit(function_args.get("tail_lines", 50), default=50, max_value=2000)
                requested_container = function_args.get("container")

                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_pods(str(pod_name), namespace=None, limit=20)
                    chosen = await self._resolve_single("pods", str(pod_name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    pod_name = str(chosen.get("name", pod_name))

                chosen_container, all_containers = await self._pick_log_container(
                    namespace,
                    pod_name,
                    explicit_container=requested_container,
                )

                if chosen_container is None and all_containers:
                    result = json.dumps(
                        {
                            "error": (
                                f"Pod '{pod_name}' in namespace '{namespace}' has multiple containers "
                                f"({', '.join(all_containers)}). "
                                "로그를 조회할 컨테이너를 'container' 인자로 명시해주세요."
                            )
                        },
                        ensure_ascii=False,
                    )
                else:
                    result = await self._call_tool_server(
                        function_name,
                        {
                            "namespace": namespace,
                            "pod_name": pod_name,
                            "tail_lines": tail_lines,
                            "container": chosen_container,
                        },
                    )
                    tool_context.state["last_log_pod"] = pod_name

            elif function_name == "k8s_get_events":
                namespace = function_args.get("namespace")
                ns = namespace if isinstance(namespace, str) and namespace.strip() else None
                result = await self._call_tool_server(function_name, {"namespace": ns})

            elif function_name == "k8s_get_available_api_resources":
                result = await self._call_tool_server(function_name, {})

            elif function_name == "k8s_get_cluster_configuration":
                result = await self._call_tool_server(function_name, {})

            elif function_name == "k8s_check_service_connectivity":
                namespace = function_args.get("namespace")
                service_name = function_args.get("service_name") or function_args.get("name") or function_args.get("service")
                port = function_args.get("port")

                if not service_name:
                    raise Exception("service_name is required")

                if not isinstance(namespace, str) or not namespace.strip():
                    matches = await self._find_services(str(service_name), namespace=None, limit=20)
                    chosen = await self._resolve_single("services", str(service_name), matches)
                    namespace = str(chosen.get("namespace", ""))
                    service_name = str(chosen.get("name", service_name))

                result = await self._call_tool_server(
                    function_name,
                    {
                        "namespace": str(namespace),
                        "service_name": str(service_name),
                        "port": str(port) if port is not None else None,
                    },
                )

            elif function_name == "k8s_generate_resource":
                result = json.dumps(
                    {"error": "YAML 생성은 비활성화되었습니다."},
                    ensure_ascii=False,
                )
            
            elif function_name == "get_node_list":
                nodes = await self.k8s_service.get_node_list()
                result = json.dumps(nodes, ensure_ascii=False)
            
            elif function_name == "describe_node":
                result_data = await self.k8s_service.describe_node(function_args["name"])
                result = json.dumps(result_data, ensure_ascii=False)
            
            elif function_name == "get_pvcs":
                namespace = function_args.get("namespace")
                pvcs = await self.k8s_service.get_pvcs(namespace) if namespace else await self.k8s_service.get_pvcs()
                result = json.dumps(pvcs, ensure_ascii=False)
            
            elif function_name == "get_pvs":
                pvs = await self.k8s_service.get_pvs()
                result = json.dumps(pvs, ensure_ascii=False)
            
            elif function_name == "get_pod_metrics":
                namespace = function_args.get("namespace")
                result = await self._call_tool_server(
                    function_name,
                    {"namespace": namespace} if namespace else {},
                )
            
            elif function_name == "get_node_metrics":
                result = await self._call_tool_server(function_name, {})
            
            else:
                return json.dumps({"error": f"Unknown function: {function_name}"})
            
            # 캐시에 저장 (5분 TTL - 실제로는 timestamp 체크 필요)
            tool_context.cache[cache_key] = result
            
            print(f"[DEBUG] Function result cached: {cache_key}")
            return result
        
        except Exception as e:
            error_msg = f"Error in {function_name}: {str(e)}"
            print(f"[DEBUG] {error_msg}")
            return json.dumps({"error": error_msg}, ensure_ascii=False)
