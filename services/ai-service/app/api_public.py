"""
Unauthenticated health plus the admin-only model connection test and model list.

`public_router` carries nothing but a liveness probe. Model registration is the
authenticated POST /model-configs (app.api); the connection test and the model
list live on `admin_router` because they make outbound HTTP calls to an
operator-supplied URL.
"""
import os
import re
import ssl
from typing import Union

from fastapi import APIRouter, Depends, HTTPException
import httpx

from app.security import require_admin
from app.services.ai.debug_dump import safe_error
from app.services import claude_code, model_config_policy
from app.services.anthropic_messages import API_VERSION as ANTHROPIC_VERSION, api_root as anthropic_root
from app.services.tls import build_verify

public_router = APIRouter()
admin_router = APIRouter(dependencies=[Depends(require_admin)])


@public_router.get("/health")
async def health():
    return {"status": "healthy"}


def _validate_base_url(url: str) -> None:
    """The same rule the stored configs follow (model_config_policy): public
    http(s) endpoints only, hosts resolved, metadata/private ranges refused."""
    try:
        model_config_policy.check_base_url(url)
    except model_config_policy.PolicyError as e:
        raise HTTPException(status_code=400, detail=str(e))


async def _test_openai_compatible(
    api_key: str,
    model: str,
    base_url: str,
    verify: Union[bool, ssl.SSLContext] = True,
) -> dict:
    """Test OpenAI-compatible endpoints (OpenAI, Groq, DeepSeek, Mistral, etc.)"""
    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        http_client=httpx.AsyncClient(verify=verify),
        timeout=15.0,
    )
    resp = await client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "ping"}],
        max_tokens=5,
    )
    return {"success": True, "model": resp.model, "message": "Connection successful"}


async def _test_anthropic(
    api_key: str,
    model: str,
    base_url: str = "https://api.anthropic.com",
    verify: Union[bool, ssl.SSLContext] = True,
) -> dict:
    """Test Anthropic Messages API directly."""
    async with httpx.AsyncClient(verify=verify, timeout=15.0) as client:
        resp = await client.post(
            f"{base_url.rstrip('/')}/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 10,
                "messages": [{"role": "user", "content": "ping"}],
            },
        )
        if resp.status_code == 200:
            data = resp.json()
            return {
                "success": True,
                "model": data.get("model", model),
                "message": "Connection successful",
            }
        else:
            detail = resp.text
            try:
                detail = resp.json().get("error", {}).get("message", resp.text)
            except Exception:
                pass
            return {"success": False, "message": f"HTTP {resp.status_code}: {detail}"}


async def _test_google(
    api_key: str,
    model: str,
    verify: Union[bool, ssl.SSLContext] = True,
) -> dict:
    """Test Google Gemini generateContent API directly."""
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    async with httpx.AsyncClient(verify=verify, timeout=15.0) as client:
        resp = await client.post(
            url,
            json={
                "contents": [{"parts": [{"text": "ping"}]}],
                "generationConfig": {"maxOutputTokens": 5},
            },
        )
        if resp.status_code == 200:
            return {
                "success": True,
                "model": model,
                "message": "Connection successful",
            }
        else:
            detail = resp.text
            try:
                err = resp.json().get("error", {})
                detail = err.get("message", resp.text)
                # Quota exceeded means the key IS valid
                if resp.status_code == 429:
                    return {
                        "success": True,
                        "model": model,
                        "message": "Connection successful (quota warning: free tier limit reached)",
                    }
            except Exception:
                pass
            return {"success": False, "message": f"HTTP {resp.status_code}: {detail}"}


# Provider routing table
_OPENAI_COMPATIBLE_DEFAULTS: dict[str, str] = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "mistral": "https://api.mistral.ai/v1",
    "together": "https://api.together.xyz/v1",
    "fireworks": "https://api.fireworks.ai/inference/v1",
    "ollama": "http://localhost:11434/v1",
}


