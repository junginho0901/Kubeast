import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Dict, Iterable, Mapping, Optional, Tuple

import jwt
from fastapi import Depends, Header, HTTPException, Request


AUTH_JWKS_URL = os.getenv("AUTH_JWKS_URL", "http://auth-service:8004/api/v1/auth/jwks.json")
JWT_ISSUER = os.getenv("JWT_ISSUER", "kubeast-auth")
JWT_AUDIENCE = os.getenv("JWT_AUDIENCE", "kubeast")

_jwk_client = jwt.PyJWKClient(AUTH_JWKS_URL)

# Token revocation (same rules as services/pkg/auth token_version.go).
# auth-service bumps a user's token_version to revoke every token issued so
# far; "tv" in a token is the version it was issued with. The current version
# is read from auth-service at most once per TOKEN_VERSION_CACHE_SECONDS per
# user. When auth-service cannot be reached a version fetched within
# TOKEN_VERSION_STALE_SECONDS still counts; with nothing cached the token is
# refused rather than trusted. Empty AUTH_TOKEN_VERSION_URL turns the check off.
AUTH_TOKEN_VERSION_URL = os.getenv(
    "AUTH_TOKEN_VERSION_URL", "http://auth-service:8004/api/v1/auth/internal/token-version"
)
TOKEN_VERSION_CACHE_SECONDS = 30.0
TOKEN_VERSION_STALE_SECONDS = 300.0


class TokenRevokedError(Exception):
    """The token's version is behind the user's current one, or the user is gone."""


def _fetch_token_version(token: str, user_id: str) -> int:
    """GET <AUTH_TOKEN_VERSION_URL>/<user_id> as the bearer. The endpoint only
    answers for the token's own subject, so the token is the credential."""
    req = urllib.request.Request(
        f"{AUTH_TOKEN_VERSION_URL}/{user_id}", headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            return int(json.load(resp)["tv"])
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404):
            raise TokenRevokedError(f"auth-service {e.code}") from e
        raise


_tv_cache: Dict[str, Tuple[int, float]] = {}  # user_id -> (version, monotonic seconds fetched)
_tv_lock = threading.Lock()


def _compare_token_version(claimed: int, current: int) -> None:
    if claimed != current:
        raise HTTPException(status_code=401, detail="Token revoked")


def check_token_version(token: str, user_id: str, claimed: int) -> None:
    """Versions only grow, so a token claiming more than the cached version was
    issued after the cache entry (sign-in right after a role change): that
    refreshes the cache instead of waiting for it to expire."""
    if not AUTH_TOKEN_VERSION_URL:
        return
    now = time.monotonic()
    with _tv_lock:
        cached = _tv_cache.get(user_id)
    if cached and now - cached[1] < TOKEN_VERSION_CACHE_SECONDS and claimed <= cached[0]:
        _compare_token_version(claimed, cached[0])
        return
    try:
        current = _fetch_token_version(token, user_id)
    except TokenRevokedError:
        with _tv_lock:
            _tv_cache.pop(user_id, None)
        raise HTTPException(status_code=401, detail="Token revoked")
    except Exception:
        if cached and now - cached[1] < TOKEN_VERSION_STALE_SECONDS:
            # Outage: the signature proves auth-service issued the token at
            # version `claimed`, so anything not older than what we last saw
            # passes; an older one was revoked before the outage.
            if claimed < cached[0]:
                raise HTTPException(status_code=401, detail="Token revoked")
            return
        raise HTTPException(status_code=401, detail="Token version unavailable")
    with _tv_lock:
        _tv_cache[user_id] = (current, now)
    _compare_token_version(claimed, current)

# Cluster id the services fall back to when a request names none (mirrors
# k8s-service ClusterMiddleware / tool-server resolveClusterKubeconfig).
DEFAULT_CLUSTER = "default"


def _perm_matches(pattern: str, perm: str) -> bool:
    """Segment-wise match, same rules as pkg/auth permMatches (Go) and the
    frontend: "*" grants everything, a "*" segment matches one segment
    ("resource.*.read" → "resource.pod.read"), a trailing "*" matches the rest
    ("ai.tool.*" → "ai.tool.k8s_scale")."""
    if pattern == "*" or pattern == perm:
        return True
    ps, qs = pattern.split("."), perm.split(".")
    for i, seg in enumerate(ps):
        if seg == "*" and i == len(ps) - 1:
            return len(qs) >= len(ps)
        if i >= len(qs) or (seg != "*" and seg != qs[i]):
            return False
    return len(ps) == len(qs)


def _match_any(perms: Iterable[str], perm: str) -> bool:
    return any(_perm_matches(p, perm) for p in perms)


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
        check_token_version(token, user_id, int(payload.get("tv") or 0))
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


AUTH_COOKIE_NAME = os.getenv("AUTH_COOKIE_NAME", "kubeast.token")
CSRF_HEADER = "x-requested-with"
CSRF_HEADER_VALUE = "XMLHttpRequest"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def bearer_or_cookie(request: Request) -> str:
    """The caller's credential as a "Bearer <token>" string.

    API clients send the Authorization header. The browser holds the token only
    as the HttpOnly session cookie; a cookie-authenticated request that can
    change state must also carry X-Requested-With (CSRF — a cross-site page
    cannot add that header without a CORS preflight). Bearer calls are exempt.
    """
    authorization = request.headers.get("authorization")
    if authorization:
        return authorization
    token = request.cookies.get(AUTH_COOKIE_NAME, "")
    if not token:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    if request.method.upper() not in _SAFE_METHODS and request.headers.get(CSRF_HEADER) != CSRF_HEADER_VALUE:
        raise HTTPException(status_code=403, detail="Missing X-Requested-With header")
    return f"Bearer {token}"


async def require_auth(authorization: Optional[str] = Depends(bearer_or_cookie)) -> TokenPayload:
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
