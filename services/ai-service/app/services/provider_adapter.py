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

import re
from typing import Optional, Dict, Any

from app.services.ai.debug_dump import log as logger
from app.services.ai.limits import KUBEAST_KEYS
from app.services.model_config_policy import AZURE_PROVIDERS, AZURE_V1_URL_HINT
from app.services.model_http import model_client
from app.services.tls import build_verify


# 프로바이더별 기본 OpenAI-compatible 엔드포인트
_PROVIDER_BASE_URLS: Dict[str, str] = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
    "google": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "ollama": "http://localhost:11434/v1",
    # Azure OpenAI는 기본값 없음 — 리소스마다 v1 주소(https://<resource>.openai.azure.com/openai/v1/)를 적어야 함
}


# OpenAI-호환 엔드포인트가 top-level 파라미터로 인식하는 표준 생성 파라미터.
# 이 키들은 create() kwargs 로 직접 전달해야 Ollama 등이 honor 한다.
# (Ollama /v1 은 nested extra_body={"options":{...}} 를 무시하므로 사용하지 않음)
_STANDARD_PARAMS = frozenset({
    "temperature", "top_p", "seed", "max_tokens", "max_completion_tokens",
    "presence_penalty", "frequency_penalty", "stop", "n",
    "logprobs", "top_logprobs", "logit_bias", "response_format",
})


# OpenAI's own API and Azure's take the answer's length as max_completion_tokens: max_tokens is deprecated there and
# refused by the reasoning models (o-series, GPT-5).
_COMPLETION_TOKENS_PROVIDERS = frozenset({"openai"}) | AZURE_PROVIDERS
# Parameters a model may refuse (reasoning models refuse sampling): named by the provider's 400, dropped and retried.
_DROPPABLE = frozenset({
    "temperature", "top_p", "presence_penalty", "frequency_penalty", "logprobs", "top_logprobs", "logit_bias",
    "max_tokens", "seed", "stop", "reasoning_effort",
})
# Azure's form names the parameter without quotes.
_REFUSED_IN_MESSAGE = re.compile(
    r"Unsupported (?:parameter|value): '(\w+)'|Unrecognized request argument supplied: (\w+)")
# (provider, base URL, model) → the parameters it refused, so later calls leave them out.
_refused: Dict[tuple, set] = {}
# Function tools in Chat Completions only with reasoning_effort "none" (developers.openai.com/api/docs/guides/latest-model).
_TOOLS_ONLY_WITHOUT_REASONING = re.compile(r"gpt-6-(?:sol|luna)(?:-\d{4}-\d{2}-\d{2})?")
# Such a model's 400 for tools sent at its default effort, whatever name a deployment or gateway gives it.
_TOOLS_NEED_NO_REASONING = re.compile(r"function tools with reasoning_effort are not supported", re.IGNORECASE)
# (provider, base URL, model) that answered so: later calls send "none" from the start.
_without_reasoning: set = set()
# What a model refuses only at an effort other than "none" (the latest-model guide above).
_SAMPLING_AT_NONE = frozenset({"temperature", "top_p", "top_logprobs", "logprobs"})


def _refused_param(err: Exception) -> Optional[str]:
    if getattr(err, "status_code", None) != 400:
        return None
    param = getattr(err, "param", None)
    if not param:
        m = _REFUSED_IN_MESSAGE.search(str(err))
        param = (m.group(1) or m.group(2)) if m else None
    return param if param in _DROPPABLE else None


def _needs_no_reasoning(err: Exception) -> bool:
    return getattr(err, "status_code", None) == 400 and bool(_TOOLS_NEED_NO_REASONING.search(str(err)))


def _leave_out(kwargs: Dict[str, Any], param: str) -> None:
    value = kwargs.pop(param, None)
    if param == "max_tokens" and value is not None:
        kwargs.setdefault("max_completion_tokens", value)


