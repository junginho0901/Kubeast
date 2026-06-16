from datetime import datetime
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field, ConfigDict


class ModelConfigCreate(BaseModel):
    name: str = Field(..., min_length=1)
    provider: str = "openai"
    model: str = Field(..., min_length=1)
    base_url: Optional[str] = None

    api_key: Optional[str] = None          # actual API key (preferred)
    api_key_env: Optional[str] = None      # env var name (fallback)

    # Legacy — kept for backward compat
    api_key_secret_name: Optional[str] = None
    api_key_secret_key: Optional[str] = None

    extra_headers: Dict[str, str] = Field(default_factory=dict)
    tls_verify: bool = True
    # 자체 서명 CA 인증서(PEM). 셀프호스트 HTTPS 엔드포인트용.
    ca_cert: Optional[str] = None
    # 생성 옵션(temperature, top_p, seed, num_ctx ...) — 로컬 모델 튜닝용.
    options: Optional[Dict[str, Any]] = None
    enabled: bool = True
    is_default: bool = False


class ModelConfigUpdate(BaseModel):
    name: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    base_url: Optional[str] = None

    api_key: Optional[str] = None
    api_key_env: Optional[str] = None

    api_key_secret_name: Optional[str] = None
    api_key_secret_key: Optional[str] = None

    extra_headers: Optional[Dict[str, str]] = None
    tls_verify: Optional[bool] = None
    ca_cert: Optional[str] = None
    options: Optional[Dict[str, Any]] = None
    enabled: Optional[bool] = None
    is_default: Optional[bool] = None


class ModelConfigResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    provider: str
    model: str
    base_url: Optional[str]

    api_key_set: bool = False               # True if api_key is stored in DB
    api_key_env: Optional[str]

    api_key_secret_name: Optional[str]
    api_key_secret_key: Optional[str]

    extra_headers: Dict[str, str]
    tls_verify: bool
    ca_cert: Optional[str] = None
    options: Optional[Dict[str, Any]] = None
    enabled: bool
    is_default: bool

    created_at: datetime
    updated_at: datetime

    @classmethod
    def model_validate(cls, obj, **kwargs):
        """Override to compute api_key_set from the raw DB object."""
        if hasattr(obj, 'api_key'):
            # SQLAlchemy model object
            raw_key = getattr(obj, 'api_key', None)
            result = super().model_validate(obj, **kwargs)
            result.api_key_set = bool(raw_key)
            return result
        return super().model_validate(obj, **kwargs)