async def _test_azure_openai(
    api_key: str,
    model: str,
    base_url: str,
    api_version: str = "2024-06-01",
    verify: Union[bool, ssl.SSLContext] = True,
) -> dict:
    """Test Azure OpenAI endpoint."""
    # Azure base_url 형식: https://<resource>.openai.azure.com/openai/deployments/<deployment>
    # OpenAI SDK는 Azure 형태 URL + api-key 헤더로 호출
    from openai import AsyncOpenAI

    # Azure는 /v1 대신 ?api-version= 사용
    clean_base = base_url.rstrip("/")
    if not clean_base:
        return {"success": False, "message": "base_url is required for Azure OpenAI"}

    client = AsyncOpenAI(
        api_key=api_key,
        base_url=clean_base,
        default_headers={"api-key": api_key},
        http_client=httpx.AsyncClient(verify=verify),
        timeout=15.0,
    )
    resp = await client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "ping"}],
        max_tokens=5,
        extra_query={"api-version": api_version},
    )
    return {"success": True, "model": resp.model or model, "message": "Connection successful"}


async def _test_ollama(
    model: str,
    base_url: str = "http://localhost:11434",
    verify: Union[bool, ssl.SSLContext] = True,
) -> dict:
    """Test Ollama connection via its OpenAI-compatible endpoint."""
    from openai import AsyncOpenAI

    clean_base = (base_url or "http://localhost:11434").rstrip("/")
    if not clean_base.endswith("/v1"):
        clean_base += "/v1"

    client = AsyncOpenAI(
        api_key="ollama",  # Ollama doesn't need a real key
        base_url=clean_base,
        http_client=httpx.AsyncClient(verify=verify),
        timeout=15.0,
    )
    try:
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=5,
        )
        return {"success": True, "model": resp.model or model, "message": "Connection successful"}
    except Exception as e:
        err_msg = str(e)
        if "Connection refused" in err_msg or "ConnectError" in err_msg:
            return {"success": False, "message": f"Cannot reach Ollama at {clean_base}. Is Ollama running?"}
        raise


@admin_router.get("/model-configs/providers")
async def provider_availability():
    """Providers this install cannot run, with why, for the model forms (admin.ai_models.*): the form greys the
    entry out and says how to turn it on instead of refusing the config only at Test or Save."""
    reason = claude_code.unavailable_reason()
    return {"providers": {claude_code.PROVIDER: {"available": reason is None, "reason": reason}}}


@admin_router.post("/model-configs/test")
async def test_model_connection(request: dict = None):
    """
    모델 연결 테스트 (admin.ai_models.*).
    body: { provider, model, base_url?, api_key_env?, api_key?, tls_verify?, ca_cert?, azure_api_version? }
    api_key_env names an environment variable of this service (how saved
    configs reference keys); api_key is a literal for ad-hoc API use.
    """
    body = request or {}
    api_key = (body.get("api_key") or "").strip()
    api_key_env = (body.get("api_key_env") or "").strip()
    provider = (body.get("provider") or "openai").strip().lower()
    try:
        model_config_policy.check_api_key_env(api_key_env)
        model_config_policy.check_extra_headers(body.get("extra_headers"))
        model_config_policy.check_provider_fields(provider, (api_key_env,), body.get("base_url"))
    except model_config_policy.PolicyError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if provider == claude_code.PROVIDER:
        # Before the key lookup: an install without the provider says so whatever the variable holds.
        reason = claude_code.unavailable_reason()
        if reason:
            return {"success": False, "message": reason}
    if not api_key and api_key_env:
        api_key = (os.getenv(api_key_env) or "").strip()
        if not api_key:
            raise HTTPException(status_code=400, detail=f"environment variable {api_key_env} is not set in ai-service")
    model = body.get("model", "")
    verify = build_verify(body.get("tls_verify", True), body.get("ca_cert"))
    user_base_url = (body.get("base_url") or "").strip()

    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    if user_base_url:
        _validate_base_url(user_base_url)

    # Ollama는 API 키 불필요
    if provider != "ollama" and not api_key:
        raise HTTPException(status_code=400, detail="api_key_env (or api_key) is required")

    try:
        if provider == claude_code.PROVIDER:
            return await claude_code.test_connection(model, api_key)

        elif provider == "anthropic":
            base = user_base_url or "https://api.anthropic.com"
            return await _test_anthropic(api_key, model, base, verify)

        elif provider in ("google", "gemini"):
            return await _test_google(api_key, model, verify)

        elif provider == "azure":
            api_version = body.get("azure_api_version", "2024-06-01")
            return await _test_azure_openai(api_key, model, user_base_url, api_version, verify)

        elif provider == "ollama":
            return await _test_ollama(model, user_base_url or "http://localhost:11434", verify)

        else:
            # OpenAI-compatible providers
            base = user_base_url or _OPENAI_COMPATIBLE_DEFAULTS.get(provider, "")
            if not base:
                raise HTTPException(
                    status_code=400,
                    detail=f"base_url is required for provider '{provider}'",
                )
            return await _test_openai_compatible(api_key, model, base, verify)

    except HTTPException:
        raise
    except Exception as e:
        return {"success": False, "message": safe_error(e, [api_key])}


