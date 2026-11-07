"""
사용자 메시지 의도/출력 형식 감지 헬퍼.

ai_service.py 에서 추출. self 의존이 없는 순수 함수 모음.
"""
from typing import Dict, List, Optional


def detect_output_preference(text: Optional[str]) -> Optional[str]:
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


def mentions_events(text: Optional[str]) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return "event" in lowered or "이벤트" in lowered


def mentions_logs(text: Optional[str]) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return "log" in lowered or "로그" in lowered


def mentions_describe(text: Optional[str]) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return "describe" in lowered or "상세" in lowered or "디스크라이브" in lowered


def filter_tools_for_output_preference(tools: List[Dict], user_text: Optional[str]) -> List[Dict]:
    pref = detect_output_preference(user_text)
    if pref not in {"json", "wide", "yaml"}:
        return tools

    want_events = mentions_events(user_text)
    want_logs = mentions_logs(user_text)
    want_describe = mentions_describe(user_text)

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
