"""
Model config resolution with in-memory caching.

Resolves the active model config from DB and caches the result for
`_CACHE_TTL` seconds so that repeated requests don't hit the database.
"""

from dataclasses import dataclass, field
from typing import Optional, Dict, Any
import logging
import os
import time
import asyncio

from app.config import settings
from app.database import get_db_service, ModelConfig
from app.services import model_config_policy

logger = logging.getLogger(__name__)


# ── cache settings ──────────────────────────────────────────────
_CACHE_TTL = 30  # seconds — how long to reuse a resolved config
_cache_lock = asyncio.Lock()

# ── cached state ────────────────────────────────────────────────
_cached_resolved: Optional["ResolvedModelConfig"] = None
_cached_at: float = 0.0  # time.monotonic() of last resolve

# API 키가 필수인 클라우드 프로바이더. 그 외(ollama, 셀프호스트, OpenAI-호환
# 로컬 게이트웨이 등)는 키 없이 동작할 수 있으므로 키 누락을 허용한다.
_PROVIDERS_REQUIRING_KEY = frozenset({"openai", "anthropic", "google", "gemini", "azure"})


@dataclass(frozen=True)
class ResolvedModelConfig:
    provider: str
    model: str
    base_url: Optional[str]
    api_key: str
    extra_headers: Dict[str, str]
    tls_verify: bool
    ca_cert: Optional[str] = None
    options: Optional[Dict[str, Any]] = None


def _resolve_api_key(config: ModelConfig) -> Optional[str]:
    # Keys live only in ai-service's environment; the config names the
    # variable — one of the key variables (model_config_policy), never an
    # arbitrary one such as the database URL. Checked here as well as at
    # save time so a row written before the rule cannot read other secrets.
    for name in (config.api_key_env, config.api_key_secret_key):
        if not name:
            continue
        try:
            model_config_policy.check_api_key_env(name)
        except model_config_policy.PolicyError:
            logger.warning("model config %s names a disallowed key variable %s; ignoring it", getattr(config, "id", "?"), name)
            continue
        value = os.getenv(name)
        if value:
            return value
    return None


def _build_resolved(config: Optional[ModelConfig]) -> ResolvedModelConfig:
    """Build a ResolvedModelConfig from a DB ModelConfig or env fallback."""
    if not config:
        # 환경변수 fallback (DB에 모델 설정이 없을 때)
        fallback_base_url = (settings.OPENAI_BASE_URL or "").strip() or None
        return ResolvedModelConfig(
            provider="openai",
            model=settings.OPENAI_MODEL,
            base_url=fallback_base_url or None,
            api_key=settings.OPENAI_API_KEY,
            extra_headers={},
            tls_verify=True,
        )

    provider = (config.provider or "openai").strip().lower()
    api_key = _resolve_api_key(config) or settings.OPENAI_API_KEY
    # 로컬/셀프호스트(Ollama 등)는 키 없이 동작. 클라우드 프로바이더만 키 필수.
    if not api_key and provider in _PROVIDERS_REQUIRING_KEY:
        raise ValueError(f"API key is missing for active model config (provider={provider})")

    base_url = (config.base_url or "").strip().rstrip("/") or None
    # The key goes wherever base_url points: re-check the destination at use
    # time too (resolve_model_config caches the result, so this is not per
    # request). A row written before the rule is refused here.
    try:
        model_config_policy.check_base_url(base_url)
    except model_config_policy.PolicyError as e:
        raise ValueError(f"active model config base_url is not allowed: {e}")
    # Ollama serves the OpenAI-compatible API under /v1; the connection test
    # already appends it, so the runtime client must resolve the same URL.
    if provider == "ollama" and base_url and not base_url.endswith("/v1"):
        base_url += "/v1"

    return ResolvedModelConfig(
        provider=config.provider,
        model=config.model,
        base_url=base_url,
        api_key=api_key or "",
        extra_headers=config.extra_headers or {},
        tls_verify=True if config.tls_verify is None else bool(config.tls_verify),
        ca_cert=(getattr(config, "ca_cert", None) or None),
        options=(getattr(config, "options", None) or None),
    )


async def resolve_model_config(config_id: Optional[int] = None) -> ResolvedModelConfig:
    """
    Resolve the active model config.

    - If ``config_id`` is provided, always queries DB (no caching).
    - Otherwise, returns the in-memory cached active config if still fresh.
    """
    global _cached_resolved, _cached_at

    # Specific config id — always query DB (admin operations)
    if config_id is not None:
        db = await get_db_service()
        config = await db.get_model_config(config_id)
        if config is None:
            raise ValueError("Model config not found")
        return _build_resolved(config)

    # ── cached path for active config ──
    now = time.monotonic()
    if _cached_resolved is not None and (now - _cached_at) < _CACHE_TTL:
        return _cached_resolved

    # Cache miss — resolve under lock to avoid thundering herd
    async with _cache_lock:
        # Double-check after acquiring lock
        now = time.monotonic()
        if _cached_resolved is not None and (now - _cached_at) < _CACHE_TTL:
            return _cached_resolved

        db = await get_db_service()
        config = await db.get_active_model_config()
        resolved = _build_resolved(config)

        _cached_resolved = resolved
        _cached_at = time.monotonic()
        return resolved


def invalidate_model_config_cache() -> None:
    """
    Call this after any ModelConfig CRUD operation to force the next
    resolve to re-query the database.
    """
    global _cached_resolved, _cached_at
    _cached_resolved = None
    _cached_at = 0.0
