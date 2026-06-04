"""
로그/리소스 진단 헬퍼.

ai_service.py 에서 추출. extract_error_patterns 는 순수 함수,
gather_resource_context 는 service.k8s_service 접근 필요.
"""
from typing import TYPE_CHECKING, List
import re

from app.models.ai import ErrorPattern, SeverityLevel, TroubleshootRequest

if TYPE_CHECKING:
    from app.services.ai_service import AIService


def extract_error_patterns(logs: str) -> List[ErrorPattern]:
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


async def gather_resource_context(service: "AIService", request: TroubleshootRequest) -> str:
    """리소스 컨텍스트 수집"""
    context = ""

    try:
        if request.resource_type.lower() == "pod":
            pods = await service.k8s_service.get_pods(request.namespace)
            pod = next((p for p in pods if p["name"] == request.resource_name), None)
            if pod:
                context += f"Pod Status: {pod.get('status', 'N/A')}\n"
                context += f"Phase: {pod.get('phase', 'N/A')}\n"
                context += f"Restart Count: {pod.get('restart_count', 0)}\n"
                context += f"Node: {pod.get('node_name', 'N/A')}\n"

            if request.include_logs:
                logs = await service.k8s_service.get_pod_logs(
                    request.namespace,
                    request.resource_name,
                    tail_lines=50
                )
                context += f"\nRecent Logs:\n{logs}\n"

        if request.include_events:
            events = await service.k8s_service.get_events(request.namespace)
            if events:
                context += "\nRecent Events:\n"
                for event in events[:5]:
                    context += f"- [{event['type']}] {event['reason']}: {event['message']}\n"

    except Exception as e:
        context += f"\nError gathering context: {e}\n"

    return context
