import base64
import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Header, HTTPException

from app.config import settings

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


def _b64url_uint(val: int) -> str:
    raw = val.to_bytes((val.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


@dataclass(frozen=True)
class TokenPayload:
    user_id: str
    role: str


def _key_paths():
    key_dir = settings.KEY_DIR
    os.makedirs(key_dir, exist_ok=True)
    return (
        os.path.join(key_dir, "jwt_private.pem"),
        os.path.join(key_dir, "jwt_public.pem"),
    )


def ensure_rsa_keypair() -> None:
    priv_path, pub_path = _key_paths()
    if os.path.exists(priv_path) and os.path.exists(pub_path):
        return

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()

    priv_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    with open(priv_path, "wb") as f:
        f.write(priv_pem)
    with open(pub_path, "wb") as f:
        f.write(pub_pem)


def _load_private_key_pem() -> bytes:
    ensure_rsa_keypair()
    priv_path, _ = _key_paths()
    with open(priv_path, "rb") as f:
        return f.read()


def _load_public_key_pem() -> bytes:
    ensure_rsa_keypair()
    _, pub_path = _key_paths()
    with open(pub_path, "rb") as f:
        return f.read()


def jwks() -> Dict[str, Any]:
    pub = serialization.load_pem_public_key(_load_public_key_pem())
    if not isinstance(pub, rsa.RSAPublicKey):
        raise RuntimeError("Invalid public key type")
    numbers = pub.public_numbers()

    kid = "auth-rs256-1"
    return {
        "keys": [
            {
                "kty": "RSA",
                "kid": kid,
                "use": "sig",
                "alg": "RS256",
                "n": _b64url_uint(numbers.n),
                "e": _b64url_uint(numbers.e),
            }
        ]
    }


def create_access_token(user_id: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=settings.JWT_EXPIRES_MINUTES)
    payload = {
        "sub": user_id,
        "role": role,
        "iss": settings.JWT_ISSUER,
        "aud": settings.JWT_AUDIENCE,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    headers = {"kid": "auth-rs256-1"}
    return jwt.encode(payload, _load_private_key_pem(), algorithm="RS256", headers=headers)


def decode_access_token(token: str) -> TokenPayload:
    try:
        public_key = serialization.load_pem_public_key(_load_public_key_pem())
        payload = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            issuer=settings.JWT_ISSUER,
            audience=settings.JWT_AUDIENCE,
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
