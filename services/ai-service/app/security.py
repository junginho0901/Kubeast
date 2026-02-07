import os
from dataclasses import dataclass
from typing import Optional

import jwt
from fastapi import Header, HTTPException


def _jwt_secret() -> str:
    return os.getenv("JWT_SECRET", "dev-secret-change-me")


@dataclass(frozen=True)
class TokenPayload:
    member_id: str
    role: str


def decode_access_token(token: str) -> TokenPayload:
    try:
        payload = jwt.decode(token, _jwt_secret(), algorithms=["HS256"])
        member_id = str(payload.get("sub") or "").strip()
        role = str(payload.get("role") or "").strip()
        if not member_id:
            raise HTTPException(status_code=401, detail="Invalid token")
        return TokenPayload(member_id=member_id, role=role or "user")
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