# What an OpenAI-compatible /models list returns besides chat models.
_NOT_CHAT = re.compile(r"embed|tts|whisper|dall-e|moderation|transcribe|image|audio|realtime|search|davinci|babbage", re.I)
_GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"


async def _list_models(provider: str, api_key: str, base: str, verify: Union[bool, ssl.SSLContext]) -> list[dict]:
    async with httpx.AsyncClient(verify=verify, timeout=15.0) as client:
        if provider == "anthropic":
            resp = await client.get(
                anthropic_root(base) + "/v1/models",
                params={"limit": 1000},
                headers={"x-api-key": api_key, "anthropic-version": ANTHROPIC_VERSION},
            )
            resp.raise_for_status()
            return [{"name": m["id"], "label": m.get("display_name") or m["id"]} for m in resp.json().get("data") or [] if m.get("id")]
        resp = await client.get(base.rstrip("/") + "/models", headers={"Authorization": f"Bearer {api_key or 'ollama'}"})
        resp.raise_for_status()
        names = {str(m.get("id") or "").removeprefix("models/") for m in resp.json().get("data") or []}
        return [{"name": n} for n in sorted(names) if n and not _NOT_CHAT.search(n)]


@admin_router.post("/model-configs/models")
async def list_provider_models(request: dict = None):
    """
    The models the provider lists for this key and address, for the model
    dropdown (admin.ai_models.*). Same key and base_url rules as the connection
    test. When the provider has no list API or the call fails, the answer is
    {"models": [], "error": ...} and the form keeps its built-in list.
    body: { provider, base_url?, api_key_env?, tls_verify?, ca_cert? }
    """
    body = request or {}
    provider = (body.get("provider") or "openai").strip().lower()
    api_key_env = (body.get("api_key_env") or "").strip()
    user_base_url = (body.get("base_url") or "").strip()
    verify = build_verify(body.get("tls_verify", True), body.get("ca_cert"))
    try:
        model_config_policy.check_api_key_env(api_key_env)
    except model_config_policy.PolicyError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if provider == claude_code.PROVIDER:
        return {"models": [], "error": "Claude Code has no model list; pick one or type its name"}
    if user_base_url:
        _validate_base_url(user_base_url)
    api_key = (os.getenv(api_key_env) or "").strip() if api_key_env else ""
    if provider != "ollama" and not api_key:
        return {"models": [], "error": f"environment variable {api_key_env or '(none)'} is not set in ai-service"}

    if provider == "anthropic":
        base = user_base_url or "https://api.anthropic.com"
    elif provider in ("google", "gemini"):
        base = user_base_url or _GEMINI_OPENAI_BASE
    elif provider == "ollama":
        base = (user_base_url or "http://localhost:11434").rstrip("/")
        base = base if base.endswith("/v1") else base + "/v1"
    elif provider == "azure":
        return {"models": [], "error": "Azure OpenAI lists deployments, not models; type the deployment name"}
    else:
        base = user_base_url or _OPENAI_COMPATIBLE_DEFAULTS.get(provider, "")
        if not base:
            return {"models": [], "error": f"base_url is required for provider '{provider}'"}

    try:
        return {"models": await _list_models(provider, api_key, base, verify)}
    except httpx.HTTPStatusError as e:
        return {"models": [], "error": f"the provider answered {e.response.status_code}"}
    except Exception as e:
        if "CERTIFICATE_VERIFY_FAILED" in str(e):
            return {"models": [], "error": "the provider's TLS certificate is not trusted: add its CA (chart customCAs, or this model's CA)"}
        return {"models": [], "error": type(e).__name__}

