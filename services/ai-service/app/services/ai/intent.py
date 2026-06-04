"""
사용자 메시지 의도/출력 형식 감지 헬퍼.

ai_service.py 에서 추출. self 의존이 없는 순수 함수 모음.
"""
from typing import Dict, List, Optional
import json


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


def detect_write_intent(text: Optional[str]) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    keywords = [
        "create",
        "apply",
        "delete",
        "patch",
        "scale",
        "rollout",
        "restart",
        "exec",
        "annotate",
        "label",
        "kubectl apply",
        "kubectl delete",
        "manifest",
        "deploy",
        "배포",
        "적용",
        "생성",
        "만들어",
        "만들기",
        "삭제",
        "지워",
        "패치",
        "수정",
        "스케일",
        "롤아웃",
        "재시작",
        "실행",
        "명령",
        "어노테이션",
        "라벨",
        "레이블",
    ]
    return any(k in lowered for k in keywords)


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


def render_k8s_resource_payload(payload) -> str:
    """k8s_get_resources 결과 포맷을 문자열로 변환"""
    try:
        if isinstance(payload, dict) and "format" in payload:
            return json.dumps(payload.get("data"), ensure_ascii=False)
        return json.dumps(payload, ensure_ascii=False)
    except Exception:
        return str(payload)


def extract_suggestions(message: str) -> List[str]:
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
