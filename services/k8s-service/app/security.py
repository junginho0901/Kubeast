import os
from dataclasses import dataclass

import jwt
from fastapi import HTTPException


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

