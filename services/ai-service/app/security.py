import os
from dataclasses import dataclass
from typing import Optional

import jwt
from fastapi import Header, HTTPException


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


async def require_auth(authorization: Optional[str] = Header(None, alias="Authorization")) -> TokenPayload:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid Authorization header")

    token = parts[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Invalid Authorization header")

    return decode_access_token(token)