class _CompletionsProxy:
    """chat.completions.create 호출에 기본 생성 옵션을 주입하는 얇은 래퍼.

    호출자가 명시하지 않은 옵션만 채워 넣는다(setdefault). 표준 파라미터는
    top-level 로, 비표준 파라미터(num_ctx 등 Ollama 전용)는 extra_body 로
    best-effort 전달한다. Ollama /v1 은 비표준 파라미터를 무시할 수 있다.
    """

    def __init__(self, inner, provider: str, default_options: Optional[Dict[str, Any]], base_url: str = ""):
        self._inner = inner
        self._provider = provider
        self._default_options = default_options or None
        self._base_url = base_url

    async def create(self, **kwargs: Any):
        if self._default_options:
            extra_body = dict(kwargs.get("extra_body") or {})
            for key, value in self._default_options.items():
                if key in KUBEAST_KEYS:
                    continue
                if key in _STANDARD_PARAMS:
                    kwargs.setdefault(key, value)
                else:
                    extra_body.setdefault(key, value)
            if extra_body:
                kwargs["extra_body"] = extra_body
        if self._provider in _COMPLETION_TOKENS_PROVIDERS:
            _leave_out(kwargs, "max_tokens")
        key = (self._provider, self._base_url, kwargs.get("model"))
        # Every call of such a model, with tools or not: at its default effort the reasoning takes the answer's length
        # (a summary comes back empty) and temperature is refused.
        given = "reasoning_effort" in kwargs or "reasoning_effort" in (kwargs.get("extra_body") or {})
        named = self._provider in _COMPLETION_TOKENS_PROVIDERS and _TOOLS_ONLY_WITHOUT_REASONING.fullmatch(
            str(kwargs.get("model") or ""))
        if not given and (named or key in _without_reasoning):
            kwargs["reasoning_effort"] = "none"
        dropped: Dict[str, Any] = {}

        def drop(param: str) -> None:
            if param in kwargs:
                dropped[param] = kwargs[param]
            _leave_out(kwargs, param)

        for param in list(_refused.get(key, ())):
            drop(param)
        while True:
            try:
                return await self._inner.create(**kwargs)
            except Exception as e:
                # Sent once at "none" at most: after it reasoning_effort is in the call, or refused and remembered.
                if (not given and kwargs.get("tools") and "reasoning_effort" not in kwargs
                        and "reasoning_effort" not in _refused.get(key, ()) and _needs_no_reasoning(e)):
                    _without_reasoning.add(key)
                    kwargs["reasoning_effort"] = "none"
                    # refused at the default effort, taken at "none": sent again, and no longer left out
                    restored = sorted(_SAMPLING_AT_NONE & dropped.keys())
                    for param in restored:
                        kwargs[param] = dropped.pop(param)
                        _refused.get(key, set()).discard(param)
                    if restored:
                        logger.info("model %s takes tools only at reasoning_effort none; sending it with %s again",
                                    kwargs.get("model"), ", ".join(restored))
                    else:
                        logger.info("model %s takes tools only at reasoning_effort none; sending it", kwargs.get("model"))
                    continue
                param = _refused_param(e)
                if param is None or param not in kwargs:
                    raise
                if param in _SAMPLING_AT_NONE and "reasoning_effort" not in kwargs and key in _without_reasoning:
                    # a call that went out at the default effort before the model was found to need "none": its
                    # refusal holds for that effort only, and the calls at "none" keep the value
                    logger.info("model %s refused %s at its default effort; leaving it out of this call",
                                kwargs.get("model"), param)
                else:
                    logger.info("model %s refused %s; leaving it out", kwargs.get("model"), param)
                    _refused.setdefault(key, set()).add(param)
                drop(param)

    def __getattr__(self, name):
        # create 외 다른 속성(list 등)은 원본으로 위임
        return getattr(self._inner, name)


class _ChatProxy:
    """self.chat 자리를 대체하며 completions 만 래핑."""

    def __init__(self, inner_chat, provider: str, default_options: Optional[Dict[str, Any]], base_url: str = ""):
        self._inner_chat = inner_chat
        self.completions = _CompletionsProxy(inner_chat.completions, provider, default_options, base_url)

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
        model: str = "gpt-6-luna",
        api_key: str = "",
        base_url: Optional[str] = None,
        tls_verify: bool = True,
        default_headers: Optional[Dict[str, str]] = None,
        options: Optional[Dict[str, Any]] = None,
        ca_cert: Optional[str] = None,
        installer_base_url: bool = False,
        **_kwargs: Any,
    ):
        self.provider = (provider or "openai").strip().lower()
        self.model = model
        self.api_key = api_key

        # base_url 결정: 사용자 지정 > 프로바이더 기본값
        clean_base_url = (base_url or "").strip()

        if self.provider in AZURE_PROVIDERS:
            # The v1 API: an OpenAI-compatible endpoint per resource. Without one the
            # key would go to api.openai.com. The key rides as the Bearer token (the
            # OpenAI SDK) and as api-key (Azure's own header), so either form passes.
            if not clean_base_url:
                raise ValueError(f"Azure OpenAI needs its v1 endpoint as base_url ({AZURE_V1_URL_HINT})")
            default_headers = {**(default_headers or {}), "api-key": api_key}

        if clean_base_url:
            resolved_base_url = clean_base_url
        else:
            resolved_base_url = _PROVIDER_BASE_URLS.get(
                self.provider, "https://api.openai.com/v1"
            )

        self._default_options = options or None

        if self.provider == "claude-code":
            from app.services.claude_code import ClaudeCodeChat

            self._openai_client = None
            self.claude_code = ClaudeCodeChat(model=model, token=api_key)
            self.chat = self.claude_code.chat
            print(f"[Provider Adapter] provider=claude-code (Claude subscription), model={model}", flush=True)
            return

        http_client = model_client(build_verify(tls_verify, ca_cert), judged=bool(clean_base_url) and not installer_base_url)

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
        self.chat = _ChatProxy(self._openai_client.chat, self.provider, self._default_options, resolved_base_url)

        print(
            f"[Provider Adapter] provider={self.provider}, "
            f"model={model}, base_url={resolved_base_url}, "
            f"options={'yes' if self._default_options else 'no'}, "
            f"ca_cert={'yes' if ca_cert else 'no'}",
            flush=True,
        )
