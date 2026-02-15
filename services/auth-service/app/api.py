from fastapi import APIRouter, HTTPException, Depends, Query, Request, Header, Response
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import uuid
import json
import logging

from app.database import get_db_service
from app.security import create_access_token, hash_password, jwks, require_auth, TokenPayload, verify_password

router = APIRouter()
audit_logger = logging.getLogger("auth.audit")
if not audit_logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    audit_logger.addHandler(handler)
audit_logger.setLevel(logging.INFO)
audit_logger.propagate = False

ALLOWED_ROLES = {"admin", "user"}


def _normalize_role(role: str) -> str:
    value = (role or "").strip().lower()
    if value not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role: {role}. Allowed: {sorted(ALLOWED_ROLES)}")
    return value


def _require_admin(payload: TokenPayload):
    if (payload.role or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin only")


class UserResponse(BaseModel):
    id: str
    name: str
    email: str
    hq: Optional[str] = None
    team: Optional[str] = None
    role: str
    created_at: datetime
    updated_at: datetime


class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str
    hq: Optional[str] = None
    team: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class UpdateUserRoleRequest(BaseModel):
    role: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.get("/jwks.json")
async def get_jwks():
    return jwks()


@router.get("/.well-known/jwks.json")
async def get_jwks_well_known():
    return jwks()


@router.post("/register", response_model=UserResponse)
async def register(request: RegisterRequest):
    email = (request.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email")
    if not request.password:
        raise HTTPException(status_code=400, detail="Password required")

    db = await get_db_service()
    existing = await db.get_user_by_email(email)
    if existing:
        raise HTTPException(status_code=409, detail="Email already exists")

    hq = (request.hq or "").strip() or None
    team = (request.team or "").strip() or None

    user_id = str(uuid.uuid4())
    user = await db.create_user(
        user_id=user_id,
        name=request.name.strip() or "user",
        email=email,
        password_hash=hash_password(request.password),
        role="user",
        hq=hq,
        team=team,
    )

    return UserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        hq=getattr(user, "hq", None),
        team=getattr(user, "team", None),
        role=user.role,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


@router.post("/login", response_model=AuthResponse)
async def login(request: LoginRequest, http_request: Request, response: Response):
    email = (request.email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email required")

    db = await get_db_service()
    user = await db.get_user_by_email(email)
    if not user or not verify_password(request.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token(user_id=user.id, role=user.role)

    # Also issue JWT via HttpOnly cookie for browser WS/SSE streaming (Argo CD style).
    from app.config import settings

    forwarded_proto = (http_request.headers.get("X-Forwarded-Proto") or "").strip().lower()
    is_secure = forwarded_proto == "https"
    response.set_cookie(
        key=settings.AUTH_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=is_secure,
        samesite="lax",
        max_age=int(settings.JWT_EXPIRES_MINUTES) * 60,
        path="/",
    )

    return AuthResponse(
        access_token=token,
        user=UserResponse(
            id=user.id,
            name=user.name,
            email=user.email,
            hq=getattr(user, "hq", None),
            team=getattr(user, "team", None),
            role=user.role,
            created_at=user.created_at,
            updated_at=user.updated_at,
        ),
    )

@router.post("/logout")
async def logout(response: Response):
    """Clear auth cookie (best-effort)."""
    from app.config import settings

    response.delete_cookie(key=settings.AUTH_COOKIE_NAME, path="/")
    return {"success": True}


@router.get("/me", response_model=UserResponse)
async def me(payload: TokenPayload = Depends(require_auth)):
    db = await get_db_service()
    user = await db.get_user_by_id(payload.user_id)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    return UserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        hq=getattr(user, "hq", None),
        team=getattr(user, "team", None),
        role=user.role,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )

@router.post("/change-password", response_model=UserResponse)
async def change_password(
    request: ChangePasswordRequest,
    http_request: Request,
    x_request_id: Optional[str] = Header(None, alias="X-Request-ID"),
    payload: TokenPayload = Depends(require_auth),
):
    current_password = request.current_password or ""
    new_password = request.new_password or ""
    if not current_password:
        raise HTTPException(status_code=400, detail="Current password required")
    if not new_password:
        raise HTTPException(status_code=400, detail="New password required")
    if len(new_password) < 4:
        raise HTTPException(status_code=400, detail="New password too short")

    db = await get_db_service()
    user = await db.get_user_by_id(payload.user_id)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    if not verify_password(current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    forwarded_for = http_request.headers.get("X-Forwarded-For")
    request_ip = (forwarded_for.split(",")[0].strip() if forwarded_for else None) or (
        http_request.client.host if http_request.client else None
    )
    user_agent = http_request.headers.get("User-Agent")
    path = str(http_request.url.path)

    updated, audit_row = await db.update_user_password_with_audit(
        actor_user_id=payload.user_id,
        target_user_id=payload.user_id,
        password_hash=hash_password(new_password),
        request_ip=request_ip,
        user_agent=user_agent,
        request_id=x_request_id,
        path=path,
    )

    if not updated:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        audit_logger.info(
            json.dumps(
                {
                    "action": "user.password.change",
                    "actor_user_id": payload.user_id,
                    "target_user_id": payload.user_id,
                    "request_ip": request_ip,
                    "user_agent": user_agent,
                    "request_id": x_request_id,
                    "path": path,
                    "audit_id": getattr(audit_row, "id", None),
                },
                ensure_ascii=False,
            )
        )
    except Exception:
        pass

    return UserResponse(
        id=updated.id,
        name=updated.name,
        email=updated.email,
        role=updated.role,
        created_at=updated.created_at,
        updated_at=updated.updated_at,
    )


@router.get("/admin/users", response_model=list[UserResponse])
async def admin_list_users(
    limit: int = Query(100, ge=1, le=200),
    offset: int = Query(0, ge=0),
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    db = await get_db_service()
    users = await db.list_users(limit=limit, offset=offset)
    return [
        UserResponse(
            id=u.id,
            name=u.name,
            email=u.email,
            hq=getattr(u, "hq", None),
            team=getattr(u, "team", None),
            role=u.role,
            created_at=u.created_at,
            updated_at=u.updated_at,
        )
        for u in users
    ]


@router.patch("/admin/users/{user_id}", response_model=UserResponse)
async def admin_update_user_role(
    user_id: str,
    request: UpdateUserRoleRequest,
    http_request: Request,
    x_request_id: Optional[str] = Header(None, alias="X-Request-ID"),
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    role = _normalize_role(request.role)
    db = await get_db_service()

    forwarded_for = http_request.headers.get("X-Forwarded-For")
    request_ip = (forwarded_for.split(",")[0].strip() if forwarded_for else None) or (
        http_request.client.host if http_request.client else None
    )
    user_agent = http_request.headers.get("User-Agent")
    path = str(http_request.url.path)

    updated, audit_row = await db.update_user_role_with_audit(
        actor_user_id=payload.user_id,
        target_user_id=user_id,
        role=role,
        request_ip=request_ip,
        user_agent=user_agent,
        request_id=x_request_id,
        path=path,
    )

    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    # App log (structured)
    try:
        audit_logger.info(
            json.dumps(
                {
                    "action": "user.role.update",
                    "actor_user_id": payload.user_id,
                    "target_user_id": user_id,
                    "role": role,
                    "request_ip": request_ip,
                    "user_agent": user_agent,
                    "request_id": x_request_id,
                    "path": path,
                    "audit_id": getattr(audit_row, "id", None),
                },
                ensure_ascii=False,
            )
        )
    except Exception:
        # never block the request on logging failures
        pass

    return UserResponse(
        id=updated.id,
        name=updated.name,
        email=updated.email,
        hq=getattr(updated, "hq", None),
        team=getattr(updated, "team", None),
        role=updated.role,
        created_at=updated.created_at,
        updated_at=updated.updated_at,
    )


@router.post("/admin/users/{user_id}/reset-password", response_model=UserResponse)
async def admin_reset_user_password(
    user_id: str,
    http_request: Request,
    x_request_id: Optional[str] = Header(None, alias="X-Request-ID"),
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    db = await get_db_service()

    forwarded_for = http_request.headers.get("X-Forwarded-For")
    request_ip = (forwarded_for.split(",")[0].strip() if forwarded_for else None) or (
        http_request.client.host if http_request.client else None
    )
    user_agent = http_request.headers.get("User-Agent")
    path = str(http_request.url.path)

    updated, audit_row = await db.reset_user_password_with_audit(
        actor_user_id=payload.user_id,
        target_user_id=user_id,
        password_hash=hash_password("1111"),
        request_ip=request_ip,
        user_agent=user_agent,
        request_id=x_request_id,
        path=path,
    )

    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        audit_logger.info(
            json.dumps(
                {
                    "action": "user.password.reset",
                    "actor_user_id": payload.user_id,
                    "target_user_id": user_id,
                    "request_ip": request_ip,
                    "user_agent": user_agent,
                    "request_id": x_request_id,
                    "path": path,
                    "audit_id": getattr(audit_row, "id", None),
                },
                ensure_ascii=False,
            )
        )
    except Exception:
        pass

    return UserResponse(
        id=updated.id,
        name=updated.name,
        email=updated.email,
        hq=getattr(updated, "hq", None),
        team=getattr(updated, "team", None),
        role=updated.role,
        created_at=updated.created_at,
        updated_at=updated.updated_at,
    )


@router.delete("/admin/users/{user_id}", status_code=204)
async def admin_delete_user(
    user_id: str,
    http_request: Request,
    x_request_id: Optional[str] = Header(None, alias="X-Request-ID"),
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    if user_id == payload.user_id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    db = await get_db_service()

    forwarded_for = http_request.headers.get("X-Forwarded-For")
    request_ip = (forwarded_for.split(",")[0].strip() if forwarded_for else None) or (
        http_request.client.host if http_request.client else None
    )
    user_agent = http_request.headers.get("User-Agent")
    path = str(http_request.url.path)

    deleted, audit_row = await db.delete_user_with_audit(
        actor_user_id=payload.user_id,
        target_user_id=user_id,
        request_ip=request_ip,
        user_agent=user_agent,
        request_id=x_request_id,
        path=path,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        audit_logger.info(
            json.dumps(
                {
                    "action": "user.delete",
                    "actor_user_id": payload.user_id,
                    "target_user_id": user_id,
                    "request_ip": request_ip,
                    "user_agent": user_agent,
                    "request_id": x_request_id,
                    "path": path,
                    "audit_id": getattr(audit_row, "id", None),
                },
                ensure_ascii=False,
            )
        )
    except Exception:
        pass

    return Response(status_code=204)
