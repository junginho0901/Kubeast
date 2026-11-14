"""플로팅 AI 어시스턴트 — AIService 래퍼.

AIService 의 확장점 4개(system_prompt_override / tool_filter /
extra_context_block / title_prefix) 만 주입하고 나머지 동작은 AIService 가
그대로 수행한다. 세션 로드/LLM 스트림/DB 저장/continuation/usage 집계 등
품질 관련 기능이 자동으로 상속된다.
"""
import asyncio
import logging
from typing import Any, AsyncGenerator, Optional

from app.models.floating_ai import PageContextPayload
from app.prompts.floating_system_prompt import (
    build_context_prompt,
    build_floating_system_prompt,
)
from app.services.ai_service import AIService
from app.services.redact import highest_numbers
from app.services.tool_whitelists import readonly_tool_filter

log = logging.getLogger(__name__)

FLOATING_TITLE_PREFIX = "[Floating] "


async def start_past_the_conversation(service: Any, session_id: str, numbers: Any) -> None:
    """The page is numbered before the chat reads its history, so its numbers start past what the saved answers show
    the model; the chat raises them again over what it sends (streaming.session_chat_stream). A failed read numbers
    from 1, as the chat's own read of the history then fails the turn."""
    from app.database import get_db_service

    try:
        saved = await (await get_db_service()).get_messages(session_id)
    except Exception as e:  # the chat reports the same read failing
        log.warning("floating chat: history not read for the page's numbers: %s", e)
        return
    sanitize = getattr(service, "_sanitize_history_content", None)
    texts = [sanitize(m.role, m.content) if sanitize else m.content for m in saved if getattr(m, "role", None) in ("user", "assistant")]
    numbers.start_after(highest_numbers(texts))


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
        # The page is numbered with this answer's table, so a value on it and in a tool result has one number.
        numbers = getattr(getattr(self._ai, "tool_server", None), "numbers", None)
        if page_context and numbers is not None:
            await start_past_the_conversation(self._ai, session_id, numbers)
        # Masking the snapshot is CPU work on text a caller sent, up to the gateway's body limit; it goes off the event
        # loop and is awaited before anything of the answer leaves.
        extra_context = (
            await asyncio.to_thread(build_context_prompt, page_context, cluster_name, numbers=numbers) if page_context else None
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
