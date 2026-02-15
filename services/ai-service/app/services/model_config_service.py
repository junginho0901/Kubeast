from dataclasses import dataclass
from typing import Optional, Dict
import os

from app.config import settings
from app.database import get_db_service, ModelConfig


@dataclass(frozen=True)
class ResolvedModelConfig:
    provider: str
    model: str
    base_url: Optional[str]
    api_key: str
    extra_headers: Dict[str, str]
    tls_verify: bool


def _resolve_api_key(config: ModelConfig) -> Optional[str]:
    if config.api_key_env:
        value = os.getenv(config.api_key_env)
        if value:
            return value
    if config.api_key_secret_key:
        # K8s Secret은 env로 주입된다고 가정 (secret key == env key)
        value = os.getenv(config.api_key_secret_key)
        if value:
            return value
    return None


async def resolve_model_config(config_id: Optional[int] = None) -> ResolvedModelConfig:
    db = await get_db_service()
    config = None
    if config_id is not None:
        config = await db.get_model_config(config_id)
        if config is None:
            raise ValueError("Model config not found")
    else:
        config = await db.get_active_model_config()

    if not config:
        return ResolvedModelConfig(
            provider="openai",
            model=settings.OPENAI_MODEL,
            base_url=(settings.OPENAI_BASE_URL or "").strip() or None,
            api_key=settings.OPENAI_API_KEY,
            extra_headers={},
            tls_verify=True,
        )

    api_key = _resolve_api_key(config) or settings.OPENAI_API_KEY
    if not api_key:
        raise ValueError("API key is missing for active model config")

    return ResolvedModelConfig(
        provider=config.provider,
        model=config.model,
        base_url=(config.base_url or "").strip() or None,
        api_key=api_key,
        extra_headers=config.extra_headers or {},
        tls_verify=True if config.tls_verify is None else bool(config.tls_verify),
    )
