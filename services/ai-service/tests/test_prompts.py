# SYSTEM_MESSAGE 회귀 테스트 — 프롬프트는 LLM 의 모든 응답 (도구 호출 정책 /
# 언어 선택 / 출력 형식) 을 좌우한다. 분할 후 다음이 깨지지 않았는지 보호:
#   - 키워드가 살아있다 (KubeAssist, Kubernetes, Critical Rules ...)
#   - 정책 문구가 살아있다 (NEVER guess, default 가정 금지 ...)
#   - 도구 사용 가이드가 들어있다 (k8s_get_resources, k8s_get_pod_logs ...)
#   - 다국어 지시가 살아있다 (Korean / English 분기)
# 정확한 byte 비교는 의도적으로 안 함 — trailing whitespace 같은 noise 변경에
# 깨지면 안 되고, 의미가 살아있는지만 본다.

from app.services.ai.prompts import SYSTEM_MESSAGE


def test_system_message_is_string():
    assert isinstance(SYSTEM_MESSAGE, str)
    assert len(SYSTEM_MESSAGE) > 1000, "프롬프트가 비정상적으로 짧음"


def test_persona_keywords():
    """페르소나 / 도메인 키워드 — 사라지면 LLM 정체성이 흔들림"""
    assert "KubeAssist" in SYSTEM_MESSAGE
    assert "Kubernetes" in SYSTEM_MESSAGE
    assert "트러블슈팅" in SYSTEM_MESSAGE


def test_critical_policy_rules():
    """안전·정확성 정책 — 사라지면 LLM 행동이 위험해짐"""
    assert "Critical Rules" in SYSTEM_MESSAGE
    assert "NEVER guess" in SYSTEM_MESSAGE
    # 네임스페이스 임의 가정 금지 — production safety
    assert "default" in SYSTEM_MESSAGE
    assert "임의로 가정하지 마세요" in SYSTEM_MESSAGE


def test_tool_usage_guide():
    """도구 호출 정책 — 사라지면 LLM 이 도구를 안 부르거나 잘못 부른다"""
    assert "도구 사용 원칙" in SYSTEM_MESSAGE
    assert "도구 호출은 최소한으로" in SYSTEM_MESSAGE
    # 핵심 도구 이름 — 누락 시 LLM 이 도구를 모르거나 잘못된 이름을 호출
    for tool in [
        "k8s_get_resources",
        "k8s_get_resource_yaml",
        "k8s_describe_resource",
        "k8s_get_pod_logs",
        "k8s_get_events",
        "k8s_find_resource",
        "k8s_explain",
        "get_cluster_overview",
        "get_pod_metrics",
        "get_node_metrics",
    ]:
        assert tool in SYSTEM_MESSAGE, f"도구 이름 {tool} 이 프롬프트에서 사라짐"


def test_not_found_protocol():
    """not_found/unavailable 결과를 받은 뒤의 행동이 프롬프트에 있어야 한다 — 없으면
    모델이 같은 이름을 네임스페이스만 바꿔 되묻는 옛 행동으로 돌아간다."""
    assert "못 찾았을 때" in SYSTEM_MESSAGE
    for keyword in ["not_found", "similar", "unknown_kind", "unavailable", "container_required", "no_previous"]:
        assert keyword in SYSTEM_MESSAGE, f"{keyword} 처리 규칙이 프롬프트에 없음"
    assert "반복하지 마세요" in SYSTEM_MESSAGE
    assert "한 번만" in SYSTEM_MESSAGE
    assert "all_namespaces=true" not in SYSTEM_MESSAGE.split("### 못 찾았을 때")[0].split("### 네임스페이스/리소스 식별 규칙")[1], (
        "느슨한 이름은 k8s_find_resource로 찾는다 (옛 all_namespaces 규칙 제거)"
    )


def test_language_policy():
    """다국어 지시 — 사라지면 LLM 이 임의 언어로 응답"""
    assert "Language" in SYSTEM_MESSAGE or "언어" in SYSTEM_MESSAGE
    assert "same language" in SYSTEM_MESSAGE
    assert "Korean" in SYSTEM_MESSAGE
    assert "English" in SYSTEM_MESSAGE


def test_response_format_guide():
    """응답 형식 가이드 — 핵심 지침"""
    assert "응답 형식" in SYSTEM_MESSAGE
    assert "간결하" in SYSTEM_MESSAGE


def test_completion_requirement():
    """응답 완결성 정책 — premature stop 방지"""
    assert "COMPLETION REQUIREMENT" in SYSTEM_MESSAGE
    assert "NEVER end your response prematurely" in SYSTEM_MESSAGE


def test_no_self_reference():
    """`self.` 잔여물이 없어야 함 — 분할 시 instance method 흔적이 string 으로
    들어가면 안 된다 (예: 'self._get_xxx()' 같은 코드가 prompt 안에 박히는 사고)
    """
    # SYSTEM_MESSAGE 안에 'self.' 패턴이 있어선 안 됨
    assert "self._get_" not in SYSTEM_MESSAGE
    assert "self." not in SYSTEM_MESSAGE
