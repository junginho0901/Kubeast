import os
from dataclasses import dataclass

import jwt
from fastapi import HTTPException
from http.cookies import SimpleCookie
from typing import Optional


AUTH_JWKS_URL = os.getenv("AUTH_JWKS_URL", "http://auth-service:8004/api/v1/auth/jwks.json")
JWT_ISSUER = os.getenv("JWT_ISSUER", "kube-assistant-auth")
JWT_AUDIENCE = os.getenv("JWT_AUDIENCE", "kube-assistant")

_jwk_client = jwt.PyJWKClient(AUTH_JWKS_URL)


@dataclass(frozen=True)
class TokenPayload:
    user_id: str
    role: str


def decode_access_token(token: str) -> TokenPayload:
    try:
        signing_key = _jwk_client.get_signing_key_from_jwt(token).key
        payload = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            issuer=JWT_ISSUER,
            audience=JWT_AUDIENCE,
        )
        user_id = str(payload.get("sub") or "").strip()
        role = str(payload.get("role") or "").strip().lower()
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
        return TokenPayload(user_id=user_id, role=role or "read")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")


def extract_token_from_cookie(cookie_header: Optional[str], cookie_name: str) -> Optional[str]:
    if not cookie_header or not cookie_name:
        return None
    cookie = SimpleCookie()
    cookie.load(cookie_header)
    morsel = cookie.get(cookie_name)
    if morsel and morsel.value:
        return morsel.value
    return None
