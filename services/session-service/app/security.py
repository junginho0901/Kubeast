import base64
import hashlib
import hmac
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import HTTPException, Header


PBKDF2_ALG = "pbkdf2_sha256"
PBKDF2_ITERATIONS = int(os.getenv("PASSWORD_HASH_ITERATIONS", "210000"))
SALT_BYTES = 16


def hash_password(password: str) -> str:
    if not password:
        raise ValueError("Password cannot be empty")

    salt = secrets.token_bytes(SALT_BYTES)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    salt_b64 = base64.urlsafe_b64encode(salt).decode("ascii").rstrip("=")
    dk_b64 = base64.urlsafe_b64encode(dk).decode("ascii").rstrip("=")
    return f"{PBKDF2_ALG}${PBKDF2_ITERATIONS}${salt_b64}${dk_b64}"


def verify_password(password: str, stored: Optional[str]) -> bool:
    if not password or not stored:
        return False

    try:
        alg, iter_str, salt_b64, dk_b64 = stored.split("$", 3)
        if alg != PBKDF2_ALG:
            return False

        iterations = int(iter_str)
        salt = base64.urlsafe_b64decode(_pad_b64(salt_b64))
        expected = base64.urlsafe_b64decode(_pad_b64(dk_b64))
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def _pad_b64(s: str) -> str:
    return s + "=" * (-len(s) % 4)


def _jwt_secret() -> str:
    return os.getenv("JWT_SECRET", "dev-secret-change-me")


def _jwt_expires_minutes() -> int:
    return int(os.getenv("JWT_EXPIRES_MINUTES", "10080"))  # 7 days


@dataclass(frozen=True)
class TokenPayload:
    member_id: str
    role: str


def create_access_token(member_id: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=_jwt_expires_minutes())
    payload = {
        "sub": member_id,
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, _jwt_secret(), algorithm="HS256")


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

