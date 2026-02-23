from datetime import datetime
from typing import Optional, Dict
from pydantic import BaseModel, Field, ConfigDict


class ModelConfigCreate(BaseModel):
    name: str = Field(..., min_length=1)
    provider: str = "openai"
    model: str = Field(..., min_length=1)
    base_url: Optional[str] = None

    api_key_secret_name: Optional[str] = None
    api_key_secret_key: Optional[str] = None
    api_key_env: Optional[str] = None

    extra_headers: Dict[str, str] = Field(default_factory=dict)
    tls_verify: bool = True
    enabled: bool = True
    is_default: bool = False


class ModelConfigUpdate(BaseModel):
    name: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    base_url: Optional[str] = None

    api_key_secret_name: Optional[str] = None
    api_key_secret_key: Optional[str] = None
    api_key_env: Optional[str] = None

    extra_headers: Optional[Dict[str, str]] = None
    tls_verify: Optional[bool] = None
    enabled: Optional[bool] = None
    is_default: Optional[bool] = None


class ModelConfigResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    provider: str
    model: str
    base_url: Optional[str]

    api_key_secret_name: Optional[str]
    api_key_secret_key: Optional[str]
    api_key_env: Optional[str]

    extra_headers: Dict[str, str]
    tls_verify: bool
    enabled: bool
    is_default: bool

    created_at: datetime
    updated_at: datetime
