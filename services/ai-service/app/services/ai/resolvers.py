# ai_service.py 의 검색/해소 함수 모음. self.k8s_service / self._helper_*
# 의존이라 service 첫 인자 패턴으로 추출.
#
# Phase 4.5.3.
#
# 함수:
# - _normalize_for_search / _query_tokens / _all_tokens_in_text / _extract_items_from_payload
#   / _query_in_mapping — 검색용 helper
# - _find_resource_matches — generic 매칭
# - _locate_resource_for_yaml — YAML 조회용 리소스 위치 결정
# - _find_pods / _find_services / _find_deployments — 종류별 검색
# - _resolve_single — 후보 중 1개 선택
# - _pick_log_container — pod 의 container 중 logs 대상 결정

import json
import re
from typing import Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.ai_service import AIService


async def _pick_log_container(
    service,
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
        pods = await service.k8s_service.get_pods(namespace)
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

def _coerce_limit(service, value: object, default: int = 20, max_value: int = 200) -> int:
    try:
        v = int(value)  # type: ignore[arg-type]
    except Exception:
        v = default
    if v <= 0:
        v = default
    if v > max_value:
        v = max_value
    return v

def _normalize_for_search(service, text: str) -> str:
    # Treat non-alphanumerics as separators (e.g., "alarm broker" matches "service-alarm-broker").
    return re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip()

def _query_tokens(service, query: str) -> List[str]:
    normalized = _normalize_for_search(service, query)
    return [t for t in normalized.split() if t]

def _all_tokens_in_text(service, query: str, text: str) -> bool:
    tokens = _query_tokens(service, query)
    if not tokens:
        return False
    hay = _normalize_for_search(service, text)
    return all(t in hay for t in tokens)

def _extract_items_from_payload(service, payload: object) -> List[Dict]:
    if isinstance(payload, dict):
        data = payload.get("data") if "data" in payload else payload
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            return list(data.get("items") or [])
    return []

async def _find_resource_matches(
    service,
    resource_type: str,
    query: str,
    namespace: Optional[str] = None,
    limit: int = 50,
) -> List[Dict]:
    payload = await service.k8s_service.get_resources(
        resource_type=resource_type,
        namespace=namespace if isinstance(namespace, str) else None,
        all_namespaces=namespace is None,
        output="json",
    )
    items = _extract_items_from_payload(service, payload)

    matches: List[Dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        meta = item.get("metadata", {}) if isinstance(item, dict) else {}
        name = str(meta.get("name", ""))
        if not name:
            continue
        if not _all_tokens_in_text(service, query, name):
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
    service,
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
        matches = await _find_resource_matches(service, preferred_type, resource_name, namespace=namespace, limit=20)
        if matches:
            chosen = await _resolve_single(service, preferred_type, resource_name, matches)
            return {
                "resource_type": preferred_type,
                "resource_name": chosen.get("name", resource_name),
                "namespace": chosen.get("namespace") or namespace,
            }

    # 2) Search across namespaces by type
    for rtype in search_types:
        try:
            matches = await _find_resource_matches(service, rtype, resource_name, namespace=None, limit=20)
        except Exception:
            continue
        if not matches:
            continue
        chosen = await _resolve_single(service, rtype, resource_name, matches)
        return {
            "resource_type": rtype,
            "resource_name": chosen.get("name", resource_name),
            "namespace": chosen.get("namespace"),
        }

    raise Exception(f"No resource matched '{resource_name}'. Provide namespace and resource type.")

def _query_in_mapping(service, query: str, mapping: object) -> bool:
    if not isinstance(mapping, dict):
        return False
    for k, v in mapping.items():
        if _all_tokens_in_text(service, query, f"{k} {v}"):
            return True
    return False

async def _find_pods(service, query_raw: str, namespace: Optional[str] = None, limit: int = 20) -> List[Dict]:
    query = query_raw.strip()
    if not query:
        return []

    if namespace and namespace.strip():
        pods = await service.k8s_service.get_pods(namespace.strip())
    else:
        pods = await service.k8s_service.get_all_pods()

    def _matches(p: Dict) -> bool:
        name = str(p.get("name", ""))
        if _all_tokens_in_text(service, query, name):
            return True
        return _query_in_mapping(service, query, p.get("labels") or {})

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

async def _find_services(service, query_raw: str, namespace: Optional[str] = None, limit: int = 20) -> List[Dict]:
    query = query_raw.strip()
    if not query:
        return []

    if namespace and namespace.strip():
        services = await service.k8s_service.get_services(namespace.strip())
        svc_dicts = [s if isinstance(s, dict) else getattr(s, "model_dump", lambda: s)() for s in services]  # type: ignore[misc]
    else:
        namespaces = await service.k8s_service.get_namespaces()
        svc_dicts = []
        for ns in namespaces:
            ns_name = ns.get("name") if isinstance(ns, dict) else getattr(ns, "name", None)
            if not ns_name:
                continue
            svcs = await service.k8s_service.get_services(str(ns_name))
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
        if _all_tokens_in_text(service, query, str(s.get("name", ""))):
            return True
        return _query_in_mapping(service, query, s.get("selector") or {})

    matches = [s for s in svc_dicts if isinstance(s, dict) and _matches(s)]
    matches.sort(key=lambda s: (str(s.get("namespace", "")), str(s.get("name", ""))))
    return matches[:limit]

async def _find_deployments(service, query_raw: str, namespace: Optional[str] = None, limit: int = 20) -> List[Dict]:
    query = query_raw.strip()
    if not query:
        return []

    if namespace and namespace.strip():
        deployments = await service.k8s_service.get_deployments(namespace.strip())
        dep_dicts = [d if isinstance(d, dict) else getattr(d, "model_dump", lambda: d)() for d in deployments]  # type: ignore[misc]
    else:
        namespaces = await service.k8s_service.get_namespaces()
        dep_dicts = []
        for ns in namespaces:
            ns_name = ns.get("name") if isinstance(ns, dict) else getattr(ns, "name", None)
            if not ns_name:
                continue
            deps = await service.k8s_service.get_deployments(str(ns_name))
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
        if _all_tokens_in_text(service, query, str(d.get("name", ""))):
            return True
        if _query_in_mapping(service, query, d.get("labels") or {}):
            return True
        if _query_in_mapping(service, query, d.get("selector") or {}):
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

async def _resolve_single(service, kind: str, query: str, matches: List[Dict]) -> Dict:
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
