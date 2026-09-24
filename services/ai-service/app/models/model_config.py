from datetime import datetime
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field, ConfigDict, model_validator


# API keys are never stored in the database. ai-service reads the key from
# its own environment (Helm values ai.*ApiKey / an ExternalSecret mounted as
# env) and the config only names the variable.
API_KEY_NOT_STORED = (
    "api_key is not stored; provide the key to ai-service as an environment "
    "variable and set api_key_env to its name"
)


def _reject_plaintext_key(values):
    if isinstance(values, dict) and values.get("api_key"):
        raise ValueError(API_KEY_NOT_STORED)
    return values


class ModelConfigCreate(BaseModel):
    name: str = Field(..., min_length=1)
    provider: str = "openai"
    model: str = Field(..., min_length=1)
    base_url: Optional[str] = None

    api_key_env: Optional[str] = None      # env var name holding the key

    # Legacy — kept for backward compat (env var name as well)
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

    @model_validator(mode="before")
    @classmethod
    def _no_plaintext_key(cls, values):
        return _reject_plaintext_key(values)


class ModelConfigUpdate(BaseModel):
    name: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    base_url: Optional[str] = None

    api_key_env: Optional[str] = None

    api_key_secret_name: Optional[str] = None
    api_key_secret_key: Optional[str] = None

    extra_headers: Optional[Dict[str, str]] = None
    tls_verify: Optional[bool] = None
    ca_cert: Optional[str] = None
    options: Optional[Dict[str, Any]] = None
    enabled: Optional[bool] = None
    is_default: Optional[bool] = None

    @model_validator(mode="before")
    @classmethod
    def _no_plaintext_key(cls, values):
        return _reject_plaintext_key(values)


class ModelConfigResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    provider: str
    model: str
    base_url: Optional[str]

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
