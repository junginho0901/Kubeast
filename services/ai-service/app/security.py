import os
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Optional

import jwt
from fastapi import Depends, Header, HTTPException


AUTH_JWKS_URL = os.getenv("AUTH_JWKS_URL", "http://auth-service:8004/api/v1/auth/jwks.json")
JWT_ISSUER = os.getenv("JWT_ISSUER", "kubeast-auth")
JWT_AUDIENCE = os.getenv("JWT_AUDIENCE", "kubeast")

_jwk_client = jwt.PyJWKClient(AUTH_JWKS_URL)

# Cluster id the services fall back to when a request names none (mirrors
# k8s-service ClusterMiddleware / tool-server resolveClusterKubeconfig).
DEFAULT_CLUSTER = "default"


def _match_any(perms: Iterable[str], perm: str) -> bool:
    for p in perms:
        if p == "*" or p == perm:
            return True
        if p.endswith(".*") and perm.startswith(p[:-1]):
            return True
    return False


@dataclass(frozen=True)
class TokenPayload:
    """Validated JWT claims.

    `matrix` is the per-cluster permission matrix from the token
    ({"*": [global admin perms], "<cluster id>": [perms in that cluster]}).
    `permissions` is the global ("*") entry only — kept as a tuple so admin
    checks and older call sites keep working. Cluster-scoped checks go through
    has_permission_for_cluster; there is no cross-cluster union.
    """

    user_id: str
    role: str
    email: str = ""
    permissions: tuple = ()
    matrix: Mapping[str, tuple] = field(default_factory=dict)

    def has_permission(self, perm: str) -> bool:
        """Global check: the all-cluster ("*") entry only."""
        return _match_any(self.permissions, perm)

    def has_permission_for_cluster(self, perm: str, cluster_id: Optional[str]) -> bool:
        """perm granted in cluster_id (or globally). Empty cluster_id = DEFAULT_CLUSTER."""
        if self.has_permission(perm):
            return True
        cid = cluster_id or DEFAULT_CLUSTER
        if cid == "*":
            return False
        return _match_any(self.matrix.get(cid, ()), perm)


def _parse_permission_matrix(raw) -> Optional[dict]:
    """Parse the JWT permissions claim into {cluster_id: (perms...)}.

    Only the per-cluster map form is accepted (auth-service issues nothing
    else since step 06). A flat list, a missing claim or any other shape returns
    None so the caller rejects the token — the same rule the Go services apply.
    """
    if not isinstance(raw, dict):
        return None
    out: dict = {}
    for cid, perms in raw.items():
        if isinstance(cid, str) and isinstance(perms, list):
            out[cid] = tuple(p for p in perms if isinstance(p, str))
    return out


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
        email = str(payload.get("email") or "").strip()
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
        matrix = _parse_permission_matrix(payload.get("permissions"))
        if matrix is None:
            raise HTTPException(status_code=401, detail="Invalid token: permissions claim must be a per-cluster map")
        return TokenPayload(
            user_id=user_id,
            role=role or "read",
            email=email,
            permissions=matrix.get("*", ()),
            matrix=matrix,
        )
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


async def require_admin(payload: TokenPayload = Depends(require_auth)) -> TokenPayload:
    """Admin gate for model-config administration (admin.ai_models.*)."""
    if payload.permissions:
        if not payload.has_permission("admin.ai_models.*"):
            raise HTTPException(status_code=403, detail="Permission denied")
        return payload
    if payload.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return payload
