"""
AI 트러블슈팅 서비스
"""
from openai import AsyncOpenAI
from typing import Callable, List, Dict, Optional
import httpx
import re
import json
import os
import sys
import time
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
from app.services.provider_adapter import ProviderAdapter
from app.services.ai.prompts import SYSTEM_MESSAGE
from app.services.ai.tools import K8S_READONLY_TOOLS, K8S_WRITE_TOOLS
from app.services.ai.language import detect_response_language, build_language_directive
from app.services.ai.tool_dispatch import execute_function_with_context
from app.services.ai import formatters, permissions
from app.services.ai import streaming as streaming_module


class TTLCache(dict):
    """dict 호환 캐시 — 5분 TTL 자동 만료"""
    TTL = 300

    def __contains__(self, key):
        if not super().__contains__(key):
            return False
        ts, _ = super().__getitem__(key)
        if time.time() - ts > self.TTL:
            self.pop(key, None)
            return False
        return True

    def __getitem__(self, key):
        ts, val = super().__getitem__(key)
        if time.time() - ts > self.TTL:
            self.pop(key, None)
            raise KeyError(key)
        return val

    def __setitem__(self, key, value):
        super().__setitem__(key, (time.time(), value))


class ToolContext:
    """Tool 실행 컨텍스트"""
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.state = {}  # 실행 상태
        self.cache = TTLCache()  # 결과 캐시 (5분 TTL)


