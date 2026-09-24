"""
Unauthenticated health plus the admin-only model connection test.

`public_router` carries nothing but a liveness probe. Model registration is the
authenticated POST /model-configs (app.api); the connection test lives on
`admin_router` because it makes outbound HTTP calls to an operator-supplied URL.
"""
import ipaddress
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
import httpx

from app.security import require_admin

public_router = APIRouter()
admin_router = APIRouter(dependencies=[Depends(require_admin)])


@public_router.get("/health")
async def health():
    return {"status": "healthy"}


# Hosts that must never be probed from the service: cloud instance metadata.
_BLOCKED_HOSTS = frozenset({"metadata.google.internal", "metadata", "instance-data"})
_BLOCKED_NETWORKS = (ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("fd00:ec2::254/128"))


def _validate_base_url(url: str) -> None:
    """Reject non-http(s) schemes, credentials in the URL and metadata endpoints."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPException(status_code=400, detail="base_url must be an http(s) URL")
    if parts.username or parts.password:
        raise HTTPException(status_code=400, detail="base_url must not contain credentials")
    host = parts.hostname.lower()
    if host in _BLOCKED_HOSTS:
        raise HTTPException(status_code=400, detail="base_url host is not allowed")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return
    if any(ip in net for net in _BLOCKED_NETWORKS):
        raise HTTPException(status_code=400, detail="base_url host is not allowed")


async def _test_openai_compatible(
    api_key: str,
    model: str,
    base_url: str,
    tls_verify: bool = True,
) -> dict:
    """Test OpenAI-compatible endpoints (OpenAI, Groq, DeepSeek, Mistral, etc.)"""
    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        http_client=httpx.AsyncClient(verify=tls_verify),
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
    tls_verify: bool = True,
) -> dict:
    """Test Anthropic Messages API directly."""
    async with httpx.AsyncClient(verify=tls_verify, timeout=15.0) as client:
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
    tls_verify: bool = True,
) -> dict:
    """Test Google Gemini generateContent API directly."""
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    async with httpx.AsyncClient(verify=tls_verify, timeout=15.0) as client:
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
    tls_verify: bool = True,
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
        http_client=httpx.AsyncClient(verify=tls_verify),
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
    tls_verify: bool = True,
) -> dict:
    """Test Ollama connection via its OpenAI-compatible endpoint."""
    from openai import AsyncOpenAI

    clean_base = (base_url or "http://localhost:11434").rstrip("/")
    if not clean_base.endswith("/v1"):
        clean_base += "/v1"

    client = AsyncOpenAI(
        api_key="ollama",  # Ollama doesn't need a real key
        base_url=clean_base,
        http_client=httpx.AsyncClient(verify=tls_verify),
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


@admin_router.post("/model-configs/test")
async def test_model_connection(request: dict = None):
    """
    모델 연결 테스트 (admin.ai_models.*).
    body: { provider, model, base_url?, api_key?, tls_verify?, azure_api_version? }
    """
    body = request or {}
    api_key = body.get("api_key", "")
    model = body.get("model", "")
    provider = (body.get("provider") or "openai").strip().lower()
    tls_verify = body.get("tls_verify", True)
    user_base_url = (body.get("base_url") or "").strip()

    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    if user_base_url:
        _validate_base_url(user_base_url)

    # Ollama는 API 키 불필요
    if provider != "ollama" and not api_key:
        raise HTTPException(status_code=400, detail="api_key is required")

    try:
        if provider == "anthropic":
            base = user_base_url or "https://api.anthropic.com"
            return await _test_anthropic(api_key, model, base, tls_verify)

        elif provider in ("google", "gemini"):
            return await _test_google(api_key, model, tls_verify)

        elif provider == "azure":
            api_version = body.get("azure_api_version", "2024-06-01")
            return await _test_azure_openai(api_key, model, user_base_url, api_version, tls_verify)

        elif provider == "ollama":
            return await _test_ollama(model, user_base_url or "http://localhost:11434", tls_verify)

        else:
            # OpenAI-compatible providers
            base = user_base_url or _OPENAI_COMPATIBLE_DEFAULTS.get(provider, "")
            if not base:
                raise HTTPException(
                    status_code=400,
                    detail=f"base_url is required for provider '{provider}'",
                )
            return await _test_openai_compatible(api_key, model, base, tls_verify)

    except HTTPException:
        raise
    except Exception as e:
        return {"success": False, "message": str(e)}
