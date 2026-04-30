"""플로팅 AI 어시스턴트 — AIService 래퍼.

AIService 의 확장점 4개(system_prompt_override / tool_filter /
extra_context_block / title_prefix) 만 주입하고 나머지 동작은 AIService 가
그대로 수행한다. 세션 로드/LLM 스트림/DB 저장/continuation/usage 집계 등
품질 관련 기능이 자동으로 상속된다.
"""
from typing import AsyncGenerator, Optional

from app.models.floating_ai import PageContextPayload
from app.prompts.floating_system_prompt import (
    build_context_prompt,
    build_floating_system_prompt,
)
from app.services.ai_service import AIService
from app.services.tool_whitelists import readonly_tool_filter


FLOATING_TITLE_PREFIX = "[Floating] "


class FloatingAIService:
    """플로팅 위젯 전용 AI 서비스 — AIService 래퍼 (D12 v2.2, D25, D26)."""

    def __init__(self, ai_service: AIService):
        self._ai = ai_service

    async def session_chat_stream(
        self,
        session_id: str,
        message: str,
        page_context: Optional[PageContextPayload] = None,
        cluster_name: Optional[str] = None,
        audit_actor: Optional[dict] = None,
        audit_http: Optional[dict] = None,
    ) -> AsyncGenerator[str, None]:
        system_prompt = build_floating_system_prompt()
        extra_context = (
            build_context_prompt(page_context, cluster_name) if page_context else None
        )

        async for event in self._ai.session_chat_stream(
            session_id=session_id,
            message=message,
            system_prompt_override=system_prompt,
            tool_filter=readonly_tool_filter,
            extra_context_block=extra_context,
            title_prefix=FLOATING_TITLE_PREFIX,
            audit_actor=audit_actor,
            audit_http=audit_http,
        ):
            yield event