class AIService:
    """AI 트러블슈팅 서비스"""
    
    def __init__(
        self,
        authorization: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        tls_verify: Optional[bool] = True,
    ):
        """프로바이더별 AsyncOpenAI 어댑터 기반 클라이언트 초기화"""
        resolved_api_key = api_key if api_key is not None else settings.OPENAI_API_KEY
        resolved_model = model or settings.OPENAI_MODEL
        resolved_provider = (provider or "openai").strip().lower()
        # base_url: 사용자가 커스텀 엔드포인트를 지정한 경우만 전달
        resolved_base_url = (base_url or "").strip() or None

        self.client = ProviderAdapter(
            provider=resolved_provider,
            model=resolved_model,
            api_key=resolved_api_key,
            base_url=resolved_base_url,
            tls_verify=tls_verify if tls_verify is not None else True,
            default_headers=extra_headers,
        )
        self.model = resolved_model
        self.provider = resolved_provider  # public name used in streamed model_info
        self._provider_name = resolved_provider
        self.user_role = self._resolve_user_role(authorization)
        self.k8s_service = K8sServiceClient(authorization=authorization)
        tool_server_url = self._resolve_tool_server_url(self.user_role)
        self.tool_server = ToolServerClient(authorization=authorization, base_url=tool_server_url)
        self.tool_contexts: Dict[str, ToolContext] = {}  # {session_id: ToolContext}
        print(f"[AI Service] 초기화 완료 - provider: {resolved_provider}, 모델: {self.model}, role: {self.user_role}", flush=True)

    def update_authorization(self, authorization: Optional[str] = None) -> None:
        """
        Update per-request authorization context without recreating the
        heavy LLM client.  This is called when the singleton AIService
        is reused across different users.
        """
        new_role = self._resolve_user_role(authorization)  # also sets self._token_payload
        if new_role != self.user_role or True:
            self.user_role = new_role
            self.k8s_service = K8sServiceClient(authorization=authorization)
            tool_server_url = self._resolve_tool_server_url(self.user_role)
            self.tool_server = ToolServerClient(authorization=authorization, base_url=tool_server_url)

    def _resolve_user_role(self, authorization: Optional[str]) -> str:
        return permissions.resolve_user_role(self, authorization)

    @property
    def token(self):
        return getattr(self, "_token_payload", None)

    def _resolve_tool_server_url(self, role: str) -> Optional[str]:
        # Permission-based: check if user has write/admin-level permissions
        if self.token and self.token.has_permission("*"):
            return os.getenv("TOOL_SERVER_URL_ADMIN")
        if self.token and self.token.has_permission("ai.tool.*"):
            return os.getenv("TOOL_SERVER_URL_WRITE")
        return os.getenv("TOOL_SERVER_URL_READ")

    async def _call_tool_server(self, function_name: str, function_args: Dict) -> str:
        return await self.tool_server.call_tool(function_name, function_args)

    def _role_allows_write(self) -> bool:
        return permissions.role_allows_write(self)

    def _role_allows_admin(self) -> bool:
        return permissions.role_allows_admin(self)

    def _is_tool_allowed(self, function_name: str) -> bool:
        return permissions.is_tool_allowed(self, function_name)

    def _filter_tools_by_role(self, tools: List[Dict]) -> List[Dict]:
        return permissions.filter_tools_by_role(self, tools)

    def _detect_response_language(self, text: str) -> str:
        return detect_response_language(text)

    def _build_language_directive(self, user_message: str) -> str:
        return build_language_directive(user_message)

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

    async def analyze_logs(self, request: LogAnalysisRequest) -> LogAnalysisResponse:
        from app.services.ai.oneshot import analyze_logs
        return await analyze_logs(self, request)

    async def troubleshoot(self, request: TroubleshootRequest) -> TroubleshootResponse:
        from app.services.ai.oneshot import troubleshoot
        return await troubleshoot(self, request)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        from app.services.ai.oneshot import chat
        return await chat(self, request)

    async def explain_resource(self, resource_type: str, resource_yaml: str) -> str:
        from app.services.ai.oneshot import explain_resource
        return await explain_resource(self, resource_type, resource_yaml)

    async def suggest_optimization(self, namespace: str) -> List[str]:
        from app.services.ai.oneshot import suggest_optimization
        return await suggest_optimization(self, namespace)

    async def suggest_optimization_stream(self, namespace: str):
        async for chunk in streaming_module.suggest_optimization_stream(self, namespace):
            yield chunk

    def _parse_cpu_quantity_to_m(self, value: Optional[str]) -> Optional[int]:
        from app.services.ai.quantities import parse_cpu_quantity_to_m
        return parse_cpu_quantity_to_m(value)

    def _parse_memory_quantity_to_mi(self, value: Optional[str]) -> Optional[int]:
        from app.services.ai.quantities import parse_memory_quantity_to_mi
        return parse_memory_quantity_to_mi(value)

    def _median_int(self, values: List[int]) -> Optional[int]:
        from app.services.ai.quantities import median_int
        return median_int(values)

    def _round_up_int(self, value: int, step: int) -> int:
        from app.services.ai.quantities import round_up_int
        return round_up_int(value, step)

    def _labels_match_selector(self, labels: Dict, selector: Dict) -> bool:
        from app.services.ai.quantities import labels_match_selector
        return labels_match_selector(labels, selector)

    def _extract_image_tag_flag(self, image: str) -> str:
        from app.services.ai.quantities import extract_image_tag_flag
        return extract_image_tag_flag(image)

    async def _build_optimization_observations(self, namespace: str) -> Dict[str, str]:
        from app.services.ai.optimization import build_optimization_observations
        return await build_optimization_observations(self, namespace)

    def _extract_error_patterns(self, logs: str) -> List[ErrorPattern]:
        from app.services.ai.diagnostics import extract_error_patterns
        return extract_error_patterns(logs)

    async def _gather_resource_context(self, request: TroubleshootRequest) -> str:
        from app.services.ai.diagnostics import gather_resource_context
        return await gather_resource_context(self, request)
    
    async def chat_stream(self, request: ChatRequest):
        async for chunk in streaming_module.chat_stream(self, request):
            yield chunk

    async def _execute_function(self, function_name: str, function_args: dict):
        from app.services.ai.tool_dispatch import execute_function
        return await execute_function(self, function_name, function_args)

    def _detect_output_preference(self, text: Optional[str]) -> Optional[str]:
        from app.services.ai.intent import detect_output_preference
        return detect_output_preference(text)

    def _detect_write_intent(self, text: Optional[str]) -> bool:
        from app.services.ai.intent import detect_write_intent
        return detect_write_intent(text)

    def _mentions_events(self, text: Optional[str]) -> bool:
        from app.services.ai.intent import mentions_events
        return mentions_events(text)

    def _mentions_logs(self, text: Optional[str]) -> bool:
        from app.services.ai.intent import mentions_logs
        return mentions_logs(text)

    def _mentions_describe(self, text: Optional[str]) -> bool:
        from app.services.ai.intent import mentions_describe
        return mentions_describe(text)

    def _filter_tools_for_output_preference(self, tools: List[Dict], user_text: Optional[str]) -> List[Dict]:
        from app.services.ai.intent import filter_tools_for_output_preference
        return filter_tools_for_output_preference(tools, user_text)

    def _render_k8s_resource_payload(self, payload) -> str:
        from app.services.ai.intent import render_k8s_resource_payload
        return render_k8s_resource_payload(payload)

    def _extract_suggestions(self, message: str) -> List[str]:
        from app.services.ai.intent import extract_suggestions
        return extract_suggestions(message)
    
    async def session_chat_stream(
        self,
        session_id: str,
        message: str,
        *,
        system_prompt_override: Optional[str] = None,
        tool_filter: Optional[Callable[[list], list]] = None,
        extra_context_block: Optional[str] = None,
        title_prefix: Optional[str] = None,
        audit_actor: Optional[dict] = None,
        audit_http: Optional[dict] = None,
    ):
        async for chunk in streaming_module.session_chat_stream(
            self,
            session_id,
            message,
            system_prompt_override=system_prompt_override,
            tool_filter=tool_filter,
            extra_context_block=extra_context_block,
            title_prefix=title_prefix,
            audit_actor=audit_actor,
            audit_http=audit_http,
        ):
            yield chunk

    def _get_tools_definition(self) -> List[Dict]:
        from app.services.ai.tools import get_tools_definition
        return get_tools_definition(self)

    async def _execute_function_with_context(
        self,
        function_name: str,
        function_args: Dict,
        tool_context: ToolContext
    ) -> str:
        return await execute_function_with_context(self, function_name, function_args, tool_context)
