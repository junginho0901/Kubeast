"""
Provider-Aware OpenAI Adapter — AsyncOpenAI drop-in replacement.

각 LLM 프로바이더(OpenAI, Google, Ollama 등)의
OpenAI-compatible 엔드포인트를 사용하여,
기존 self.client.chat.completions.create(...) 호출을 변경 없이
모든 프로바이더에서 사용할 수 있게 합니다. Anthropic 은 같은 인터페이스 뒤에서
네이티브 Messages API 를 씁니다(app/services/anthropic_messages.py).

로컬/셀프호스트 모델 지원 (kagent parity):
  - options:  Ollama-native 생성 옵션(num_ctx, temperature, top_p ...)을
              매 요청에 자동 주입 (provider=ollama 는 extra_body={"options": ...},
              그 외 OpenAI-호환은 top-level 파라미터로 병합).
  - ca_cert:  자체 서명 CA(PEM) 를 신뢰하도록 httpx TLS 검증을 구성.
"""

from __future__ import annotations

from typing import Optional, Dict, Any
import httpx

from app.services.tls import build_verify


# 프로바이더별 기본 OpenAI-compatible 엔드포인트
_PROVIDER_BASE_URLS: Dict[str, str] = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
    "google": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "ollama": "http://localhost:11434/v1",
    # Azure는 사용자가 base_url을 직접 지정해야 함 (endpoint + deployment)
    # "azure": "https://<resource>.openai.azure.com/openai/deployments/<deployment>/",
}


# OpenAI-호환 엔드포인트가 top-level 파라미터로 인식하는 표준 생성 파라미터.
# 이 키들은 create() kwargs 로 직접 전달해야 Ollama 등이 honor 한다.
# (Ollama /v1 은 nested extra_body={"options":{...}} 를 무시하므로 사용하지 않음)
_STANDARD_PARAMS = frozenset({
    "temperature", "top_p", "seed", "max_tokens", "max_completion_tokens",
    "presence_penalty", "frequency_penalty", "stop", "n",
    "logprobs", "top_logprobs", "logit_bias", "response_format",
})


class _CompletionsProxy:
    """chat.completions.create 호출에 기본 생성 옵션을 주입하는 얇은 래퍼.

    호출자가 명시하지 않은 옵션만 채워 넣는다(setdefault). 표준 파라미터는
    top-level 로, 비표준 파라미터(num_ctx 등 Ollama 전용)는 extra_body 로
    best-effort 전달한다. Ollama /v1 은 비표준 파라미터를 무시할 수 있다.
    """

    def __init__(self, inner, provider: str, default_options: Optional[Dict[str, Any]]):
        self._inner = inner
        self._provider = provider
        self._default_options = default_options or None

    async def create(self, **kwargs: Any):
        if self._default_options:
            extra_body = dict(kwargs.get("extra_body") or {})
            for key, value in self._default_options.items():
                if key in _STANDARD_PARAMS:
                    kwargs.setdefault(key, value)
                else:
                    extra_body.setdefault(key, value)
            if extra_body:
                kwargs["extra_body"] = extra_body
        return await self._inner.create(**kwargs)

    def __getattr__(self, name):
        # create 외 다른 속성(list 등)은 원본으로 위임
        return getattr(self._inner, name)


class _ChatProxy:
    """self.chat 자리를 대체하며 completions 만 래핑."""

    def __init__(self, inner_chat, provider: str, default_options: Optional[Dict[str, Any]]):
        self._inner_chat = inner_chat
        self.completions = _CompletionsProxy(inner_chat.completions, provider, default_options)

    def __getattr__(self, name):
        return getattr(self._inner_chat, name)


class ProviderAdapter:
    """
    AsyncOpenAI drop-in replacement.

    프로바이더에 따라 적절한 base_url을 자동 설정합니다.
    기존 코드에서 self.client.chat.completions.create(...) 호출이
    그대로 작동합니다.

    사용 예:
        adapter = ProviderAdapter(
            provider="anthropic",
            model="claude-opus-4-8",
            api_key="sk-ant-...",
        )
        resp = await adapter.chat.completions.create(
            model="claude-opus-4-8",
            messages=[...],
        )
    """

    def __init__(
        self,
        provider: str = "openai",
        model: str = "gpt-4o-mini",
        api_key: str = "",
        base_url: Optional[str] = None,
        tls_verify: bool = True,
        default_headers: Optional[Dict[str, str]] = None,
        options: Optional[Dict[str, Any]] = None,
        ca_cert: Optional[str] = None,
        **_kwargs: Any,
    ):
        self.provider = (provider or "openai").strip().lower()
        self.model = model
        self.api_key = api_key

        # base_url 결정: 사용자 지정 > 프로바이더 기본값
        clean_base_url = (base_url or "").strip()

        if clean_base_url:
            resolved_base_url = clean_base_url
        else:
            resolved_base_url = _PROVIDER_BASE_URLS.get(
                self.provider, "https://api.openai.com/v1"
            )

        http_client = httpx.AsyncClient(verify=build_verify(tls_verify, ca_cert))
        self._default_options = options or None

        if self.provider == "anthropic":
            from app.services.anthropic_messages import AnthropicMessagesClient

            self._openai_client = None
            self.chat = AnthropicMessagesClient(
                model=model,
                api_key=api_key,
                base_url=resolved_base_url,
                http_client=http_client,
                default_headers=default_headers,
                options=options,
            ).chat
            print(
                f"[Provider Adapter] provider=anthropic (Messages API), model={model}, "
                f"base_url={resolved_base_url}, ca_cert={'yes' if ca_cert else 'no'}",
                flush=True,
            )
            return

        # Ollama 등 로컬 모델은 API 키 불필요 — 빈 값이면 더미값 사용
        effective_api_key = api_key if api_key else "ollama"

        # AsyncOpenAI 클라이언트 생성 — the SDK is imported here, when a model
        # client is first made, not at service start (idle memory).
        from openai import AsyncOpenAI

        self._openai_client = AsyncOpenAI(
            api_key=effective_api_key,
            base_url=resolved_base_url,
            default_headers=default_headers if default_headers else None,
            http_client=http_client,
        )

        # 생성 옵션(num_ctx 등)을 매 요청에 주입하는 프록시로 chat 인터페이스 노출
        self.chat = _ChatProxy(self._openai_client.chat, self.provider, self._default_options)

        print(
            f"[Provider Adapter] provider={self.provider}, "
            f"model={model}, base_url={resolved_base_url}, "
            f"options={'yes' if self._default_options else 'no'}, "
            f"ca_cert={'yes' if ca_cert else 'no'}",
            flush=True,
        )
