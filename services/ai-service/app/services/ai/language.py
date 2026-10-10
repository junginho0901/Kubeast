# 응답 언어 판정 + LANGUAGE OVERRIDE directive 생성. ai_service.py 의
# _detect_response_language / _build_language_directive 에서 추출 (모듈 함수
# 라 self 의존 X). AIService 의 wrapper 메서드가 이 함수들로 위임.
#
# 변경 이력:
#   - 기존 heuristic: hangul >= ascii_letters 면 Korean (ASCII letter 단순 비교)
#     → K8s 리소스 이름 (pod/deployment 명) 이 영문이라 한국어 입력에서도
#     ASCII 비중이 더 커서 English 로 오판하는 사례 빈번 (사용자 보고 2026-05-04)
#   - 새 heuristic: hangul > 0 면 무조건 Korean. 한글이 1자라도 있다는 건
#     사용자가 한국어로 의도했다는 강한 신호. K8s 환경은 영어 리소스 이름이
#     항상 끼므로 ASCII 비율 비교는 무의미.


def detect_response_language(text: str) -> str:
    """사용자 메시지에서 응답 언어 결정.

    Returns:
        "Korean" — 한글 음절/자모가 1자라도 포함된 경우
        "English" — 그 외 (빈 문자열 / ASCII 만 / 다른 스크립트 만)
    """
    if not isinstance(text, str) or not text.strip():
        return "English"

    for ch in text:
        code = ord(ch)
        # 한글 음절 (가~힣) + 자모 (초성/중성/종성) + 호환 자모
        if 0xAC00 <= code <= 0xD7A3 or 0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F:
            return "Korean"
    return "English"


def build_language_directive(user_message: str) -> str:
    """LLM 의 system message 마지막에 주입할 언어 강제 directive."""
    lang = detect_response_language(user_message)
    return (
        f"LANGUAGE OVERRIDE (highest priority): The user's current message is in {lang}. "
        f"You MUST write your entire response in {lang}, regardless of the language used "
        f"in earlier turns or the rest of this system prompt. Keep command names, code, "
        f"and Kubernetes resource identifiers verbatim."
    )


def ui_language_directive(lang: str) -> str:
    """Directive for a request that names the UI language ("ko" / "en") instead of a user message."""
    name = "Korean" if lang == "ko" else "English"
    return (
        f"LANGUAGE OVERRIDE (highest priority): The user's screen is in {name}. "
        f"You MUST write your entire response in {name}, including any line you take from the data. "
        f"Keep command names, code, and Kubernetes resource identifiers verbatim."
    )
